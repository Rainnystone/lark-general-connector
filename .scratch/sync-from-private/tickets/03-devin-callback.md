# 03: Devin callback in the default redirect allowlist

Spec: `.scratch/sync-from-private/spec.md`, section Design / Part 3, on docs branch `docs/sync-from-private`.

Blocked by: none.

## Scope

`wrangler.jsonc`, `test/mcp.test.ts`, `README.md`, `README.zh-CN.md`, `package.json` (the `ALLOWED_REDIRECT_URIS` description). Follow the shape of merge `e7682b1` (PR #9).

## Do

- Re-verify the callback at https://docs.devin.ai/work-with-devin/mcp.
- Append `https://api.devin.ai/mcp/oauth/callback` to the committed `ALLOWED_REDIRECT_URIS` default as an exact entry.
- Add `test/mcp.test.ts` cases in "redirect rules": the exact URI is allowed; trailing slash, extra path, query, other host (`api.devin.ai.evil.com`) and `http://` are refused. If a test asserts the committed default, update it.
- Update the default lists and client notes in both READMEs and the bilingual `package.json` description.

## Acceptance

1. The exact Devin callback is allowed by the committed default; near misses are refused.
2. Both READMEs and `package.json` name Devin among the defaults.
3. `npm test` and typecheck are green.
