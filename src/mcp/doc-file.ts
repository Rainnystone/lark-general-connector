import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { FeishuClient } from "../feishu/client";
import { feishuOpen, parseDocRef, readOpenPayload, resolveDoc, resolvesWikiNode, stringField, type ResolvedDoc } from "../feishu/docs";
import { bytesToStandardBase64, estimatedBase64Bytes, mimeOf, readBoundedBytes, standardBase64ToBytes } from "../feishu/media";
import type { FeishuCall } from "../feishu/mcp-proxy";
import { fromOpen, runTool } from "./proxied-call";
import { OUTPUT_LIMIT } from "./tools";

export const FILE_ACTIONS = ["meta", "download"] as const;
export const WRITE_FILE_ACTIONS = ["upload"] as const;
/** 256 KiB inline cap for read_file download. */
export const FILE_INLINE_MAX = 256 * 1024;
/** 10 MiB decoded cap for write_file upload (single upload_all). */
export const FILE_UPLOAD_MAX = 10 * 1024 * 1024;

const UPLOAD_URL = "https://open.feishu.cn/open-apis/drive/v1/files/upload_all";

export interface ReadFileArgs {
  doc: string;
  action: (typeof FILE_ACTIONS)[number];
}

export interface WriteFileArgs {
  action: (typeof WRITE_FILE_ACTIONS)[number];
  file_name: string;
  content_base64: string;
  folder_token?: string;
}

const TEXT_EXTENSIONS = [".md", ".txt", ".csv", ".json"] as const;

const READ_TOOL: Record<string, string> = {
  docx: "fetch_doc",
  doc: "fetch_doc",
  sheet: "read_sheet",
  bitable: "read_bitable",
  slides: "read_slides",
  file: "read_file",
  mindnote: "read_mindnote",
};

const META_URL = "https://open.feishu.cn/open-apis/drive/v1/metas/batch_query";

function typeMismatch(objType: string): FeishuCall {
  const label = objType.length > 0 ? objType : "unknown";
  const tool = READ_TOOL[label];
  return { kind: "done", text: tool ? `this is a ${label}; use ${tool}` : `this is a ${label}`, isError: true };
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

function filePathToken(doc: string): string | null {
  try {
    const url = new URL(doc.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const parts = url.pathname.split("/").filter((part) => part.length > 0);
    const at = parts.indexOf("file");
    const raw = parts[at + 1];
    if (at < 0 || !raw) return null;
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function downloadUrl(token: string): string {
  return `https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(token)}/download`;
}

function fileNameOf(disposition: string | null): string {
  if (!disposition) return "";
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      return star[1].trim();
    }
  }
  const quoted = /filename\s*=\s*"([^"]*)"/i.exec(disposition);
  if (quoted?.[1]) return quoted[1];
  const plain = /filename\s*=\s*([^;]+)/i.exec(disposition);
  return plain?.[1]?.trim() ?? "";
}

