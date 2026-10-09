# Spec: lark-general-connector (open-source Feishu/Lark remote MCP connector)

Status: ready-for-agent · Source of truth for code: the private repo's `main` @ `e51c217` · Inventory: `INVENTORY.md`

## Problem Statement

I run a personal remote MCP server on Cloudflare Workers that lets my AI clients (ChatGPT, Claude) read and edit my Feishu docs and read my chats as me. It works and is tested, but it lives in a private repo full of my account values, and it only speaks Feishu China. Other people who want the same thing for their own Feishu or Lark account have no safe, low-effort way to run it. Today they would have to rewrite the config by hand, guess the Feishu app setup, and trust code that was never scrubbed.

## Solution

A new public MIT repo, `Rainnystone/lark-general-connector`, that is a **near-copy of the private repo's tested code**. It is a fresh import, not a rewrite. One person deploys it into their own Cloudflare account against their own Feishu or Lark custom app, then pastes one `/mcp` URL into any OAuth-capable remote MCP client. Only these things change from the private code:

- personal values become config
- one region value switches Feishu China ↔ Lark international
- a Deploy to Cloudflare button, a bilingual setup wizard, and a bilingual AGENTS.md
- bilingual docs with disclaimers
- a secret scan in CI

Tool logic, tool set, scopes and safety rules stay byte-identical wherever possible.

## User Stories

1. As a deployer, I want to click "Deploy to Cloudflare" and get a working Worker in my own account, so that I don't hand-edit config files.
2. As a deployer, I want KV and the Durable Object created for me, so that I never copy resource ids.
3. As a deployer, I want to be prompted for each secret with a plain explanation of where to find it, so that I fill them correctly the first time.
4. As a deployer, I want the Worker to know its own public URL without me typing my workers.dev subdomain, so that the button works with zero edits.
5. As a Lark international user, I want to set one value to `lark`, so that every login, API and MCP call goes to larksuite.com hosts.
6. As a Feishu China user, I want the default to just work, so that I change nothing.
7. As a deployer, I want a guided wizard (Chinese + English) that walks me through creating the Feishu/Lark app, adding the exact scopes, setting the redirect URI and publishing, so that I don't need to know the Feishu console.
8. As a deployer who uses a coding agent, I want an AGENTS.md the agent can follow end to end and stop at each human-only step, so that my agent can do the setup with me.
9. As a deployer, I want the first login to show me my own open_id and refuse access until I set it as the owner, so that nobody else can ever connect.
10. As the owner, I want only my open_id to be able to complete login and call tools, so that a leaked URL is useless to anyone else.
11. As the owner, I want contacts and chats to be read-only and the connector to never send messages or create, update or delete chats, so that the AI can't speak for me.
12. As the owner, I want doc delete to only move a cloud-space doc to the recycle bin after I confirm its exact title, and wiki docs to never be deletable, so that mistakes are recoverable.
13. As the owner, I want a kill switch var that stops every tool without a deploy, so that I can cut access instantly.
14. As a user of Kimi web or another OAuth MCP client, I want to add my client's redirect URI to one config value, so that the connector isn't locked to ChatGPT and Claude.
15. As a reader of the README, I want to see which clients were actually tested (ChatGPT, Claude) separately from "should work", so that I set expectations.
16. As a deployer, I want the README to say that Feishu permissions and admin approval are my responsibility, that the official Feishu MCP may change or be retired (OpenAPI fallback exists), and that free-plan limits apply, so that I'm not surprised.
17. As a deployer whose Feishu MCP backend breaks, I want to flip tools to OpenAPI with `TOOL_BACKENDS`, so that I keep working without a code change.
18. As a contributor, I want CI to run the full test suite and a secret scan over the whole history on every push and PR, so that no secret or personal id can land.
19. As the maintainer, I want to deploy the OSS build as a separate test Worker on my own Cloudflare, so that I verify it without ever touching my live private Worker.
20. As the maintainer, I want generic fixes to flow from private to public by my own out-of-repo process, so that the public repo carries no sync machinery.

## Implementation Decisions

### Locked (decisions settled with the owner)

