import { env, exports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach } from "vitest";
import { FakeFeishu, installFake, uninstallFake } from "./fake-feishu";

export const PUBLIC_URL = "https://example.workers.dev";
export const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

export function restoreEnv(): void {
  env.FEISHU_APP_ID = "cli_test";
  env.FEISHU_APP_SECRET = "test-app-secret";
  env.OWNER_OPEN_ID = "ou_owner";
  env.COOKIE_SECRET = "test-cookie-secret-32-characters-min";
  env.FEISHU_REGION = "feishu";
  env.MCP_DISABLED = "0";
  env.TOOL_BACKENDS = "";
  env.P2P_DISCOVERY = "";
}

export function logLines(): { lines: () => string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  return {
    lines: () => lines,
    restore: () => {
      console.log = original;
    },
  };
}

export function useFakeFeishu(): FakeFeishu {
  const fake = new FakeFeishu();
  beforeEach(async () => {
    await reset();
    restoreEnv();
    fake.reset();
    installFake(fake);
  });
  afterEach(() => {
    uninstallFake();
  });
  return fake;
}

export class CookieJar {
  private readonly jar = new Map<string, string>();

  absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

export function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(path, PUBLIC_URL);
  const headers = new Headers(init?.headers);
  if (!headers.has("host")) headers.set("host", url.host);
  return exports.default.fetch(new Request(url, { redirect: "manual", ...init, headers }));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function clientPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export async function registerClient(redirectUris: string[], clientName = "Claude"): Promise<string> {
  const response = await workerFetch("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`register ${response.status} ${text}`);
  const body = JSON.parse(text) as { client_id?: string };
  if (!body.client_id) throw new Error(`register missing client_id ${text}`);
  return body.client_id;
}

export async function authorizeUrl(clientId: string, redirectUri: string, challenge: string): Promise<string> {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${PUBLIC_URL}/mcp`,
    state: "client-state",
  });
  return `/authorize?${params.toString()}`;
}

export interface ApprovedLogin {
  clientId: string;
  verifier: string;
  challenge: string;
  jar: CookieJar;
  feishu: URL;
  redirectUri: string;
  pageHtml: string;
  stateCookie: string;
}

export async function approveLogin(
  redirectUri = CLAUDE_REDIRECT,
  shared?: { jar: CookieJar; clientId: string },
): Promise<ApprovedLogin> {
  const clientId = shared?.clientId ?? (await registerClient([redirectUri]));
  const { verifier, challenge } = await clientPkce();
  const jar = shared?.jar ?? new CookieJar();
  const page = await workerFetch(await authorizeUrl(clientId, redirectUri, challenge), { headers: { cookie: jar.header() } });
  jar.absorb(page);
  const pageHtml = await page.text();
  if (page.status !== 200) throw new Error(`authorize page ${page.status} ${pageHtml.slice(0, 300)}`);
  const handle = /name="handle" value="([^"]+)"/.exec(pageHtml)?.[1];
  if (!handle) throw new Error(`approval page missing handle ${pageHtml.slice(0, 300)}`);
  const approved = await workerFetch("/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: new URLSearchParams({ handle, decision: "approve" }).toString(),
  });
  jar.absorb(approved);
  const location = approved.headers.get("location");
  if (approved.status !== 302 || !location) {
    throw new Error(`approve ${approved.status} ${location ?? ""} ${await approved.text()}`);
  }
  const stateCookie = approved.headers.getSetCookie().find((cookie) => cookie.includes("feishu-state")) ?? "";
  return { clientId, verifier, challenge, jar, feishu: new URL(location), redirectUri, pageHtml, stateCookie };
}

export async function finishLogin(approved: ApprovedLogin, code = "auth-code"): Promise<{ accessToken: string; callbackLocation: string }> {
  const state = approved.feishu.searchParams.get("state");
  if (!state) throw new Error("feishu redirect missing state");
  const callback = await workerFetch(`/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
    headers: { cookie: approved.jar.header() },
  });
  const callbackLocation = callback.headers.get("location");
  if (callback.status !== 302 || !callbackLocation) {
    throw new Error(`callback ${callback.status} ${callbackLocation ?? ""} ${await callback.text()}`);
  }
  const clientUrl = new URL(callbackLocation);
  const authCode = clientUrl.searchParams.get("code");
  if (!authCode) throw new Error(`client redirect missing code ${callbackLocation}`);
  const token = await workerFetch("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: approved.redirectUri,
      client_id: approved.clientId,
      code_verifier: approved.verifier,
      resource: `${PUBLIC_URL}/mcp`,
    }).toString(),
  });
  const text = await token.text();
  const body = JSON.parse(text) as { access_token?: string };
  if (!body.access_token) throw new Error(`token ${token.status} ${text}`);
  return { accessToken: body.access_token, callbackLocation };
}

export async function login(redirectUri = CLAUDE_REDIRECT): Promise<{ accessToken: string; approved: ApprovedLogin }> {
  const approved = await approveLogin(redirectUri);
  const done = await finishLogin(approved);
  return { accessToken: done.accessToken, approved };
}

export function parseRpc(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed) as unknown;
  const data = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0 && line !== "[DONE]");
  const last = data[data.length - 1];
  if (!last) return null;
  return JSON.parse(last) as unknown;
}

export async function postMcp(token: string | null, message: unknown): Promise<{ status: number; body: unknown; www: string | null; raw: string }> {
  const headers = new Headers({ accept: "application/json, text/event-stream", "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await workerFetch("/mcp", { method: "POST", headers, body: JSON.stringify(message) });
  const raw = await response.text();
  return { status: response.status, body: parseRpc(raw), www: response.headers.get("www-authenticate"), raw };
}

export async function initialize(token: string): Promise<unknown> {
  const response = await postMcp(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0.0.1" },
    },
  });
  await postMcp(token, { jsonrpc: "2.0", method: "notifications/initialized" });
  return response.body;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export async function listTools(token: string): Promise<Array<Record<string, unknown>>> {
  await initialize(token);
  const response = await postMcp(token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const result = asRecord(asRecord(response.body).result);
  return Array.isArray(result.tools) ? (result.tools as Array<Record<string, unknown>>) : [];
}

export async function callTool(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ status: number; body: unknown; raw: string }> {
  await initialize(token);
  const response = await postMcp(token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } });
  return response;
}

export function toolText(body: unknown): string {
  const result = asRecord(asRecord(body).result);
  const content = Array.isArray(result.content) ? result.content : [];
  const first = asRecord(content[0]);
  return typeof first.text === "string" ? first.text : "";
}
