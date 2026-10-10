import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { FeishuClient, OUTBOUND_LIMIT } from "../feishu/client";
import {
  blockChildrenUrl,
  commentCreateUrl,
  CREATE_DOCUMENT_URL,
  feishuOpen,
  type OpenPayload,
  PARAGRAPH_BATCH,
  parseDocRef,
  plainParagraphs,
  resolveDoc,
  resolvesWikiNode,
  type ResolvedDoc,
  stringField,
  textBlock,
} from "../feishu/docs";
import { callFeishuMcp, type FeishuCall } from "../feishu/mcp-proxy";
import { asRecord } from "../feishu/payload";
import { byBackend, fromOpen, runTool } from "./proxied-call";
import { TOKEN_INVALID } from "./tools";

export const UPDATE_DOC_MODES = ["append", "overwrite", "replace_range", "replace_all", "insert_before", "insert_after", "delete_range"] as const;

export type UpdateDocMode = (typeof UPDATE_DOC_MODES)[number];

export interface CreateDocArgs {
  title: string;
  content_markdown: string;
  wiki_node_token?: string;
  folder_token?: string;
}

export interface UpdateDocArgs {
  doc: string;
  mode: UpdateDocMode;
  content_markdown: string;
  selection_with_ellipsis?: string;
  selection_by_title?: string;
  new_title?: string;
}

export interface AddDocCommentArgs {
  doc: string;
  text: string;
}

const OPENAPI_UPDATE_UNSUPPORTED = "not supported on openapi backend; switch `update_doc` back to mcp";
const OPENAPI_CREATE_WIKI = "not supported on openapi backend; switch `create_doc` back to mcp";
const TOO_LONG = "too long, split it";

// One slot stays free for the single token retry on this client, and one for the
// token-store read, so a full write still finishes inside the 40-call budget.
const WRITE_CALL_LIMIT = OUTBOUND_LIMIT - 2;

interface OpenSession {
  client: FeishuClient;
  token: { value: string };
  renew: () => Promise<string>;
}

function session(client: FeishuClient, accessToken: string, renew: () => Promise<string>): OpenSession {
  return { client, token: { value: accessToken }, renew };
}

async function callOpen(open: OpenSession, method: string, url: string, body?: string): Promise<OpenPayload> {
  let result = await feishuOpen(open.client, method, url, open.token.value, body);
  if (!TOKEN_INVALID.has(result.code)) return result;
  open.token.value = await open.renew();
  result = await feishuOpen(open.client, method, url, open.token.value, body);
  if (!TOKEN_INVALID.has(result.code)) return result;
  return { status: result.status, code: result.status === 429 ? result.code : 1, msg: "", data: {} };
}

function openFailure(result: OpenPayload): FeishuCall | null {
  if (result.code !== 0 || result.status === 429 || result.rawText !== undefined) return fromOpen(result, "");
  return null;
}

function plannedWrites(paragraphCount: number, overhead: number): number {
  if (paragraphCount === 0) return overhead;
  return overhead + Math.ceil(paragraphCount / PARAGRAPH_BATCH);
}

