import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { FeishuTokenStore } from "../src/tokens/store";
import { callTool, logLines, login, toolText, useFakeFeishu } from "./support";

const fake = useFakeFeishu();

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const THIRTY_DAYS_S = 2_592_000;

function tokens(name = "ou_owner") {
  return env.FEISHU_TOKENS.getByName(name);
}

async function alarmAt(name = "ou_owner"): Promise<number | null> {
  return runInDurableObject(tokens(name), (_instance, state) => state.storage.getAlarm());
}

async function put(input: {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  refreshExpiresIn?: number;
  authorizedAt?: number;
  name?: string;
}): Promise<void> {
  await tokens(input.name).putTokens({
    accessToken: input.accessToken ?? "u-stored",
    refreshToken: input.refreshToken ?? "ur-stored",
    expiresIn: input.expiresIn ?? 7200,
    refreshExpiresIn: input.refreshExpiresIn ?? THIRTY_DAYS_S,
    scope: "offline_access",
    authorizedAt: input.authorizedAt,
  });
}

describe("token keepalive alarm", () => {
  it("putTokens sets an alarm at refresh_expires_at minus min(2d, lifetime/2), not before now + 1 minute", async () => {
    const beforeLong = Date.now();
    await put({ refreshExpiresIn: THIRTY_DAYS_S });
    const afterLong = Date.now();
    const longAlarm = await alarmAt();
    expect(longAlarm).not.toBeNull();
    const longLead = TWO_DAYS_MS;
    expect(longAlarm).toBeGreaterThanOrEqual(beforeLong + THIRTY_DAYS_S * 1000 - longLead);
    expect(longAlarm).toBeLessThanOrEqual(afterLong + THIRTY_DAYS_S * 1000 - longLead);

    const beforeShort = Date.now();
    await put({ name: "ou_two_hour", refreshExpiresIn: 7200 });
    const afterShort = Date.now();
    const shortAlarm = await alarmAt("ou_two_hour");
    expect(shortAlarm).not.toBeNull();
    expect(shortAlarm).toBeGreaterThanOrEqual(beforeShort + HOUR_MS);
    expect(shortAlarm).toBeLessThanOrEqual(afterShort + HOUR_MS);

    const beforeClamp = Date.now();
    await put({ name: "ou_clamp", refreshExpiresIn: 30 });
    const afterClamp = Date.now();
    const clampAlarm = await alarmAt("ou_clamp");
    expect(clampAlarm).not.toBeNull();
    expect(clampAlarm).toBeGreaterThanOrEqual(beforeClamp + MINUTE_MS);
    expect(clampAlarm).toBeLessThanOrEqual(afterClamp + MINUTE_MS);
  });

  it("alarm() with a valid row refreshes once and sets the next alarm from the new expiry", async () => {
    await put({ refreshToken: "ur-stored", refreshExpiresIn: 7200 });
    const logs = logLines();
    const before = Date.now();
    expect(await runDurableObjectAlarm(tokens())).toBe(true);
    const after = Date.now();
    logs.restore();
    const refreshes = fake.calls.filter((call) => call.body.includes("grant_type=refresh_token"));
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]?.body).toContain("refresh_token=ur-stored");
    await expect(tokens().getAccess({ force: false })).resolves.toEqual({
      ok: true,
      accessToken: "u-access-1",
      refreshed: false,
    });
    const next = await alarmAt();
    expect(next).not.toBeNull();
    expect(next).toBeGreaterThanOrEqual(before + THIRTY_DAYS_S * 1000 - TWO_DAYS_MS);
    expect(next).toBeLessThanOrEqual(after + THIRTY_DAYS_S * 1000 - TWO_DAYS_MS);
    const refreshLogs = logs.lines().filter((line) => line.includes('"event":"token_refresh"'));
    expect(refreshLogs).toHaveLength(1);
    expect(refreshLogs[0]).toContain('"ok":true');
    expect(refreshLogs[0]).toContain('"alarm":true');
    expect(refreshLogs.join("\n")).not.toContain("ur-stored");
    expect(refreshLogs.join("\n")).not.toContain("u-access-1");
  });

  it("alarm() retries in one hour on transient or network failure, and skips when that would pass expiry or the refresh token moved", async () => {
    fake.refreshError = { body: { code: 1 } };
    const beforeTransient = Date.now();
    await put({ name: "ou_transient", refreshExpiresIn: THIRTY_DAYS_S });
    expect(await runDurableObjectAlarm(tokens("ou_transient"))).toBe(true);
    const afterTransient = Date.now();
    const transientRetry = await alarmAt("ou_transient");
    expect(transientRetry).not.toBeNull();
    expect(transientRetry).toBeGreaterThanOrEqual(beforeTransient + HOUR_MS);
    expect(transientRetry).toBeLessThanOrEqual(afterTransient + HOUR_MS);
    fake.refreshError = null;

    fake.extra = () => {
      throw new TypeError("failed to fetch");
    };
    const beforeNetwork = Date.now();
    await put({ name: "ou_network", refreshExpiresIn: THIRTY_DAYS_S });
    expect(await runDurableObjectAlarm(tokens("ou_network"))).toBe(true);
    const afterNetwork = Date.now();
    fake.extra = null;
    const networkRetry = await alarmAt("ou_network");
    expect(networkRetry).not.toBeNull();
    expect(networkRetry).toBeGreaterThanOrEqual(beforeNetwork + HOUR_MS);
    expect(networkRetry).toBeLessThanOrEqual(afterNetwork + HOUR_MS);

    fake.refreshError = { body: { code: 1 } };
    await put({ name: "ou_too_late", refreshExpiresIn: 1800 });
    expect(await runDurableObjectAlarm(tokens("ou_too_late"))).toBe(true);
    expect(await alarmAt("ou_too_late")).toBeNull();
    fake.refreshError = null;

    await put({ refreshToken: "ur-old", refreshExpiresIn: THIRTY_DAYS_S });
    let release: () => void = () => undefined;
    fake.holdRefresh = new Promise((resolve) => {
      release = resolve;
    });
    const pending = runDurableObjectAlarm(tokens());
    await vi.waitFor(() => {
      expect(fake.calls.some((call) => call.body.includes("refresh_token=ur-old"))).toBe(true);
    });
    await put({ refreshToken: "ur-new", refreshExpiresIn: THIRTY_DAYS_S });
    const keepalive = await alarmAt();
    expect(keepalive).not.toBeNull();
    expect(keepalive).toBeGreaterThan(Date.now() + TWO_DAYS_MS);
    fake.refreshError = { body: { code: 1 } };
    release();
    expect(await pending).toBe(true);
    expect(await alarmAt()).toBe(keepalive);
  });

  it("alarm() does not reschedule after permanent failure, reauth, a missing row, MCP_DISABLED, or the one-year cap", async () => {
    fake.refreshError = { body: { code: 20026 } };
    await put({ name: "ou_permanent", refreshExpiresIn: THIRTY_DAYS_S });
    expect(await runDurableObjectAlarm(tokens("ou_permanent"))).toBe(true);
    expect(await alarmAt("ou_permanent")).toBeNull();
    expect((await tokens("ou_permanent").status()).stored).toBe(false);
    fake.refreshError = null;

    const beforeReauth = fake.calls.length;
    await runInDurableObject(tokens("ou_permanent"), (instance: FeishuTokenStore) => instance.alarm());
    expect(await alarmAt("ou_permanent")).toBeNull();
    expect(fake.calls).toHaveLength(beforeReauth);

    const beforeMissing = fake.calls.length;
    await runInDurableObject(tokens("ou_missing"), (instance: FeishuTokenStore) => instance.alarm());
    expect(await alarmAt("ou_missing")).toBeNull();
    expect(fake.calls).toHaveLength(beforeMissing);

    env.MCP_DISABLED = "1";
    await put({ name: "ou_disabled", refreshExpiresIn: THIRTY_DAYS_S });
    const beforeDisabled = fake.calls.length;
    expect(await runDurableObjectAlarm(tokens("ou_disabled"))).toBe(true);
    expect(await alarmAt("ou_disabled")).toBeNull();
    expect(fake.calls).toHaveLength(beforeDisabled);
    env.MCP_DISABLED = "0";

    await put({
      name: "ou_year",
      refreshExpiresIn: THIRTY_DAYS_S,
      authorizedAt: Date.now() - 365 * 24 * 60 * 60 * 1000 - 1000,
    });
    const beforeYear = fake.calls.length;
    expect(await runDurableObjectAlarm(tokens("ou_year"))).toBe(true);
    expect(await alarmAt("ou_year")).toBeNull();
    expect(fake.calls).toHaveLength(beforeYear);
    expect((await tokens("ou_year").status()).stored).toBe(false);
  });

  it("schedules a keepalive alarm on first status or getAccess when a valid row has none", async () => {
    await put({ refreshExpiresIn: THIRTY_DAYS_S });
    const original = await alarmAt();
    expect(original).not.toBeNull();
    await runInDurableObject(tokens(), (_instance, state) => state.storage.deleteAlarm());
    expect(await alarmAt()).toBeNull();

    expect((await tokens().status()).stored).toBe(true);
    expect(await alarmAt()).toBe(original);

    await runInDurableObject(tokens(), (_instance, state) => state.storage.deleteAlarm());
    expect(await alarmAt()).toBeNull();
    expect((await tokens().status()).stored).toBe(true);
    expect(await alarmAt()).toBeNull();

    await put({ name: "ou_access", refreshExpiresIn: THIRTY_DAYS_S });
    const accessOriginal = await alarmAt("ou_access");
    await runInDurableObject(tokens("ou_access"), (_instance, state) => state.storage.deleteAlarm());
    await expect(tokens("ou_access").getAccess({ force: false })).resolves.toMatchObject({ ok: true, refreshed: false });
    expect(await alarmAt("ou_access")).toBe(accessOriginal);
  });

  it("still refreshes from a tool call near access expiry and reschedules the keepalive alarm", async () => {
    const { accessToken } = await login();
    await put({
      accessToken: "u-old",
      refreshToken: "ur-lazy",
      expiresIn: 60,
      refreshExpiresIn: 7200,
    });
    const before = await alarmAt();
    expect(before).not.toBeNull();
    expect(before).toBeLessThan(Date.now() + HOUR_MS + MINUTE_MS);
    const response = await callTool(accessToken, "whoami");
    expect(toolText(response.body)).toContain("Owner");
    expect(fake.calls.filter((call) => call.body.includes("refresh_token=ur-lazy"))).toHaveLength(1);
    const after = await alarmAt();
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    expect(after).toBeGreaterThan(Date.now() + TWO_DAYS_MS);
  });

  it("alarm refresh goes to accounts.larksuite.com under lark, and nowhere when the region is invalid", async () => {
    env.FEISHU_REGION = "lark";
    await put({ name: "ou_lark", refreshToken: "ur-lark", refreshExpiresIn: THIRTY_DAYS_S });
    expect(await runDurableObjectAlarm(tokens("ou_lark"))).toBe(true);
    const larkRefreshes = fake.calls.filter((call) => call.body.includes("refresh_token=ur-lark"));
    expect(larkRefreshes).toHaveLength(1);
    expect(new URL(larkRefreshes[0]?.url ?? "").hostname).toBe("accounts.larksuite.com");
    expect(larkRefreshes[0]?.url.includes("feishu.cn")).toBe(false);
    for (const call of fake.calls) {
      expect(call.url.includes("feishu.cn"), call.url).toBe(false);
    }

    env.FEISHU_REGION = "intl";
    await put({ name: "ou_invalid", refreshToken: "ur-invalid", refreshExpiresIn: THIRTY_DAYS_S });
    const before = fake.calls.length;
    expect(await runDurableObjectAlarm(tokens("ou_invalid"))).toBe(true);
    expect(fake.calls).toHaveLength(before);
    expect(await alarmAt("ou_invalid")).toBeNull();
  });
});
