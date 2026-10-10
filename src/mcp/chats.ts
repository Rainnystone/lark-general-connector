import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { FeishuClient } from "../feishu/client";
import { feishuOpen, stringField } from "../feishu/docs";
import type { FeishuCall } from "../feishu/mcp-proxy";
import { asRecord } from "../feishu/payload";
import { openIdNameMap } from "../feishu/users";
import {
  P2P_CURSOR,
  P2P_SEARCH_FREQUENCY,
  P2P_SEARCH_LIMIT,
  P2P_SEARCH_NOTE,
  P2P_SEARCH_PAGE_CAP,
  p2pDiscoveryMode,
  p2pSearchHits,
  p2pSearchRequest,
  type P2pDiscoveryMode,
} from "./p2p-discovery";
import { CHAT_PAGE_CAP } from "./page-caps";
import { fromOpen, runTool } from "./proxied-call";
import {
  decodeResumeToken,
  encodeResumeToken,
  finishRows,
  fitPage,
  invalidPageToken,
  joinBlocks,
  pageTokenFooter,
  readPageCursor,
  renderFit,
  textResult,
  TOKEN_INVALID,
  windowBlocks,
} from "./tools";

export const CHAT_KINDS = ["all", "group", "p2p"] as const;
export const MESSAGE_ORDERS = ["asc", "desc"] as const;

export type ChatKind = (typeof CHAT_KINDS)[number];

export interface ListChatsArgs {
  kind?: ChatKind;
  page_token?: string;
}

export interface ListChatMessagesArgs {
  chat_id: string;
  start_time?: string;
  end_time?: string;
  order?: (typeof MESSAGE_ORDERS)[number];
  page_token?: string;
  page_size?: number;
}

const SAW_P2P = "p2pseen:";
const CHAT_PAGE_SIZE = "100";
const MESSAGE_PAGE_DEFAULT = 20;
const MESSAGE_PAGE_MAX = 50;

const MESSAGE_ERRORS: Record<number, string> = {
  230002: "The owner is not in this chat, so its messages cannot be read.",
  231204: "This Feishu app has external sharing or associated organizations enabled, so messages cannot be read as the owner.",
  230013: "The other person is outside this app's availability, so this chat cannot be read.",
};

type MessageOrder = (typeof MESSAGE_ORDERS)[number];

function nextPage(data: Record<string, unknown>, page: number, cap: number): { stop: true } | { stop: false; token: string; capped: boolean } {
  const returned = stringField(data, "page_token");
  if (data.has_more !== true || returned.length === 0) return { stop: true };
  return { stop: false, token: returned, capped: page === cap - 1 };
}

function pageFooter(capped: boolean, pageToken: string | null): string {
  if (!capped) return "";
  return pageTokenFooter(pageToken);
}

function lines(fields: Array<[string, string]>): string {
  return fields
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

function chatsUrl(pageToken: string | undefined, withTypes: boolean): string {
  const url = new URL("https://open.feishu.cn/open-apis/im/v1/chats");
  url.searchParams.set("page_size", CHAT_PAGE_SIZE);
  if (withTypes) url.searchParams.set("types", "p2p,group");
  if (pageToken) url.searchParams.set("page_token", pageToken);
  return url.toString();
}

interface ChatRow {
  chatId: string;
  kind: string;
  name: string;
  peerId: string;
  peerType: string;
  discoveredVia: string;
}

function timeValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return typeof value === "string" ? value : "";
}

function formatUtc(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/** Unix seconds, unix milliseconds, or an ISO 8601 instant. Render UTC with an explicit offset. */
export function isoWithOffset(raw: string): string {
  if (!/^\d+$/.test(raw)) {
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) return "";
    return formatUtc(parsed);
  }
  const magnitude = Number(raw);
  if (!Number.isFinite(magnitude)) return "";
  const ms = raw.length >= 13 ? magnitude : magnitude * 1000;
  return formatUtc(ms);
}

