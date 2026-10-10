# 03 read_bitable
Blocked by: 01

## What
- Read app, tables and fields via `bitable/v1`.
- Read records via `base/v3/bases/{app}/tables/{tbl}/records`, with `offset`/`limit` passed through.

## Acceptance
- Tests from fixtures, with the Lark host rewrite asserted.
- No `bitable:app:readonly` scope added.
