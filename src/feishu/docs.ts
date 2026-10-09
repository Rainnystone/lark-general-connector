import { FeishuClient } from "./client";
import { asRecord, readBoundedJson } from "./payload";

export const DOC_WIKI_SEARCH_URL = "https://open.feishu.cn/open-apis/search/v2/doc_wiki/search";
export const CREATE_DOCUMENT_URL = "https://open.feishu.cn/open-apis/docx/v1/documents";
export const PARAGRAPH_BATCH = 50;

export interface OpenPayload {
  status: number;
  code: number;
  /** Feishu `msg` when the business code is non-zero. Empty when there is nothing safe to show. */
  msg: string;
  /** True when Feishu sent a non-zero numeric `code`, even if `msg` is empty. */
  feishuError?: boolean;
  data: Record<string, unknown>;
  rawText?: string;
  /** False when the body was not JSON, or was cut off before it could be parsed. */
  parsed?: boolean;
}

function leadingBusinessCode(text: string): number | null {
  const match = /^\s*\{\s*"code"\s*:\s*(-?\d+)/.exec(text);
  if (!match?.[1]) return null;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) ? code : null;
}

function errorCode(status: number, businessCode: number | null): number {
  if (businessCode !== null && businessCode !== 0) return businessCode;
  return status > 0 ? status : 1;
}

function businessMsg(payload: Record<string, unknown>, businessCode: number | null): string {
  if (businessCode === null || businessCode === 0) return "";
  const msg = payload.msg;
  return typeof msg === "string" ? msg : "";
}

function isFeishuError(businessCode: number | null): boolean {
  return businessCode !== null && businessCode !== 0;
}

export async function readOpenPayload(response: Response): Promise<OpenPayload> {
  const bodyRead = await readBoundedJson(response);
  if (bodyRead.truncated) {
    const text = typeof bodyRead.value === "string" ? bodyRead.value : "";
    const parsedCode = asRecord(bodyRead.value).code;
    const businessCode = typeof parsedCode === "number" ? parsedCode : leadingBusinessCode(text);
    return { status: response.status, code: errorCode(response.status, businessCode), msg: "", feishuError: isFeishuError(businessCode), data: {}, parsed: false };
  }
  if (!bodyRead.parsed) {
    return { status: response.status, code: errorCode(response.status, null), msg: "", data: {}, parsed: false };
  }
  const payload = asRecord(bodyRead.value);
  const businessCode = typeof payload.code === "number" ? payload.code : null;
  const code = businessCode ?? response.status;
  return {
    status: response.status,
    code,
    msg: businessMsg(payload, businessCode),
    feishuError: isFeishuError(businessCode),
    data: asRecord(payload.data),
    parsed: true,
  };
}

export async function feishuOpen(client: FeishuClient, method: string, url: string, accessToken: string, body?: string): Promise<OpenPayload> {
  const response = await client.request(method, url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body,
  });
  return readOpenPayload(response);
}

export interface DocRef {
  kind: "wiki" | "token";
  token: string;
}

export function parseDocRef(doc: string): DocRef {
  const trimmed = doc.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "token", token: trimmed };
    const parts = url.pathname.split("/").filter((part) => part.length > 0);
    const wikiAt = parts.indexOf("wiki");
    const wikiToken = parts[wikiAt + 1];
    if (wikiAt >= 0 && wikiToken) return { kind: "wiki", token: decodeURIComponent(wikiToken) };
    const docAt = parts.findIndex((part) => part === "docx" || part === "docs" || part === "doc");
    const docToken = parts[docAt + 1];
    if (docAt >= 0 && docToken) return { kind: "token", token: decodeURIComponent(docToken) };
  } catch {
    return { kind: "token", token: trimmed };
  }
  return { kind: "token", token: trimmed };
}

export function wikiNodeUrl(token: string): string {
  const url = new URL("https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node");
  url.searchParams.set("token", token);
  return url.toString();
}

/** get_node without obj_type returns this when the token is not a wiki node. */
export const WIKI_NODE_MISSING = 131005;

export type ResolvedDoc =
  | { ok: true; token: string; objType: string }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "open"; payload: OpenPayload };

function isHttpUrl(doc: string): boolean {
  try {
    const url = new URL(doc.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Wiki URLs and bare tokens need get_node. A doc URL keeps its path token. */
export function resolvesWikiNode(doc: string): boolean {
  if (parseDocRef(doc).kind === "wiki") return true;
  return !isHttpUrl(doc);
}

/**
 * A doc URL uses the path token as docx. A wiki URL and a bare token go
 * through get_node with no obj_type. Code 0 uses the node's obj_token and
 * obj_type. A bare token that is not a wiki node (131005) is a drive docx.
 * A wiki URL that misses stays an error.
 */
export async function resolveDoc(doc: string, loadNode: (url: string) => Promise<OpenPayload>): Promise<ResolvedDoc> {
  const ref = parseDocRef(doc);
  if (!resolvesWikiNode(doc)) return { ok: true, token: ref.token, objType: "docx" };
  const node = await loadNode(wikiNodeUrl(ref.token));
  if (node.status === 429 || node.parsed === false) return { ok: false, reason: "open", payload: node };
  if (ref.kind === "token" && node.code === WIKI_NODE_MISSING) return { ok: true, token: ref.token, objType: "docx" };
  if (node.code !== 0) return { ok: false, reason: "open", payload: node };
  const fields = wikiNodeFields(node.data);
  if (fields.objToken.length === 0) return { ok: false, reason: "empty" };
  return { ok: true, token: fields.objToken, objType: fields.objType };
}

export function wikiNodeFields(data: Record<string, unknown>): { objToken: string; objType: string; spaceId: string } {
  const node = typeof data.node === "object" && data.node !== null ? (data.node as Record<string, unknown>) : {};
  return {
    objToken: stringField(node, "obj_token"),
    objType: stringField(node, "obj_type"),
    spaceId: stringField(node, "space_id"),
  };
}

export function rawContentUrl(documentId: string): string {
  return `https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`;
}

export function wikiNodesUrl(spaceId: string, pageToken: string | undefined, parentNodeToken: string | undefined): string {
  const url = new URL(`https://open.feishu.cn/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`);
  url.searchParams.set("page_size", "50");
  if (pageToken) url.searchParams.set("page_token", pageToken);
  if (parentNodeToken) url.searchParams.set("parent_node_token", parentNodeToken);
  return url.toString();
}

export function fileCommentsUrl(docToken: string): URL {
  return new URL(`https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(docToken)}/comments`);
}

export function commentsUrl(docToken: string, docType: string, pageToken: string | undefined): string {
  const url = fileCommentsUrl(docToken);
  url.searchParams.set("file_type", docType);
  url.searchParams.set("page_size", "50");
  if (pageToken) url.searchParams.set("page_token", pageToken);
  return url.toString();
}

export function plainParagraphs(content: string): string[] {
  return content
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .filter((line) => line.length > 0);
}

export function textBlock(content: string): Record<string, unknown> {
  return {
    block_type: 2,
    text: {
      elements: [{ text_run: { content } }],
      style: {},
    },
  };
}

export function blockChildrenUrl(documentId: string): string {
  const id = encodeURIComponent(documentId);
  return `https://open.feishu.cn/open-apis/docx/v1/documents/${id}/blocks/${id}/children`;
}

export function commentCreateUrl(docToken: string, docType: string): string {
  const url = fileCommentsUrl(docToken);
  url.searchParams.set("file_type", docType);
  return url.toString();
}

export function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}
