import { createMcpHandler } from "agents/mcp/server";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { audit } from "./audit";
import { configuredOwner, handleAuth, publicOrigin } from "./auth/handler";
import { disabledPage } from "./auth/pages";
import type { Env } from "./env";
import { isDisabled } from "./flags";
import { parseFeishuRegion } from "./feishu/client";
import { createFeishuServer, SERVER_INSTRUCTIONS } from "./mcp/server";
import { requestContext } from "./request-store";
import { corsOriginHostnames, registrationDecision } from "./redirects";
import { FeishuTokenStore } from "./tokens/store";

const YEAR_SECONDS = 365 * 24 * 60 * 60;
const providers = new Map<string, OAuthProvider<Env>>();

function resourceMetadataUrl(publicUrl: string): string {
  return `${publicUrl}/.well-known/oauth-protected-resource/mcp`;
}

function invalidToken(publicUrl: string): Response {
  return new Response(JSON.stringify({ error: "invalid_token" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "www-authenticate": `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl(publicUrl)}"`,
    },
  });
}

function propsOpenId(props: unknown): string | null {
  if (typeof props !== "object" || props === null || !("openId" in props)) return null;
  const openId = props.openId;
  return typeof openId === "string" && openId.length > 0 ? openId : null;
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

function getProvider(env: Env, publicUrl: string): OAuthProvider<Env> {
  const key = `${publicUrl}\n${env.ALLOWED_REDIRECT_URIS}`;
  const cached = providers.get(key);
  if (cached) return cached;
  const allowlist = env.ALLOWED_REDIRECT_URIS;
  const mcp = createMcpHandler(
    (ctx) => {
      const stored = requestContext.getStore();
      if (!stored) return createFeishuServer(env, "");
      return createFeishuServer(stored.env, stored.openId);
    },
    { route: "/mcp", allowedOriginHostnames: corsOriginHostnames(publicUrl, allowlist) },
  );
  const provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(request, handlerEnv, ctx) {
        const openId = propsOpenId(ctx.props);
        const owner = configuredOwner(handlerEnv.OWNER_OPEN_ID);
        if (!openId || owner === null || openId !== owner) return invalidToken(publicUrl);
        const status = await handlerEnv.FEISHU_TOKENS.getByName(openId).status();
        if (!status.stored || status.reauthRequired) return invalidToken(publicUrl);
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
    resourceMetadata: { resource: `${publicUrl}/mcp` },
    clientRegistrationCallback: (options) => registrationDecision(options.clientMetadata, allowlist),
  });
  providers.set(key, provider);
  return provider;
}

function requestAtPublicUrl(request: Request, publicUrl: string): Request {
  const url = new URL(request.url);
  const pinned = new URL(publicUrl);
  if (url.origin === pinned.origin) return request;
  url.protocol = pinned.protocol;
  url.host = pinned.host;
  const headers = new Headers(request.headers);
  headers.set("host", pinned.host);
  const init: RequestInit = { method: request.method, headers, redirect: request.redirect };
  if (request.body !== null) init.body = request.body;
  return new Request(url, init);
}

function invalidRegionResponse(): Response {
  audit({ event: "invalid_region" });
  return new Response("invalid FEISHU_REGION", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function killSwitchResponse(request: Request): Response {
  audit({ event: "killswitch_block" });
  const path = new URL(request.url).pathname;
  if (path === "/mcp") return disabledMcp();
  return disabledPage();
}

let oauthHelpersOrigin: string | undefined;

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (parseFeishuRegion(env.FEISHU_REGION) === null) return invalidRegionResponse();
    const path = new URL(request.url).pathname;
    if (isDisabled(env.MCP_DISABLED) && (path === "/mcp" || path === "/authorize" || path === "/callback")) {
      return killSwitchResponse(request);
    }
    const publicUrl = publicOrigin(env, request);
    // The library installs OAuth helpers once and then refuses to replace them.
    // A second origin must drop those helpers so authorize sees its own resource.
    if (oauthHelpersOrigin !== publicUrl) {
      env.OAUTH_PROVIDER = undefined;
      oauthHelpersOrigin = publicUrl;
    }
    return getProvider(env, publicUrl).fetch(requestAtPublicUrl(request, publicUrl), env, ctx);
  },
};

export { FeishuTokenStore, SERVER_INSTRUCTIONS };
export default worker;
