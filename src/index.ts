import { createMcpHandler } from "agents/mcp/server";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { audit } from "./audit";
import { handleAuth } from "./auth/handler";
import { disabledPage } from "./auth/pages";
import type { Env } from "./env";
import { isDisabled } from "./flags";
import { createFeishuServer, SERVER_INSTRUCTIONS } from "./mcp/server";
import { requestContext } from "./request-store";
import { registrationDecision } from "./redirects";
import { FeishuTokenStore } from "./tokens/store";

const YEAR_SECONDS = 365 * 24 * 60 * 60;
const providers = new Map<string, OAuthProvider<Env>>();

function resourceMetadataUrl(env: Env): string {
  return `${env.PUBLIC_URL.replace(/\/$/, "")}/.well-known/oauth-protected-resource/mcp`;
}

function invalidToken(env: Env): Response {
  return new Response(JSON.stringify({ error: "invalid_token" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "www-authenticate": `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl(env)}"`,
    },
  });
}

function propsOpenId(props: unknown): string | null {
  if (typeof props !== "object" || props === null || !("openId" in props)) return null;
  const openId = props.openId;
  return typeof openId === "string" && openId.length > 0 ? openId : null;
}

function originHostnames(env: Env): string[] {
  const host = new URL(env.PUBLIC_URL).hostname;
  return ["claude.ai", "www.claude.ai", "chatgpt.com", "www.chatgpt.com", host, "localhost", "127.0.0.1"];
}

function disabledMcp(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "disabled by owner" },
    }),
    { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}

function getProvider(env: Env): OAuthProvider<Env> {
  const key = `${env.PUBLIC_URL}\n${env.ALLOWED_REDIRECT_URIS}`;
  const cached = providers.get(key);
  if (cached) return cached;
  const allowlist = env.ALLOWED_REDIRECT_URIS;
  const mcp = createMcpHandler(
    (ctx) => {
      const stored = requestContext.getStore();
      if (!stored) return createFeishuServer(env, "");
      return createFeishuServer(stored.env, stored.openId);
    },
    { route: "/mcp", allowedOriginHostnames: originHostnames(env) },
  );
  const provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(request, handlerEnv, ctx) {
        const openId = propsOpenId(ctx.props);
        if (!openId || openId !== handlerEnv.OWNER_OPEN_ID) return invalidToken(handlerEnv);
        const status = await handlerEnv.FEISHU_TOKENS.getByName(openId).status();
        if (!status.stored || status.reauthRequired) return invalidToken(handlerEnv);
        return requestContext.run({ env: handlerEnv, openId }, () => mcp(request, handlerEnv, ctx));
      },
    },
    defaultHandler: { fetch: (request, handlerEnv) => handleAuth(request, handlerEnv) },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    refreshTokenTTL: YEAR_SECONDS,
    scopesSupported: ["offline_access"],
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: { resource: `${env.PUBLIC_URL.replace(/\/$/, "")}/mcp` },
    clientRegistrationCallback: (options) => registrationDecision(options.clientMetadata, allowlist),
  });
  providers.set(key, provider);
  return provider;
}

function killSwitchResponse(request: Request): Response {
  audit({ event: "killswitch_block" });
  const path = new URL(request.url).pathname;
  if (path === "/mcp") return disabledMcp();
  return disabledPage();
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (isDisabled(env.MCP_DISABLED) && (path === "/mcp" || path === "/authorize" || path === "/callback")) {
      return killSwitchResponse(request);
    }
    return getProvider(env).fetch(request, env, ctx);
  },
};

export { FeishuTokenStore, SERVER_INSTRUCTIONS };
export default worker;
