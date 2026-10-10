# 11 Live acceptance (owner runs, not the agent)
Blocked by: 01–10

## Setup
- Push the built `main` to test repo **Rainnystone/lgc-button-test**.
- Deploy it to a **separate test Worker** (not the production connector) with a **throwaway Feishu app**: all scopes imported from `scopes.import.json`, Bot on, published.
- Temporarily append a localhost redirect to `ALLOWED_REDIRECT_URIS` for a scripted e2e client.

## Checks (same as the private e2e)
- `tools/list` returns 25 tools.
- Reads (read-only): read_sheet on a sheet (metadata and a range), read_bitable records, read_slides, read_file (inline and `too_large`), read_mindnote, on test content in the throwaway tenant.
- Writes, only on new `mcp-probe-e2e-` objects:
  - sheet: create, put, append, and a formula read back via FormattedValue;
  - Base: create app/field/record, update, then delete a field and a record;
  - slides: create, add, replace (read back), delete page;
  - file: upload, then re-upload gives a new token.
- delete_doc moves each scratch object to the recycle bin.
- Refusals:
  - delete of a wiki-hosted sheet is refused;
  - a wrong title is refused;
  - `fetch_doc` on a `/sheets/` URL and on a wiki sheet points to read_sheet;
  - docx `fetch_doc` is unchanged.
- Optional: a Lark tenant pass (beta); note any missing scope.

## Cleanup
- Remove the temporary redirect and redeploy.
- Confirm that `/register` with localhost is refused and that `/mcp` returns 401.
- Delete the token file.
- Delete the test Worker and the throwaway app when done.
