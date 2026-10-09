# Inventory: private connector repo → public lark-general-connector

Source: the private repo's `main` @ `e51c217` (2026-10-09 19:31 UTC+8), read from a `git archive` snapshot. The private repo was not modified. This file is public, so personal values are described by kind and location only. The literal values are kept outside this repo.

Size: 64 files tracked. 16 tools (`whoami search_docs fetch_doc list_wiki_docs get_doc_comments create_doc update_doc add_doc_comment get_user search_users fetch_doc_media list_chats list_chat_messages search_messages delete_doc get_message`) and 25 Feishu scopes (`src/scopes.ts`). All of this carries over unchanged.

## 1. Hard-coded personal values (all must go)

| Value (by kind) | file:line | Action in OSS |
| --- | --- | --- |
| Cloudflare account id (32 hex) | `wrangler.jsonc:10` | Delete the `account_id` key. Wrangler or the Deploy button uses the logged-in account |
| OAUTH_KV namespace id (32 hex) | `wrangler.jsonc:25` | Leave the binding with no `id`, so it gets auto-provisioned |
| PUBLIC_URL = `https://<private-worker-name>.<owner-subdomain>.workers.dev` | `wrangler.jsonc:19`, `test/support.ts:6`, `worker-configuration.d.ts:6` (generated) | Set to `""` in config (derived from the request when empty). Use a neutral placeholder in tests and regenerate the types |
| Private Worker / package name | `wrangler.jsonc:3`, `package.json:2`, `package-lock.json:2,8`, `src/mcp/server.ts:22` (MCP server name) | Rename to `lark-general-connector` |
| Private Worker name, private branch name, Workers Builds wiring in docs | `README.md:26,65,71` | Rewrite the README (bilingual) |
| Owner's workers.dev subdomain | only inside the PUBLIC_URL rows above | gone once PUBLIC_URL goes |
| Feishu app id | **not present** in the tree (stored as a CF secret). Tests use `cli_test` | Keep it absent. Generic `cli_[a-f0-9]{16}` check in the secret scan |
| Real owner open_id | **not present** (`OWNER_OPEN_ID` is a CF secret). Every `ou_*` in tests is synthetic (`ou_owner`, `ou_ada`, `ou_other`, `ou_bootstrap`, `ou_xxx` in captured tool schemas) | Keep them. The scan flags `ou_` followed by 20+ hex chars |
| Two real doc tokens (27-char) from a live capture | `test/fixtures/fetch-doc-pages.json:6,21,35,49` | Replace with synthetic ids (`doxcnFixture1`, `doxcnFixture2`) |
| Two real private doc titles (one is a meeting transcript title) | `test/fixtures/fetch-doc-pages.json:7,22,36,50` | Replace with neutral titles. Keep the emoji / `<quote-container>` bodies, since they encode the edge cases |
| Provenance note mentioning a private transcript | `test/fixtures/fetch-doc-pages.json:2` | Reword it neutrally |
| Emails | none personal. Only `pass@claude.ai` (userinfo-rejection test, `test/mcp.test.ts:240`) and `ada@example.com` (`test/contacts.test.ts`) | keep |
| Claude/ChatGPT redirect list (not personal, but client-specific) | `wrangler.jsonc:20`. Hard-coded CORS origins in `src/index.ts:39` | Keep as the default list. Derive the origins from the list (ticket 04) |
| `ENABLE_PROBE` (dead leftover) | `src/env.ts:12`, `test/support.ts:15`, `vitest.config.ts:15`, `scripts/check-no-secrets.mjs:7`, `test/hardening.test.ts`, `test/mcp.test.ts`, `README.md:15`, `CONTEXT.md` | Drop it |
| Private-process rules in `scripts/check-no-secrets.mjs` (docs-track, README marks) | `scripts/check-no-secrets.mjs:8,24-31` | Replace with the generic public scan (ticket 01) |

Git history is not a concern, because the OSS repo is a fresh import with no history. (Info only: the Feishu app id never appears in any private commit.)

## 2. Feishu/Lark hosts that switch per region

Measured: all three Feishu host families have a live Lark twin.

