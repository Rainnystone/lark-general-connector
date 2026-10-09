import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { FeishuClient } from "../feishu/client";
import { feishuOpen, stringField } from "../feishu/docs";
import type { FeishuCall } from "../feishu/mcp-proxy";
import { asRecord } from "../feishu/payload";
import { openIdNameMap } from "../feishu/users";
import { isoWithOffset } from "./chats";
import { fromOpen, runTool } from "./proxied-call";
import { P2P_SEARCH_FREQUENCY, P2P_SEARCH_LIMIT, messageSearchUrl, searchItemMeta } from "./p2p-discovery";
import { finishRows, fitPage, invalidPageToken, readPageCursor, renderFit, windowBlocks, TOKEN_INVALID } from "./tools";

export const MESSAGE_CHAT_TYPES = ["group", "p2p"] as const;

export const MESSAGE_SENDER_TYPES = ["user", "bot"] as const;

export interface SearchMessagesArgs {
  query?: string;
  chat_ids?: string[];
  from_ids?: string[];
  from_types?: Array<(typeof MESSAGE_SENDER_TYPES)[number]>;
  exclude_from_types?: Array<(typeof MESSAGE_SENDER_TYPES)[number]>;
  chat_type?: (typeof MESSAGE_CHAT_TYPES)[number];
  start_time?: string;
  end_time?: string;
  is_at_me?: boolean;
  page_token?: string;
  page_size?: number;
}

const SEARCH_PAGE_DEFAULT = 20;
const SEARCH_PAGE_MAX = 30;

function lines(fields: Array<[string, string]>): string {
  return fields
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

function searchPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isInteger(pageSize) || pageSize < 1) return SEARCH_PAGE_DEFAULT;
  return Math.min(pageSize, SEARCH_PAGE_MAX);
}

function searchUrl(args: SearchMessagesArgs, pageToken: string | undefined): string {
  return messageSearchUrl(searchPageSize(args.page_size), pageToken);
}

function idList(ids: string[] | undefined): string[] | undefined {
  if (!ids || ids.length === 0) return undefined;
  return ids;
}

function searchBody(args: SearchMessagesArgs): string {
  const filter: Record<string, unknown> = {};
  const chatIds = idList(args.chat_ids);
  const fromIds = idList(args.from_ids);
  const fromTypes = idList(args.from_types);
  const excludeFromTypes = idList(args.exclude_from_types);
  if (chatIds) filter.chat_ids = chatIds;
  if (fromIds) filter.from_ids = fromIds;
  if (fromTypes) filter.from_types = fromTypes;
  if (excludeFromTypes) filter.exclude_from_types = excludeFromTypes;
  if (args.chat_type) filter.chat_type = args.chat_type;
  if (args.is_at_me !== undefined) filter.is_at_me = args.is_at_me;
  const timeRange: Record<string, string> = {};
  if (args.start_time) timeRange.start_time = args.start_time;
  if (args.end_time) timeRange.end_time = args.end_time;
  if (Object.keys(timeRange).length > 0) filter.time_range = timeRange;
  const body: Record<string, unknown> = { query: args.query ?? "" };
  if (Object.keys(filter).length > 0) body.filter = filter;
  return JSON.stringify(body);
}

function snippetOf(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return stringField(record, "content") || stringField(record, "text") || stringField(record, "snippet");
}

interface SearchHit {
  messageId: string;
  chatId: string;
  p2p: boolean | null;
  senderId: string;
  time: string;
  type: string;
  snippet: string;
}

function searchHits(data: Record<string, unknown>): SearchHit[] {
  const items = Array.isArray(data.items) ? data.items : [];
  const hits: SearchHit[] = [];
  for (const item of items) {
    const meta = searchItemMeta(item);
    if (!meta) continue;
    hits.push({
      messageId: meta.messageId,
      chatId: meta.chatId,
      p2p: meta.p2p,
    senderId: meta.senderId,
    time: isoWithOffset(meta.createTime),
    type: meta.type,
    snippet: snippetOf(asRecord(item).display_info),
    });
  }
  return hits;
}