function chatRows(data: Record<string, unknown>): ChatRow[] {
  const items = Array.isArray(data.items) ? data.items : [];
  const rows: ChatRow[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const chatId = stringField(record, "chat_id");
    if (chatId.length === 0) continue;
    rows.push({
      chatId,
      kind: stringField(record, "chat_mode"),
      name: stringField(record, "name"),
      peerId: stringField(record, "p2p_target_id"),
      peerType: stringField(record, "p2p_target_type"),
      discoveredVia: "",
    });
  }
  return rows;
}

function includesP2p(kind: ChatKind): boolean {
  switch (kind) {
    case "all":
    case "p2p":
      return true;
    case "group":
      return false;
    default: {
      const unexpected: never = kind;
      return unexpected;
    }
  }
}

function includedWithGroups(kind: string): boolean {
  return kind === "group" || kind === "topic";
}

function keepKind(kind: ChatKind, rowKind: string): boolean {
  switch (kind) {
    case "all":
      return true;
    case "group":
      return includedWithGroups(rowKind);
    case "p2p":
      return rowKind === "p2p";
    default: {
      const unexpected: never = kind;
      return unexpected;
    }
  }
}

function documentedGroups(rows: ChatRow[]): ChatRow[] {
  const groups: ChatRow[] = [];
  for (const row of rows) {
    const kind = row.kind.length === 0 ? "group" : row.kind;
    if (!includedWithGroups(kind)) continue;
    groups.push(kind === row.kind ? row : { ...row, kind });
  }
  return groups;
}

function chatBlock(row: ChatRow, peerName: string): string {
  const name = row.kind === "p2p" ? (row.name.length > 0 ? row.name : peerName) : row.name;
  return lines([
    ["chat_id", row.chatId],
    ["kind", row.kind],
    ["name", name],
    ["peer_type", row.kind === "p2p" ? row.peerType : ""],
    ["discovered_via", row.discoveredVia],
  ]);
}

async function chatBlocks(client: FeishuClient, accessToken: string, rows: ChatRow[]): Promise<string[]> {
  const peerIds = rows.filter((row) => row.kind === "p2p" && row.name.length === 0 && row.peerId.length > 0).map((row) => row.peerId);
  const names = await openIdNameMap(client, accessToken, peerIds);
  return rows.map((row) => chatBlock(row, names.get(row.peerId) ?? row.peerId));
}

function nestedCursor(value: string): boolean {
  return value.startsWith(SAW_P2P) || value.startsWith(P2P_CURSOR) || value.startsWith("rowcap:");
}

function readChatCursor(
  pageToken: string | undefined,
): { ok: true; token: string | undefined; sawP2p: boolean; skip: number; offset: number } | { ok: false } {
  const decoded = decodeResumeToken(pageToken);
  if (!decoded.ok) return { ok: false };
  let raw = decoded.cursor.token;
  let sawP2p = false;
  if (raw?.startsWith(SAW_P2P)) {
    const bare = raw.slice(SAW_P2P.length);
    if (nestedCursor(bare)) return { ok: false };
    if (bare.length === 0 && decoded.cursor.skip === 0 && decoded.cursor.offset === 0) return { ok: false };
    sawP2p = true;
    raw = bare.length > 0 ? bare : undefined;
  } else if (raw?.startsWith(P2P_CURSOR)) {
    const bare = raw.slice(P2P_CURSOR.length);
    if (nestedCursor(bare)) return { ok: false };
  } else if (raw?.startsWith("rowcap:")) {
    return { ok: false };
  }
  return { ok: true, token: raw, sawP2p, skip: decoded.cursor.skip, offset: decoded.cursor.offset };
}

