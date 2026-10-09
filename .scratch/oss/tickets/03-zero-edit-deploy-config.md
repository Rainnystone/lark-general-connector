# 03: Zero-edit deploy config (self-derived URL, auto KV, bootstrap-friendly owner)

**What to build:** A fresh deploy needs no hand edits. When `PUBLIC_URL` is empty, the Worker uses the request's own origin for OAuth metadata, resource metadata, the Feishu callback and the allowed origin. `OAUTH_KV` is auto-provisioned. `.dev.vars.example` lists exactly the four secrets, and `package.json` carries bilingual prompt descriptions for each. Until the deployer sets a real open_id, `OWNER_OPEN_ID` may hold a placeholder: login is denied and the bootstrap page shows the caller's own open_id.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] `PUBLIC_URL` defaults to `""`. Tests with it empty show that `/.well-known/oauth-protected-resource/mcp`, the `www-authenticate` resource_metadata and the Feishu `redirect_uri` all use the request origin. A set value still overrides.
- [ ] `.dev.vars.example` contains only `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `COOKIE_SECRET`, `OWNER_OPEN_ID=pending`.
- [ ] `package.json` has `cloudflare.bindings` descriptions (中文 + English) for the 4 secrets and for `FEISHU_REGION`, `PUBLIC_URL` and `ALLOWED_REDIRECT_URIS`, plus a `deploy` script set to `wrangler deploy`.
- [ ] Test: `OWNER_OPEN_ID` empty or a non-open_id value such as `pending` → callback shows the bootstrap page with the caller's open_id, stores no tokens and grants nothing. A mismatched real open_id → forbidden page (unchanged).
- [ ] `npx wrangler deploy --dry-run` succeeds from a clean checkout with no account-specific values in the repo.
