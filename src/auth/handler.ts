import { AuthorizationError, CimdFetchError, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { audit } from "../audit";
import type { Env } from "../env";
import { bytesToBase64Url } from "../encoding";
import { exchangeToken, feishuAuthorizeUrl, readUserInfo } from "../feishu/api";
import { FeishuClient } from "../feishu/client";
import { feishuScopeString } from "../scopes";
import { isRedirectAllowed } from "../redirects";
import { grantUserId } from "./grants";
import { configuredOwner } from "./open-id";
import { approvalPage, bootstrapDeniedPage, forbiddenPage } from "./pages";
import { openStateCookie, readCookie, sealStateCookie, stateCookieHeader, stateCookieName, stateExpiry } from "./state-cookie";

export { configuredOwner };

export function publicOrigin(env: Env, request: Request): string {
  const configured = env.PUBLIC_URL.trim();
  if (configured.length === 0) return new URL(request.url).origin;
  return new URL(configured).origin;
}

function callbackUrl(env: Env, request: Request): string {
  return `${publicOrigin(env, request)}/callback`;
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function logLoginFailure(fields: { code: string | number; feishu_code?: number; error_description?: string } | { name: string; message: string }): void {
  console.error(JSON.stringify({ event: "login_failed", ...fields }));
}

function scrubFeishuDescription(description: string, secrets: readonly string[]): string {
  let text = description;
  for (const secret of secrets) {
    if (secret.length >= 8) text = text.split(secret).join("[redacted]");
  }
  text = text.replace(/bearer\s+\S+/gi, "bearer [redacted]");
  text = text.replace(/https?:\/\/\S+/g, "[url]");
  text = text.replace(/\S+@\S+/g, "[redacted]");
  text = text.replace(/code=[^\s&]+/gi, "code=[redacted]");
  text = text.replace(/[A-Za-z0-9_-]{20,}/g, "[redacted]");
  return text.trim();
}

function publicErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  return scrubErrorMessage(error.message);
}

function scrubErrorMessage(message: string): string {
  if (message.length === 0) return "unknown";
  if (/code=/i.test(message) || /bearer\s+\S+/i.test(message) || /token|secret|password|authorization/i.test(message) || message.includes("@")) {
    return "error";
  }
  const scrubbed = message.replace(/https?:\/\/\S+/g, "[url]");
  return scrubbed.length === 0 ? "unknown" : scrubbed;
}

function redirect(location: string, headers: Headers): Response {
  const next = new Headers(headers);
  next.set("location", location);
  next.set("cache-control", "no-store");
  return new Response(null, { status: 302, headers: next });
}

async function startUpstream(env: Env, oauth: OAuthHelpers, request: AuthRequest, headers: Headers, incoming: Request): Promise<Response> {
  const upstream = await oauth.beginUpstream(request, { headers });
  const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const sealed = await sealStateCookie({ state: upstream.state, exp: stateExpiry(), nonce }, env.COOKIE_SECRET);
  upstream.headers.append("set-cookie", stateCookieHeader(await stateCookieName(upstream.state), sealed));
  const location = feishuAuthorizeUrl({
    clientId: env.FEISHU_APP_ID,
    redirectUri: callbackUrl(env, incoming),
    scope: feishuScopeString(),
    state: upstream.state,
  });
  return redirect(location, upstream.headers);
}

async function handleAuthorize(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  if (request.method === "POST") return handleDecision(request, env, oauth);
  let authRequest: AuthRequest;
  try {
    authRequest = await oauth.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.redirectTo && error.redirectUri && isRedirectAllowed(error.redirectUri, env.ALLOWED_REDIRECT_URIS)) {
        return Response.redirect(error.redirectTo, 302);
      }
      return text(error.description || "invalid request", 400);
    }
    if (error instanceof CimdFetchError) return text("client metadata unavailable", 400);
    return text("invalid request", 400);
  }
  if (!isRedirectAllowed(authRequest.redirectUri, env.ALLOWED_REDIRECT_URIS)) return text("redirect URI is not allowed", 400);

  const remembered = await oauth.isConsentRemembered(request, authRequest, { secret: env.COOKIE_SECRET });
  if (remembered) return startUpstream(env, oauth, authRequest, new Headers(), request);
  const consent = await oauth.beginConsent(authRequest);
  const described = await oauth.describeConsent(authRequest);
  const page = approvalPage({ clientName: described.clientName, redirectHost: described.redirectHost, handle: consent.handle });
  const headers = new Headers(page.headers);
  for (const cookie of consent.headers.getSetCookie()) headers.append("set-cookie", cookie);
  return new Response(page.body, { status: page.status, headers });
}

