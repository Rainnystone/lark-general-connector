import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { FeishuClient } from "../feishu/client";
import { feishuOpen, parseDocRef, resolveDoc, resolvesWikiNode, stringField, type ResolvedDoc } from "../feishu/docs";
import type { FeishuCall } from "../feishu/mcp-proxy";
import { asRecord } from "../feishu/payload";
import { fromOpen, runTool } from "./proxied-call";

export const SHEET_ACTIONS = ["meta", "values"] as const;
export const WRITE_SHEET_ACTIONS = ["create", "put", "append", "batch_update"] as const;
export const VALUE_RENDER_OPTIONS = ["ToString", "FormattedValue", "Formula", "UnformattedValue"] as const;
export const INSERT_DATA_OPTIONS = ["INSERT_ROWS", "OVERWRITE"] as const;

const CREATE_SHEET_URL = "https://open.feishu.cn/open-apis/sheets/v3/spreadsheets";

export interface ReadSheetArgs {
  doc: string;
  action: (typeof SHEET_ACTIONS)[number];
  range?: string;
  value_render_option?: (typeof VALUE_RENDER_OPTIONS)[number];
}

export interface WriteSheetValueRange {
  range: string;
  values: unknown[][];
}

export interface WriteSheetArgs {
  action: (typeof WRITE_SHEET_ACTIONS)[number];
  doc?: string;
  title?: string;
  folder_token?: string;
  range?: string;
  values?: unknown[][];
  insert_data_option?: (typeof INSERT_DATA_OPTIONS)[number];
  value_ranges?: WriteSheetValueRange[];
}

const READ_TOOL: Record<string, string> = {
  docx: "fetch_doc",
  doc: "fetch_doc",
  sheet: "read_sheet",
  bitable: "read_bitable",
  slides: "read_slides",
  file: "read_file",
  mindnote: "read_mindnote",
};

const WRITE_TOOL: Record<string, string> = {
  docx: "update_doc",
  doc: "update_doc",
  sheet: "write_sheet",
  bitable: "write_bitable",
  slides: "write_slides",
  file: "write_file",
  mindnote: "read_mindnote",
};

