import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { FeishuClient } from "../src/feishu/client";
import { runTool } from "../src/mcp/proxied-call";
import { callWhoami } from "../src/mcp/tools";
import { approveLogin, restoreEnv, workerFetch } from "./support";

const USER_INFO = "https://open.feishu.cn/open-apis/authen/v1/user_info";
const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

function resultText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  return first?.type === "text" && typeof first.text === "string" ? first.text : "";
}

async function storeOwnerTokens(): Promise<void> {
  await env.FEISHU_TOKENS.getByName("ou_owner").putTokens({
    accessToken: "u-stored",
    refreshToken: "ur-stored",
    expiresIn: 7200,
    refreshExpiresIn: 2_592_000,
    scope: "offline_access",
  });
}

describe("Workers global fetch", () => {
  beforeEach(async () => {
    await reset();
    restoreEnv();
  });

  it("reaches Feishu from FeishuClient when no fetch is injected", async () => {
    const client = new FeishuClient();
    const response = await client.request("GET", USER_INFO);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ code: 0, data: { name: "Owner", open_id: "ou_owner" } });
  });

  it("completes the ChatGPT callback", async () => {
    const approved = await approveLogin(CHATGPT_REDIRECT);
    const state = approved.feishu.searchParams.get("state") ?? "";
    const callback = await workerFetch(`/callback?code=auth-code&state=${encodeURIComponent(state)}`, {
      headers: { cookie: approved.jar.header() },
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location") ?? "").toContain("code=");
    expect((await env.FEISHU_TOKENS.getByName("ou_owner").status()).stored).toBe(true);
  });

  it("refreshes a token from the token store", async () => {
    await storeOwnerTokens();
    const access = await env.FEISHU_TOKENS.getByName("ou_owner").getAccess({ force: true });
    expect(access).toEqual({ ok: true, accessToken: "u-from-outbound", refreshed: true });
  });

  it("answers whoami from Feishu", async () => {
    await storeOwnerTokens();
    const result = await callWhoami(env, "ou_owner");
    expect(resultText(result)).toBe("name: Owner\nopen_id: ou_owner");
  });

  it("answers a proxied tool call from Feishu", async () => {
    await storeOwnerTokens();
    const result = await runTool(env, "ou_owner", "get_user", null, async (client, accessToken) => {
      const response = await client.request("GET", USER_INFO, { headers: { authorization: `Bearer ${accessToken}` } });
      const payload = (await response.json()) as { data?: { open_id?: string } };
      return { kind: "done", text: payload.data?.open_id ?? "", isError: false };
    });
    expect(resultText(result)).toBe("ou_owner");
  });

  it("logs a scrubbed Feishu error description when login is refused", async () => {
    const logged = captureErrors();
    try {
      const callback = await callbackWith("auth-code-described");
      expect(callback.status).toBe(502);
      expect(await callback.text()).toBe("login failed");
      const text = logged.lines().join("\n");
      expect(text).toContain('"event":"login_failed"');
      expect(text).toContain("The refresh token provided is invalid.");
      expect(text).toContain("20049");
      expect(text).not.toContain("auth-code-described");
      expect(text).not.toContain("test-app-secret");
      assertNoSecrets(text, "auth-code-described");
    } finally {
      logged.restore();
    }
  });

  it("logs the Feishu exchange code when login is refused", async () => {
    await expectLoggedFailure("auth-code-permanent", 502, JSON.stringify({ event: "login_failed", code: "20026" }));
  });

  it("logs the Feishu user code when login is refused", async () => {
    await expectLoggedFailure("auth-code-userinfo", 502, JSON.stringify({ event: "login_failed", code: 99991663 }));
  });

  it("logs the caught error name and message when login throws", async () => {
    const failure = await callbackWhenPutThrows(new TypeError("feishu unreachable"));
    expect(failure.status).toBe(500);
    expect(failure.body).toBe("login failed");
    expect(failure.logged).toContain(JSON.stringify({ event: "login_failed", name: "TypeError", message: "feishu unreachable" }));
    assertNoSecrets(failure.logged, "auth-code");
  });

  it("logs a thrown error without the request URL or secret", async () => {
    const failure = await callbackWhenPutThrows(new TypeError("GET https://open.feishu.cn/x?code=secret-auth-code user@example.com"));
    expect(failure.status).toBe(500);
    expect(failure.logged).toContain(JSON.stringify({ event: "login_failed", name: "TypeError", message: "error" }));
    expect(failure.logged).not.toContain("secret-auth-code");
    expect(failure.logged).not.toContain("user@example.com");
    expect(failure.logged).not.toContain("open.feishu.cn");
  });
});

function captureErrors(): { lines: () => string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  return {
    lines: () => lines,
    restore: () => {
      console.error = original;
    },
  };
}

async function callbackWhenPutThrows(error: Error): Promise<{ status: number; body: string; logged: string }> {
  const tokens = env.FEISHU_TOKENS;
  const logged = captureErrors();
  env.FEISHU_TOKENS = {
    getByName(name: string) {
      if (name === "ou_owner") {
        return {
          putTokens() {
            throw error;
          },
        };
      }
      return tokens.getByName(name);
    },
  } as unknown as typeof tokens;
  try {
    const callback = await callbackWith("auth-code");
    return { status: callback.status, body: await callback.text(), logged: logged.lines().join("\n") };
  } finally {
    env.FEISHU_TOKENS = tokens;
    logged.restore();
  }
}

async function expectLoggedFailure(oauthCode: string, status: number, needle: string): Promise<void> {
  const logged = captureErrors();
  try {
    const callback = await callbackWith(oauthCode);
    expect(callback.status).toBe(status);
    expect(await callback.text()).toBe("login failed");
    const text = logged.lines().join("\n");
    expect(text).toContain(needle);
    assertNoSecrets(text, oauthCode);
  } finally {
    logged.restore();
  }
}

async function callbackWith(code: string): Promise<Response> {
  const approved = await approveLogin(CHATGPT_REDIRECT);
  const state = approved.feishu.searchParams.get("state") ?? "";
  return workerFetch(`/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
    headers: { cookie: approved.jar.header() },
  });
}

function assertNoSecrets(logged: string, oauthCode: string): void {
  expect(logged).not.toContain(oauthCode);
  expect(logged).not.toContain("test-app-secret");
  expect(logged).not.toContain("test-cookie-secret");
  expect(logged).not.toContain("u-from-outbound");
  expect(logged).not.toContain("ur-from-outbound");
  expect(logged).not.toContain("u-userinfo-fail");
  expect(logged).not.toContain("ur-userinfo-fail");
  expect(logged).not.toContain("u-stored");
  expect(logged).not.toContain("ur-stored");
}
