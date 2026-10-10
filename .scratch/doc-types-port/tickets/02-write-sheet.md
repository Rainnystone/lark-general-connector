# 02 write_sheet
Blocked by: 01

## What
Add `create`, `put`, `append` and `batch_update`, passed through to sheets v3 create and v2 values. Formula cells are passed through as `{type:"formula",text}`. The description says ranges need `sheetId!A1:B2` and that formula results are read back with `valueRenderOption=FormattedValue`.

## Acceptance
- Tests from the write fixtures: exact request bodies; formula shape forwarded unchanged.
- Allowlist rules for write paths only.
