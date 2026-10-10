import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { FeishuClient } from "../feishu/client";
import { commentsUrl, DOC_WIKI_SEARCH_URL, feishuOpen, parseDocRef, rawContentUrl, resolveDoc, resolvesWikiNode, stringField, type ResolvedDoc, wikiNodeFields, wikiNodesUrl, wikiNodeUrl } from "../feishu/docs";
import { asRecord } from "../feishu/payload";
import { callFeishuMcp, callFeishuMcpResult, type FeishuCall } from "../feishu/mcp-proxy";
import { openIdNameLookup } from "../feishu/users";
import { byBackend, fromOpen, runTool } from "./proxied-call";
import { DOC_READ_PAGE_CAP } from "./page-caps";
import { finishRows, fitPage, invalidPageToken, pageTokenFooter, readPageCursor, renderFit, windowBlocks } from "./tools";

export interface SearchDocsArgs {
  query: string;
  page_token?: string;
  count?: number;
}

export interface FetchDocArgs {
  doc: string;
  offset?: number;
  limit?: number;
}

/**
 * Feishu counts `limit` in Unicode code points and has no page size of its own.
 * The payload is a JSON string inside the JSON-RPC body. `<`, `>`, and `&` expand
 * to `\u00XX` (6) and then `\\u00XX` (7). 28_000 * 7 = 196_000, under BODY_CHAR_LIMIT,
 * leaving room for the envelope and for the title under the 100_000-character tool output.
 * A caller limit above this page is clamped to it. Live captures return emoji as characters, not `\u` escapes.
 */
const FETCH_DOC_PAGE = 28_000;
const OPENAPI_FETCH_CAP = 100_000;
const OPENAPI_FETCH_NOTE = "OpenAPI returned a prefix of this doc. Use the MCP backend to read the rest.";

export interface ListWikiDocsArgs {
  space_id?: string;
  node_token?: string;
  page_token?: string;
}

export interface DocCommentsArgs {
  doc: string;
  page_token?: string;
}

const SEARCH_DEFAULT_COUNT = 20;
const SEARCH_MAX_COUNT = 50;
const SEARCH_MCP_MAX_COUNT = 20;
/** doc_wiki search rejects a query longer than 30 and a page larger than 20. */
const SEARCH_QUERY_MAX = 30;
const SEARCH_PAGE_MAX = 20;
const LIST_DOCS_PAGE_SIZE = 50;

