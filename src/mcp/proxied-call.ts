import type { CallToolResult } from "@modelcontextprotocol/server";
import { audit } from "../audit";
import type { Env } from "../env";
import { BudgetExceededError, EndpointNotAllowedError, FeishuClient } from "../feishu/client";
import type { FeishuCall } from "../feishu/mcp-proxy";
import type { AccessResult } from "../tokens/store";
import { toolBackend, type ProxiedToolName, type ToolBackend } from "./tool-backends";
import { failAccess, resolveAccess, textResult, TOKEN_INVALID } from "./tools";

const OPEN_MSG_LIMIT = 200;

const OPEN_ERROR_HINTS: Record<number, string> = {
  230001: "invalid request parameter",
  131002: "invalid parameter",
  99992402: "validation",
  41050: "no user authority",
  99992351: "invalid or nonexistent id",
  99992364: "nonexistent or cross-tenant id",
  1770002: "not found",
  1770003: "deleted",
  99991679: "re-authorize the connector to grant new scopes",
};

function scrubOpenMsg(msg: string): string {
  let text = msg;
  text = text.replace(/bearer\s+\S+/gi, "bearer [redacted]");
  text = text.replace(/https?:\/\/\S+/gi, "[url]");
  text = text.replace(/\S+@\S+/g, "[redacted]");
  text = text.replace(/code=[^\s&]+/gi, "code=[redacted]");
  text = text.replace(/[A-Za-z0-9_-]{20,}/g, "[redacted]");
  text = text.trim();
  const points = Array.from(text);
  return points.length > OPEN_MSG_LIMIT ? points.slice(0, OPEN_MSG_LIMIT).join("") : text;
}

function openErrorText(code: number, msg: string | undefined, feishuError: boolean): string | null {
  const hint = OPEN_ERROR_HINTS[code];
  const scrubbed = scrubOpenMsg(msg ?? "");
  if (scrubbed.length === 0 && hint === undefined) return feishuError ? `Feishu error ${code}` : null;
  if (scrubbed.length === 0) return `Feishu error ${code}: ${hint}`;
  if (hint === undefined || scrubbed === hint) return `Feishu error ${code}: ${scrubbed}`;
  return `Feishu error ${code}: ${scrubbed} (${hint})`;
}

export function fromOpen(result: { status: number; code: number; msg?: string; feishuError?: boolean; rawText?: string }, text: string): FeishuCall {
  if (result.status === 429) return { kind: "rate_limit" };
  if (TOKEN_INVALID.has(result.code)) return { kind: "token_invalid" };
  if (result.rawText !== undefined || result.code !== 0) {
    const detail = openErrorText(result.code, result.msg, result.feishuError === true);
    return {
      kind: "done",
      text: detail ?? "Feishu request failed",
      isError: true,
      code: result.code !== 0 ? String(result.code) : String(result.status || 1),
    };
  }
  return { kind: "done", text, isError: false };
}

function settle(outcome: FeishuCall): { result: CallToolResult; ok: boolean; code: string } {
  switch (outcome.kind) {
    case "done":
      if (outcome.image && !outcome.isError) {
        const content: CallToolResult["content"] = [];
        if (outcome.text.length > 0) content.push({ type: "text", text: outcome.text });
        content.push({ type: "image", data: outcome.image.data, mimeType: outcome.image.mimeType });
        return { result: { content }, ok: true, code: "0" };
      }
      return {
        result: textResult(outcome.text, outcome.isError),
        ok: !outcome.isError,
        code: outcome.isError ? (outcome.code ?? "is_error") : "0",
      };
    case "token_invalid":
      return { result: textResult("Feishu request failed", true), ok: false, code: "-32003" };
    case "rate_limit":
      return { result: textResult("Feishu rate limit, retry shortly", true), ok: false, code: "429" };
    case "internal":
      return { result: textResult("internal error", true), ok: false, code: "-32011" };
    case "failed":
      return { result: textResult("Feishu request failed", true), ok: false, code: "error" };
    default: {
      const unexpected: never = outcome;
      return { result: textResult("Feishu request failed", true), ok: false, code: String(unexpected) };
    }
  }
}

export class AccessLost extends Error {
  readonly access: Extract<AccessResult, { ok: false }>;