function withP2pSeen(token: string, sawP2p: boolean): string {
  if (!sawP2p) return token;
  if (token.length === 0) return SAW_P2P;
  const decoded = decodeResumeToken(token);
  if (!decoded.ok) return token;
  const inner = decoded.cursor.token ?? "";
  if (inner.startsWith(SAW_P2P) || inner.startsWith(P2P_CURSOR)) return token;
  const marked = `${SAW_P2P}${inner}`;
  if (decoded.cursor.skip > 0 || decoded.cursor.offset > 0) return encodeResumeToken(marked, decoded.cursor.skip, decoded.cursor.offset);
  return marked;
}

function rememberPeer(peers: Map<string, string>, chatId: string, senderId: string, ownerOpenId: string): void {
  const current = peers.get(chatId);
  if (senderId.length === 0 || senderId === ownerOpenId) {
    if (current === undefined) peers.set(chatId, "");
    return;
  }
  if (current === undefined || current.length === 0) peers.set(chatId, senderId);
}

interface DiscoveryPlan {
  listPrimary: boolean;
  searchFrom?: string;
  forceSearch: boolean;
  showCursor: (token: string) => string;
}

function discoveryPlan(mode: P2pDiscoveryMode, pageToken: string | undefined): DiscoveryPlan {
  const bare = pageToken?.startsWith(P2P_CURSOR) ? pageToken.slice(P2P_CURSOR.length) : pageToken;
  switch (mode) {
    case "types_param":
      return { listPrimary: true, forceSearch: false, showCursor: (token) => token };
    case "search":
      return { listPrimary: false, searchFrom: bare, forceSearch: true, showCursor: (token) => token };
    case "auto":
      if (pageToken?.startsWith(P2P_CURSOR)) {
        return { listPrimary: false, searchFrom: bare, forceSearch: true, showCursor: (token) => `${P2P_CURSOR}${token}` };
      }
      return { listPrimary: true, forceSearch: false, showCursor: (token) => `${P2P_CURSOR}${token}` };
    default: {
      const unexpected: never = mode;
      return unexpected;
    }
  }
}

function groupListingNote(kind: ChatKind, error: FeishuCall | null): string {
  if (kind !== "all" || error === null || error.kind !== "done") return "";
  return `\n\ngroup listing failed: ${error.text}`;
}

function searchAfterPrimary(mode: P2pDiscoveryMode, primaryFailed: boolean, listingComplete: boolean, sawP2p: boolean): boolean {
  switch (mode) {
    case "auto":
      return primaryFailed || (listingComplete && !sawP2p);
    case "types_param":
    case "search":
      return false;
    default: {
      const unexpected: never = mode;
      return unexpected;
    }
  }
}

function rowsFromPeers(peers: Map<string, string>): ChatRow[] {
  const rows: ChatRow[] = [];
  for (const [chatId, peerId] of peers) {
    rows.push({ chatId, kind: "p2p", name: "", peerId, peerType: "", discoveredVia: "search" });
  }
  return rows;
}

async function discoverP2pChats(
  client: FeishuClient,
  accessToken: string,
  ownerOpenId: string,
  startToken?: string,
): Promise<{ call?: FeishuCall; rows: ChatRow[]; capped: boolean; continuation: string | null; ran: boolean; limited: boolean }> {
  const peers = new Map<string, string>();
  let pageToken = startToken;
  let capped = false;
  let continuation: string | null = null;
  for (let page = 0; page < P2P_SEARCH_PAGE_CAP; page += 1) {
    const request = p2pSearchRequest(pageToken);
    const result = await feishuOpen(client, "POST", request.url, accessToken, request.body);
    if (TOKEN_INVALID.has(result.code)) return { call: fromOpen(result, ""), rows: [], capped: false, continuation: null, ran: true, limited: false };
    const limited = result.status === 429 || result.code === P2P_SEARCH_FREQUENCY;
    if (limited || result.code !== 0 || result.rawText !== undefined) {
      return { rows: rowsFromPeers(peers), capped: false, continuation: null, ran: true, limited };
    }
    for (const hit of p2pSearchHits(result.data)) {
      if (hit.p2p === false) continue;
      rememberPeer(peers, hit.chatId, hit.senderId, ownerOpenId);
    }
    const step = nextPage(result.data, page, P2P_SEARCH_PAGE_CAP);
    if (step.stop) {
      capped = false;
      continuation = null;
      break;
    }
    continuation = step.token;
    pageToken = step.token;
    capped = step.capped;
  }
  return { rows: rowsFromPeers(peers), capped, continuation, ran: true, limited: false };
}

