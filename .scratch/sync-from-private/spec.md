# Spec: sync idle token keep-alive, Base region check, and Devin callback

## Problem

1. **Idle token expiry.** `TokenStore.getAccess` in `src/tokens/store.ts` refreshes the user access token only when a tool call arrives. If no tool is called for longer than the refresh token lifetime (`refresh_expires_at`), the next call hits `refresh_expired`, the store sets `reauth_required`, and the owner must redo OAuth although the grant was still good. Example: a connector unused for a week-plus vacation asks for reauthorization on the first call afterwards.
2. **Base record-read host under Lark.** `recordsUrl` in `src/mcp/doc-bitable.ts` builds `https://open.feishu.cn/open-apis/base/v3/bases/.../records`. Every Open API URL in this repo is written with the canonical `open.feishu.cn` host and rewritten by `rewriteUrlForRegion` (`src/feishu/region.ts`, called from `src/feishu/client.ts` and `src/feishu/api.ts`) after the allowlist check. `test/bitable-read.test.ts` proves this for `action: "app"` only; nothing proves it for the `base/v3` records read. It is unverified whether `FEISHU_REGION=lark` sends records reads to `open.larksuite.com`.
3. **Devin callback not allowed by default.** Adding the connector in Devin's web app fails at dynamic client registration (`POST /register` returns `invalid_client_metadata`, "redirect URI is not allowed") because the committed `ALLOWED_REDIRECT_URIS` default in `wrangler.jsonc` lists only Claude, ChatGPT and Gemini.

## Goal

1. An idle deployment stays authorized until the one-year cap (`authorized_at + YEAR_MS`) with no tool calls and no owner action, in both regions.
2. Either a test proves Base record reads follow `FEISHU_REGION`, or a failing test exposes the wrong host and the fix routes it correctly.
3. Devin's documented app.devin.ai callback is in the committed default allowlist, matched exactly.

## Non-goals

- Proactive notification (email, chat message) when reauth is needed. The next tool call keeps returning the existing reauth prompt.
- Getting around the one-year cap.
- Calling any document or business API as a "ping". Exchanging the refresh token is the keep-alive.
- Cron Triggers. A Durable Object alarm needs no Cron Trigger quota.
- Changing how hosts are rewritten for other endpoints, or the allowlist of canonical hosts in `src/feishu/client.ts`.
- Wildcards or prefixes for Devin. Dedicated or custom-domain Devin deployments append their own callback, as today.

## Design

### Part 1: alarm keep-alive (ticket 01)

The token lives in the SQLite-backed `TokenStore` Durable Object. Use its single alarm.

1. **Schedule.** Whenever a refresh token is stored (`putTokens`, and the `ok` branch of `refresh`), set the alarm to `refresh_expires_at - lead`, where `lead = min(2 days, half the refresh lifetime)`, never earlier than `now + 1 minute`.
2. **Fire.** `alarm()` reads the row.
   - `MCP_DISABLED` set (`isDisabled` in `src/flags.ts`), no row, or `reauth_required` set: do nothing, do not reschedule.
   - Otherwise call the existing refresh path (`getAccess({ force: true, alarm: true })`), so expiry checks, the one-year cap, in-flight dedupe and the compare-and-swap stay in one place.
   - `ok`: the refresh branch already scheduled the next alarm.
   - Transient or network failure: retry in 1 hour, only while `now + 1h < refresh_expires_at`, and only if the row still holds the refresh token the alarm started with and is not `reauth_required`.
   - Permanent failure, `refresh_expired`, or the one-year cap: existing code marks reauth. Do not reschedule.
3. **Bootstrap.** Deployments that already hold a token have no alarm. When `status()` or a non-alarm `getAccess` reads a valid row and `getAlarm()` is null, schedule one with the step 1 rule, once per object lifetime, inside `blockConcurrencyWhile`.
4. **Audit.** Alarm-driven refreshes use the existing `token_refresh` event in `src/audit.ts` with an optional `alarm: true` field. Never log token values.
5. **Region.** The refresh request already goes through the region-aware client (`accounts.feishu.cn` rewritten to `accounts.larksuite.com` for `lark`). The alarm must reuse that path; it adds no host of its own. If `FEISHU_REGION` is invalid, the alarm must not send anything upstream (same fail-closed rule as every route).

### Part 2: Base records region check (ticket 02)

Add a test to `test/bitable-read.test.ts` mirroring "sends bitable reads to open.larksuite.com when FEISHU_REGION is lark", for the records action (`RECORDS_PATH`). Run it before any product change.
- If it fails (a call to `open.feishu.cn` or a missing `open.larksuite.com` call), fix the routing so `recordsUrl` output goes through `rewriteUrlForRegion` like the other endpoints.
- If it passes on unchanged `main`, it is not a bug: keep the test as regression coverage, change no product code, and record the evidence (test name, commit SHA, pass output) as won't-fix on the docs PR.

### Part 3: Devin callback (ticket 03)

Mirror how the Gemini prefix was added (merge `e7682b1`, PR #9): append `https://api.devin.ai/mcp/oauth/callback` to the `ALLOWED_REDIRECT_URIS` default in `wrangler.jsonc` as an exact entry (no trailing slash, no `*`). Source: https://docs.devin.ai/work-with-devin/mcp, OAuth field under "SSE and HTTP transports": on app.devin.ai the callback is `https://api.devin.ai/mcp/oauth/callback`; other deployments use the value their deployment shows. Re-check that page before committing; if it changed, use the documented string and say so on the code PR. Update `README.md`, `README.zh-CN.md`, and the `ALLOWED_REDIRECT_URIS` description in `package.json` (bilingual) to list Devin among the defaults, and add redirect-rule cases to `test/mcp.test.ts`.

## Acceptance

- Part 1: every item in ticket 01 Acceptance is covered by a test driving the real store against `test/fake-feishu.ts`, including the `lark` region.
- Part 2: ticket 02 ends either fixed with a red-then-green test, or won't-fix with the passing test and evidence.
- Part 3: the exact Devin callback registers; near-miss URIs are refused; docs list it in both languages.
- `npm test`, typecheck and CI stay green on the code PR head.
