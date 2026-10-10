import type { CallToolResult } from "@modelcontextprotocol/server";
import { audit } from "../audit";
import type { Env } from "../env";
import { FeishuClient } from "../feishu/client";
import { feishuOpen, stringField, wikiNodeUrl, type OpenPayload } from "../feishu/docs";
import type { FeishuCall } from "../feishu/mcp-proxy";
import { asRecord } from "../feishu/payload";
import { fromOpen, runTool } from "./proxied-call";
import { textResult, TOKEN_INVALID } from "./tools";

const WIKI_NOT_IN_SPACE = 131005;
const NOT_OWNED_CODE = 1061004;
const BUSY_CODE = 1061045;
const MOVED_TO_RECYCLE_BIN = "Moved to 云空间 回收站. It can be restored there.";
const WIKI_REFUSED = "This doc lives in a wiki space; not deletable here.";
const ONLY_TYPES = "only Feishu docs (docx, sheet, bitable, slides, file) can be deleted by this connector";
const NOT_OWNED = "This doc is not owned by you or lives in a wiki space.";
const BUSY = "try again in a moment";
const META_URL = "https://open.feishu.cn/open-apis/drive/v1/metas/batch_query";

const PATH_KIND = {
  docx: "docx",
  sheets: "sheet",
  base: "bitable",
  slides: "slides",
  file: "file",
} as const;

export interface DeleteDocArgs {
  doc: string;
  confirm_title: string;
}

type DeletableKind = (typeof PATH_KIND)[keyof typeof PATH_KIND];
type DeleteTarget = { kind: DeletableKind; token: string } | { kind: "wiki"; token: string | null } | { kind: "refused"; token: string | null };

function decodedPart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parseDeleteTarget(doc: string): DeleteTarget {
  const trimmed = doc.trim();
  let url: URL | null = null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") url = parsed;
  } catch {
    url = null;
  }
  if (!url) {
    if (trimmed.length === 0) return { kind: "refused", token: null };
    if (/^wik/i.test(trimmed)) return { kind: "wiki", token: trimmed };
    return { kind: "docx", token: trimmed };
  }
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  const wikiAt = parts.indexOf("wiki");
  if (wikiAt >= 0) {
    const raw = parts[wikiAt + 1];
    if (!raw) return { kind: "wiki", token: null };
    const token = decodedPart(raw);
    if (token === null) return { kind: "refused", token: null };
    return { kind: "wiki", token };
  }
  for (const segment of Object.keys(PATH_KIND) as Array<keyof typeof PATH_KIND>) {
    const at = parts.indexOf(segment);
    const raw = parts[at + 1];
    if (at < 0 || !raw) continue;
    const token = decodedPart(raw);
    if (token === null) return { kind: "refused", token: null };
    if (/^wik/i.test(token)) return { kind: "wiki", token };
    return { kind: PATH_KIND[segment], token };
  }
  const last = parts[parts.length - 1];
  if (!last) return { kind: "refused", token: null };
  const token = decodedPart(last);
  if (token === null) return { kind: "refused", token: null };
  return { kind: "refused", token };
}

function refuseEarly(target: string | null, code: string, text: string, started: number): CallToolResult {
  audit({ event: "tool_call", tool: "delete_doc", target, ok: false, code, ms: Date.now() - started });
  return textResult(text, true);
}

function wikiCheckUrl(token: string, objType: DeletableKind): string {
  const url = new URL("https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node");
  url.searchParams.set("token", token);
  url.searchParams.set("obj_type", objType);
  return url.toString();
}

function documentUrl(token: string): string {
  return `https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(token)}`;
}

function deleteUrl(token: string, type: DeletableKind): string {
  const url = new URL(`https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(token)}`);
  url.searchParams.set("type", type);
  return url.toString();
}

function confirmedTitle(value: string): string {
  return value.normalize("NFC").trim();
}

function transportBlock(result: OpenPayload): FeishuCall | null {
  if (TOKEN_INVALID.has(result.code)) return { kind: "token_invalid" };
  if (result.status === 429) return fromOpen(result, "");
  return null;
}

function explicitSuccess(result: OpenPayload): boolean {
  return result.parsed === true && result.rawText === undefined && result.code === 0 && result.status >= 200 && result.status < 300;
}

function liveTitle(data: Record<string, unknown>): string {
  return stringField(asRecord(data.document), "title");
}

function metaTitle(data: Record<string, unknown>, token: string): string | null {
  const metas = data.metas;
  if (!Array.isArray(metas)) return null;
  const match = metas.find((item) => stringField(asRecord(item), "doc_token") === token);
  if (match === undefined) return null;
  return stringField(asRecord(match), "title");
}

function titleFrom(kind: DeletableKind, data: Record<string, unknown>, token: string): string | null {
  switch (kind) {
    case "docx":
      return liveTitle(data);
    case "sheet":
    case "bitable":
    case "slides":
    case "file":
      return metaTitle(data, token);
    default: {
      const unexpected: never = kind;
      return unexpected;
    }
  }
}