async function listChats(client: FeishuClient, accessToken: string, args: ListChatsArgs, mode: P2pDiscoveryMode, ownerOpenId: string): Promise<FeishuCall> {
  const kind = args.kind ?? "all";
  let withTypes = true;
  let unavailable = false;
  let primaryFailed = false;
  let primaryError: FeishuCall | null = null;
  const cursor = readChatCursor(args.page_token);
  if (!cursor.ok) return invalidPageToken();
  const plan = discoveryPlan(mode, cursor.token);
  let pageToken = plan.listPrimary ? cursor.token : undefined;
  let skip = plan.listPrimary ? cursor.skip : 0;
  let offset = plan.listPrimary ? cursor.offset : 0;
  let capped = false;
  let continuation: string | null = null;
  let sawP2p = cursor.sawP2p;
  const rows: ChatRow[] = [];
  let blocks: string[] = [];
  let replays: (string | null)[] = [];
  if (plan.listPrimary) {
    for (let page = 0; page < CHAT_PAGE_CAP; page += 1) {
      const requestToken = pageToken;
      let result = await feishuOpen(client, "GET", chatsUrl(pageToken, withTypes), accessToken);
      if (TOKEN_INVALID.has(result.code) || result.status === 429) return fromOpen(result, "");
      if (page === 0 && withTypes && (result.code !== 0 || result.rawText !== undefined)) {
        withTypes = false;
        unavailable = true;
        result = await feishuOpen(client, "GET", chatsUrl(pageToken, false), accessToken);
        if (TOKEN_INVALID.has(result.code) || result.status === 429) return fromOpen(result, "");
      }
      if (result.code !== 0 || result.rawText !== undefined) {
        if (!searchAfterPrimary(mode, true, false, false)) return fromOpen(result, "");
        primaryFailed = true;
        primaryError = fromOpen(result, "");
        break;
      }
      const loaded = chatRows(result.data);
      const pageRows = (unavailable ? documentedGroups(loaded) : loaded).filter((row) => keepKind(kind, row.kind));
      const pageBlocks = (await chatBlocks(client, accessToken, pageRows)).filter((block) => block.length > 0);
      const window = windowBlocks(pageBlocks, skip, offset);
      if (!window.ok) return invalidPageToken();
      const returned = stringField(result.data, "page_token");
      const rawNext = result.data.has_more === true && returned.length > 0 ? returned : null;
      const mark = mode === "auto" && (sawP2p || loaded.some((row) => row.kind === "p2p"));
      const shownRequest = mark ? withP2pSeen(requestToken ?? "", true) : requestToken;
      const shownNext = rawNext === null ? null : withP2pSeen(rawNext, mark);
      if (window.consumed) {
        if (rawNext === null) {
          capped = false;
          continuation = null;
          break;
        }
        if (loaded.some((row) => row.kind === "p2p")) sawP2p = true;
        continuation = withP2pSeen(rawNext, mode === "auto" && sawP2p);
        pageToken = rawNext;
        skip = 0;
        offset = 0;
        capped = page === CHAT_PAGE_CAP - 1;
        if (capped) break;
        continue;
      }
      const decision = fitPage(blocks, replays, window.blocks, window.skip, window.offset, shownRequest, shownNext);
      if (decision.invalid) return invalidPageToken();
      const early = renderFit(decision, "no chats");
      if (early !== null) return { kind: "done", text: early, isError: false };
      if (loaded.some((row) => row.kind === "p2p")) sawP2p = true;
      rows.push(...pageRows.slice(window.skip));
      blocks = decision.blocks;
      replays = decision.replays;
      skip = 0;
      offset = 0;
      if (rawNext === null) {
        capped = false;
        continuation = null;
        break;
      }
      continuation = withP2pSeen(rawNext, mode === "auto" && sawP2p);
      pageToken = rawNext;
      capped = page === CHAT_PAGE_CAP - 1;
      if (capped) break;
    }
  }
  let searchNote = "";
  let searchFooter = "";
  const listingComplete = !capped;
  const groupNote = groupListingNote(kind, primaryError);
  if (includesP2p(kind) && (plan.forceSearch || searchAfterPrimary(mode, primaryFailed || (unavailable && listingComplete), listingComplete, sawP2p))) {
    const discovered = await discoverP2pChats(client, accessToken, ownerOpenId, plan.searchFrom);
    if (discovered.call) return discovered.call;
    const known = new Set(rows.map((row) => row.chatId));
    // Skip is an index into the kind-filtered search order, before chats already listed are hidden.
    // A continuation does not rebuild primary rows, so a skip into the filtered list repeats chats.
    const discoveredRows = discovered.rows.filter((row) => keepKind(kind, row.kind));
    const rendered = await chatBlocks(client, accessToken, discoveredRows);
    const searchSkip = plan.listPrimary ? 0 : cursor.skip;
    const searchOffset = plan.listPrimary ? 0 : cursor.offset;
    const window = windowBlocks(rendered, searchSkip, searchOffset);
    if (!window.ok) return invalidPageToken();
    if (discoveredRows.some((row) => !known.has(row.chatId))) unavailable = false;
    searchNote = `\n\n${P2P_SEARCH_NOTE}`;
    if (discovered.limited) searchNote += `\n\n${P2P_SEARCH_LIMIT}`;
    const origin = plan.showCursor(plan.searchFrom ?? "");
    const nextSearch = discovered.continuation === null ? null : plan.showCursor(discovered.continuation);
    const extra = `${groupNote}${unavailable ? "\n\np2p listing unavailable" : ""}${searchNote}`;
    const visiblePage = window.consumed
      ? []
      : window.blocks.map((block, index) => {
          const row = discoveredRows[window.skip + index];
          return row !== undefined && known.has(row.chatId) ? "" : block;
        });
    const decision = fitPage(
      blocks,
      replays,
      visiblePage,
      window.consumed ? 0 : window.skip,
      window.consumed ? 0 : window.offset,
      origin,
      nextSearch,
      extra,
    );
    if (decision.invalid) return invalidPageToken();
    const early = renderFit(decision, "no chats", extra);
    if (early !== null) return { kind: "done", text: early, isError: false };
    blocks = decision.blocks;
    replays = decision.replays;
    searchFooter = pageFooter(discovered.capped, nextSearch);
  }
  if (primaryError && rows.length === 0 && blocks.length === 0) {
    if (primaryError.kind !== "done") return primaryError;
    return { ...primaryError, text: `${primaryError.text}${searchNote}${searchFooter}` };
  }
  const note = unavailable ? "\n\np2p listing unavailable" : "";
  const notes = `${groupNote}${note}${searchNote}`;
  const footer = `${notes}${pageFooter(capped, continuation)}${searchFooter}`;
  return { kind: "done", text: finishRows(blocks, replays, footer, notes, "no chats"), isError: false };
}

