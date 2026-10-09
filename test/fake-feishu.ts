import { argumentError, capturedTool, FEISHU_MCP_TOOLS } from "./mcp-schema";

export const MARKER = "MARKER_feishu_content_9f3a";

export interface RecordedCall {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}

export class FakeFeishu {
  calls: RecordedCall[] = [];
  openId = "ou_owner";
  name = "Owner";
  authExpiresIn = 7200;
  refreshExpiresIn = 7200;
  refreshTokenExpiresIn = 2_592_000;
  delayRefreshMs = 0;
  holdRefresh: Promise<void> | null = null;
  userInfoCodes: number[] = [];
  refreshError: { httpStatus?: number; body: Record<string, unknown> } | null = null;
  extra: ((method: string, url: URL, body: string) => Response | undefined) | null = null;
  private issued = 0;

  reset(): void {
    this.calls = [];
    this.openId = "ou_owner";
    this.name = "Owner";
    this.authExpiresIn = 7200;
    this.refreshExpiresIn = 7200;
    this.refreshTokenExpiresIn = 2_592_000;
    this.delayRefreshMs = 0;
    this.holdRefresh = null;
    this.userInfoCodes = [];
    this.refreshError = null;
    this.extra = null;
    this.issued = 0;
  }

  private issue(expiresIn: number): Record<string, unknown> {
    this.issued += 1;
    return {
      code: 0,
      access_token: `u-access-${this.issued}`,
      refresh_token: `ur-refresh-${this.issued}`,
      expires_in: expiresIn,
      refresh_token_expires_in: this.refreshTokenExpiresIn,
      token_type: "Bearer",
      scope: "offline_access",
    };
  }

  async handle(input: RequestInfo | URL, init: RequestInit | undefined, original: typeof fetch): Promise<Response> {
    const urlString = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlString);
    if (!url.hostname.endsWith("feishu.cn")) return original(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    const recorded: Record<string, string> = {};
    headers.forEach((value, key) => {
      recorded[key] = value;
    });
    this.calls.push({ method, url: url.toString(), body, headers: recorded });
    return this.respond(method, url, body);
  }

  private async respond(method: string, url: URL, body: string): Promise<Response> {
    if (method === "POST" && url.pathname === "/mcp") {
      const problem = mcpArgumentProblem(body);
      if (problem) {
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { isError: true, content: [{ type: "text", text: problem }] },
        });
      }
    }
    const extra = this.extra?.(method, url, body);
    if (extra) return extra;
    const path = url.pathname;
    if (method === "POST" && path === "/oauth/v3/token") {
      const params = new URLSearchParams(body);
      const grant = params.get("grant_type");
      if (grant === "refresh_token") {
        if (this.holdRefresh) await this.holdRefresh;
        if (this.delayRefreshMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayRefreshMs));
        if (this.refreshError) {
          return Response.json(this.refreshError.body, { status: this.refreshError.httpStatus ?? 200 });
        }
        return Response.json(this.issue(this.refreshExpiresIn));
      }
      if (grant === "authorization_code") {
        // Feishu v3 rejects a code_verifier the v1 authorize endpoint did not bind
        // with an 88-byte body: invalid_grant / 20049 / "PKCE code challenge failed."
        if (params.has("code_verifier")) {
          return Response.json(
            { error: "invalid_grant", error_description: "PKCE code challenge failed.", code: 20049 },
            { status: 400 },
          );
        }
        return Response.json(this.issue(this.authExpiresIn));
      }
      throw new Error(`unexpected Feishu token grant: ${grant ?? ""}`);
    }
    if (method === "GET" && path === "/open-apis/wiki/v2/spaces/get_node") {
      return Response.json({ code: 131005, msg: "not found" });
    }
    if (method === "GET" && path === "/open-apis/authen/v1/user_info") {
      const code = this.userInfoCodes.shift() ?? 0;
      if (code !== 0) return Response.json({ code, msg: "token invalid" });
      return Response.json({
        code: 0,
        data: { name: this.name, open_id: this.openId, email: MARKER, avatar_url: MARKER },
      });
    }
    if (method === "GET" && path === "/open-apis/im/v1/chats") {
      return Response.json({
        code: 0,
        data: {
          items: [
            { chat_id: "oc_group", name: MARKER, chat_mode: "group" },
            { chat_id: "oc_p2p", name: MARKER, chat_mode: "p2p" },
          ],
        },
      });
    }
    if (method === "GET" && path === "/open-apis/im/v1/messages") {
      return Response.json({ code: 0, data: { items: [{ body: { content: MARKER } }] } });
    }
    if (method === "POST" && path === "/open-apis/im/v1/messages/search") {
      return Response.json({ code: 0, data: { items: [{ message: MARKER }] } });
    }
    if (method === "POST" && path === "/mcp") {
      const payload = JSON.parse(body) as { method?: string };
      if (payload.method !== "tools/list") throw new Error(`unexpected Feishu MCP method: ${payload.method ?? ""}`);
      return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "fetch-doc" }, { name: "search-doc" }] } });
    }
    throw new Error(`unexpected Feishu request: ${method} ${url.toString()}`);
  }
}

function mcpArgumentProblem(body: string): string | null {
  let payload: { method?: string; params?: { name?: string; arguments?: unknown } };
  try {
    payload = JSON.parse(body) as { method?: string; params?: { name?: string; arguments?: unknown } };
  } catch {
    return null;
  }
  if (payload.method !== "tools/call") return null;
  const name = payload.params?.name;
  if (!name) return "missing tool name";
  if (!FEISHU_MCP_TOOLS.tools.some((tool) => tool.name === name)) return `unknown tool ${name}`;
  return argumentError(capturedTool(name).inputSchema, payload.params?.arguments ?? {});
}

let originalFetch: typeof fetch | null = null;

export function installFake(fake: FakeFeishu): void {
  if (!originalFetch) originalFetch = globalThis.fetch.bind(globalThis);
  const base = originalFetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => fake.handle(input, init, base)) as typeof fetch;
}

export function uninstallFake(): void {
  if (originalFetch) globalThis.fetch = originalFetch;
}