function typeMismatch(objType: string, tools: Record<string, string>): FeishuCall {
  const label = objType.length > 0 ? objType : "unknown";
  const tool = tools[label];
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

function sheetPathToken(doc: string): string | null {
  try {
    const url = new URL(doc.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const parts = url.pathname.split("/").filter((part) => part.length > 0);
    const at = parts.indexOf("sheets");
    const raw = parts[at + 1];
    if (at < 0 || !raw) return null;
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function metaUrl(token: string): string {
  return `https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(token)}/sheets/query`;
}

function encodeSheetRange(range: string): string {
  return encodeURIComponent(range).replaceAll("!", "%21");
}

function sheetValuesUrl(token: string, range: string, render: string): string {
  return `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(token)}/values/${encodeSheetRange(range)}?valueRenderOption=${encodeURIComponent(render)}`;
}

function sheetPutUrl(token: string): string {
  return `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(token)}/values`;
}

function sheetAppendUrl(token: string, insertDataOption: string | undefined): string {
  const url = new URL(`https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(token)}/values_append`);
  if (insertDataOption) url.searchParams.set("insertDataOption", insertDataOption);
  return url.toString();
}

function sheetBatchUrl(token: string): string {
  return `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(token)}/values_batch_update`;
}

function valueRangeBody(range: string, values: unknown[][]): string {
  return JSON.stringify({ valueRange: { range, values } });
}

async function resolveSheet(
  client: FeishuClient,
  accessToken: string,
  doc: string,
  tools: Record<string, string>,
): Promise<{ token: string } | FeishuCall> {
  const fromPath = sheetPathToken(doc);
  if (fromPath) return { token: fromPath };
  const resolved = await resolveDoc(doc, (url) => feishuOpen(client, "GET", url, accessToken));
  if (!resolved.ok) return unresolvedDoc(resolved);
  if (resolved.objType === "sheet") return { token: resolved.token };
  if (!resolved.wikiNode && resolvesWikiNode(doc)) return { token: resolved.token };
  return typeMismatch(resolved.objType, tools);
}

async function readSheet(client: FeishuClient, accessToken: string, args: ReadSheetArgs): Promise<{ target: string | null; call: FeishuCall }> {
  const resolved = await resolveSheet(client, accessToken, args.doc, READ_TOOL);
  if ("kind" in resolved) return { target: parseDocRef(args.doc).token, call: resolved };
  const token = resolved.token;
  switch (args.action) {
    case "meta": {
      const result = await feishuOpen(client, "GET", metaUrl(token), accessToken);
      return { target: token, call: fromOpen(result, JSON.stringify(result.data)) };
    }
    case "values": {
      const range = args.range?.trim() ?? "";
      if (range.length === 0) return { target: token, call: { kind: "done", text: "range is required", isError: true } };
      const render = args.value_render_option ?? "ToString";
      const result = await feishuOpen(client, "GET", sheetValuesUrl(token, range, render), accessToken);
      return { target: token, call: fromOpen(result, JSON.stringify(result.data)) };
    }
    default: {
      const unexpected: never = args.action;
      return { target: token, call: unexpected };
    }
  }
}

export function callReadSheet(env: Env, openId: string, args: ReadSheetArgs): Promise<CallToolResult> {
  let target: string | null = parseDocRef(args.doc).token;
  return runTool(env, openId, "read_sheet", () => target, async (client, accessToken) => {
    const outcome = await readSheet(client, accessToken, args);
    target = outcome.target;
    return outcome.call;
  });
}

async function writeSheet(client: FeishuClient, accessToken: string, args: WriteSheetArgs): Promise<{ target: string | null; call: FeishuCall }> {
  if (args.action === "create") {
    const title = args.title?.trim() ?? "";
    if (title.length === 0) return { target: null, call: { kind: "done", text: "title is required", isError: true } };
    const body: Record<string, string> = { title };
    const folder = args.folder_token?.trim() ?? "";
    if (folder.length > 0) body.folder_token = folder;
    const result = await feishuOpen(client, "POST", CREATE_SHEET_URL, accessToken, JSON.stringify(body));
    const token = stringField(asRecord(result.data.spreadsheet), "spreadsheet_token");
    return { target: token.length > 0 ? token : null, call: fromOpen(result, JSON.stringify(result.data)) };
  }
  const doc = args.doc?.trim() ?? "";
  if (doc.length === 0) return { target: null, call: { kind: "done", text: "doc is required", isError: true } };
  const resolved = await resolveSheet(client, accessToken, doc, WRITE_TOOL);
  if ("kind" in resolved) return { target: parseDocRef(doc).token, call: resolved };
  const token = resolved.token;
  switch (args.action) {
    case "put": {
      const range = args.range?.trim() ?? "";
      if (range.length === 0) return { target: token, call: { kind: "done", text: "range is required", isError: true } };
      if (args.values === undefined) return { target: token, call: { kind: "done", text: "values is required", isError: true } };
      const result = await feishuOpen(client, "PUT", sheetPutUrl(token), accessToken, valueRangeBody(range, args.values));
      return { target: token, call: fromOpen(result, JSON.stringify(result.data)) };
    }
    case "append": {
      const range = args.range?.trim() ?? "";
      if (range.length === 0) return { target: token, call: { kind: "done", text: "range is required", isError: true } };
      if (args.values === undefined) return { target: token, call: { kind: "done", text: "values is required", isError: true } };
      const result = await feishuOpen(
        client,
        "POST",
        sheetAppendUrl(token, args.insert_data_option),
        accessToken,
        valueRangeBody(range, args.values),
      );
      return { target: token, call: fromOpen(result, JSON.stringify(result.data)) };
    }
    case "batch_update": {
      if (args.value_ranges === undefined) {
        return { target: token, call: { kind: "done", text: "value_ranges is required", isError: true } };
      }
      const valueRanges = args.value_ranges.map((entry) => ({ range: entry.range, values: entry.values }));
      const result = await feishuOpen(client, "POST", sheetBatchUrl(token), accessToken, JSON.stringify({ valueRanges }));
      return { target: token, call: fromOpen(result, JSON.stringify(result.data)) };
    }
    default: {
      const unexpected: never = args.action;
      return { target: token, call: unexpected };
    }
  }
}

export function callWriteSheet(env: Env, openId: string, args: WriteSheetArgs): Promise<CallToolResult> {
  let target: string | null = args.doc ? parseDocRef(args.doc).token : null;
  return runTool(env, openId, "write_sheet", () => target, async (client, accessToken) => {
    const outcome = await writeSheet(client, accessToken, args);
    target = outcome.target;
    return outcome.call;
  });
}