export function callListChats(env: Env, openId: string, args: ListChatsArgs): Promise<CallToolResult> {
  const mode = p2pDiscoveryMode(env.P2P_DISCOVERY);
  switch (mode) {
    case "auto":
    case "types_param":
    case "search":
      return runTool(env, openId, "list_chats", null, (client, accessToken) => listChats(client, accessToken, args, mode, openId));
    default: {
      const unexpected: never = mode;
      return Promise.resolve(textResult(String(unexpected), true));
    }
  }
}

function messagePageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isInteger(pageSize) || pageSize < 1) return MESSAGE_PAGE_DEFAULT;
  return Math.min(pageSize, MESSAGE_PAGE_MAX);
}

function sortType(order: MessageOrder | undefined): string {
  switch (order) {
    case "asc":
      return "ByCreateTimeAsc";
    case "desc":
    case undefined:
      return "ByCreateTimeDesc";
    default: {
      const unexpected: never = order;
      return unexpected;
    }
  }
}

const ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function offsetMinutes(zone: string): number | null {
  if (zone === "Z") return 0;
  const sign = zone.startsWith("-") ? -1 : 1;
  const hours = Number(zone.slice(1, 3));
  const minutes = Number(zone.slice(4, 6));
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
  return sign * (hours * 60 + minutes);
}

