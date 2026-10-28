# 01: Durable Object alarm keeps the refresh token alive

Spec: `.scratch/sync-from-private/spec.md`, section Design / Part 1, on docs branch `docs/sync-from-private`.

Blocked by: none.

## Scope

`src/tokens/store.ts`, `src/audit.ts` (optional `alarm?: true` on `token_refresh`). Tests under `test/`. `wrangler.jsonc` only if alarms need config (they should not).

## Do

- Add a private helper that computes the alarm time per Spec Part 1 step 1; call it after `putTokens` (which becomes async) and after a successful `refresh`.
- Implement `alarm()` per step 2, reusing `getAccess({ force: true, alarm: true })` and respecting `MCP_DISABLED`.
- Bootstrap a missing alarm per step 3.
- Tag alarm-driven refreshes in the audit event per step 4.
- Update every caller of `putTokens` / `status` if they become async.

## Acceptance

1. `putTokens` sets an alarm at `refresh_expires_at - min(2d, lifetime/2)`, clamped to at least now + 1 minute.
2. `alarm()` with a valid row refreshes once and sets the next alarm from the new expiry.
3. Transient or network failure in `alarm()` sets a retry at now + 1 hour while that is before `refresh_expires_at`, otherwise none; no retry if the row's refresh token changed meanwhile.
4. Permanent failure, `reauth_required`, a missing row, `MCP_DISABLED`, or the one-year cap produce no new alarm.
5. A valid row with no alarm gets one on first read.
6. The lazy refresh path on tool calls still works and reschedules the alarm.
7. With `FEISHU_REGION=lark`, the alarm refresh goes to `accounts.larksuite.com` and nothing to `*.feishu.cn`; with an invalid region nothing goes upstream.
8. `npm test` and typecheck are green.
