import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isRedirectAllowed } from "../src/redirects";
import { sealStateCookie, stateCookieName } from "../src/auth/state-cookie";
import { SPEC_SCOPES } from "./spec-scopes";
import { approveLogin, CLAUDE_REDIRECT, CookieJar, finishLogin, PUBLIC_URL, registerClient, useFakeFeishu, workerFetch } from "./support";

const fake = useFakeFeishu();

describe("oauth", () => {
  it("challenges /mcp with protected-resource metadata", async () => {
    const resource = `${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`;
    for (const method of ["GET", "POST"] as const) {
      const response = await workerFetch("/mcp", { method, headers: { accept: "application/json, text/event-stream" }, body: method === "POST" ? "{}" : undefined });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate") ?? "").toContain(resource);
    }
  });

  it("publishes resource metadata and authorization-server metadata", async () => {
    const resource = await workerFetch("/.well-known/oauth-protected-resource/mcp");
    expect(resource.status).toBe(200);
    const resourceBody = (await resource.json()) as { resource?: string };
    expect(resourceBody.resource).toBe(`${PUBLIC_URL}/mcp`);

    const metadata = await workerFetch("/.well-known/oauth-authorization-server");
    expect(metadata.status).toBe(200);
    const body = (await metadata.json()) as {
      code_challenge_methods_supported?: string[];
      authorization_response_iss_parameter_supported?: boolean;
      client_id_metadata_document_supported?: boolean;
      token_endpoint_auth_methods_supported?: string[];
    };
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.authorization_response_iss_parameter_supported).toBe(true);
    expect(body.client_id_metadata_document_supported).toBe(true);
    expect(body.token_endpoint_auth_methods_supported).toContain("none");
  });

  it("registers the allowlisted redirects and refuses an evil one", async () => {
    await expect(registerClient([CLAUDE_REDIRECT])).resolves.toEqual(expect.any(String));
    await expect(registerClient(["https://chatgpt.com/connector_platform_oauth_redirect"], "ChatGPT")).resolves.toEqual(expect.any(String));
    await expect(registerClient(["https://chatgpt.com/connector/oauth/callback"], "ChatGPT")).resolves.toEqual(expect.any(String));
    const evil = await workerFetch("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://evil.example/cb"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(evil.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses authorize for a redirect that is not allowlisted", async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT]);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://evil.example/cb",
      code_challenge: "abc",
      code_challenge_method: "S256",
      resource: `${PUBLIC_URL}/mcp`,
    });
    const response = await workerFetch(`/authorize?${params.toString()}`);
    expect(response.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it("shows the approval page and redirects to Feishu with the pinned scope", async () => {
    const approved = await approveLogin();
    expect(approved.pageHtml).toContain("Claude");
    expect(approved.pageHtml).toContain("claude.ai");
    expect(approved.pageHtml).toContain("Approve");
    expect(approved.feishu.hostname).toBe("accounts.feishu.cn");
    expect(approved.feishu.pathname).toBe("/open-apis/authen/v1/authorize");
    expect(approved.feishu.searchParams.get("client_id")).toBe("cli_test");
    expect(approved.feishu.searchParams.get("redirect_uri")).toBe(`${PUBLIC_URL}/callback`);
    expect(approved.feishu.searchParams.get("code_challenge")).toBeNull();
    expect(approved.feishu.searchParams.get("code_challenge_method")).toBeNull();
    expect(approved.feishu.searchParams.get("prompt")).toBeNull();
    expect(approved.feishu.searchParams.get("state")).toBeTruthy();
    const scope = approved.feishu.searchParams.get("scope")?.split(" ") ?? [];
    expect(new Set(scope)).toEqual(new Set(SPEC_SCOPES));
    expect(scope).toHaveLength(25);
  });

  it("completes two overlapping Feishu logins from the same browser", async () => {
    const claude = await registerClient([CLAUDE_REDIRECT], "Claude");
    const chatgpt = await registerClient(["https://chatgpt.com/connector_platform_oauth_redirect"], "ChatGPT");
    const jar = new CookieJar();
    const first = await approveLogin(CLAUDE_REDIRECT, { jar, clientId: claude });
    const second = await approveLogin("https://chatgpt.com/connector_platform_oauth_redirect", { jar, clientId: chatgpt });
    expect(first.stateCookie.startsWith("__Host-")).toBe(true);
    expect(second.stateCookie.startsWith("__Host-")).toBe(true);
    expect(first.stateCookie.split("=", 1)[0]).not.toBe(second.stateCookie.split("=", 1)[0]);
    for (const cookie of [first.stateCookie, second.stateCookie]) {
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Max-Age=600");
      expect(cookie.toLowerCase()).not.toContain("domain=");
    }
    const firstCallback = await workerFetch(`/callback?code=auth-code&state=${encodeURIComponent(first.feishu.searchParams.get("state") ?? "")}`, {
      headers: { cookie: jar.header() },
    });
    expect(firstCallback.status).toBe(302);
    const secondCallback = await workerFetch(`/callback?code=auth-code-2&state=${encodeURIComponent(second.feishu.searchParams.get("state") ?? "")}`, {
      headers: { cookie: jar.header() },
    });
    expect(secondCallback.status).toBe(302);
    expect(fake.calls.filter((call) => call.url.includes("/oauth/v3/token"))).toHaveLength(2);
  });

  it("rejects a forged, expired, or replayed callback without calling Feishu", async () => {
    const forgedName = await stateCookieName("abc");
    const forged = await workerFetch("/callback?code=x&state=abc", { headers: { cookie: `${forgedName}=forged` } });
    expect(forged.status).toBe(400);
    expect(fake.calls).toHaveLength(0);

    const sealed = await sealStateCookie({ state: "stale", exp: Date.now() - 1000, nonce: "nonce" }, env.COOKIE_SECRET);
    const expiredName = await stateCookieName("stale");
    const expired = await workerFetch("/callback?code=x&state=stale", { headers: { cookie: `${expiredName}=${sealed}` } });
    expect(expired.status).toBe(400);
    expect(fake.calls).toHaveLength(0);

    const approved = await approveLogin();
    const state = approved.feishu.searchParams.get("state");
    const cookie = approved.jar.header();
    const first = await workerFetch(`/callback?code=auth-code&state=${encodeURIComponent(state ?? "")}`, { headers: { cookie } });
    expect(first.status).toBe(302);
    const tokenCalls = fake.calls.filter((call) => call.url.includes("/oauth/v3/token")).length;
    const replay = await workerFetch(`/callback?code=auth-code&state=${encodeURIComponent(state ?? "")}`, { headers: { cookie } });
    expect(replay.status).toBe(400);
    expect(fake.calls.filter((call) => call.url.includes("/oauth/v3/token"))).toHaveLength(tokenCalls);
  });

  it("completes ChatGPT login when Feishu rejects an S256 code_verifier", async () => {
    const approved = await approveLogin("https://chatgpt.com/connector_platform_oauth_redirect");
    expect(approved.feishu.searchParams.get("code_challenge")).toBeNull();
    expect(approved.feishu.searchParams.get("code_challenge_method")).toBeNull();
    const done = await finishLogin(approved);
    const tokenCall = fake.calls.find((call) => call.url.includes("/oauth/v3/token") && call.body.includes("authorization_code"));
    const params = new URLSearchParams(tokenCall?.body ?? "");
    expect(params.get("code_verifier")).toBeNull();
    expect(params.get("redirect_uri")).toBe(`${PUBLIC_URL}/callback`);
    expect(done.callbackLocation).toContain("https://chatgpt.com/connector_platform_oauth_redirect");
  });

  it("completes login, stores tokens, and audits auth_ok", async () => {
    const logs: string[] = [];
    const spy = viSpy(logs);
    const approved = await approveLogin();
    const done = await finishLogin(approved);
    const tokenCall = fake.calls.find((call) => call.url.includes("/oauth/v3/token") && call.body.includes("authorization_code"));
    expect(tokenCall).toBeTruthy();
    const params = new URLSearchParams(tokenCall?.body ?? "");
    expect(params.get("client_secret")).toBe("test-app-secret");
    expect(params.get("code_verifier")).toBeNull();
    expect(params.get("redirect_uri")).toBe(`${PUBLIC_URL}/callback`);
    const clientUrl = new URL(done.callbackLocation);
    expect(clientUrl.searchParams.get("code")).toBeTruthy();
    expect(clientUrl.searchParams.get("iss")).toBeTruthy();
    const status = await env.FEISHU_TOKENS.getByName("ou_owner").status();
    expect(status.stored).toBe(true);
    expect(logs.some((line) => line.includes('"event":"auth_ok"'))).toBe(true);
    const helpers = env.OAUTH_PROVIDER;
    expect(helpers).toBeTruthy();
    const unwrapped = await helpers?.unwrapToken(done.accessToken);
    expect(unwrapped?.grant.props).toEqual({ openId: "ou_owner" });
    expect(JSON.stringify(unwrapped?.grant.props)).not.toContain("ur-refresh");
    spy.mockRestore();
  });

  it("rejects another open_id and shows the caller's open_id when the owner is unset", async () => {
    fake.openId = "ou_other";
    const approved = await approveLogin();
    const state = approved.feishu.searchParams.get("state") ?? "";
    const rejected = await workerFetch(`/callback?code=auth-code&state=${encodeURIComponent(state)}`, { headers: { cookie: approved.jar.header() } });
    expect(rejected.status).toBe(403);
    const rejectedBody = await rejected.text();
    expect(rejectedBody).not.toContain("ou_other");
    expect((await env.FEISHU_TOKENS.getByName("ou_other").status()).stored).toBe(false);
    expect((await env.FEISHU_TOKENS.getByName("ou_owner").status()).stored).toBe(false);

    env.OWNER_OPEN_ID = "";
    fake.reset();
    installAgain();
    fake.openId = "ou_bootstrap";
    const second = await approveLogin();
    const bootstrapState = second.feishu.searchParams.get("state") ?? "";
    const bootstrap = await workerFetch(`/callback?code=auth-code&state=${encodeURIComponent(bootstrapState)}`, { headers: { cookie: second.jar.header() } });
    expect(bootstrap.status).toBe(403);
    expect(await bootstrap.text()).toContain("ou_bootstrap");
    expect((await env.FEISHU_TOKENS.getByName("ou_bootstrap").status()).stored).toBe(false);
  });

  it("answers a dead refresh token with invalid_grant", async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT]);
    const response = await workerFetch("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "dead", client_id: clientId }).toString(),
    });
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("invalid_grant");
  });
});

function viSpy(logs: string[]) {
  const spy = consoleSpy();
  return spy;
  function consoleSpy() {
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
      original.apply(console, args);
    };
    return { mockRestore: () => { console.log = original; } };
  }
}

function installAgain(): void {
  fake.reset();
}
