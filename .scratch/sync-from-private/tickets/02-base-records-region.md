# 02: Base record reads follow FEISHU_REGION

Spec: `.scratch/sync-from-private/spec.md`, section Design / Part 2, on docs branch `docs/sync-from-private`.

Blocked by: none.

## Scope

`test/bitable-read.test.ts`; `src/mcp/doc-bitable.ts` only if the test fails.

## Do

- First, on the unchanged code branch head, add a test: with `FEISHU_REGION=lark`, `read_bitable` action `records` must call `https://open.larksuite.com${RECORDS_PATH}` and nothing containing `feishu.cn`. Run it.
- Red: fix so the records URL is region-rewritten like other endpoints; commit test then fix.
- Green on first run: no product change. Commit the test as regression coverage and comment on the docs PR `won't-fix 02: not a bug` with the test name, SHA, and the pass line.

## Acceptance

1. A test proves Lark region records reads hit `open.larksuite.com` only.
2. Either a red-then-green history, or a won't-fix comment with evidence.
3. `npm test` and typecheck are green.