function isTextual(fileName: string, mime: string): boolean {
  if (mime === "application/json" || mime.startsWith("text/")) return true;
  const lower = fileName.toLowerCase();
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function utf8Text(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function downloadPayload(size: number | null, contentType: string, fileName: string, bytes: Uint8Array | null): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (size !== null) payload.size = size;
  if (contentType.length > 0) payload.content_type = contentType;
  if (fileName.length > 0) payload.file_name = fileName;
  if (bytes === null) {
    payload.too_large = true;
    return payload;
  }
  payload.content_base64 = bytesToStandardBase64(bytes);
  if (isTextual(fileName, contentType)) {
    const text = utf8Text(bytes);
    if (text !== null) payload.text = text;
  }
  return payload;
}

function fitDownload(size: number, contentType: string, fileName: string, bytes: Uint8Array): FeishuCall {
  const payload = downloadPayload(size, contentType, fileName, bytes);
  const full = JSON.stringify(payload);
  if (full.length <= OUTPUT_LIMIT) return { kind: "done", text: full, isError: false };
  if (payload.text !== undefined) {
    const stripped = { ...payload };
    delete stripped.text;
    const withoutText = JSON.stringify(stripped);
    if (withoutText.length <= OUTPUT_LIMIT) return { kind: "done", text: withoutText, isError: false };
  }
  return { kind: "done", text: JSON.stringify(downloadPayload(size, contentType, fileName, null)), isError: false };
}

async function resolveFile(client: FeishuClient, accessToken: string, doc: string): Promise<{ token: string } | FeishuCall> {
  const fromPath = filePathToken(doc);
  if (fromPath) return { token: fromPath };
  const resolved = await resolveDoc(doc, (url) => feishuOpen(client, "GET", url, accessToken));
  if (!resolved.ok) return unresolvedDoc(resolved);
  if (resolved.objType === "file") return { token: resolved.token };
  if (!resolved.wikiNode && resolvesWikiNode(doc)) return { token: resolved.token };
  return typeMismatch(resolved.objType);
}

async function downloadFile(client: FeishuClient, accessToken: string, token: string): Promise<FeishuCall> {
  const response = await client.request("GET", downloadUrl(token), { headers: { authorization: `Bearer ${accessToken}` } });
  if (response.status === 429) {
    await response.body?.cancel();
    return { kind: "rate_limit" };
  }
  if (response.status < 200 || response.status >= 300) {
    const payload = await readOpenPayload(response);
    const code = payload.code !== 0 ? payload.code : response.status || 1;
    return fromOpen({ ...payload, code }, "");
  }
  const mimeType = mimeOf(response.headers.get("content-type"));
  const fileName = fileNameOf(response.headers.get("content-disposition"));
  const read = await readBoundedBytes(response, FILE_INLINE_MAX);
  if (read.overflow) return { kind: "done", text: JSON.stringify(downloadPayload(read.size, mimeType, fileName, null)), isError: false };
  return fitDownload(read.size ?? read.bytes.byteLength, mimeType, fileName, read.bytes);
}

async function readFile(client: FeishuClient, accessToken: string, args: ReadFileArgs): Promise<{ target: string | null; call: FeishuCall }> {
  const resolved = await resolveFile(client, accessToken, args.doc);
  if ("kind" in resolved) return { target: parseDocRef(args.doc).token, call: resolved };
  const token = resolved.token;
  switch (args.action) {
    case "meta": {
      const result = await feishuOpen(
        client,
        "POST",
        META_URL,
        accessToken,
        JSON.stringify({ request_docs: [{ doc_token: token, doc_type: "file" }], with_url: true }),
      );
      return { target: token, call: fromOpen(result, JSON.stringify(result.data)) };
    }
    case "download":
      return { target: token, call: await downloadFile(client, accessToken, token) };
    default: {
      const unexpected: never = args.action;
      return { target: token, call: unexpected };
    }
  }
}

export function callReadFile(env: Env, openId: string, args: ReadFileArgs): Promise<CallToolResult> {
  let target: string | null = parseDocRef(args.doc).token;
  return runTool(env, openId, "read_file", () => target, async (client, accessToken) => {
    const outcome = await readFile(client, accessToken, args);
    target = outcome.target;
    return outcome.call;
  });
}

async function uploadFile(client: FeishuClient, accessToken: string, args: WriteFileArgs): Promise<{ target: string | null; call: FeishuCall }> {
  const fileName = args.file_name.trim();
  if (fileName.length === 0) return { target: null, call: { kind: "done", text: "file_name is required", isError: true } };
  if (estimatedBase64Bytes(args.content_base64) > FILE_UPLOAD_MAX) {
    return { target: null, call: { kind: "done", text: "file exceeds 10 MiB", isError: true } };
  }
  const bytes = standardBase64ToBytes(args.content_base64);
  if (bytes === null) return { target: null, call: { kind: "done", text: "content_base64 is invalid", isError: true } };
  if (bytes.byteLength > FILE_UPLOAD_MAX) {
    return { target: null, call: { kind: "done", text: "file exceeds 10 MiB", isError: true } };
  }
  const form = new FormData();
  form.set("file_name", fileName);
  form.set("parent_type", "explorer");
  form.set("parent_node", args.folder_token?.trim() ?? "");
  form.set("size", String(bytes.byteLength));
  form.set("file", new Blob([bytes]), fileName);
  const response = await client.request("POST", UPLOAD_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
    body: form,
  });
  const result = await readOpenPayload(response);
  const token = stringField(result.data, "file_token");
  return { target: token.length > 0 ? token : null, call: fromOpen(result, JSON.stringify(result.data)) };
}

async function writeFile(client: FeishuClient, accessToken: string, args: WriteFileArgs): Promise<{ target: string | null; call: FeishuCall }> {
  switch (args.action) {
    case "upload":
      return uploadFile(client, accessToken, args);
    default: {
      const unexpected: never = args.action;
      return { target: null, call: unexpected };
    }
  }
}

export function callWriteFile(env: Env, openId: string, args: WriteFileArgs): Promise<CallToolResult> {
  let target: string | null = null;
  return runTool(env, openId, "write_file", () => target, async (client, accessToken) => {
    const outcome = await writeFile(client, accessToken, args);
    target = outcome.target;
    return outcome.call;
  });
}
