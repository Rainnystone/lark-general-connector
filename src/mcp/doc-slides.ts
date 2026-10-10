import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { FeishuClient } from "../feishu/client";
import { feishuOpen, parseDocRef, resolveDoc, resolvesWikiNode, stringField, type ResolvedDoc } from "../feishu/docs";
import type { FeishuCall } from "../feishu/mcp-proxy";
import { fromOpen, runTool } from "./proxied-call";
import { OUTPUT_LIMIT } from "./tools";

export const SLIDES_ACTIONS = ["get"] as const;
export const WRITE_SLIDES_ACTIONS = ["create", "add_slide", "replace_slide", "delete_slide"] as const;

export interface ReadSlidesArgs {
  doc: string;
  action: (typeof SLIDES_ACTIONS)[number];
}

export interface WriteSlidesArgs {
  action: (typeof WRITE_SLIDES_ACTIONS)[number];
  doc?: string;
  title?: string;
  slide?: string;
  slide_id?: string;
  before_slide_id?: string;
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

const PRESENTATION_NS = "https://www.larkoffice.com/sml/2.0";
const CREATE_URL = "https://open.feishu.cn/open-apis/slides_ai/v1/xml_presentations";

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

function slidesSlideUrl(token: string, slideId?: string): string {
  const url = new URL(`${CREATE_URL}/${encodeURIComponent(token)}/slide`);
  if (slideId) url.searchParams.set("slide_id", slideId);
  return url.toString();
}

function slidesReplaceUrl(token: string, slideId: string): string {
  const url = new URL(`${CREATE_URL}/${encodeURIComponent(token)}/slide/replace`);
  url.searchParams.set("slide_id", slideId);
  url.searchParams.set("revision_id", "-1");
  return url.toString();
}

function required(name: string, value: string | undefined): string | FeishuCall {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return { kind: "done", text: `${name} is required`, isError: true };
  return trimmed;
}

function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function createPresentationXml(title: string): string {
  return `<presentation xmlns="${PRESENTATION_NS}" width="960" height="540"><title>${escapeXml(title)}</title></presentation>`;
}

async function resolveSlides(
  client: FeishuClient,
  accessToken: string,
  doc: string,
  tools: Record<string, string>,
): Promise<{ token: string } | FeishuCall> {
  const fromPath = slidesPathToken(doc);
  if (fromPath) return { token: fromPath };
  const resolved = await resolveDoc(doc, (url) => feishuOpen(client, "GET", url, accessToken));
  if (!resolved.ok) return unresolvedDoc(resolved);
  if (resolved.objType === "slides") return { token: resolved.token };
  if (!resolved.wikiNode && resolvesWikiNode(doc)) return { token: resolved.token };
  return typeMismatch(resolved.objType, tools);
}

async function readSlides(client: FeishuClient, accessToken: string, args: ReadSlidesArgs): Promise<{ target: string | null; call: FeishuCall }> {
  const resolved = await resolveSlides(client, accessToken, args.doc, READ_TOOL);
  if ("kind" in resolved) return { target: parseDocRef(args.doc).token, call: resolved };
  const token = resolved.token;
  switch (args.action) {
    case "get": {
      const result = await feishuOpen(client, "GET", slidesGetUrl(token), accessToken);
      if (result.parsed === false) {
        return { target: token, call: { kind: "done", text: JSON.stringify({ too_large: true }), isError: false } };
      }
      if (result.status === 429 || result.code !== 0 || result.rawText !== undefined) {
        return { target: token, call: fromOpen(result, "") };
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

async function writeSlides(client: FeishuClient, accessToken: string, args: WriteSlidesArgs): Promise<{ target: string | null; call: FeishuCall }> {
  switch (args.action) {
    case "create": {
      const title = required("title", args.title);
      if (typeof title !== "string") return { target: null, call: title };
      const result = await feishuOpen(
        client,
        "POST",
        CREATE_URL,
        accessToken,
        JSON.stringify({ xml_presentation: { content: createPresentationXml(title) } }),
      );
      const token = stringField(result.data, "xml_presentation_id");
      return { target: token.length > 0 ? token : null, call: fromOpen(result, JSON.stringify(result.data)) };
    }
    case "add_slide":
    case "replace_slide":
    case "delete_slide": {
      const doc = required("doc", args.doc);
      if (typeof doc !== "string") return { target: null, call: doc };
      const resolved = await resolveSlides(client, accessToken, doc, WRITE_TOOL);
      if ("kind" in resolved) return { target: parseDocRef(doc).token, call: resolved };
      const token = resolved.token;
      switch (args.action) {
        case "add_slide": {
          const slide = required("slide", args.slide);
          if (typeof slide !== "string") return { target: token, call: slide };
          const body: Record<string, unknown> = { slide: { content: slide } };
          const before = args.before_slide_id?.trim() ?? "";
          if (before.length > 0) body.before_slide_id = before;
          const result = await feishuOpen(client, "POST", slidesSlideUrl(token), accessToken, JSON.stringify(body));
          return { target: token, call: fromOpen(result, JSON.stringify(result.data)) };
        }
        case "replace_slide": {
          const slideId = required("slide_id", args.slide_id);
          if (typeof slideId !== "string") return { target: token, call: slideId };
          const slide = required("slide", args.slide);
          if (typeof slide !== "string") return { target: token, call: slide };
          const result = await feishuOpen(
            client,
            "POST",
            slidesReplaceUrl(token, slideId),
            accessToken,
            JSON.stringify({ parts: [{ action: "block_replace", block_id: slideId, replacement: slide }] }),
          );
          return { target: token, call: fromOpen(result, JSON.stringify(result.data)) };
        }
        case "delete_slide": {
          const slideId = required("slide_id", args.slide_id);
          if (typeof slideId !== "string") return { target: token, call: slideId };
          const result = await feishuOpen(client, "DELETE", slidesSlideUrl(token, slideId), accessToken);
          return { target: token, call: fromOpen(result, JSON.stringify(result.data)) };
        }
        default: {
          const unexpected: never = args.action;
          return { target: token, call: unexpected };
        }
      }
    }
    default: {
      const unexpected: never = args.action;
      return { target: args.doc ? parseDocRef(args.doc).token : null, call: unexpected };
    }
  }
}

export function callWriteSlides(env: Env, openId: string, args: WriteSlidesArgs): Promise<CallToolResult> {
  let target: string | null = args.doc ? parseDocRef(args.doc).token : null;
  return runTool(env, openId, "write_slides", () => target, async (client, accessToken) => {
    const outcome = await writeSlides(client, accessToken, args);
    target = outcome.target;
    return outcome.call;
  });
}
