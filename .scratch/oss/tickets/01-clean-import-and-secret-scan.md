# 01: Clean import of tested code, de-personalized, tests green, secret scan in CI

**What to build:** The public repo gets the private repo's tested code from its `main` @ `e51c217` as one fresh commit on top of the existing LICENSE/README, with no private history. Every personal value is removed and the full test suite passes. On every push and PR, CI runs the tests plus a secret scan over the whole history. Tool, scope, auth and safety logic stay byte-identical. Only config, names, fixtures and dead leftovers change (see INVENTORY §1).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Source tree imported from a `git archive` of the private repo's `main` @ `e51c217`, with no private git objects. `git log` on the public repo shows only the existing initial commit(s) plus this import.
- [ ] `wrangler.jsonc`: no `account_id`. `OAUTH_KV` binding has no `id`. Name is `lark-general-connector`. `PUBLIC_URL` holds a neutral placeholder (ticket 03 makes it optional). `package.json`, the lockfile and the MCP server name are all renamed.
- [ ] `test/support.ts` and vitest config use a neutral placeholder origin. `worker-configuration.d.ts` is regenerated.
- [ ] `test/fixtures/fetch-doc-pages.json`: real doc ids and titles replaced with synthetic ones. The edge-case bodies (emoji, negative offset, past end, paging fields) are kept, and the tests that use them still pass.
- [ ] `ENABLE_PROBE` removed everywhere (env type, tests, scan, docs).
- [ ] The private-process rules in the secret-scan script (docs-track, README marks) are replaced with generic checks: `cli_[0-9a-f]{16}`, `account_id` or a KV `id` in wrangler config, 32-hex ids, non-placeholder `*.workers.dev` hosts, `ou_` + 20 or more hex chars, 27-char doc tokens in fixtures, and secret names declared as wrangler vars. The script contains none of the user's literal values.
- [ ] GitHub Actions workflow on push/PR: `npm ci && npm test` plus gitleaks over the full history (`fetch-depth: 0`). Both are green on the import branch.
- [ ] `diff -r` of `src/` against the snapshot shows changes only in the server name, `env.ts` (ENABLE_PROBE) and nothing in tool, auth or safety modules.
- [ ] Pre-push gate, run locally from **outside** the repo: grep the working tree and every commit to be pushed for the owner's literal values: the workers.dev subdomain, the Cloudflare account id, the Feishu app id, the KV id, the private Worker name, the real doc ids/titles and the owner open_id. The literal list lives only outside the repo. The result is 0 hits. The output is attached to the PR description with the values redacted.
- [ ] The controller (Orchestrator) runs that outside-repo literal grep and approves the push (the repo is already public).
