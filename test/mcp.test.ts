import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { SERVER_INSTRUCTIONS } from "../src/mcp/server";
import { isRedirectAllowed } from "../src/redirects";
import { RECONNECT } from "../src/mcp/tools";
import { MARKER } from "./fake-feishu";
import { approveLogin, callTool, initialize, listTools, logLines, login, postMcp, toolText, useFakeFeishu, workerFetch } from "./support";

const fake = useFakeFeishu();

describe("mcp", () => {
  it("keeps server instructions self-contained", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(512);
    expect(SERVER_INSTRUCTIONS).toContain("cannot send or change messages");
  });

  it("lists whoami and does not list the removed probe", async () => {
    const { accessToken } = await login();
    const listed = await listTools(accessToken);
    const whoami = listed.find((tool) => tool.name === "whoami");
    expect(whoami?.title).toBe("Who am I in Feishu");
    const annotations = whoami?.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean };
    expect(annotations.readOnlyHint).toBe(true);
    expect(annotations.destructiveHint).toBe(false);
    expect(listed.some((tool) => tool.name === "probe_capabilities")).toBe(false);
  });

  it("returns the owner from whoami with one user_info call", async () => {
    const logs = logLines();
    fake.name = MARKER;
    const { accessToken } = await login();
    const before = fake.calls.filter((call) => call.url.includes("/user_info")).length;
    const response = await callTool(accessToken, "whoami");
    const text = toolText(response.body);
    expect(text).toContain(MARKER);
    expect(text).toContain("ou_owner");
    expect(fake.calls.filter((call) => call.url.includes("/user_info"))).toHaveLength(before + 1);
    const toolCalls = logs.lines().filter((line) => line.includes('"event":"tool_call"'));
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toContain('"tool":"whoami"');
    expect(toolCalls[0]).toContain('"target":null');
    expect(toolCalls[0]).toContain('"ok":true');
    expect(toolCalls[0]).toContain('"code":"0"');
    expect(logs.lines().join("\n")).not.toContain(MARKER);
    logs.restore();
  });

  it("rejects a grant whose open_id is no longer the owner", async () => {
    const { accessToken } = await login();
    const before = fake.calls.length;
    env.OWNER_OPEN_ID = "ou_other";
    const response = await postMcp(accessToken, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(401);
    expect(fake.calls).toHaveLength(before);
  });

  it("shares one refresh across two concurrent whoami calls and keeps the rotated token", async () => {
    fake.authExpiresIn = 120;
    fake.refreshExpiresIn = 7200;
    fake.delayRefreshMs = 80;
    const { accessToken } = await login();
    const [first, second] = await Promise.all([callTool(accessToken, "whoami"), callTool(accessToken, "whoami")]);
    expect(toolText(first.body)).toContain("Owner");
    expect(toolText(second.body)).toContain("Owner");
    const refreshes = fake.calls.filter((call) => call.body.includes("grant_type=refresh_token"));
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]?.body).toContain("ur-refresh-1");

    fake.userInfoCodes = [99991677, 0];
    const follow = await callTool(accessToken, "whoami");
    expect(toolText(follow.body)).toContain("Owner");
    const later = fake.calls.filter((call) => call.body.includes("grant_type=refresh_token"));
    expect(later).toHaveLength(2);
    expect(later[1]?.body).toContain("ur-refresh-2");
  });

  it("refreshes once when Feishu reports 99991663", async () => {
    fake.authExpiresIn = 7200;
    const { accessToken } = await login();
    fake.userInfoCodes = [99991663, 0];
    const response = await callTool(accessToken, "whoami");
    expect(toolText(response.body)).toContain("Owner");
    expect(fake.calls.filter((call) => call.body.includes("grant_type=refresh_token"))).toHaveLength(1);
    expect(fake.calls.filter((call) => call.url.includes("/user_info")).length).toBeGreaterThanOrEqual(2);
  });

  it("retries once after Feishu rejects the user token", async () => {
    fake.authExpiresIn = 7200;
    const { accessToken } = await login();
    fake.userInfoCodes = [99991677, 0];
    const response = await callTool(accessToken, "whoami");
    expect(toolText(response.body)).toContain("Owner");
    const refreshes = fake.calls.filter((call) => call.body.includes("grant_type=refresh_token"));
    const userInfo = fake.calls.filter((call) => call.url.includes("/user_info"));
    expect(refreshes).toHaveLength(1);
    expect(userInfo.filter((call) => call.url.includes("/user_info")).length).toBeGreaterThanOrEqual(2);
  });

  it("treats an expired Feishu refresh token as reconnect without calling it a 365-day failure", async () => {
    const logs = logLines();
    fake.refreshTokenExpiresIn = 0.001;
    const { accessToken } = await login();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const response = await callTool(accessToken, "whoami");
    expect(toolText(response.body)).toContain(RECONNECT);
    const reauth = logs.lines().filter((line) => line.includes('"event":"reauth_required"'));
    expect(reauth).toHaveLength(1);
    expect(reauth[0]).toContain('"code":"refresh_expired"');
    expect(reauth[0]).not.toContain("20037");
    logs.restore();
  });

  it("keeps a reauthorization when an older refresh finishes later", async () => {
    await reauthorizeDuringHeldRefresh();
  });

  it("does not clear a reauthorization when an older refresh fails permanently", async () => {
    fake.refreshError = { body: { code: 20037 } };
    const store = await reauthorizeDuringHeldRefresh();
    expect((await store.status()).reauthRequired).toBe(false);
  });

  it("treats refresh error 20026 as a terminal reconnect", async () => {
    const logs = logLines();
    fake.authExpiresIn = 60;
    fake.refreshError = { body: { code: 20026 } };
    const { accessToken } = await login();
    const response = await callTool(accessToken, "whoami");
    expect(toolText(response.body)).toContain(RECONNECT);
    expect(fake.calls.filter((call) => call.body.includes("grant_type=refresh_token"))).toHaveLength(1);
    expect(logs.lines().some((line) => line.includes('"event":"reauth_required"') && line.includes('"code":"20026"'))).toBe(true);
    const next = await postMcp(accessToken, { jsonrpc: "2.0", id: 4, method: "tools/list" });
    expect(next.status).toBe(401);
    logs.restore();
  });

  it("requires reconnect after a permanent refresh failure", async () => {
    const logs = logLines();
    fake.authExpiresIn = 60;
    fake.refreshError = { body: { code: 20037 } };
    const { accessToken } = await login();
    const response = await callTool(accessToken, "whoami");
    expect(toolText(response.body)).toContain(RECONNECT);
    expect(fake.calls.filter((call) => call.body.includes("grant_type=refresh_token"))).toHaveLength(1);
    expect(logs.lines().some((line) => line.includes('"event":"reauth_required"'))).toBe(true);
    const next = await postMcp(accessToken, { jsonrpc: "2.0", id: 4, method: "tools/list" });
    expect(next.status).toBe(401);
    logs.restore();
  });

  it("blocks a pending callback when the kill switch is on", async () => {
    const approved = await approveLogin();
    const state = approved.feishu.searchParams.get("state") ?? "";
    env.MCP_DISABLED = "1";
    const before = fake.calls.length;
    const response = await workerFetch(`/callback?code=auth-code&state=${encodeURIComponent(state)}`, {
      headers: { cookie: approved.jar.header() },
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("disabled");
    expect(fake.calls).toHaveLength(before);
    expect((await env.FEISHU_TOKENS.getByName("ou_owner").status()).stored).toBe(false);
  });

  it("blocks mcp and authorize when the kill switch is on", async () => {
    env.MCP_DISABLED = "1";
    const mcp = await workerFetch("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) });
    expect(mcp.status).toBe(503);
    const body = (await mcp.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe("disabled by owner");
    const authorize = await workerFetch("/authorize");
    expect(await authorize.text()).toContain("disabled");
    expect(fake.calls).toHaveLength(0);

    for (const value of ["0", "", "false"]) {
      env.MCP_DISABLED = value;
      const open = await workerFetch("/mcp", { method: "GET" });
      expect(open.status).toBe(401);
    }
  });

  it("does not call Feishu for the removed probe tool", async () => {
    const { accessToken } = await login();
    const before = fake.calls.length;
    const response = await callTool(accessToken, "probe_capabilities");
    expect(fake.calls).toHaveLength(before);
    expect(response.status).toBe(200);
    const result = (response.body as { result?: { isError?: boolean }; error?: { message?: string } }).result;
    const error = (response.body as { error?: { message?: string } }).error;
    expect(result?.isError === true || typeof error?.message === "string").toBe(true);
  });

  it("returns instructions from initialize", async () => {
    const { accessToken } = await login();
    const body = await initialize(accessToken);
    const result = (body as { result?: { instructions?: string } }).result;
    expect(result?.instructions).toBe(SERVER_INSTRUCTIONS);
  });
});

async function reauthorizeDuringHeldRefresh() {
  const store = env.FEISHU_TOKENS.getByName("ou_owner");
  await store.putTokens({
    accessToken: "u-old",
    refreshToken: "rt-old",
    expiresIn: 60,
    refreshExpiresIn: 7200,
    scope: "offline_access",
  });
  let release: () => void = () => undefined;
  fake.holdRefresh = new Promise((resolve) => {
    release = resolve;
  });
  const pending = store.getAccess({ force: true });
  await vi.waitFor(() => {
    expect(fake.calls.some((call) => call.body.includes("refresh_token=rt-old"))).toBe(true);
  });
  await store.putTokens({
    accessToken: "u-reauth",
    refreshToken: "rt-new",
    expiresIn: 7200,
    refreshExpiresIn: 7200,
    scope: "offline_access",
  });
  release();
  await expect(pending).resolves.toEqual({ ok: true, accessToken: "u-reauth", refreshed: false });
  await expect(store.getAccess({ force: false })).resolves.toEqual({ ok: true, accessToken: "u-reauth", refreshed: false });
  return store;
}

describe("redirect rules", () => {
  it("matches exact URIs and prefixes without lookalikes", () => {
    const list = "https://claude.ai/api/mcp/auth_callback,https://chatgpt.com/connector_platform_oauth_redirect,https://chatgpt.com/connector/oauth/";
    expect(isRedirectAllowed("https://claude.ai/api/mcp/auth_callback", list)).toBe(true);
    expect(isRedirectAllowed("https://claude.ai/api/mcp/auth_callback.evil.com", list)).toBe(false);
    expect(isRedirectAllowed("https://chatgpt.com/connector/oauth/abc", list)).toBe(true);
    expect(isRedirectAllowed("https://chatgpt.com/connector/oauth.evil", list)).toBe(false);
    expect(isRedirectAllowed("https://user:pass@claude.ai/api/mcp/auth_callback", list)).toBe(false);
  });
});