function lines(fields: Array<[string, string]>): string {
  return fields
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

function searchCount(count: number | undefined): number {
  if (count === undefined) return SEARCH_DEFAULT_COUNT;
  if (!Number.isInteger(count) || count < 1) return SEARCH_DEFAULT_COUNT;
  return Math.min(count, SEARCH_MAX_COUNT);
}

function searchMcpArguments(args: SearchDocsArgs): Record<string, unknown> {
  const page: Record<string, unknown> = { size: Math.min(searchCount(args.count), SEARCH_MCP_MAX_COUNT) };
  if (args.page_token && /^\d+$/.test(args.page_token)) page.offset = Number(args.page_token);
  else if (args.page_token) page.page_token = args.page_token;
  return { query: args.query, page };
}

/** list-docs has no space_id. A real space id is listed through OpenAPI instead. */
function listMcpArguments(args: ListWikiDocsArgs): Record<string, unknown> | null {
  if (args.space_id && args.space_id !== "my_library" && !args.node_token) return null;
  const sent: Record<string, unknown> = { page_size: LIST_DOCS_PAGE_SIZE };
  if (args.page_token) sent.page_token = args.page_token;
  if (args.node_token) sent.doc_id = args.node_token;
  else sent.my_library = true;
  return sent;
}

function pageFooter(capped: boolean, pageToken: string | null): string {
  if (!capped) return "";
  return pageTokenFooter(pageToken);
}

/** A later page is available. This is not the ten-page cap. */
function nextPageFooter(pageToken: string | null): string {
  if (pageToken === null || pageToken.length === 0) return "";
  return `\npage_token: ${pageToken}`;
}

function stripHighlight(value: string): string {
  return value.replaceAll(/<\/?hb?>/g, "");
}

function iconToken(iconInfo: string): string {
  if (iconInfo.length === 0) return "";
  try {
    const token = asRecord(JSON.parse(iconInfo) as unknown).token;
    return typeof token === "string" ? token : "";
  } catch {
    return "";
  }
}

function editedField(meta: Record<string, unknown>): string {
  const edited = meta.update_time;
  if (typeof edited === "number" && Number.isFinite(edited)) return String(edited);
  return stringField(meta, "update_time");
}

function wikiResultType(entityType: string, docType: string): string {
  if (entityType === "WIKI") return "wiki";
  const raw = docType.length > 0 ? docType : entityType;
  return raw.toLowerCase();
}

function resultTitle(record: Record<string, unknown>): string {
  const highlighted = stringField(record, "title_highlighted");
  const title = highlighted.length > 0 ? highlighted : stringField(record, "title");
  return stripHighlight(title);
}

function docWikiBlock(unit: unknown): string {
  const record = asRecord(unit);
  const meta = asRecord(record.result_meta);
  const type = wikiResultType(stringField(record, "entity_type"), stringField(meta, "doc_types"));
  return lines([
    ["title", resultTitle(record)],
    ["type", type],
    ["token", stringField(meta, "token")],
    ["url", stringField(meta, "url")],
    ["owner", stringField(meta, "owner_id")],
    ["edited", editedField(meta)],
    ["obj_token", iconToken(stringField(meta, "icon_info"))],
    ["summary", stripHighlight(stringField(record, "summary_highlighted"))],
  ]);
}

function nodeBlock(item: unknown): string {
  const record = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
  return lines([
    ["title", stringField(record, "title")],
    ["token", stringField(record, "node_token")],
    ["type", stringField(record, "obj_type")],
    ["obj_token", stringField(record, "obj_token")],
    ["has_child", record.has_child === true ? "true" : record.has_child === false ? "false" : ""],
  ]);
}

function searchQuery(query: string): string {
  return Array.from(query).slice(0, SEARCH_QUERY_MAX).join("");
}

function docWikiBody(args: SearchDocsArgs, pageToken: string | undefined): string {
  const body: Record<string, unknown> = {
    query: searchQuery(args.query),
    page_size: Math.min(searchCount(args.count), SEARCH_PAGE_MAX),
    doc_filter: {},
    wiki_filter: {},
  };
  if (pageToken !== undefined && pageToken.length > 0) body.page_token = pageToken;
  return JSON.stringify(body);
}

async function searchOpenApi(client: FeishuClient, accessToken: string, args: SearchDocsArgs): Promise<FeishuCall> {
  const resume = readPageCursor(args.page_token, []);
  if (!resume.ok) return invalidPageToken();
  const result = await feishuOpen(client, "POST", DOC_WIKI_SEARCH_URL, accessToken, docWikiBody(args, resume.cursor.token));
  if (result.code !== 0 || result.status === 429 || result.rawText !== undefined) return fromOpen(result, "");
  const units = Array.isArray(result.data.res_units) ? result.data.res_units : [];
  const pageBlocks = units.map((unit) => docWikiBlock(unit)).filter((block) => block.length > 0);
  const window = windowBlocks(pageBlocks, resume.cursor.skip, resume.cursor.offset);
  if (!window.ok) return invalidPageToken();
  const returned = stringField(result.data, "page_token");
  const nextToken = result.data.has_more === true && returned.length > 0 ? returned : null;
  if (window.consumed) {
    return { kind: "done", text: finishRows([], [], nextPageFooter(nextToken), "", "no matching docs"), isError: false };
  }
  const decision = fitPage([], [], window.blocks, window.skip, window.offset, resume.cursor.token, nextToken);
  if (decision.invalid) return invalidPageToken();
  const early = renderFit(decision, "no matching docs");
  if (early !== null) return { kind: "done", text: early, isError: false };
  return { kind: "done", text: finishRows(decision.blocks, decision.replays, nextPageFooter(decision.resumeToken), "", "no matching docs"), isError: false };
}

interface WikiFields {
  objToken: string;
  objType: string;
  spaceId: string;
}

async function readWikiNode(client: FeishuClient, accessToken: string, token: string): Promise<{ fields: WikiFields } | FeishuCall> {
  const node = await feishuOpen(client, "GET", wikiNodeUrl(token), accessToken);
  if (node.rawText !== undefined || node.code !== 0 || node.status === 429) return fromOpen(node, "");
  return { fields: wikiNodeFields(node.data) };
}

function unresolvedDoc(resolved: Exclude<ResolvedDoc, { ok: true }>): FeishuCall {
  switch (resolved.reason) {
    case "empty":
      return { kind: "done", text: "Feishu request failed", isError: true };
    case "open":
      return fromOpen(resolved.payload, "");
    default: {
      const unexpected: never = resolved;
      return unexpected;
    }
  }
}

const FETCH_DOC_READ_TOOL: Record<string, string> = {
  sheet: "read_sheet",
  bitable: "read_bitable",
  slides: "read_slides",
  file: "read_file",
  mindnote: "read_mindnote",
};

function fetchDocTypeRefusal(objType: string): FeishuCall {
  const label = objType.length > 0 ? objType : "unknown";
  const tool = FETCH_DOC_READ_TOOL[label];
  return { kind: "done", text: tool ? `this is a ${label}; use ${tool}` : `this is a ${label}`, isError: true };
}

async function gateFetchDoc(client: FeishuClient, accessToken: string, doc: string): Promise<{ token: string } | FeishuCall> {
  const ref = parseDocRef(doc);
  if (!resolvesWikiNode(doc)) {
    if (ref.objType !== "docx") return fetchDocTypeRefusal(ref.objType);
    return { token: ref.token };
  }
  const resolved = await resolveDoc(doc, (url) => feishuOpen(client, "GET", url, accessToken));
  if (!resolved.ok) return unresolvedDoc(resolved);
  if (resolved.objType !== "docx") return fetchDocTypeRefusal(resolved.objType);
  return { token: resolved.token };
}

async function fetchOpenApi(client: FeishuClient, accessToken: string, token: string): Promise<FeishuCall> {
  const result = await feishuOpen(client, "GET", rawContentUrl(token), accessToken);
  return fromOpen(result, capOpenContent(stringField(result.data, "content")));
}

async function listOpenApi(client: FeishuClient, accessToken: string, args: ListWikiDocsArgs): Promise<FeishuCall> {
  let spaceId = args.space_id ?? "";
  const parent = args.node_token;
  if (spaceId.length === 0 && args.node_token) {
    const loaded = await readWikiNode(client, accessToken, args.node_token);
    if ("kind" in loaded) return loaded;
    spaceId = loaded.fields.spaceId;
  }
  if (spaceId.length === 0 && !args.node_token) spaceId = "my_library";
  if (spaceId.length === 0) return { kind: "done", text: "space_id or node_token is required", isError: true };
  return gatherPages(
    args.page_token,
    (pageToken) => feishuOpen(client, "GET", wikiNodesUrl(spaceId, pageToken, parent), accessToken),
    (data) => {
      const items = Array.isArray(data.items) ? data.items : [];
      return items.map((item) => nodeBlock(item));
    },
    "no wiki docs",
  );
}

async function gatherPages(
  firstToken: string | undefined,
  load: (pageToken: string | undefined) => Promise<{ status: number; code: number; data: Record<string, unknown>; rawText?: string }>,
  render: (data: Record<string, unknown>) => string[] | FeishuCall | Promise<string[] | FeishuCall>,
  emptyText: string,
): Promise<FeishuCall> {
  const resume = readPageCursor(firstToken, []);
  if (!resume.ok) return invalidPageToken();
  let blocks: string[] = [];
  let replays: (string | null)[] = [];
  let pageToken = resume.cursor.token;
  let skip = resume.cursor.skip;
  let offset = resume.cursor.offset;
  let capped = false;
  let continuation: string | null = null;
  for (let page = 0; page < DOC_READ_PAGE_CAP; page += 1) {
    const requestToken = pageToken;
    const result = await load(pageToken);
    if (result.code !== 0 || result.status === 429 || result.rawText !== undefined) return fromOpen(result, "");
    const rendered = await render(result.data);
    if (!Array.isArray(rendered)) return rendered;
    const pageBlocks = rendered.filter((block) => block.length > 0);
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
      capped = page === DOC_READ_PAGE_CAP - 1;
      if (capped) break;
      continue;
    }
    const decision = fitPage(blocks, replays, window.blocks, window.skip, window.offset, requestToken, nextToken);
    if (decision.invalid) return invalidPageToken();
    const early = renderFit(decision, emptyText);
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
    capped = page === DOC_READ_PAGE_CAP - 1;
    if (capped) break;
  }
  return { kind: "done", text: finishRows(blocks, replays, pageFooter(capped, continuation), "", emptyText), isError: false };
}