- Personal use only: one person = their Cloudflare account + their Feishu/Lark app + their AI clients. No multi-user or org mode. Owner gate defaults to the deployer.
- Same 16 tools, same 25 scopes, same backends and switches. No new features.
- Fresh public repo, clean history, MIT. The private repo and its Workers Builds stay untouched.
- Both regions through one config value. README, wizard and AGENTS.md are bilingual (中文 + English).
- Private→public sync is an out-of-repo process, not a repo feature.

### Thin-proxy rule

The Worker stays an OAuth server + MCP proxy: Feishu remote MCP first, Feishu OpenAPI as fallback and for direct tools. No Feishu feature is reimplemented, tools stay in the same modules, and no new abstractions are added beyond the region seam below.

### Config surface

| Kind | Name | Default | Notes |
| --- | --- | --- | --- |
| Secret | `FEISHU_APP_ID` | — | prompted by the button (`.dev.vars.example`) |
| Secret | `FEISHU_APP_SECRET` | — | prompted |
| Secret | `COOKIE_SECRET` | — | prompted; description says `openssl rand -hex 32`. The wizard generates it |
| Secret | `OWNER_OPEN_ID` | `pending` | prompted. Any value that is not an open_id counts as "not configured" (see invariants) |
| Committed var | `FEISHU_REGION` | `feishu` | `feishu` or `lark`. Any other value fails closed (503 on every route, nothing sent upstream) |
| Committed var | `PUBLIC_URL` | `""` | empty → the request's own origin. Set it to pin a custom domain |
| Committed var | `ALLOWED_REDIRECT_URIS` | Claude + ChatGPT callbacks | comma list. Users append other clients. Allowed CORS origins are derived from these hostnames plus the Worker's own host and localhost |
| Dashboard var | `MCP_DISABLED`, `TOOL_BACKENDS`, `P2P_DISCOVERY` | unset | unchanged semantics, kept by `keep_vars: true`, documented but not prompted |
| Binding | `OAUTH_KV` | auto-provisioned | no `id` in config |
| Binding | `FEISHU_TOKENS` | DO `FeishuTokenStore`, migration `v1` | unchanged |

Removed: `account_id`, the KV id, the private Worker name (now `lark-general-connector`), and the dead `ENABLE_PROBE`.

### Region support

- Mapping (all measured live, see INVENTORY §2): `open.feishu.cn↔open.larksuite.com`, `accounts.feishu.cn↔accounts.larksuite.com`, `mcp.feishu.cn↔mcp.larksuite.com`.
- **One seam.** Source literals and the endpoint allowlist stay canonical (`*.feishu.cn`). The outbound client checks the allowlist against the canonical URL, then rewrites the host for the configured region just before fetch. The same mapping applies to the browser authorize redirect. As a result, no tool module changes.
- The Feishu console link, redirect-URI help and scope list in the wizard and docs are region-aware.
- **Lark ships as beta: supported, not live-tested.** Lark MCP is reachable and advertises the same tool scopes, but no Lark account is available to verify it with a real Lark UAT. If it misbehaves, the documented Lark fallback is `TOOL_BACKENDS` with every switchable tool set to `openapi` (no code change). Live Lark verification is a parked, optional ticket (10); nothing blocks on it.

### Deploy paths

1. **Deploy to Cloudflare button** (README): it clones the repo into the user's GitHub, provisions KV + DO, prompts for the 4 secrets with descriptions, and lets the user edit `FEISHU_REGION`. The `deploy` script is `wrangler deploy`.
2. **Wizard** (`npm run setup`, Node with no extra deps, bilingual prompts):
   - choose the region
   - choose a Worker name (it **refuses a name that already exists** in the account unless the user types it back)
   - `wrangler login`, then deploy, then put the secrets (it generates `COOKIE_SECRET`)
   - print the region's console URL, the exact scope list and `<url>/callback`
   - pause at each human-only step (create the app, add scopes, set the redirect, publish/approval)
   - capture the open_id from the bootstrap page and set `OWNER_OPEN_ID`
   - print the `/mcp` URL
3. **AGENTS.md** (bilingual): the same steps written for a coding agent. It marks the human-only steps and tells the agent to never paste secrets into files or chat logs.

All three paths share one order: create app → deploy → set redirect → publish → connect client → bootstrap login shows open_id → set `OWNER_OPEN_ID` → reconnect.

### Security invariants (must not regress; each has a test)

