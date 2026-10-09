# 07: Bilingual setup wizard (`npm run setup`)

**What to build:** A guided terminal script (中文 + English, Node only, no new dependencies) that takes a deployer from nothing to a working `/mcp` URL. It covers: pick the region, pick a Worker name, `wrangler login`, deploy, set secrets (it generates `COOKIE_SECRET`), and print the region-specific Feishu/Lark console link, the exact scope list and `<url>/callback`. It pauses at each human-only step (create the app, add scopes, set the redirect, publish/apply for approval), then captures the open_id from the bootstrap login, sets `OWNER_OPEN_ID`, and prints the `/mcp` URL.

**Blocked by:** 02, 03

**Status:** ready-for-agent

- [ ] Refuses to deploy to a Worker name that already exists in the account unless the user types the name back. This protects live Workers.
- [ ] The scope list it prints comes from the code's scope constant, so it cannot drift. The console links and hosts come from the region mapping.
- [ ] Secrets go only through `wrangler secret put` (stdin). Nothing is written to disk or echoed back.
- [ ] Unit test for the non-interactive parts (scope/link rendering per region, name-collision guard with a faked `wrangler` call).
- [ ] Dry run against the ticket-05 test Worker name shows the collision guard firing. A run with a new test name completes up to the bootstrap step.
