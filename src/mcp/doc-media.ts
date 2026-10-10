import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { FeishuClient } from "../feishu/client";
import { feishuOpen, readOpenPayload } from "../feishu/docs";
import {
  INLINE_IMAGE_NOTE,
  MEDIA_BYTE_CAP,
  bytesToStandardBase64,
  imageMetadata,
  mediaNote,
  mimeOf,
  readBoundedBytes,
} from "../feishu/media";
import { callFetchFileMcp, type FeishuCall } from "../feishu/mcp-proxy";
import { byBackend, fromOpen, runTool } from "./proxied-call";

export interface FetchDocMediaArgs {
  doc?: string;
  media_token?: string;
  whiteboard_id?: string;
}

type MediaChoice =
  | { kind: "image"; token: string }
  | { kind: "board"; id: string }
  | { kind: "invalid"; text: string };

function mediaChoice(args: FetchDocMediaArgs): MediaChoice {
  if (args.media_token && args.whiteboard_id) return { kind: "invalid", text: "provide media_token or whiteboard_id, not both" };
  if (args.whiteboard_id) return { kind: "board", id: args.whiteboard_id };
  if (args.media_token) return { kind: "image", token: args.media_token };
  return { kind: "invalid", text: "media_token or whiteboard_id is required" };
}

function mediaUrl(token: string): string {
  return `https://open.feishu.cn/open-apis/drive/v1/medias/${encodeURIComponent(token)}/download`;
}

function whiteboardUrl(whiteboardId: string): string {
  return `https://open.feishu.cn/open-apis/board/v1/whiteboards/${encodeURIComponent(whiteboardId)}/nodes`;
}

async function downloadImage(client: FeishuClient, accessToken: string, mediaToken: string): Promise<FeishuCall> {
  const response = await client.request("GET", mediaUrl(mediaToken), { headers: { authorization: `Bearer ${accessToken}` } });
  if (response.status === 429) {
    await response.body?.cancel();
    return { kind: "rate_limit" };
  }
  const mimeType = mimeOf(response.headers.get("content-type"));
  const json = mimeType === "application/json" || mimeType.endsWith("+json");
  if (json || response.status < 200 || response.status >= 300) {
    const payload = await readOpenPayload(response);
    if (response.status >= 200 && response.status < 300) return fromOpen(payload, "");
    const code = payload.code !== 0 ? payload.code : response.status || 1;
    return fromOpen({ ...payload, code }, "");
  }
  const read = await readBoundedBytes(response, MEDIA_BYTE_CAP);
  if (read.overflow) return { kind: "done", text: imageMetadata(mimeType, read.size), isError: false };
  if (!mimeType.startsWith("image/")) return { kind: "done", text: mediaNote(mimeType, read.size, INLINE_IMAGE_NOTE), isError: false };
  return { kind: "done", text: "", isError: false, image: { data: bytesToStandardBase64(read.bytes), mimeType } };
}

async function whiteboardNodes(client: FeishuClient, accessToken: string, whiteboardId: string): Promise<FeishuCall> {
  const result = await feishuOpen(client, "GET", whiteboardUrl(whiteboardId), accessToken);
  if (result.code !== 0 || result.status === 429 || result.rawText !== undefined) return fromOpen(result, "");
  const body = JSON.stringify(result.data.nodes === undefined ? result.data : result.data.nodes);
  return { kind: "done", text: body, isError: false };
}

async function fetchOpenApi(client: FeishuClient, accessToken: string, choice: MediaChoice): Promise<FeishuCall> {
  switch (choice.kind) {
    case "invalid":
      return { kind: "done", text: choice.text, isError: true };
    case "board":
      return whiteboardNodes(client, accessToken, choice.id);
    case "image":
      return downloadImage(client, accessToken, choice.token);
    default: {
      const unexpected: never = choice;
      return unexpectedChoice(unexpected);
    }
  }
}

async function fetchMcp(client: FeishuClient, accessToken: string, choice: MediaChoice): Promise<FeishuCall> {
  switch (choice.kind) {
    case "invalid":
      return { kind: "done", text: choice.text, isError: true };
    case "board":
      return callFetchFileMcp(client, accessToken, { resource_token: choice.id, type: "whiteboard" });
    case "image":
      return callFetchFileMcp(client, accessToken, { resource_token: choice.token, type: "media" });
    default: {
      const unexpected: never = choice;
      return unexpectedChoice(unexpected);
    }
  }
}

function unexpectedChoice(_choice: never): FeishuCall {
  return { kind: "failed" };
}

export function callFetchDocMedia(env: Env, openId: string, args: FetchDocMediaArgs): Promise<CallToolResult> {
  const choice = mediaChoice(args);
  const target = choice.kind === "image" ? choice.token : choice.kind === "board" ? choice.id : null;
  return runTool(env, openId, "fetch_doc_media", target, (client, accessToken, backend) =>
    byBackend(
      backend,
      () => fetchMcp(client, accessToken, choice),
      () => fetchOpenApi(client, accessToken, choice),
    ),
  );
}
