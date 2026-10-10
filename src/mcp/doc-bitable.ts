import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { FeishuClient } from "../feishu/client";
import { feishuOpen, parseDocRef, resolveDoc, resolvesWikiNode, stringField, type ResolvedDoc } from "../feishu/docs";
import type { FeishuCall } from "../feishu/mcp-proxy";
import { asRecord } from "../feishu/payload";
import { fromOpen, runTool } from "./proxied-call";

export const BITABLE_ACTIONS = ["app", "tables", "fields", "records"] as const;
export const WRITE_BITABLE_ACTIONS = [
  "create_app",
  "create_field",
  "create_record",
  "update_record",
  "update_field",
  "delete_field",
  "delete_record",
] as const;

const CREATE_APP_URL = "https://open.feishu.cn/open-apis/bitable/v1/apps";

export interface ReadBitableArgs {
  doc: string;
  action: (typeof BITABLE_ACTIONS)[number];
  table_id?: string;
  page_token?: string;
  offset?: number;
  limit?: number;
  view_id?: string;
}

export interface WriteBitableArgs {
  action: (typeof WRITE_BITABLE_ACTIONS)[number];
  doc?: string;
  name?: string;
  folder_token?: string;
  table_id?: string;
  field_name?: string;
  type?: number;
  property?: Record<string, unknown>;
  fields?: Record<string, unknown>;
  record_id?: string;
  field_id?: string;
}

const RECORDS_LIMIT_MAX = 200;

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

function bitablePathToken(doc: string): string | null {
  try {
    const url = new URL(doc.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const parts = url.pathname.split("/").filter((part) => part.length > 0);
    const at = parts.indexOf("base");
    const raw = parts[at + 1];
    if (at < 0 || !raw) return null;
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function appUrl(token: string): string {
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(token)}`;
}

function tablesUrl(token: string, pageToken: string | undefined): string {
  const url = new URL(`https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(token)}/tables`);
  if (pageToken && pageToken.length > 0) url.searchParams.set("page_token", pageToken);
  return url.toString();
}

function fieldsUrl(token: string, tableId: string, pageToken: string | undefined): string {
  const url = new URL(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(token)}/tables/${encodeURIComponent(tableId)}/fields`,
  );
  if (pageToken && pageToken.length > 0) url.searchParams.set("page_token", pageToken);
  return url.toString();
}

function sentLimit(limit: number | undefined): number | undefined {
  if (limit === undefined || !Number.isInteger(limit)) return undefined;
  return Math.min(limit, RECORDS_LIMIT_MAX);
}

function sentOffset(offset: number | undefined): number | undefined {
  if (offset === undefined || !Number.isInteger(offset)) return undefined;
  return offset;
}

function tableRecordsUrl(token: string, tableId: string): string {
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(token)}/tables/${encodeURIComponent(tableId)}/records`;
}

function tableRecordUrl(token: string, tableId: string, recordId: string): string {
  return `${tableRecordsUrl(token, tableId)}/${encodeURIComponent(recordId)}`;
}

function tableFieldUrl(token: string, tableId: string, fieldId: string): string {
  return `${fieldsUrl(token, tableId, undefined)}/${encodeURIComponent(fieldId)}`;
}

function fieldBody(fieldName: string, type: number, property: Record<string, unknown> | undefined): string {
  const body: Record<string, unknown> = { field_name: fieldName, type };
  if (property !== undefined) body.property = property;
  return JSON.stringify(body);
}

function recordsUrl(token: string, tableId: string, args: ReadBitableArgs): string {
  const url = new URL(
    `https://open.feishu.cn/open-apis/base/v3/bases/${encodeURIComponent(token)}/tables/${encodeURIComponent(tableId)}/records`,
  );
  const offset = sentOffset(args.offset);
  if (offset !== undefined) url.searchParams.set("offset", String(offset));
  const limit = sentLimit(args.limit);
  if (limit !== undefined) url.searchParams.set("limit", String(limit));
  const viewId = args.view_id?.trim() ?? "";
  if (viewId.length > 0) url.searchParams.set("view_id", viewId);
  return url.toString();
}

async function resolveBitable(client: FeishuClient, accessToken: string, doc: string): Promise<{ token: string } | FeishuCall> {
  const fromPath = bitablePathToken(doc);
  if (fromPath) return { token: fromPath };
  const resolved = await resolveDoc(doc, (url) => feishuOpen(client, "GET", url, accessToken));
  if (!resolved.ok) return unresolvedDoc(resolved);
  if (resolved.objType === "bitable") return { token: resolved.token };
  if (!resolved.wikiNode && resolvesWikiNode(doc)) return { token: resolved.token };
  return typeMismatch(resolved.objType);
}

function missingTableId(token: string): { target: string; call: FeishuCall } {
  return { target: token, call: { kind: "done", text: "table_id is required", isError: true } };
}

