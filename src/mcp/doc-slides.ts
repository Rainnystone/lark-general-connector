import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { FeishuClient } from "../feishu/client";
import { feishuOpen, parseDocRef, resolveDoc, resolvesWikiNode, type ResolvedDoc } from "../feishu/docs";
import type { FeishuCall } from "../feishu/mcp-proxy";
import { fromOpen, runTool } from "./proxied-call";
import { OUTPUT_LIMIT } from "./tools";

export const SLIDES_ACTIONS = ["get"] as const;

export interface ReadSlidesArgs {
  doc: string;
  action: (typeof SLIDES_ACTIONS)[number];
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

const CREATE_URL = "https://open.feishu.cn/open-apis/slides_ai/v1/xml_presentations";

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

function slidesPathToken(doc: string): string | null {
  try {
    const url = new URL(doc.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const parts = url.pathname.split("/").filter((part) => part.length > 0);
    const at = parts.indexOf("slides");
    const raw = parts[at + 1];
    if (at < 0 || !raw) return null;
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function slidesGetUrl(token: string): string {
  return `${CREATE_URL}/${encodeURIComponent(token)}`;
}

async function resolveSlides(client: FeishuClient, accessToken: string, doc: string): Promise<{ token: string } | FeishuCall> {
  const fromPath = slidesPathToken(doc);
  if (fromPath) return { token: fromPath };
  const resolved = await resolveDoc(doc, (url) => feishuOpen(client, "GET", url, accessToken));
  if (!resolved.ok) return unresolvedDoc(resolved);
  if (resolved.objType === "slides") return { token: resolved.token };
  if (!resolved.wikiNode && resolvesWikiNode(doc)) return { token: resolved.token };
  return typeMismatch(resolved.objType);
}

async function readSlides(client: FeishuClient, accessToken: string, args: ReadSlidesArgs): Promise<{ target: string | null; call: FeishuCall }> {
  const resolved = await resolveSlides(client, accessToken, args.doc);
  if ("kind" in resolved) return { target: parseDocRef(args.doc).token, call: resolved };
  const token = resolved.token;
  switch (args.action) {
    case "get": {
      const result = await feishuOpen(client, "GET", slidesGetUrl(token), accessToken);
      if (result.status === 429 || result.code !== 0 || result.rawText !== undefined) {
        return { target: token, call: fromOpen(result, "") };
      }
      if (result.parsed === false) {
        return { target: token, call: { kind: "done", text: JSON.stringify({ too_large: true }), isError: false } };
      }
      const text = JSON.stringify(result.data);
      if (text.length > OUTPUT_LIMIT) {
        return { target: token, call: { kind: "done", text: JSON.stringify({ too_large: true }), isError: false } };
      }
      return { target: token, call: fromOpen(result, text) };
    }
    default: {
      const unexpected: never = args.action;
      return { target: token, call: unexpected };
    }
  }
}

export function callReadSlides(env: Env, openId: string, args: ReadSlidesArgs): Promise<CallToolResult> {
  let target: string | null = parseDocRef(args.doc).token;
  return runTool(env, openId, "read_slides", () => target, async (client, accessToken) => {
    const outcome = await readSlides(client, accessToken, args);
    target = outcome.target;
    return outcome.call;
  });
}