async function commentsOpenApi(client: FeishuClient, accessToken: string, args: DocCommentsArgs): Promise<FeishuCall> {
  const resolved = await resolveDoc(args.doc, (url) => feishuOpen(client, "GET", url, accessToken));
  if (!resolved.ok) return unresolvedDoc(resolved);
  const docType = resolved.objType.length > 0 ? resolved.objType : "docx";
  return gatherPages(
    args.page_token,
    (pageToken) => feishuOpen(client, "GET", commentsUrl(resolved.token, docType, pageToken), accessToken),
    (data) => renderCommentPage(client, accessToken, data),
    "no comments",
  );
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function commentUserIds(items: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    const record = recordOf(item);
    const author = stringField(record, "user_id");
    if (author.length > 0) ids.push(author);
    for (const reply of repliesOf(record)) {
      const replyAuthor = stringField(reply, "user_id");
      if (replyAuthor.length > 0) ids.push(replyAuthor);
      for (const element of elementsOf(reply)) {
        const personId = stringField(recordOf(element.person), "user_id");
        if (personId.length > 0) ids.push(personId);
      }
    }
  }
  return ids;
}

async function renderCommentPage(client: FeishuClient, accessToken: string, data: Record<string, unknown>): Promise<string[] | FeishuCall> {
  const items = Array.isArray(data.items) ? data.items : [];
  const lookedUp = await openIdNameLookup(client, accessToken, commentUserIds(items));
  if (lookedUp.tokenInvalid) return { kind: "token_invalid" };
  return items.map((item) => commentBlock(item, lookedUp.names)).filter((block) => block.length > 0);
}