function createdToken(text: string): string | null {
  try {
    const record = asRecord(JSON.parse(text) as unknown);
    const candidate = record.doc_id ?? record.document_id;
    return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
  } catch {
    return null;
  }
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

async function resolveCloudDoc(open: OpenSession, doc: string): Promise<{ documentId: string; objType: string } | FeishuCall> {
  const resolved = await resolveDoc(doc, (url) => callOpen(open, "GET", url));
  if (!resolved.ok) return unresolvedDoc(resolved);
  return { documentId: resolved.token, objType: resolved.objType };
}

function notDocx(objType: string, action: "updated" | "commented on"): FeishuCall | null {
  if (objType === "docx") return null;
  const label = objType.length > 0 ? objType : "unknown";
  return { kind: "done", text: `only docx can be ${action} here (this is a ${label})`, isError: true };
}

function isFeishuCall(value: { documentId: string } | FeishuCall): value is FeishuCall {
  return "kind" in value;
}

async function appendParagraphs(open: OpenSession, documentId: string, paragraphs: string[]): Promise<FeishuCall | null> {
  for (let index = 0; index < paragraphs.length; index += PARAGRAPH_BATCH) {
    const children = paragraphs.slice(index, index + PARAGRAPH_BATCH).map((paragraph) => textBlock(paragraph));
    const written = await callOpen(open, "POST", blockChildrenUrl(documentId), JSON.stringify({ index: -1, children }));
    const writeFailed = openFailure(written);
    if (writeFailed) return writeFailed;
  }
  return null;
}

async function createOpenApi(open: OpenSession, args: CreateDocArgs, remember: (documentId: string) => void): Promise<FeishuCall> {
  if (args.wiki_node_token) return { kind: "done", text: OPENAPI_CREATE_WIKI, isError: true };
  const paragraphs = plainParagraphs(args.content_markdown);
  if (plannedWrites(paragraphs.length, 1) > WRITE_CALL_LIMIT) return { kind: "done", text: TOO_LONG, isError: true };
  const body: Record<string, string> = { title: args.title };
  if (args.folder_token) body.folder_token = args.folder_token;
  const created = await callOpen(open, "POST", CREATE_DOCUMENT_URL, JSON.stringify(body));
  const failed = openFailure(created);
  if (failed) return failed;
  const documentId = stringField(asRecord(created.data.document), "document_id");
  if (documentId.length === 0) return { kind: "done", text: "Feishu request failed", isError: true };
  remember(documentId);
  const writeFailed = await appendParagraphs(open, documentId, paragraphs);
  if (writeFailed) return writeFailed;
  return { kind: "done", text: `token: ${documentId}`, isError: false };
}

async function updateOpenApi(open: OpenSession, args: UpdateDocArgs, remember: (documentId: string) => void): Promise<FeishuCall> {
  if (args.mode !== "append") return { kind: "done", text: OPENAPI_UPDATE_UNSUPPORTED, isError: true };
  const paragraphs = plainParagraphs(args.content_markdown);
  const overhead = resolvesWikiNode(args.doc) ? 1 : 0;
  if (plannedWrites(paragraphs.length, overhead) > WRITE_CALL_LIMIT) return { kind: "done", text: TOO_LONG, isError: true };
  const resolved = await resolveCloudDoc(open, args.doc);
  if (isFeishuCall(resolved)) return resolved;
  remember(resolved.documentId);
  const refused = notDocx(resolved.objType, "updated");
  if (refused) return refused;
  const writeFailed = await appendParagraphs(open, resolved.documentId, paragraphs);
  if (writeFailed) return writeFailed;
  return { kind: "done", text: `token: ${resolved.documentId}`, isError: false };
}

function commentBody(text: string): string {
  return JSON.stringify({
    reply_list: {
      replies: [{ content: { elements: [{ type: "text_run", text_run: { text } }] } }],
    },
  });
}

async function commentOpenApi(open: OpenSession, args: AddDocCommentArgs, remember: (documentId: string) => void): Promise<FeishuCall> {
  const resolved = await resolveCloudDoc(open, args.doc);
  if (isFeishuCall(resolved)) return resolved;
  remember(resolved.documentId);
  const refused = notDocx(resolved.objType, "commented on");
  if (refused) return refused;
  const created = await callOpen(open, "POST", commentCreateUrl(resolved.documentId, "docx"), commentBody(args.text));
  const failed = openFailure(created);
  if (failed) return failed;
  const commentId = stringField(created.data, "comment_id");
  return { kind: "done", text: commentId.length > 0 ? `comment_id: ${commentId}` : "comment posted", isError: false };
}

export function callCreateDoc(env: Env, openId: string, args: CreateDocArgs): Promise<CallToolResult> {
  let created: string | null = null;
  return runTool(env, openId, "create_doc", () => created, (client, accessToken, backend, renew) =>
    byBackend(
      backend,
      async () => {
        const outcome = await callFeishuMcp(client, accessToken, "create-doc", {
          title: args.title,
          markdown: args.content_markdown,
          folder_token: args.folder_token,
          wiki_node: args.wiki_node_token,
        });
        if (outcome.kind === "done" && !outcome.isError) created = createdToken(outcome.text);
        return outcome;
      },
      () => createOpenApi(session(client, accessToken, renew), args, (documentId) => {
        created = documentId;
      }),
    ),
  );
}

export function callUpdateDoc(env: Env, openId: string, args: UpdateDocArgs): Promise<CallToolResult> {
  let target = parseDocRef(args.doc).token;
  return runTool(env, openId, "update_doc", () => target, (client, accessToken, backend, renew) =>
    byBackend(
      backend,
      () =>
        callFeishuMcp(client, accessToken, "update-doc", {
          doc_id: args.doc,
          mode: args.mode,
          markdown: args.content_markdown,
          selection_with_ellipsis: args.selection_with_ellipsis,
          selection_by_title: args.selection_by_title,
          new_title: args.new_title,
        }),
      () => updateOpenApi(session(client, accessToken, renew), args, (documentId) => {
        target = documentId;
      }),
    ),
  );
}

export function callAddDocComment(env: Env, openId: string, args: AddDocCommentArgs): Promise<CallToolResult> {
  let target = parseDocRef(args.doc).token;
  return runTool(env, openId, "add_doc_comment", () => target, (client, accessToken, backend, renew) =>
    byBackend(
      backend,
      () =>
        callFeishuMcp(client, accessToken, "add-comments", {
          doc_id: args.doc,
          elements: [{ type: "text", text: args.text }],
        }),
      () => commentOpenApi(session(client, accessToken, renew), args, (documentId) => {
        target = documentId;
      }),
    ),
  );
}
