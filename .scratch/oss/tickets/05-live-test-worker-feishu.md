# 05: Live verification on a separate test Worker (Feishu China)

**What to build:** The OSS build runs live in the user's Cloudflare account as a **separate test Worker** with its own name, KV, DO namespace and Feishu redirect, and passes a smoke checklist from ChatGPT and Claude. The live private Worker is never deployed to, renamed, reconfigured or given new secrets.

**Blocked by:** 02, 03, 04

**Status:** needs-human (Cloudflare login, Feishu console, AI clients)

- [ ] Before anything else, record the private Worker's current deployment id and secret names (read-only). Re-check them at the end and confirm they are identical.
- [ ] Deploy with `wrangler deploy --name lark-connector-test` (or another name the user picks) from a local checkout of the public branch. There is no Workers Builds hookup. KV is auto-provisioned under the test name, and the secrets are set with `wrangler secret put --name lark-connector-test`.
- [ ] Uses a **separate throwaway Feishu test app** (never the live app) with the 25 scopes and redirect `<test-url>/callback`. The app is deleted or disabled after testing.
- [ ] Bootstrap flow works: the first login shows the open_id and denies. After `OWNER_OPEN_ID` is set, reconnecting succeeds.
- [ ] Smoke checklist passes from ChatGPT and from Claude: all 16 tools once each. Denials are checked too: a non-owner account is refused, wiki delete is refused, delete with a wrong title is refused, and a real delete lands in the recycle bin. `MCP_DISABLED=1` → 503, and unsetting it restores service. One `TOOL_BACKENDS` openapi flip works.
- [ ] Results recorded in the PR (no tokens, ids or doc titles in the record).
- [ ] Teardown (test Worker + its KV) only with the user's approval.
