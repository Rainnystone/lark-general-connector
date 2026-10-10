# 01 Scopes, bulk-import JSON, allowlist, read_sheet (tracer bullet)
Blocked by: none

## What
- Add the 23 scopes to `src/scopes.ts` (order as in SPEC), `test/spec-scopes.ts`, and the ```scopes``` blocks in README.md, README.zh-CN.md and AGENTS.md.
- Add `scopes.import.json` (`{"scopes":{"tenant":[],"user":[…]}}`) plus a test asserting `user` deep-equals `FEISHU_SCOPES` and `tenant` is empty.
- Add the sheet read rules to `src/feishu/client.ts` (re-apply; keep the region rewrite).
- Port the `read_sheet` resolver changes in `src/feishu/docs.ts`, plus `src/mcp/doc-sheet.ts` (read half).
- Register `read_sheet` in `server.ts`.

## Acceptance
- `npm test` green, including `scripts/agents-md.test.mjs` and the new JSON test.
- `sheet-read.test.ts`: metadata and a range read from de-personalized fixtures; `FEISHU_REGION=lark` sends to `open.larksuite.com`.
- Allowlist test: new paths are allowed; neighbouring paths are refused.
- No tenant subdomain, `ou_` id or real title in the diff.