function displayName(names: Map<string, string>, id: string): string {
  return names.get(id) ?? id;
}

function commentBlock(item: unknown, names: Map<string, string>): string {
  const record = recordOf(item);
  const author = stringField(record, "user_id");
  const fields: Array<[string, string]> = [
    ["comment_id", stringField(record, "comment_id")],
    ["type", record.is_whole === true ? "whole" : record.is_whole === false ? "segment" : ""],
    ["quote", stringField(record, "quote")],
    ["solved", record.is_solved === true ? "true" : record.is_solved === false ? "false" : ""],
    ["author", author.length > 0 ? displayName(names, author) : ""],
  ];
  for (const field of replyLines(record, names)) fields.push(field);
  return lines(fields);
}

function repliesOf(record: Record<string, unknown>): Record<string, unknown>[] {
  const replyList = recordOf(record.reply_list);
  const replies = Array.isArray(replyList.replies) ? replyList.replies : [];
  return replies.map((reply) => recordOf(reply));
}

function elementsOf(reply: Record<string, unknown>): Record<string, unknown>[] {
  const content = recordOf(reply.content);
  const elements = Array.isArray(content.elements) ? content.elements : [];
  return elements.map((element) => recordOf(element));
}

function elementText(elementRecord: Record<string, unknown>, names: Map<string, string>): string {
  switch (stringField(elementRecord, "type")) {
    case "person": {
      const id = stringField(recordOf(elementRecord.person), "user_id");
      return id.length > 0 ? `@${displayName(names, id)}` : "";
    }
    case "docs_link":
      return stringField(recordOf(elementRecord.docs_link), "url");
    default: {
      const run = recordOf(elementRecord.text_run);
      const fromRun = stringField(run, "text") || stringField(run, "content");
      if (fromRun.length > 0) return fromRun;
      return stringField(elementRecord, "text");
    }
  }
}

function replyLines(record: Record<string, unknown>, names: Map<string, string>): Array<[string, string]> {
  const fields: Array<[string, string]> = [];
  for (const reply of repliesOf(record)) {
    const text = elementsOf(reply)
      .map((element) => elementText(element, names))
      .join("");
    if (text.length === 0) continue;
    const author = stringField(reply, "user_id");
    if (author.length > 0) fields.push(["reply", `${displayName(names, author)}: ${text}`]);
    else fields.push(["text", text]);
  }
  return fields;
}

export function callSearchDocs(env: Env, openId: string, args: SearchDocsArgs): Promise<CallToolResult> {
  return runTool(env, openId, "search_docs", null, (client, accessToken, backend) =>
    byBackend(
      backend,
      () =>
        callFeishuMcp(client, accessToken, "search-doc", searchMcpArguments(args)),
      () => searchOpenApi(client, accessToken, args),
    ),
  );
}