function unixSeconds(raw: string): string | null {
  if (/^\d{1,10}$/.test(raw)) return raw;
  const match = ISO_8601.exec(raw);
  if (!match) return null;
  const zoneOffset = offsetMinutes(match[7] ?? "");
  if (zoneOffset === null) return null;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return null;
  const wall = new Date(parsed + zoneOffset * 60_000);
  const fields = [match[1], match[2], match[3], match[4], match[5], match[6]].map((part) => Number(part));
  const [year, month, day, hour, minute, second] = fields;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    wall.getUTCFullYear() !== year ||
    wall.getUTCMonth() + 1 !== month ||
    wall.getUTCDate() !== day ||
    wall.getUTCHours() !== hour ||
    wall.getUTCMinutes() !== minute ||
    wall.getUTCSeconds() !== second
  ) {
    return null;
  }
  const seconds = Math.floor(parsed / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return String(seconds);
}

function messagesUrl(args: ListChatMessagesArgs): { url: string } | { error: string } {
  const url = new URL("https://open.feishu.cn/open-apis/im/v1/messages");
  url.searchParams.set("container_id_type", "chat");
  url.searchParams.set("container_id", args.chat_id);
  url.searchParams.set("sort_type", sortType(args.order));
  url.searchParams.set("page_size", String(messagePageSize(args.page_size)));
  if (args.start_time) {
    const seconds = unixSeconds(args.start_time);
    if (seconds === null) return { error: "start_time must be ISO 8601 or unix seconds" };
    url.searchParams.set("start_time", seconds);
  }
  if (args.end_time) {
    const seconds = unixSeconds(args.end_time);
    if (seconds === null) return { error: "end_time must be ISO 8601 or unix seconds" };
    url.searchParams.set("end_time", seconds);
  }
  if (args.page_token) url.searchParams.set("page_token", args.page_token);
  return { url: url.toString() };
}

function postSource(content: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(content.content) || stringField(content, "title").length > 0) return content;
  for (const key of ["zh_cn", "en_us", "ja_jp"]) {
    const localized = asRecord(content[key]);
    if (Array.isArray(localized.content) || stringField(localized, "title").length > 0) return localized;
  }
  return content;
}

function inlinePost(record: Record<string, unknown>): string {
  const tag = stringField(record, "tag");
  switch (tag) {
    case "text":
      return stringField(record, "text");
    case "a": {
      const label = stringField(record, "text");
      const href = stringField(record, "href");
      if (href.length === 0) return label;
      if (label.length === 0 || label === href) return href;
      return `${label} (${href})`;
    }
    case "at":
      return stringField(record, "user_name") || stringField(record, "text");
    case "img":
    case "media":
      return "[image]";
    case "emotion":
      return "[sticker]";
    case "":
      return "";
    default:
      return "";
  }
}

function postText(content: Record<string, unknown>): string {
  const source = postSource(content);
  const rows = Array.isArray(source.content) ? source.content : [];
  const rendered: string[] = [];
  const title = stringField(source, "title");
  if (title.length > 0) rendered.push(title);
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const line = row.map((element) => inlinePost(asRecord(element))).join("");
    if (line.length > 0) rendered.push(line);
  }
  return rendered.join("\n");
}