  constructor(access: Extract<AccessResult, { ok: false }>) {
    super("Feishu access lost");
    this.name = "AccessLost";
    this.access = access;
  }
}

export type RunnableToolName =
  | ProxiedToolName
  | "list_chats"
  | "list_chat_messages"
  | "search_messages"
  | "get_message"
  | "delete_doc"
  | "read_sheet"
  | "write_sheet"
  | "read_bitable"
  | "write_bitable"
  | "read_slides"
  | "write_slides"
  | "read_file"
  | "write_file"
  | "read_mindnote";

function isProxiedTool(tool: RunnableToolName): tool is ProxiedToolName {
  switch (tool) {
    case "list_chats":
    case "list_chat_messages":
    case "search_messages":
    case "get_message":
    case "delete_doc":
    case "read_sheet":
    case "write_sheet":
    case "read_bitable":
    case "write_bitable":
    case "read_slides":
    case "write_slides":
    case "read_file":
    case "write_file":
    case "read_mindnote":
      return false;
    case "search_docs":
    case "fetch_doc":
    case "list_wiki_docs":
    case "get_doc_comments":
    case "create_doc":
    case "update_doc":
    case "add_doc_comment":
    case "get_user":
    case "search_users":
    case "fetch_doc_media":
      return true;
    default: {
      const unexpected: never = tool;
      return unexpected;
    }
  }
}

let invalidBackendsLogged = "";

function noteInvalidBackends(raw: string | undefined, invalid: boolean): void {
  if (!invalid) return;
  const key = raw ?? "";
  if (invalidBackendsLogged === key) return;
  invalidBackendsLogged = key;
  audit({ event: "tool_backends_invalid" });
}

export async function runTool(
  env: Env,
  openId: string,
  tool: RunnableToolName,
  target: string | null | (() => string | null),
  run: (client: FeishuClient, accessToken: string, backend: ToolBackend, renew: () => Promise<string>) => Promise<FeishuCall>,
): Promise<CallToolResult> {
  const started = Date.now();
  let code = "0";
  let ok = false;
  let result = textResult("Feishu request failed", true);
  try {
    const choice = isProxiedTool(tool) ? toolBackend(env.TOOL_BACKENDS, tool) : { backend: "openapi" as const, invalid: false };
    noteInvalidBackends(env.TOOL_BACKENDS, choice.invalid);
    const backend = choice.backend;
    const client = new FeishuClient();
    let renewed = false;
    const renew = async (): Promise<string> => {
      if (renewed) throw new AccessLost({ ok: false, reauth: false, code: "refresh", refreshFailed: false });
      renewed = true;
      const next = await resolveAccess(env, openId, true);
      if (!next.ok) throw new AccessLost(next);
      return next.accessToken;
    };
    let access = await resolveAccess(env, openId, false);
    if (!access.ok) {
      code = access.code;
      result = await failAccess(env, openId, access);
      return result;
    }
    let outcome = await run(client, access.accessToken, backend, renew);
    if (outcome.kind === "token_invalid") {
      access = await resolveAccess(env, openId, true);
      if (!access.ok) {
        code = access.code;
        result = await failAccess(env, openId, access);
        return result;
      }
      renewed = true;
      outcome = await run(client, access.accessToken, backend, renew);
    }
    const settled = settle(outcome);
    ok = settled.ok;
    code = settled.code;
    result = settled.result;
    return result;
  } catch (error) {
    if (error instanceof AccessLost) {
      code = error.access.code;
      result = await failAccess(env, openId, error.access);
      return result;
    }
    if (error instanceof BudgetExceededError || error instanceof EndpointNotAllowedError) {
      code = "budget";
      result = textResult(error.message, true);
      return result;
    }
    code = "error";
    result = textResult("Feishu request failed", true);
    return result;
  } finally {
    const audited = typeof target === "function" ? target() : target;
    audit({ event: "tool_call", tool, target: audited, ok, code, ms: Date.now() - started });
  }
}

function unexpectedBackend(_backend: never): FeishuCall {
  return { kind: "failed" };
}

export function byBackend(backend: ToolBackend, mcp: () => Promise<FeishuCall>, openapi: () => Promise<FeishuCall>): Promise<FeishuCall> {
  switch (backend) {
    case "mcp":
      return mcp();
    case "openapi":
      return openapi();
    default:
      return Promise.resolve(unexpectedBackend(backend));
  }
}
