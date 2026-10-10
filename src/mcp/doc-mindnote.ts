import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { FeishuClient } from "../feishu/client";
import { feishuOpen, parseDocRef, resolveDoc, resolvesWikiNode, type ResolvedDoc } from "../feishu/docs";
import type { FeishuCall } from "../feishu/mcp-proxy";
import { fromOpen, runTool } from "./proxied-call";

export const MINDNOTE_ACTIONS = ["nodes"] as const;

export interface ReadMindnoteArgs {
  doc: string;
  action: (typeof MINDNOTE_ACTIONS)[number];
  page_token?: string;
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

function mindnotePathToken(doc: string): string | null {
  try {
    const url = new URL(doc.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const parts = url.pathname.split("/").filter((part) => part.length > 0);
    const at = parts.indexOf("mindnotes");
    const raw = parts[at + 1];
    if (at < 0 || !raw) return null;
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function nodesUrl(token: string, pageToken: string | undefined): string {
  const url = new URL(`https://open.feishu.cn/open-apis/mindnote/v1/mindnotes/${encodeURIComponent(token)}/nodes`);
  if (pageToken) url.searchParams.set("page_token", pageToken);
  return url.toString();
}

async function resolveMindnote(client: FeishuClient, accessToken: string, doc: string): Promise<{ token: string } | FeishuCall> {
  const fromPath = mindnotePathToken(doc);
  if (fromPath) return { token: fromPath };
  const resolved = await resolveDoc(doc, (url) => feishuOpen(client, "GET", url, accessToken));
  if (!resolved.ok) return unresolvedDoc(resolved);
  if (resolved.objType === "mindnote") return { token: resolved.token };
  if (!resolved.wikiNode && resolvesWikiNode(doc)) return { token: resolved.token };
  return typeMismatch(resolved.objType);
}

async function readMindnote(client: FeishuClient, accessToken: string, args: ReadMindnoteArgs): Promise<{ target: string | null; call: FeishuCall }> {
  const resolved = await resolveMindnote(client, accessToken, args.doc);
  if ("kind" in resolved) return { target: parseDocRef(args.doc).token, call: resolved };
  const token = resolved.token;
  switch (args.action) {
    case "nodes": {
      const result = await feishuOpen(client, "GET", nodesUrl(token, args.page_token), accessToken);
      return { target: token, call: fromOpen(result, JSON.stringify(result.data)) };
    }
    default: {
      const unexpected: never = args.action;
      return { target: token, call: unexpected };
    }
  }
}

export function callReadMindnote(env: Env, openId: string, args: ReadMindnoteArgs): Promise<CallToolResult> {
  let target: string | null = parseDocRef(args.doc).token;
  return runTool(env, openId, "read_mindnote", () => target, async (client, accessToken) => {
    const outcome = await readMindnote(client, accessToken, args);
    target = outcome.target;
    return outcome.call;
  });
}