async function readBitable(client: FeishuClient, accessToken: string, args: ReadBitableArgs): Promise<{ target: string | null; call: FeishuCall }> {
  const resolved = await resolveBitable(client, accessToken, args.doc);
  if ("kind" in resolved) return { target: parseDocRef(args.doc).token, call: resolved };
  const token = resolved.token;
  switch (args.action) {
    case "app": {
      const result = await feishuOpen(client, "GET", appUrl(token), accessToken);
      return { target: token, call: fromOpen(result, JSON.stringify(result.data)) };
    }
    case "tables": {
      const result = await feishuOpen(client, "GET", tablesUrl(token, args.page_token), accessToken);
      return { target: token, call: fromOpen(result, JSON.stringify(result.data)) };
    }
    case "fields": {
      const tableId = args.table_id?.trim() ?? "";
      if (tableId.length === 0) return missingTableId(token);
      const result = await feishuOpen(client, "GET", fieldsUrl(token, tableId, args.page_token), accessToken);
      return { target: token, call: fromOpen(result, JSON.stringify(result.data)) };
    }
    case "records": {
      const tableId = args.table_id?.trim() ?? "";
      if (tableId.length === 0) return missingTableId(token);
      const result = await feishuOpen(client, "GET", recordsUrl(token, tableId, args), accessToken);
      return { target: token, call: fromOpen(result, JSON.stringify(result.data)) };
    }
    default: {
      const unexpected: never = args.action;
      return { target: token, call: unexpected };
    }
  }
}

export function callReadBitable(env: Env, openId: string, args: ReadBitableArgs): Promise<CallToolResult> {
  let target: string | null = parseDocRef(args.doc).token;
  return runTool(env, openId, "read_bitable", () => target, async (client, accessToken) => {
    const outcome = await readBitable(client, accessToken, args);
    target = outcome.target;
    return outcome.call;
  });
}

function missing(token: string | null, text: string): { target: string | null; call: FeishuCall } {
  return { target: token, call: { kind: "done", text, isError: true } };
}

async function writeBitable(client: FeishuClient, accessToken: string, args: WriteBitableArgs): Promise<{ target: string | null; call: FeishuCall }> {
  if (args.action === "create_app") {
    const name = args.name?.trim() ?? "";
    if (name.length === 0) return missing(null, "name is required");
    const body: Record<string, string> = { name };
    const folder = args.folder_token?.trim() ?? "";
    if (folder.length > 0) body.folder_token = folder;
    const result = await feishuOpen(client, "POST", CREATE_APP_URL, accessToken, JSON.stringify(body));
    const token = stringField(asRecord(result.data.app), "app_token");
    return { target: token.length > 0 ? token : null, call: fromOpen(result, JSON.stringify(result.data)) };
  }
  const doc = args.doc?.trim() ?? "";
  if (doc.length === 0) return missing(null, "doc is required");
  const resolved = await resolveBitable(client, accessToken, doc);
  if ("kind" in resolved) return { target: parseDocRef(doc).token, call: resolved };
  const token = resolved.token;
  const tableId = args.table_id?.trim() ?? "";
  if (tableId.length === 0) return missingTableId(token);
  switch (args.action) {
    case "create_field": {
      const fieldName = args.field_name?.trim() ?? "";
      if (fieldName.length === 0) return missing(token, "field_name is required");
      if (args.type === undefined || !Number.isInteger(args.type)) return missing(token, "type is required");
      const result = await feishuOpen(client, "POST", fieldsUrl(token, tableId, undefined), accessToken, fieldBody(fieldName, args.type, args.property));
      return { target: token, call: fromOpen(result, JSON.stringify(result.data)) };
    }
    case "create_record": {
      if (args.fields === undefined) return missing(token, "fields is required");
      const result = await feishuOpen(client, "POST", tableRecordsUrl(token, tableId), accessToken, JSON.stringify({ fields: args.fields }));
      return { target: token, call: fromOpen(result, JSON.stringify(result.data)) };
    }
    case "update_record": {
      const recordId = args.record_id?.trim() ?? "";
      if (recordId.length === 0) return missing(token, "record_id is required");
      if (args.fields === undefined) return missing(token, "fields is required");
      const result = await feishuOpen(client, "PUT", tableRecordUrl(token, tableId, recordId), accessToken, JSON.stringify({ fields: args.fields }));
      return { target: token, call: fromOpen(result, JSON.stringify(result.data)) };
    }
    case "update_field": {
      const fieldId = args.field_id?.trim() ?? "";
      if (fieldId.length === 0) return missing(token, "field_id is required");
      const fieldName = args.field_name?.trim() ?? "";
      if (fieldName.length === 0) return missing(token, "field_name is required");
      if (args.type === undefined || !Number.isInteger(args.type)) return missing(token, "type is required");
      const result = await feishuOpen(client, "PUT", tableFieldUrl(token, tableId, fieldId), accessToken, fieldBody(fieldName, args.type, args.property));
      return { target: token, call: fromOpen(result, JSON.stringify(result.data)) };
    }
    case "delete_field": {
      const fieldId = args.field_id?.trim() ?? "";
      if (fieldId.length === 0) return missing(token, "field_id is required");
      const result = await feishuOpen(client, "DELETE", tableFieldUrl(token, tableId, fieldId), accessToken);
      return { target: token, call: fromOpen(result, JSON.stringify(result.data)) };
    }
    case "delete_record": {
      const recordId = args.record_id?.trim() ?? "";
      if (recordId.length === 0) return missing(token, "record_id is required");
      const result = await feishuOpen(client, "DELETE", tableRecordUrl(token, tableId, recordId), accessToken);
      return { target: token, call: fromOpen(result, JSON.stringify(result.data)) };
    }
    default: {
      const unexpected: never = args.action;
      return { target: token, call: unexpected };
    }
  }
}

export function callWriteBitable(env: Env, openId: string, args: WriteBitableArgs): Promise<CallToolResult> {
  let target: string | null = args.doc ? parseDocRef(args.doc).token : null;
  return runTool(env, openId, "write_bitable", () => target, async (client, accessToken) => {
    const outcome = await writeBitable(client, accessToken, args);
    target = outcome.target;
    return outcome.call;
  });
}
