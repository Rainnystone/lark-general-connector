import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { FeishuClient } from "../feishu/client";
import { feishuOpen, parseDocRef, resolveDoc, resolvesWikiNode, type ResolvedDoc } from "../feishu/docs";
import type { FeishuCall } from "../feishu/mcp-proxy";
import { fromOpen, runTool } from "./proxied-call";

export const SHEET_ACTIONS = ["meta", "values"] as const;
export const VALUE_RENDER_OPTIONS = ["ToString", "FormattedValue", "Formula", "UnformattedValue"] as const;

export interface ReadSheetArgs {
  doc: string;
  action: (typeof SHEET_ACTIONS)[number];
  range?: string;
  value_render_option?: (typeof VALUE_RENDER_OPTIONS)[number];
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

async function resolveSheet(client: FeishuClient, accessToken: string, doc: string): Promise<{ token: string } | FeishuCall> {
  const fromPath = sheetPathToken(doc);
  if (fromPath) return { token: fromPath };
  const resolved = await resolveDoc(doc, (url) => feishuOpen(client, "GET", url, accessToken));
  if (!resolved.ok) return unresolvedDoc(resolved);
  if (resolved.objType === "sheet") return { token: resolved.token };
  if (!resolved.wikiNode && resolvesWikiNode(doc)) return { token: resolved.token };
  return typeMismatch(resolved.objType);
}

async function readSheet(client: FeishuClient, accessToken: string, args: ReadSheetArgs): Promise<{ target: string | null; call: FeishuCall }> {
  const resolved = await resolveSheet(client, accessToken, args.doc);
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