function sentOffset(offset: number | undefined): number | undefined {
  if (offset === undefined || !Number.isInteger(offset)) return undefined;
  return offset < 0 ? 0 : offset;
}

function sentLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0 || limit > FETCH_DOC_PAGE) return FETCH_DOC_PAGE;
  return limit;
}

function fetchDocArguments(args: FetchDocArgs): Record<string, unknown> {
  const sent: Record<string, unknown> = { doc_id: args.doc, limit: sentLimit(args.limit) };
  const offset = sentOffset(args.offset);
  if (offset !== undefined) sent.offset = offset;
  return sent;
}

function jsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function markdownRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    const parsed = jsonRecord(value);
    return parsed && typeof parsed.markdown === "string" ? parsed : null;
  }
  const record = asRecord(value);
  if (typeof record.markdown === "string") return record;
  if (typeof record.text === "string") return markdownRecord(record.text);
  return null;
}

function payloadFromResult(result: Record<string, unknown>, text: string): Record<string, unknown> | null {
  const fromText = markdownRecord(text);
  if (fromText) return fromText;
  if (!Array.isArray(result.content)) return markdownRecord(result);
  for (const item of result.content) {
    const payload = markdownRecord(item);
    if (payload) return payload;
  }
  return null;
}

function presentFetchDoc(payload: Record<string, unknown>): string {
  const title = typeof payload.title === "string" ? payload.title : "";
  const markdown = payload.markdown;
  if (typeof markdown !== "string") return "";
  const parts: string[] = [];
  if (title.length > 0) parts.push(`title: ${title}`);
  if (markdown.length > 0) parts.push(markdown);
  if (payload.has_more === true) {
    const rows = ["has_more: true"];
    const next = payload.next_offset;
    if (typeof next === "number" && Number.isInteger(next)) rows.push(`next_offset: ${next}`);
    parts.push(rows.join("\n"));
  }
  return parts.join("\n\n");
}

function capOpenContent(content: string): string {
  if (content.length <= OPENAPI_FETCH_CAP) return content;
  const note = `\n\n${OPENAPI_FETCH_NOTE}`;
  const room = Math.max(0, OPENAPI_FETCH_CAP - note.length);
  return `${content.slice(0, room)}${note}`;
}

async function fetchMcp(client: FeishuClient, accessToken: string, args: FetchDocArgs): Promise<FeishuCall> {
  const outcome = await callFeishuMcpResult(client, accessToken, "fetch-doc", fetchDocArguments(args));
  if (outcome.kind !== "done") return outcome;
  if (outcome.isError) return { kind: "done", text: outcome.text, isError: true };
  const payload = payloadFromResult(outcome.result, outcome.text);
  if (!payload) return { kind: "failed" };
  return { kind: "done", text: presentFetchDoc(payload), isError: false };
}

export function callFetchDoc(env: Env, openId: string, args: FetchDocArgs): Promise<CallToolResult> {
  return runTool(env, openId, "fetch_doc", parseDocRef(args.doc).token, async (client, accessToken, backend) => {
    const gated = await gateFetchDoc(client, accessToken, args.doc);
    if ("kind" in gated) return gated;
    return byBackend(
      backend,
      () => fetchMcp(client, accessToken, args),
      () => fetchOpenApi(client, accessToken, gated.token),
    );
  });
}

export function callListWikiDocs(env: Env, openId: string, args: ListWikiDocsArgs): Promise<CallToolResult> {
  const target = args.space_id ?? args.node_token ?? null;
  return runTool(env, openId, "list_wiki_docs", target, (client, accessToken, backend) => {
    const mcpArgs = listMcpArguments(args);
    if (mcpArgs === null) return listOpenApi(client, accessToken, args);
    return byBackend(
      backend,
      () => callFeishuMcp(client, accessToken, "list-docs", mcpArgs),
      () => listOpenApi(client, accessToken, args),
    );
  });
}

export function callGetDocComments(env: Env, openId: string, args: DocCommentsArgs): Promise<CallToolResult> {
  return runTool(env, openId, "get_doc_comments", parseDocRef(args.doc).token, (client, accessToken, backend) =>
    byBackend(
      backend,
      () =>
        callFeishuMcp(client, accessToken, "get-comments", {
          doc_id: args.doc,
          page_token: args.page_token,
        }),
      () => commentsOpenApi(client, accessToken, args),
    ),
  );
}