- Owner gate: login completes and `/mcp` serves only when the Feishu open_id equals `OWNER_OPEN_ID`. Unset or placeholder means everyone is denied, and the bootstrap page shows only the caller's own open_id.
- Contacts and chats are read-only. There are no message-send scopes or endpoints, and no chat create/update/delete. The endpoint allowlist is the fixed list of method+path pairs (canonical hosts) and the region rewrite cannot widen it.
- Doc delete covers only cloud-space docx, goes to the recycle bin, and requires an exact title confirmation. Wiki docs are never deletable.
- Kill switch, outbound subrequest budget, and content-free audit logs stay unchanged.
- Secrets live only in Cloudflare encrypted secrets. The repo never contains secret values, account ids, KV ids, worker names, subdomains, real open_ids, app ids or real doc tokens/titles, including in fixtures and tests.

## Testing Decisions

- A good test drives the Worker through its public HTTP surface (OAuth endpoints and `/mcp` JSON-RPC) with Feishu faked at the outbound fetch. It asserts on responses and on the outbound calls the Worker actually made, never on internals.
- Prior art to reuse: the existing vitest + `@cloudflare/vitest-plugin` suite with its fake Feishu outbound service (`oauth`, `hardening`, `allowlist`, `mcp-contract`, `doc-*`, `chats`, `contacts` tests). The whole private suite must pass unchanged except for de-personalized constants and fixtures.
- New seams: none. The region tests run the same suite paths with `FEISHU_REGION=lark` and assert that every outbound URL and the authorize redirect use larksuite hosts, that none use feishu.cn, and that the reverse holds by default. An invalid region gets a fail-closed test.
- Deploy-config tests: an empty `PUBLIC_URL` yields correct resource metadata and callback URLs from the request origin, and a placeholder `OWNER_OPEN_ID` shows the bootstrap page and denies login.
- CI (GitHub Actions on push/PR): `npm ci && npm test` plus gitleaks over the full history (`fetch-depth: 0`) plus the repo's own generic scan script. The scan flags patterns like `cli_[0-9a-f]{16}`, 32-hex ids in wrangler config, `account_id`/KV `id` keys, non-placeholder `*.workers.dev` hosts, long `ou_` ids, and 27-char doc tokens in fixtures. The user's literal values are **never** written into the public repo. They are checked once, locally, by a pre-push grep run from outside the repo.
- **Live test plan (separate test Worker, never the live one):**
  - deploy the OSS build from a local checkout with `wrangler deploy` under a distinct name (e.g. `lark-connector-test`) into the user's Cloudflare account
  - its own auto-provisioned KV and DO namespace
  - its own **separate throwaway Feishu test app** (never the live app) with redirect `<test-url>/callback`
  - secrets set per-Worker with `wrangler secret put --name <test>`
  - no Workers Builds hookup to either repo
  - confirm before and after that the private Worker's deployments list and secrets are unchanged
  - run a smoke checklist covering all 16 tools from ChatGPT and Claude, including denial cases (non-owner login, wiki delete, wrong title, kill switch)
  - delete the test Worker and its KV when done, with user approval

## Out of Scope

- Multi-user/org deployment, admin UIs, any new tool, scope or write capability.
- Reimplementing Feishu features. Changing MCP-first/OpenAPI-fallback behavior.
- Automating private→public sync (handled outside the repo).
- Changing, redeploying or reconfiguring the private repo or its live Worker.
- Custom-domain automation (`PUBLIC_URL` override is enough).
- Publishing to any MCP registry or marketplace.

## Further Notes

- Process: `/to-spec → /to-tickets → implement + /tdd → /code-review` in a Cursor Cloud Agent Project on the public repo.
- The public repo is already public, so the **first push is the publication**. Ticket 01's pre-push gate is mandatory: the controller (Orchestrator) runs the outside-repo literal grep and approves the push.
- Deploy-button KV without an `id`: documented as supported (wrangler ≥4.45, "stays linked"), but it has to be confirmed by a real button deploy in ticket 06. If it fails, fall back to a placeholder id per the Cloudflare docs.

### Resolved decisions (2026-10-09)

1. The test Worker uses a separate throwaway Feishu test app, not the live app.
2. There is no Lark account. Lark ships as beta (supported, not live-tested, OpenAPI fallback documented). Ticket 10 is parked and optional.
3. The work is delegated. The controller (Orchestrator) runs the outside-repo literal grep and approves pushes.

### Open questions

None.
