import { FeishuClient } from "./client";

export const FEISHU_AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
export const FEISHU_TOKEN_URL = "https://accounts.feishu.cn/oauth/v3/token";
export const FEISHU_USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info";

const PERMANENT_CODES = new Set(["invalid_grant", "20026", "20037", "20064", "20073"]);

export function feishuAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
}): string {
  const url = new URL(FEISHU_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scope);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export interface FeishuAccess {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  scope: string;
}

export type TokenExchange =
  | { kind: "ok"; token: FeishuAccess }
  | { kind: "permanent"; code: string; feishuCode?: number; errorDescription?: string }
  | { kind: "transient"; code: string; feishuCode?: number; errorDescription?: string };

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function codeOf(body: Record<string, unknown>, status: number): string {
  if (typeof body.error === "string" && body.error.length > 0) return body.error;
  if (typeof body.code === "number" || typeof body.code === "string") return String(body.code);
  return String(status);
}

function failureDetails(body: Record<string, unknown>): { feishuCode?: number; errorDescription?: string } {
  const feishuCode = typeof body.code === "number" && Number.isFinite(body.code) ? body.code : undefined;
  const errorDescription = typeof body.error_description === "string" && body.error_description.length > 0 ? body.error_description : undefined;
  return {
    ...(feishuCode !== undefined ? { feishuCode } : {}),
    ...(errorDescription !== undefined ? { errorDescription } : {}),
  };
}

export function classifyTokenResponse(status: number, payload: unknown): TokenExchange {
  const body = asRecord(payload);
  const code = codeOf(body, status);
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : Number.NaN;
  const refreshExpiresIn = typeof body.refresh_token_expires_in === "number" ? body.refresh_token_expires_in : Number.NaN;
  const feishuCode = body.code;
  const successCode = feishuCode === undefined || feishuCode === 0;
  if (accessToken && refreshToken && successCode && Number.isFinite(expiresIn) && Number.isFinite(refreshExpiresIn) && expiresIn > 0 && refreshExpiresIn > 0) {
    const scope = typeof body.scope === "string" ? body.scope : "";
    return { kind: "ok", token: { accessToken, refreshToken, expiresIn, refreshExpiresIn, scope } };
  }
  const details = failureDetails(body);
  if (PERMANENT_CODES.has(code)) return { kind: "permanent", code, ...details };
  return { kind: "transient", code, ...details };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { code: response.status };
  }
}

export async function exchangeToken(client: FeishuClient, params: URLSearchParams): Promise<TokenExchange> {
  const response = await client.request("POST", FEISHU_TOKEN_URL, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const payload = await readJson(response);
  return classifyTokenResponse(response.status, payload);
}

export interface UserInfo {
  code: number;
  name: string;
  openId: string;
}

export async function readUserInfo(client: FeishuClient, accessToken: string): Promise<UserInfo> {
  const response = await client.request("GET", FEISHU_USER_INFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const body = asRecord(await readJson(response));
  const data = asRecord(body.data);
  const code = typeof body.code === "number" ? body.code : response.status;
  const name = typeof data.name === "string" ? data.name : "";
  const openId = typeof data.open_id === "string" ? data.open_id : "";
  return { code, name, openId };
}