function wikiCheckFailure(node: OpenPayload): FeishuCall {
  let code = node.parsed === true ? node.code : node.status;
  if (node.status === 429 && code === 0) code = node.status;
  return { kind: "done", text: `Wiki check failed (${code}).`, isError: true, code: String(code) };
}

type WikiGuard = { blocked: true; call: FeishuCall } | { blocked: false };

async function guardWiki(client: FeishuClient, accessToken: string, url: string): Promise<WikiGuard> {
  const node = await feishuOpen(client, "GET", url, accessToken);
  if (TOKEN_INVALID.has(node.code)) return { blocked: true, call: { kind: "token_invalid" } };
  if (node.status === 429 || node.parsed !== true) return { blocked: true, call: wikiCheckFailure(node) };
  if (node.code === 0) return { blocked: true, call: { kind: "done", text: WIKI_REFUSED, isError: true, code: "wiki" } };
  if (node.code !== WIKI_NOT_IN_SPACE) return { blocked: true, call: wikiCheckFailure(node) };
  return { blocked: false };
}

async function loadTitle(client: FeishuClient, accessToken: string, token: string, kind: DeletableKind): Promise<OpenPayload> {
  switch (kind) {
    case "docx":
      return feishuOpen(client, "GET", documentUrl(token), accessToken);
    case "sheet":
    case "bitable":
    case "slides":
    case "file":
      return feishuOpen(
        client,
        "POST",
        META_URL,
        accessToken,
        JSON.stringify({ request_docs: [{ doc_token: token, doc_type: kind }], with_url: true }),
      );
    default: {
      const unexpected: never = kind;
      return unexpected;
    }
  }
}

function titleFailure(kind: DeletableKind, loaded: OpenPayload): FeishuCall {
  if (kind !== "docx" && loaded.parsed === true && loaded.code !== 0) return fromOpen(loaded, "");
  const code = loaded.parsed === true ? loaded.code : loaded.status;
  return { kind: "done", text: "Document not found or no access.", isError: true, code: String(code) };
}

async function deleteCloudDoc(
  client: FeishuClient,
  accessToken: string,
  token: string,
  kind: DeletableKind,
  confirmTitle: string,
): Promise<FeishuCall> {
  // Node tokens match only when obj_type is omitted. obj_type=docx returns 131005 for them.
  const nodeToken = await guardWiki(client, accessToken, wikiNodeUrl(token));
  if (nodeToken.blocked) return nodeToken.call;
  const objToken = await guardWiki(client, accessToken, wikiCheckUrl(token, kind));
  if (objToken.blocked) return objToken.call;
  const loaded = await loadTitle(client, accessToken, token, kind);
  const loadedBlock = transportBlock(loaded);
  if (loadedBlock) return loadedBlock;
  const rawTitle = loaded.parsed === true && loaded.code === 0 ? titleFrom(kind, loaded.data, token) : null;
  if (loaded.parsed !== true || loaded.code !== 0 || rawTitle === null) return titleFailure(kind, loaded);
  const title = confirmedTitle(rawTitle);
  if (title.length === 0 || title !== confirmedTitle(confirmTitle)) {
    return { kind: "done", text: "Title does not match. Delete refused.", isError: true, code: "title_mismatch" };
  }
  const deleted = await feishuOpen(client, "DELETE", deleteUrl(token, kind), accessToken);
  const deletedBlock = transportBlock(deleted);
  if (deletedBlock) return deletedBlock;
  if (deleted.parsed === true && deleted.code === NOT_OWNED_CODE) return { kind: "done", text: NOT_OWNED, isError: true, code: String(NOT_OWNED_CODE) };
  if (deleted.parsed === true && deleted.code === BUSY_CODE) return { kind: "done", text: BUSY, isError: true, code: String(BUSY_CODE) };
  if (explicitSuccess(deleted)) return { kind: "done", text: MOVED_TO_RECYCLE_BIN, isError: false };
  if (deleted.parsed === true && deleted.code !== 0) return fromOpen(deleted, "");
  return { kind: "done", text: `Delete failed (${deleted.status}).`, isError: true, code: String(deleted.status) };
}

export function callDeleteDoc(env: Env, openId: string, args: DeleteDocArgs): Promise<CallToolResult> {
  const started = Date.now();
  const target = parseDeleteTarget(args.doc);
  switch (target.kind) {
    case "wiki":
      return Promise.resolve(refuseEarly(target.token, "wiki", WIKI_REFUSED, started));
    case "refused":
      return Promise.resolve(refuseEarly(target.token, "only_docx", ONLY_TYPES, started));
    case "docx":
    case "sheet":
    case "bitable":
    case "slides":
    case "file":
      return runTool(env, openId, "delete_doc", target.token, (client, accessToken) =>
        deleteCloudDoc(client, accessToken, target.token, target.kind, args.confirm_title),
      );
    default: {
      const unexpected: never = target;
      return Promise.resolve(refuseEarly(null, String(unexpected), "Feishu request failed", started));
    }
  }
}