async function handleDecision(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  const form = await request.formData();
  const handle = form.get("handle");
  const decision = form.get("decision");
  if (typeof handle !== "string" || handle.length === 0) return text("invalid request", 400);
  if (decision === "deny") {
    const denied = await oauth.denyConsent(request, handle);
    return redirect(denied.redirectTo, denied.headers);
  }
  const approved = await oauth.approveConsent(request, handle, {
    scope: ["offline_access"],
    remember: { secret: env.COOKIE_SECRET },
  });
  return startUpstream(env, oauth, approved.request, approved.headers, request);
}

async function handleCallback(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const sealed = state ? readCookie(request, await stateCookieName(state)) : null;
  const payload = sealed ? await openStateCookie(sealed, env.COOKIE_SECRET) : null;
  if (!payload || !state || payload.state !== state || Date.now() > payload.exp) return text("invalid state", 400);
  const fresh = await env.FEISHU_TOKENS.getByName("__oauth_state__").consumeNonce(payload.nonce);
  if (!fresh) return text("invalid state", 400);

  let upstream: Awaited<ReturnType<OAuthHelpers["finishUpstream"]>>;
  try {
    upstream = await oauth.finishUpstream(request);
  } catch (error) {
    if (error instanceof AuthorizationError) return text("invalid state", 400);
    return text("invalid state", 400);
  }
  if (url.searchParams.get("error")) {
    return redirect(authorizationErrorRedirect(upstream.request, "access_denied"), upstream.headers);
  }
  const code = url.searchParams.get("code");
  if (!code) return text("missing code", 400);

  const client = new FeishuClient();
  const exchanged = await exchangeToken(
    client,
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.FEISHU_APP_ID,
      client_secret: env.FEISHU_APP_SECRET,
      code,
      redirect_uri: callbackUrl(env, request),
    }),
  );
  if (exchanged.kind !== "ok") {
    const errorDescription = exchanged.errorDescription ? scrubFeishuDescription(exchanged.errorDescription, [code, env.FEISHU_APP_SECRET]) : "";
    logLoginFailure({
      code: exchanged.code,
      ...(typeof exchanged.feishuCode === "number" && String(exchanged.feishuCode) !== exchanged.code ? { feishu_code: exchanged.feishuCode } : {}),
      ...(errorDescription.length > 0 ? { error_description: errorDescription } : {}),
    });
    return text("login failed", 502);
  }

  const info = await readUserInfo(client, exchanged.token.accessToken);
  if (info.code !== 0 || !info.openId) {
    logLoginFailure({ code: info.code });
    return text("login failed", 502);
  }

  const owner = configuredOwner(env.OWNER_OPEN_ID);
  if (owner === null) {
    audit({ event: "auth_rejected" });
    return bootstrapDeniedPage(info.openId);
  }
  if (info.openId !== owner) {
    audit({ event: "auth_rejected" });
    return forbiddenPage();
  }

  await env.FEISHU_TOKENS.getByName(info.openId).putTokens({
    accessToken: exchanged.token.accessToken,
    refreshToken: exchanged.token.refreshToken,
    expiresIn: exchanged.token.expiresIn,
    refreshExpiresIn: exchanged.token.refreshExpiresIn,
    scope: exchanged.token.scope,
  });
  const completed = await oauth.completeAuthorization({
    request: upstream.request,
    userId: grantUserId(info.openId),
    metadata: {},
    scope: upstream.request.scope.length > 0 ? upstream.request.scope : ["offline_access"],
    props: { openId: info.openId },
  });
  audit({ event: "auth_ok" });
  return redirect(completed.redirectTo, upstream.headers);
}

export async function handleAuth(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth) return text("oauth unavailable", 500);
  const path = new URL(request.url).pathname;
  try {
    if (path === "/authorize") return await handleAuthorize(request, env, oauth);
    if (path === "/callback") return await handleCallback(request, env, oauth);
    return text("not found", 404);
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    logLoginFailure({ name, message: publicErrorMessage(error) });
    return text("login failed", 500);
  }
}