function hitBlock(hit: SearchHit, sender: string): string {
  return lines([
    ["message_id", hit.messageId],
    ["chat_id", hit.chatId],
    ["is_p2p_chat", hit.p2p === null ? "" : String(hit.p2p)],
    ["sender", sender.length > 0 ? sender : hit.senderId],
    ["time", hit.time],
    ["type", hit.type],
    ["snippet", hit.snippet],
  ]);
}

function searchFooter(data: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof data.total === "number" && Number.isFinite(data.total)) parts.push(`total: ${data.total}`);
  const token = stringField(data, "page_token");
  if (data.has_more === true && token.length > 0) {
    parts.push("page cap reached");
    parts.push(`page_token: ${token}`);
  }
  return parts.length === 0 ? "" : `\n${parts.join("\n")}`;
}

async function hitBlocks(client: FeishuClient, accessToken: string, hits: SearchHit[]): Promise<string[]> {
  const openIds = hits.map((hit) => hit.senderId).filter((id) => id.length > 0);
  const names = await openIdNameMap(client, accessToken, openIds);
  return hits.map((hit) => hitBlock(hit, names.get(hit.senderId) ?? hit.senderId));
}

async function searchMessages(client: FeishuClient, accessToken: string, args: SearchMessagesArgs): Promise<{ call: FeishuCall; target: string | null }> {
  const resume = readPageCursor(args.page_token, []);
  if (!resume.ok) return { call: invalidPageToken(), target: null };
  const result = await feishuOpen(client, "POST", searchUrl(args, resume.cursor.token), accessToken, searchBody(args));
  if (result.status === 429 || result.code === P2P_SEARCH_FREQUENCY) {
    const code = result.status === 429 ? "429" : String(result.code);
    return { call: { kind: "done", text: P2P_SEARCH_LIMIT, isError: true, code }, target: null };
  }
  if (TOKEN_INVALID.has(result.code) || result.code !== 0 || result.rawText !== undefined) {
    return { call: fromOpen(result, ""), target: null };
  }
  const hits = searchHits(result.data);
  const blocks = await hitBlocks(client, accessToken, hits);
  const window = windowBlocks(blocks, resume.cursor.skip, resume.cursor.offset);
  if (!window.ok) return { call: invalidPageToken(), target: null };
  const visibleHits = window.consumed ? [] : hits.slice(window.skip);
  const first = visibleHits[0];
  const target = first ? first.messageId || first.chatId || null : null;
  const token = stringField(result.data, "page_token");
  const next = result.data.has_more === true && token.length > 0 ? token : null;
  const footer = searchFooter(result.data);
  const totalLine = typeof result.data.total === "number" && Number.isFinite(result.data.total) ? `\ntotal: ${result.data.total}` : "";
  if (window.consumed) {
    return { call: { kind: "done", text: finishRows([], [], footer, totalLine, "no messages"), isError: false }, target: null };
  }
  const decision = fitPage([], [], window.blocks, window.skip, window.offset, resume.cursor.token, next, totalLine);
  if (decision.invalid) return { call: invalidPageToken(), target: null };
  const early = renderFit(decision, "no messages", totalLine);
  if (early !== null) return { call: { kind: "done", text: early, isError: false }, target };
  return { call: { kind: "done", text: finishRows(decision.blocks, decision.replays, footer, totalLine, "no messages"), isError: false }, target };
}

export function callSearchMessages(env: Env, openId: string, args: SearchMessagesArgs): Promise<CallToolResult> {
  let target: string | null = null;
  return runTool(env, openId, "search_messages", () => target, async (client, accessToken) => {
    const outcome = await searchMessages(client, accessToken, args);
    target = outcome.target;
    return outcome.call;
  });
}
