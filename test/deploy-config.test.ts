import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { approveLogin, finishLogin, useFakeFeishu, workerFetch } from "./support";
import { grantUserId } from "../src/auth/grants";

const fake = useFakeFeishu();
const REQUEST_ORIGIN = "https://connector.example";
const PINNED_ORIGIN = "https://pinned.example";

describe("PUBLIC_URL", () => {
  it("advertises the request origin when PUBLIC_URL is unset", async () => {
    Reflect.deleteProperty(env, "PUBLIC_URL");

    const metadata = await workerFetch("/.well-known/oauth-protected-resource/mcp", undefined, REQUEST_ORIGIN);
    expect(metadata.status).toBe(200);
    const body = (await metadata.json()) as { resource?: string };
    expect(body.resource).toBe(`${REQUEST_ORIGIN}/mcp`);
    await expectAuthorizationServer(REQUEST_ORIGIN, REQUEST_ORIGIN);

    const challenge = await workerFetch("/mcp", { method: "GET", headers: { accept: "application/json, text/event-stream" } }, REQUEST_ORIGIN);
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate") ?? "").toContain(
      `resource_metadata="${REQUEST_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );

    const approved = await approveLogin(undefined, undefined, { requestOrigin: REQUEST_ORIGIN });
    expect(approved.feishu.searchParams.get("redirect_uri")).toBe(`${REQUEST_ORIGIN}/callback`);
    expect(fake.calls).toHaveLength(0);
  });

  it("advertises the request origin when PUBLIC_URL is empty", async () => {
    Object.assign(env, { PUBLIC_URL: "" });

    const metadata = await workerFetch("/.well-known/oauth-protected-resource/mcp", undefined, REQUEST_ORIGIN);
    expect(metadata.status).toBe(200);
    const body = (await metadata.json()) as { resource?: string };
    expect(body.resource).toBe(`${REQUEST_ORIGIN}/mcp`);
    await expectAuthorizationServer(REQUEST_ORIGIN, REQUEST_ORIGIN);

    const challenge = await workerFetch("/mcp", { method: "GET", headers: { accept: "application/json, text/event-stream" } }, REQUEST_ORIGIN);
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate") ?? "").toContain(
      `resource_metadata="${REQUEST_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );

    const approved = await approveLogin(undefined, undefined, { requestOrigin: REQUEST_ORIGIN });
    expect(approved.feishu.searchParams.get("redirect_uri")).toBe(`${REQUEST_ORIGIN}/callback`);
    expect(fake.calls).toHaveLength(0);
  });

  it("uses a configured PUBLIC_URL instead of the request origin", async () => {
    Object.assign(env, { PUBLIC_URL: PINNED_ORIGIN });

    const metadata = await workerFetch("/.well-known/oauth-protected-resource/mcp", undefined, REQUEST_ORIGIN);
    expect(metadata.status).toBe(200);
    const body = (await metadata.json()) as { resource?: string };
    expect(body.resource).toBe(`${PINNED_ORIGIN}/mcp`);
    await expectAuthorizationServer(REQUEST_ORIGIN, PINNED_ORIGIN);

    const challenge = await workerFetch("/mcp", { method: "GET", headers: { accept: "application/json, text/event-stream" } }, REQUEST_ORIGIN);
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate") ?? "").toContain(
      `resource_metadata="${PINNED_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );

    const approved = await approveLogin(undefined, undefined, { requestOrigin: REQUEST_ORIGIN, resourceOrigin: PINNED_ORIGIN });
    expect(approved.feishu.searchParams.get("redirect_uri")).toBe(`${PINNED_ORIGIN}/callback`);
    expect(fake.calls).toHaveLength(0);
  });

  it("allows the request origin and rejects a foreign Origin when PUBLIC_URL is empty", async () => {
    Object.assign(env, { PUBLIC_URL: "" });
    const approved = await approveLogin(undefined, undefined, { requestOrigin: REQUEST_ORIGIN });
    const session = await finishLogin(approved);
    const allowed = await postMcp(session.accessToken, REQUEST_ORIGIN, REQUEST_ORIGIN);
    expect(allowed.status).not.toBe(403);
    const rejected = await postMcp(session.accessToken, "https://evil.example", REQUEST_ORIGIN);
    expect(rejected.status).toBe(403);
    expect(await rejected.text()).toContain("Invalid Origin: evil.example");
  });

  it("allows the pinned origin and rejects the request host when PUBLIC_URL is set", async () => {
    Object.assign(env, { PUBLIC_URL: PINNED_ORIGIN });
    const approved = await approveLogin(undefined, undefined, { requestOrigin: REQUEST_ORIGIN, resourceOrigin: PINNED_ORIGIN });
    const session = await finishLogin(approved);
    const allowed = await postMcp(session.accessToken, PINNED_ORIGIN, REQUEST_ORIGIN);
    expect(allowed.status).not.toBe(403);
    const rejected = await postMcp(session.accessToken, REQUEST_ORIGIN, REQUEST_ORIGIN);
    expect(rejected.status).toBe(403);
    expect(await rejected.text()).toContain("Invalid Origin: connector.example");
  });
});

describe("owner bootstrap", () => {
  it("shows the caller's open_id and grants nothing when the owner is unset or not an open_id", async () => {
    for (const owner of ["", "pending"]) {
      Object.assign(env, { OWNER_OPEN_ID: owner });
      fake.openId = "ou_bootstrap";
      const approved = await approveLogin();
      const state = approved.feishu.searchParams.get("state") ?? "";
      const response = await workerFetch(`/callback?code=auth-code&state=${encodeURIComponent(state)}`, {
        headers: { cookie: approved.jar.header() },
      });
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("ou_bootstrap");
      expect((await env.FEISHU_TOKENS.getByName("ou_bootstrap").status()).stored).toBe(false);
      const helpers = env.OAUTH_PROVIDER;
      expect(helpers).toBeTruthy();
      const grants = await helpers!.listUserGrants(grantUserId("ou_bootstrap"));
      expect(grants.items).toHaveLength(0);
      fake.reset();
    }
  });
});

async function expectAuthorizationServer(requestOrigin: string, origin: string): Promise<void> {
  const response = await workerFetch("/.well-known/oauth-authorization-server", undefined, requestOrigin);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { issuer?: string; authorization_endpoint?: string; token_endpoint?: string };
  expect(body.issuer).toBe(origin);
  expect(body.authorization_endpoint).toBe(`${origin}/authorize`);
  expect(body.token_endpoint).toBe(`${origin}/token`);
}

function postMcp(token: string, origin: string, requestOrigin: string): Promise<Response> {
  return workerFetch(
    "/mcp",
    {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        origin,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "vitest", version: "0" } },
      }),
    },
    requestOrigin,
  );
}
