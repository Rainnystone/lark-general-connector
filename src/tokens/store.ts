import { DurableObject } from "cloudflare:workers";
import { audit } from "../audit";
import type { Env } from "../env";
import { exchangeToken } from "../feishu/api";
import { FeishuClient, parseFeishuRegion } from "../feishu/client";
import { isDisabled } from "../flags";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

interface TokenRow {
  access_token: string;
  refresh_token: string;
  access_expires_at: number;
  refresh_expires_at: number;
  scope: string;
  authorized_at: number;
  reauth_required: number;
}

export interface PutTokensInput {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  scope: string;
  authorizedAt?: number;
}

export type AccessResult =
  | { ok: true; accessToken: string; refreshed: boolean }
  | { ok: false; reauth: true; code: string; refreshFailed: boolean }
  | { ok: false; reauth: false; code: string; refreshFailed: false };

export interface TokenStatus {
  stored: boolean;
  reauthRequired: boolean;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function rowFrom(record: Record<string, unknown>): TokenRow | null {
  const access = stringValue(record.access_token);
  const refresh = stringValue(record.refresh_token);
  const accessExpires = numberValue(record.access_expires_at);
  const refreshExpires = numberValue(record.refresh_expires_at);
  const scope = stringValue(record.scope);
  const authorizedAt = numberValue(record.authorized_at);
  const reauth = numberValue(record.reauth_required);
  if (access === null || refresh === null || accessExpires === null || refreshExpires === null || scope === null || authorizedAt === null || reauth === null) {
    return null;
  }
  return {
    access_token: access,
    refresh_token: refresh,
    access_expires_at: accessExpires,
    refresh_expires_at: refreshExpires,
    scope,
    authorized_at: authorizedAt,
    reauth_required: reauth,
  };
}

export class FeishuTokenStore extends DurableObject<Env> {
  private inflight: Promise<AccessResult> | null = null;
  private alarmBootstrapped = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS feishu_tokens (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        access_expires_at INTEGER NOT NULL,
        refresh_expires_at INTEGER NOT NULL,
        scope TEXT NOT NULL,
        authorized_at INTEGER NOT NULL,
        reauth_required INTEGER NOT NULL DEFAULT 0
      )`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS consumed_nonces (
        nonce TEXT PRIMARY KEY,
        consumed_at INTEGER NOT NULL
      )`);
    });
  }

  async putTokens(input: PutTokensInput): Promise<TokenStatus> {
    const now = Date.now();
    const authorizedAt = input.authorizedAt ?? now;
    const refreshExpiresAt = now + input.refreshExpiresIn * 1000;
    this.ctx.storage.sql.exec(
      `INSERT INTO feishu_tokens (singleton, access_token, refresh_token, access_expires_at, refresh_expires_at, scope, authorized_at, reauth_required)
       VALUES (1, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(singleton) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         access_expires_at = excluded.access_expires_at,
         refresh_expires_at = excluded.refresh_expires_at,
         scope = excluded.scope,
         authorized_at = excluded.authorized_at,
         reauth_required = 0`,
      input.accessToken,
      input.refreshToken,
      now + input.expiresIn * 1000,
      refreshExpiresAt,
      input.scope,
      authorizedAt,
    );
    await this.scheduleKeepalive(refreshExpiresAt, now);
    return { stored: true, reauthRequired: false };
  }

  async status(): Promise<TokenStatus> {
    const row = this.read();
    if (!row || row.reauth_required !== 0) return { stored: false, reauthRequired: row?.reauth_required === 1 };
    await this.bootstrapAlarm();
    return { stored: true, reauthRequired: false };
  }

  consumeNonce(nonce: string): boolean {
    const existing = this.ctx.storage.sql.exec("SELECT nonce FROM consumed_nonces WHERE nonce = ?", nonce).toArray();
    if (existing.length > 0) return false;
    this.ctx.storage.sql.exec("INSERT INTO consumed_nonces (nonce, consumed_at) VALUES (?, ?)", nonce, Date.now());
    return true;
  }

  async alarm(): Promise<void> {
    if (isDisabled(this.env.MCP_DISABLED) || parseFeishuRegion(this.env.FEISHU_REGION) === null) {
      this.alarmBootstrapped = false;
      return;
    }
    const row = this.read();
    if (!row || row.reauth_required !== 0) return;
    const startedRefresh = row.refresh_token;
    const result = await this.getAccess({ force: true, alarm: true });
    if (result.ok) return;
    if (result.reauth) {
      if (result.refreshFailed) audit({ event: "reauth_required", code: result.code });
      return;
    }
    const now = Date.now();
    const retryAt = now + HOUR_MS;
    const current = this.read();
    if (!current || current.reauth_required !== 0) return;
    if (current.refresh_token !== startedRefresh) return;
    if (retryAt >= current.refresh_expires_at) return;
    await this.ctx.storage.setAlarm(retryAt);
  }

  async getAccess(options: { force: boolean; alarm?: boolean }): Promise<AccessResult> {
    const row = this.read();
    if (!row || row.reauth_required !== 0) {
      return { ok: false, reauth: true, code: "reauth_required", refreshFailed: false };
    }
    const now = Date.now();
    if (now >= row.authorized_at + YEAR_MS) {
      this.markReauth();
      return { ok: false, reauth: true, code: "20037", refreshFailed: true };
    }
    if (now >= row.refresh_expires_at) {
      this.markReauth();
      return { ok: false, reauth: true, code: "refresh_expired", refreshFailed: true };
    }
    if (!options.alarm) await this.bootstrapAlarm();
    const needsRefresh = options.force || row.access_expires_at - now <= REFRESH_WINDOW_MS;
    if (!needsRefresh) return { ok: true, accessToken: row.access_token, refreshed: false };
    if (!this.inflight) {
      const pending = this.refresh(row, options.alarm === true);
      this.inflight = pending;
      void pending.finally(() => {
        if (this.inflight === pending) this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async scheduleKeepalive(refreshExpiresAt: number, now = Date.now()): Promise<void> {
    const remaining = refreshExpiresAt - now;
    const lead = Math.min(TWO_DAYS_MS, remaining / 2);
    await this.ctx.storage.setAlarm(Math.max(now + MINUTE_MS, refreshExpiresAt - lead));
  }

  private async bootstrapAlarm(): Promise<void> {
    if (this.alarmBootstrapped) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.alarmBootstrapped) return;
      this.alarmBootstrapped = true;
      if ((await this.ctx.storage.getAlarm()) !== null) return;
      const row = this.read();
      if (!row || row.reauth_required !== 0) return;
      await this.scheduleKeepalive(row.refresh_expires_at);
    });
  }

  private read(): TokenRow | null {
    const rows = this.ctx.storage.sql.exec("SELECT * FROM feishu_tokens WHERE singleton = 1").toArray();
    const first = rows[0];
    if (!first) return null;
    return rowFrom(first);
  }

  private wroteSameRefresh(query: string, refreshToken: string, ...bindings: Array<string | number>): boolean {
    return this.ctx.storage.sql.exec(query, ...bindings, refreshToken).rowsWritten > 0;
  }

  private staleRefreshResult(fromAlarm: boolean): AccessResult {
    const current = this.read();
    this.auditRefresh(false, "stale", fromAlarm);
    if (!current || current.reauth_required !== 0) {
      return { ok: false, reauth: true, code: "reauth_required", refreshFailed: false };
    }
    return { ok: true, accessToken: current.access_token, refreshed: false };
  }

  private auditRefresh(ok: boolean, code: string, fromAlarm: boolean): void {
    audit(fromAlarm ? { event: "token_refresh", ok, code, alarm: true } : { event: "token_refresh", ok, code });
  }

  private markReauth(): void {
    this.ctx.storage.sql.exec(
      "UPDATE feishu_tokens SET access_token = '', refresh_token = '', reauth_required = 1 WHERE singleton = 1",
    );
  }

  private async refresh(row: TokenRow, fromAlarm: boolean): Promise<AccessResult> {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.env.FEISHU_APP_ID,
      client_secret: this.env.FEISHU_APP_SECRET,
      refresh_token: row.refresh_token,
    });
    let exchange: Awaited<ReturnType<typeof exchangeToken>>;
    try {
      exchange = await exchangeToken(new FeishuClient(), params);
    } catch {
      this.auditRefresh(false, "network", fromAlarm);
      return { ok: false, reauth: false, code: "network", refreshFailed: false };
    }
    switch (exchange.kind) {
      case "ok": {
        const now = Date.now();
        const refreshExpiresAt = now + exchange.token.refreshExpiresIn * 1000;
        const wrote = this.wroteSameRefresh(
          `UPDATE feishu_tokens SET access_token = ?, refresh_token = ?, access_expires_at = ?, refresh_expires_at = ?, scope = ?, reauth_required = 0
           WHERE singleton = 1 AND refresh_token = ?`,
          row.refresh_token,
          exchange.token.accessToken,
          exchange.token.refreshToken,
          now + exchange.token.expiresIn * 1000,
          refreshExpiresAt,
          exchange.token.scope || row.scope,
        );
        if (!wrote) return this.staleRefreshResult(fromAlarm);
        this.auditRefresh(true, "0", fromAlarm);
        await this.scheduleKeepalive(refreshExpiresAt, now);
        return { ok: true, accessToken: exchange.token.accessToken, refreshed: true };
      }
      case "permanent": {
        const wrote = this.wroteSameRefresh(
          "UPDATE feishu_tokens SET access_token = '', refresh_token = '', reauth_required = 1 WHERE singleton = 1 AND refresh_token = ?",
          row.refresh_token,
        );
        if (!wrote) return this.staleRefreshResult(fromAlarm);
        this.auditRefresh(false, exchange.code, fromAlarm);
        return { ok: false, reauth: true, code: exchange.code, refreshFailed: true };
      }
      case "transient":
        this.auditRefresh(false, exchange.code, fromAlarm);
        return { ok: false, reauth: false, code: exchange.code, refreshFailed: false };
      default: {
        const neverExchange: never = exchange;
        return neverExchange;
      }
    }
  }
}
