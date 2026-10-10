import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { FeishuClient } from "../feishu/client";
import { feishuOpen, stringField } from "../feishu/docs";
import { callFeishuMcp, type FeishuCall } from "../feishu/mcp-proxy";
import { asRecord } from "../feishu/payload";
import { byBackend, fromOpen, runTool } from "./proxied-call";
import { finishRows, fitPage, invalidPageToken, pageTokenFooter, readPageCursor, renderFit, windowBlocks } from "./tools";

export interface GetUserArgs {
  user_id: string;
  id_type?: string;
}

export interface SearchUsersArgs {
  query: string;
  page_token?: string;
}

const USER_ID_TYPES = ["open_id", "union_id", "user_id"] as const;
type UserIdType = (typeof USER_ID_TYPES)[number];

const ID_TYPE_ERROR = "id_type must be open_id, union_id, or user_id";

function isUserIdType(value: string): value is UserIdType {
  switch (value) {
    case "open_id":
    case "union_id":
    case "user_id":
      return true;
    default:
      return false;
  }
}

function chosenIdType(value: string | undefined): UserIdType | null {
  const chosen = value ?? "open_id";
  return isUserIdType(chosen) ? chosen : null;
}

function lines(fields: Array<[string, string]>): string {
  return fields
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

function avatarUrl(record: Record<string, unknown>): string {
  const avatar = asRecord(record.avatar);
  return stringField(avatar, "avatar_origin") || stringField(avatar, "avatar_640") || stringField(avatar, "avatar_240") || stringField(avatar, "avatar_72");
}

function departmentNames(record: Record<string, unknown>): string {
  const paths = Array.isArray(record.department_path) ? record.department_path : [];
  const names: string[] = [];
  for (const entry of paths) {
    const name = stringField(asRecord(asRecord(entry).department_name), "name");
    if (name.length > 0) names.push(name);
  }
  return names.join(", ");
}

function colleagueText(record: Record<string, unknown>): string {
  return lines([
    ["name", stringField(record, "name")],
    ["en_name", stringField(record, "en_name")],
    ["departments", departmentNames(record)],
    ["avatar", avatarUrl(record)],
  ]);
}

function searchBlock(record: Record<string, unknown>): string {
  return lines([
    ["name", stringField(record, "name")],
    ["open_id", stringField(record, "open_id")],
    ["avatar", avatarUrl(record)],
  ]);
}

function userUrl(userId: string, idType: UserIdType): string {
  const url = new URL(`https://open.feishu.cn/open-apis/contact/v3/users/${encodeURIComponent(userId)}`);
  url.searchParams.set("user_id_type", idType);
  return url.toString();
}

function searchUrl(args: SearchUsersArgs): string {
  const url = new URL("https://open.feishu.cn/open-apis/search/v1/user");
  url.searchParams.set("query", args.query);
  if (args.page_token) url.searchParams.set("page_token", args.page_token);
  return url.toString();
}

async function getUserOpenApi(client: FeishuClient, accessToken: string, userId: string, idType: UserIdType): Promise<FeishuCall> {
  const result = await feishuOpen(client, "GET", userUrl(userId, idType), accessToken);
  return fromOpen(result, colleagueText(asRecord(result.data.user)));
}

async function searchOpenApi(client: FeishuClient, accessToken: string, args: SearchUsersArgs): Promise<FeishuCall> {
  const resume = readPageCursor(args.page_token, []);
  if (!resume.ok) return invalidPageToken();
  const result = await feishuOpen(client, "GET", searchUrl({ ...args, page_token: resume.cursor.token }), accessToken);
  if (result.code !== 0 || result.status === 429 || result.rawText !== undefined) return fromOpen(result, "");
  const users = Array.isArray(result.data.users) ? result.data.users : [];
  const blocks = users.map((user) => searchBlock(asRecord(user))).filter((block) => block.length > 0);
  const window = windowBlocks(blocks, resume.cursor.skip, resume.cursor.offset);
  if (!window.ok) return invalidPageToken();
  const token = stringField(result.data, "page_token");
  const next = result.data.has_more === true && token.length > 0 ? token : null;
  if (window.consumed) {
    const body = "no matching colleagues";
    return { kind: "done", text: finishRows([], [], pageTokenFooter(next), "", body), isError: false };
  }
  const decision = fitPage([], [], window.blocks, window.skip, window.offset, resume.cursor.token, next);
  if (decision.invalid) return invalidPageToken();
  const early = renderFit(decision, "no matching colleagues");
  if (early !== null) return { kind: "done", text: early, isError: false };
  return { kind: "done", text: finishRows(decision.blocks, decision.replays, pageTokenFooter(next), "", "no matching colleagues"), isError: false };
}

export function callGetUser(env: Env, openId: string, args: GetUserArgs): Promise<CallToolResult> {
  const idType = chosenIdType(args.id_type);
  return runTool(env, openId, "get_user", args.user_id, (client, accessToken, backend) => {
    if (!idType) return Promise.resolve({ kind: "done", text: ID_TYPE_ERROR, isError: true });
    if (args.user_id.length === 0) return Promise.resolve({ kind: "done", text: "user_id is required", isError: true });
    return byBackend(
      backend,
      () => {
        if (idType !== "open_id") return Promise.resolve({ kind: "done" as const, text: "id_type must be open_id", isError: true as const });
        return callFeishuMcp(client, accessToken, "get-user", { open_id: args.user_id });
      },
      () => getUserOpenApi(client, accessToken, args.user_id, idType),
    );
  });
}

export function callSearchUsers(env: Env, openId: string, args: SearchUsersArgs): Promise<CallToolResult> {
  return runTool(env, openId, "search_users", null, (client, accessToken, backend) =>
    byBackend(
      backend,
      () => callFeishuMcp(client, accessToken, "search-user", { query: args.query, page_token: args.page_token }),
      () => searchOpenApi(client, accessToken, args),
    ),
  );
}