| Role | Feishu (CN) | Lark (intl) | Evidence |
| --- | --- | --- | --- |
| OpenAPI | `open.feishu.cn` | `open.larksuite.com` | official lark-openapi-mcp README `--domain https://open.larksuite.com` |
| OAuth authorize (browser redirect) | `accounts.feishu.cn/open-apis/authen/v1/authorize` | `accounts.larksuite.com/open-apis/authen/v1/authorize` | both 200 (probed 2026-10-09) |
| OAuth token | `accounts.feishu.cn/oauth/v3/token` | `accounts.larksuite.com/oauth/v3/token` | both return the same `invalid_grant` JSON (code 20003) for a dummy code |
| Remote MCP | `mcp.feishu.cn/mcp` | `mcp.larksuite.com/mcp` | both return 401 with **identical** `www-authenticate` scope lists (`mcp-tool:docs:fetch-doc` … `offline_access`) and their own `resource_metadata`. Lark docs page `open.larksuite.com/document/mcp_open_tools/call-feishu-mcp-server-in-remote-mode` exists (beta, Docs toolkit) |

**Not verified:** whether `mcp.larksuite.com` accepts this Worker's `x-lark-mcp-uat` / `x-lark-mcp-allowed-tools` header style with a Lark UAT, and whether every one of the 25 scope names exists on Lark (likely candidates for gaps: `search:message`, `im:message.p2p_msg:get_as_user`, `im:message.group_msg:get_as_user`). Checking this needs a Lark tenant (ticket 10). Fallback: `TOOL_BACKENDS` routes every switchable tool to OpenAPI on Lark with no code change.

### Host occurrences in src (all canonical `*.feishu.cn`)

- `src/feishu/api.ts:3` authorize URL, `:4` token URL, `:5` user_info
- `src/feishu/mcp-proxy.ts:5` MCP URL
- `src/feishu/client.ts:11-32` endpoint allowlist (22 rules, host field)
- `src/feishu/docs.ts:4,5,102,158,162,170,201`
- `src/feishu/users.ts:8`
- `src/mcp/chats.ts:87,549,738`
- `src/mcp/contacts.ts:81,87`
- `src/mcp/doc-delete.ts:79,86,90`
- `src/mcp/doc-media.ts:36,40`
- `src/mcp/p2p-discovery.ts:26`

Every outbound call except the browser authorize redirect goes through `FeishuClient.request` (`src/feishu/client.ts`, constructed at `src/mcp/proxied-call.ts:151`, `src/mcp/tools.ts:283`, `src/tokens/store.ts:192`, `src/auth/handler.ts:139`). The authorize URL is built in `src/feishu/api.ts:9-15` (`feishuAuthorizeUrl`). **This gives one seam for the region switch:** keep every literal canonical, check the allowlist against the canonical URL, then map the host to the region inside `request()`, and apply the same mapping in `feishuAuthorizeUrl`. Tool code stays byte-identical.

Tests hard-code `*.feishu.cn` in 13 files (≈170 lines, e.g. `test/allowlist.test.ts` 38, `test/hardening.test.ts` 49, `test/doc-read.test.ts` 40). Those tests stay as-is for the default region, and new tests cover Lark.

## 3. Deploy to Cloudflare button: requirements (Cloudflare docs, updated 2026-07-22)

- Repo must be public GitHub/GitLab, Workers app (not Pages), non-monorepo or self-contained subdir.
- Reads the Wrangler config: auto-provisions KV and Durable Objects (both used here). Docs say "include default values for resource names, resource IDs". Wrangler ≥4.45 also auto-provisions a KV binding **without** `id`, and it "stays linked across future deploys". Dashboard/Git deploys create it, but do not write the id back. Known pitfall: error 10014 "namespace already exists" on re-provisioning (workers-sdk#14262, fixed upstream). The repo pins wrangler 4.148.0.
- `vars` in the Wrangler config are presented for editing at deploy time. Secrets come from `.dev.vars.example` / `.env.example` (dotenv), and the user is prompted for each one.
- Optional `package.json` → `cloudflare.bindings.<NAME>.description` (inline markdown) explains each prompt.
- Build/deploy commands come from `package.json` `build`/`deploy` scripts. With no `deploy` script, it defaults to `npx wrangler deploy`.
- The button clones the repo into the user's GitHub account and wires Workers Builds.
- Current `.dev.vars.example` also lists the dashboard vars `MCP_DISABLED`, `TOOL_BACKENDS`, `P2P_DISCOVERY`. The button would prompt for those as secrets, so the OSS version keeps only the 4 real secrets there.

## 4. Config surface today (private)

Secrets: `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `OWNER_OPEN_ID` (empty → login denied and bootstrap page shows the caller's open_id, `src/auth/handler.ts:166`), `COOKIE_SECRET`. Dashboard vars (`keep_vars: true`): `MCP_DISABLED`, `TOOL_BACKENDS`, `P2P_DISCOVERY`. Committed vars: `PUBLIC_URL`, `ALLOWED_REDIRECT_URIS`. Bindings: `OAUTH_KV`, DO `FEISHU_TOKENS` (`FeishuTokenStore`, sqlite migration `v1`).