function applyMentions(text: string, mentions: unknown): string {
  if (!Array.isArray(mentions) || text.length === 0) return text;
  const pairs: Array<{ key: string; name: string }> = [];
  for (const mention of mentions) {
    const record = asRecord(mention);
    const key = stringField(record, "key");
    const name = stringField(record, "name");
    if (key.length === 0 || name.length === 0) continue;
    pairs.push({ key, name });
  }
  pairs.sort((left, right) => right.key.length - left.key.length);
  let rendered = text;
  for (const pair of pairs) rendered = rendered.split(pair.key).join(`@${pair.name}`);
  return rendered;
}

function messageBody(type: string, content: Record<string, unknown> | null): string {
  switch (type) {
    case "text":
      return content ? stringField(content, "text") : "";
    case "post":
      return content ? postText(content) : "";
    case "image":
      return "[image]";
    case "file": {
      const name = content ? stringField(content, "file_name") : "";
      return name.length > 0 ? `[file: ${name}]` : "[file]";
    }
    case "audio":
      return "[audio]";
    case "media":
      return "[video]";
    case "sticker":
      return "[sticker]";
    case "share_chat":
      return "[share_chat]";
    case "share_user":
      return "[share_user]";
    case "interactive":
      return "[interactive]";
    case "system":
      return "[system]";
    default:
      return type.length > 0 ? `[${type}]` : "[message]";
  }
}

interface MessageRow {
  messageId: string;
  threadId: string;
  parentId: string;
  senderId: string;
  senderType: string;
  openId: string;
  time: string;
  type: string;
  text: string;
}

function messageRows(data: Record<string, unknown>): MessageRow[] {
  const items = Array.isArray(data.items) ? data.items : [];
  const rows: MessageRow[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const sender = asRecord(record.sender);
    const senderId = stringField(sender, "id");
    const body = asRecord(record.body);
    const rawContent = stringField(body, "content");
    let parsed: Record<string, unknown> | null = null;
    if (rawContent.length > 0) {
      try {
        parsed = asRecord(JSON.parse(rawContent) as unknown);
      } catch {
        parsed = null;
      }
    }
    const type = stringField(record, "msg_type");
    rows.push({
      messageId: stringField(record, "message_id"),
      threadId: stringField(record, "thread_id"),
      parentId: stringField(record, "parent_id"),
      senderId,
      senderType: stringField(sender, "sender_type"),
      openId: stringField(sender, "id_type") === "open_id" ? senderId : "",
      time: isoWithOffset(timeValue(record, "create_time")),
      type,
      text: applyMentions(messageBody(type, parsed), record.mentions),
    });
  }
  return rows;
}

function senderLabel(row: MessageRow, resolved: string): string {
  if (row.senderType === "app") return row.senderId.length > 0 ? `bot ${row.senderId}` : "bot";
  return resolved.length > 0 ? resolved : row.senderId;
}

function messageBlock(row: MessageRow, sender: string): string {
  return lines([
    ["message_id", row.messageId],
    ["thread_id", row.threadId],
    ["parent_id", row.parentId],
    ["sender", senderLabel(row, sender)],
    ["time", row.time],
    ["type", row.type],
    ["text", row.text],
  ]);
}

function messageReadError(code: number): string | undefined {
  return MESSAGE_ERRORS[code];
}

function renderMessageItems(client: FeishuClient, accessToken: string, data: Record<string, unknown>): Promise<string> {
  return renderMessages(client, accessToken, messageRows(data));
}

