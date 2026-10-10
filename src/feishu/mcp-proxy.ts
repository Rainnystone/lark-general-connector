import { FeishuClient } from "./client";
import { MEDIA_BYTE_CAP, MCP_MEDIA_CHAR_LIMIT, estimatedBase64Bytes, imageMetadata } from "./media";
import { asRecord, readBoundedJson } from "./payload";

export const FEISHU_MCP_URL = "https://mcp.feishu.cn/mcp";

export interface McpImage {
  data: string;
  mimeType: string;
}

export type FeishuCall =
  | { kind: "done"; text: string; isError: boolean; image?: McpImage; code?: string }
  | { kind: "token_invalid" }
  | { kind: "rate_limit" }
  | { kind: "internal" }
  | { kind: "failed" };

export function presentArgs(args: Record<string, unknown>): Record<string, unknown> {
  const present: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) present[key] = value;
  }
  return present;
}

function postFeishuMcp(client: FeishuClient, accessToken: string, tool: string, args: Record<string, unknown>): Promise<Response> {
  return client.request("POST", FEISHU_MCP_URL, {
    headers: {
      "content-type": "application/json",
      "x-lark-mcp-uat": accessToken,
      "x-lark-mcp-allowed-tools": tool,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: presentArgs(args) },
    }),
  });
}

function contentText(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const parts: string[] = [];
  for (const item of content) {
    const text = asRecord(item).text;
    if (typeof text === "string" && text.length > 0) parts.push(text);
  }
  return parts.join("\n");
}

function rpcFailure(status: number, code: number | null): Exclude<FeishuCall, { kind: "done" }> | null {
  if (status === 429 || code === -32030) return { kind: "rate_limit" };
  if (code === -32003) return { kind: "token_invalid" };
  if (code === -32011) return { kind: "internal" };
  if (code !== null || status < 200 || status >= 300) return { kind: "failed" };
  return null;
}

function errorCodeOf(payload: Record<string, unknown>): number | null {
  const errorCode = asRecord(payload.error).code;
  return typeof errorCode === "number" ? errorCode : null;
}

export type McpToolResult =
  | { kind: "done"; result: Record<string, unknown>; text: string; isError: boolean }
  | { kind: "token_invalid" }
  | { kind: "rate_limit" }
  | { kind: "internal" }
  | { kind: "failed" };

export async function callFeishuMcpResult(client: FeishuClient, accessToken: string, tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const response = await postFeishuMcp(client, accessToken, tool, args);
  const bodyRead = await readBoundedJson(response);
  const payload = bodyRead.parsed ? asRecord(bodyRead.value) : {};
  const failure = rpcFailure(response.status, errorCodeOf(payload));
  if (failure) return failure;
  if (bodyRead.truncated || !bodyRead.parsed) return { kind: "failed" };
  const result = asRecord(payload.result);
  return { kind: "done", result, text: contentText(result), isError: result.isError === true };
}

export async function callFeishuMcp(client: FeishuClient, accessToken: string, tool: string, args: Record<string, unknown>): Promise<FeishuCall> {
  const outcome = await callFeishuMcpResult(client, accessToken, tool, args);
  if (outcome.kind !== "done") return outcome;
  return { kind: "done", text: outcome.text, isError: outcome.isError };
}

function mimeFromPartial(partial: string): string {
  return /"mimeType"\s*:\s*"([^"]+)"/.exec(partial)?.[1] ?? "";
}

function partialIsImage(partial: string): boolean {
  return /"type"\s*:\s*"image"/.test(partial);
}

function partialIsText(partial: string): boolean {
  const type = /"type"\s*:\s*"([^"]+)"/.exec(partial)?.[1];
  return type === "text" || (type !== "image" && partial.includes('"text"'));
}

function classifyMediaResult(result: Record<string, unknown>): FeishuCall {
  const content = Array.isArray(result.content) ? result.content : [];
  const parts: string[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (block.type === "image" && typeof block.data === "string") {
      const mimeType = typeof block.mimeType === "string" ? block.mimeType : "";
      const size = estimatedBase64Bytes(block.data);
      if (size > MEDIA_BYTE_CAP) return { kind: "done", text: imageMetadata(mimeType, size), isError: false };
      return { kind: "done", text: "", isError: result.isError === true, image: { data: block.data, mimeType: mimeType || "application/octet-stream" } };
    }
    if (typeof block.text === "string" && block.text.length > 0) parts.push(block.text);
  }
  return { kind: "done", text: parts.join("\n"), isError: result.isError === true };
}

function classifyUnparsedMedia(partial: string): FeishuCall {
  if (partialIsText(partial)) return { kind: "done", text: partial, isError: false };
  return { kind: "done", text: imageMetadata(mimeFromPartial(partial), null), isError: false };
}

export async function callFetchFileMcp(client: FeishuClient, accessToken: string, args: Record<string, unknown>): Promise<FeishuCall> {
  const response = await postFeishuMcp(client, accessToken, "fetch-file", args);
  if (response.status === 429) {
    await response.body?.cancel();
    return { kind: "rate_limit" };
  }
  const bodyRead = await readBoundedJson(response, MCP_MEDIA_CHAR_LIMIT);
  const payload = bodyRead.parsed ? asRecord(bodyRead.value) : {};
  const failure = rpcFailure(response.status, errorCodeOf(payload));
  if (failure && bodyRead.parsed) return failure;
  if (bodyRead.truncated) {
    const partial = typeof bodyRead.value === "string" ? bodyRead.value : "";
    if (!bodyRead.parsed && partialIsImage(partial)) return { kind: "done", text: imageMetadata(mimeFromPartial(partial), null), isError: false };
    return { kind: "failed" };
  }
  if (!bodyRead.parsed) {
    if (failure) return failure;
    return classifyUnparsedMedia(typeof bodyRead.value === "string" ? bodyRead.value : "");
  }
  return classifyMediaResult(asRecord(payload.result));
}