export function callGetMessage(env: Env, openId: string, args: { message_id: string }): Promise<CallToolResult> {
  const messageId = args.message_id.trim();
  return runTool(env, openId, "get_message", messageId.length > 0 ? messageId : null, async (client, accessToken) => {
    if (messageId.length === 0) return { kind: "done", text: "message_id is required", isError: true };
    const result = await feishuOpen(client, "GET", `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, accessToken);
    const explained = messageReadError(result.code);
    if (explained) return { kind: "done", text: explained, isError: true, code: String(result.code) };
    if (TOKEN_INVALID.has(result.code) || result.status === 429 || result.code !== 0 || result.rawText !== undefined) return fromOpen(result, "");
    return { kind: "done", text: await renderMessageItems(client, accessToken, result.data), isError: false };
  });
}

async function messageBlocks(client: FeishuClient, accessToken: string, rows: MessageRow[]): Promise<string[]> {
  const openIds = rows.map((row) => row.openId).filter((id) => id.length > 0);
  const names = await openIdNameMap(client, accessToken, openIds);
  return rows.map((row) => messageBlock(row, names.get(row.openId) ?? row.senderId));
}

async function renderMessages(client: FeishuClient, accessToken: string, rows: MessageRow[]): Promise<string> {
  const blocks = await messageBlocks(client, accessToken, rows);
  return blocks.length === 0 ? "no messages" : joinBlocks(blocks);
}

async function listMessages(client: FeishuClient, accessToken: string, args: ListChatMessagesArgs): Promise<FeishuCall> {
  if (args.chat_id.trim().length === 0) return { kind: "done", text: "chat_id is required", isError: true };
  const resume = readPageCursor(args.page_token, []);
  if (!resume.ok) return invalidPageToken();
  let pageToken = resume.cursor.token;
  let skip = resume.cursor.skip;
  let offset = resume.cursor.offset;
  let blocks: string[] = [];
  let replays: (string | null)[] = [];
  let capped = false;
  let continuation: string | null = null;
  for (let page = 0; page < CHAT_PAGE_CAP; page += 1) {
    const requestToken = pageToken;
    const built = messagesUrl({ ...args, page_token: pageToken });
    if ("error" in built) return { kind: "done", text: built.error, isError: true };
    const result = await feishuOpen(client, "GET", built.url, accessToken);
    const explained = MESSAGE_ERRORS[result.code];
    if (explained) return { kind: "done", text: explained, isError: true, code: String(result.code) };
    if (result.code !== 0 || result.status === 429 || result.rawText !== undefined) return fromOpen(result, "");
    const pageBlocks = (await messageBlocks(client, accessToken, messageRows(result.data))).filter((block) => block.length > 0);
    const window = windowBlocks(pageBlocks, skip, offset);
    if (!window.ok) return invalidPageToken();
    const returned = stringField(result.data, "page_token");
    const nextToken = result.data.has_more === true && returned.length > 0 ? returned : null;
    if (window.consumed) {
      if (nextToken === null) {
        capped = false;
        continuation = null;
        break;
      }
      continuation = nextToken;
      pageToken = nextToken;
      skip = 0;
      offset = 0;
      capped = page === CHAT_PAGE_CAP - 1;
      if (capped) break;
      continue;
    }
    const decision = fitPage(blocks, replays, window.blocks, window.skip, window.offset, requestToken, nextToken);
    if (decision.invalid) return invalidPageToken();
    const early = renderFit(decision, "no messages");
    if (early !== null) return { kind: "done", text: early, isError: false };
    blocks = decision.blocks;
    replays = decision.replays;
    skip = 0;
    offset = 0;
    if (nextToken === null) {
      capped = false;
      continuation = null;
      break;
    }
    continuation = nextToken;
    pageToken = nextToken;
    capped = page === CHAT_PAGE_CAP - 1;
    if (capped) break;
  }
  return { kind: "done", text: finishRows(blocks, replays, pageFooter(capped, continuation), "", "no messages"), isError: false };
}

export function callListChatMessages(env: Env, openId: string, args: ListChatMessagesArgs): Promise<CallToolResult> {
  return runTool(env, openId, "list_chat_messages", args.chat_id, (client, accessToken) => listMessages(client, accessToken, args));
}
