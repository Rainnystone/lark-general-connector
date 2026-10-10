# Spec: port doc-type tools (sheet, Base, slides, file, mind note) to lark-general-connector

Status: docs only. This PR never merges. Implementation lands in one small PR per ticket off `main`.

## Problem
Today the connector reads and writes only Feishu / Lark docs (docx). People also keep their work in sheets, Bases (multi-dimensional tables), slides, uploaded files and mind notes, and the AI can't open any of these. A private build of this connector already ships 9 tools for them and has passed a live end-to-end run. This spec ports those tools into the open-source repo without losing anything the open-source repo added: the Feishu/Lark region switch, the `pending` owner bootstrap, the Deploy button, the wizard, and the friendlier docs.

## Solution
Add 9 OpenAPI-only tools. The total goes from 16 to **25**:

| Tool | Does |
|---|---|
| `read_sheet` | metadata (sheet ids) or a range of values |
| `write_sheet` | create, put, append, batch_update; formulas use Feishu's `{type:"formula",text:"=…"}` |
| `read_bitable` | app, tables, fields; records via Base v3 |
| `write_bitable` | create app/field/record, update field/record, delete field/record |
| `read_slides` | presentation XML |
| `write_slides` | create, add_slide, replace_slide (`slide_id` + `revision_id=-1` as query), delete_slide |
| `read_file` | metadata; inline bytes up to 256 KiB (text or base64), otherwise `too_large:true` |
| `write_file` | upload up to 10 MiB; a re-upload makes a new file_token (documented "update") |
| `read_mindnote` | node list (read-only) |

Changes to existing tools:
- `delete_doc` now also deletes sheet, bitable, slides and file.
- `fetch_doc` resolves the type before either backend and refuses non-docx types with a pointer ("this is a sheet; use read_sheet").
- The `list_wiki_docs` description routes each obj_type to the right tool.

## Locked rules (unchanged and binding)
- **Thin proxy.** Forward Feishu OpenAPI. No home-made parsers. No paging beyond passing Feishu's own `page_token`/`offset` through.
- **Owner-only gate.** No change to the owner gate, the kill switch, the 40-call budget, or audit (audit stays content-free).
- **Delete.** `delete_doc` moves an item only to the recycle bin, and only after exact title confirmation, now for docx/sheet/bitable/slides/file. Wiki-hosted items of any type are never deletable. The guard is `get_node` with the item's own `obj_type`.
  - The OSS **empty-title guard** is kept and extended: an empty live title, from either the docx path or the `drive/v1/metas/batch_query` path, refuses the delete.
- **In-doc deletes** (a Base field or record, a slide page) are content edits. They need no title confirmation, but the tool description must say they're irreversible.
- **Chats and contacts stay read-only.**
- **Allowlist** gets only the exact new method+path rules, on canonical `*.feishu.cn` hosts. The region rewrite happens after the allowlist check, so no larksuite host is ever allowlisted.
- **No personal data in the repo.** That means no tenant subdomain, no `ou_` ids and no real doc titles in source, tests, fixtures or docs.

## Scopes
- One list, `FEISHU_SCOPES` in `src/scopes.ts`, for both regions: the existing 25 plus these 23, inserted before `offline_access`, in this order:
  - `sheets:spreadsheet.meta:read`, `sheets:spreadsheet:read`, `sheets:spreadsheet:create`, `sheets:spreadsheet:write_only`
  - `base:app:read`, `base:table:read`, `base:field:read`, `base:record:read`, `base:app:create`, `base:field:create`, `base:record:create`, `base:record:update`, `base:field:update`, `base:field:delete`, `base:record:delete`
  - `slides:presentation:read`, `slides:presentation:create`, `slides:presentation:update`, `slides:presentation:write_only`
  - `drive:drive.metadata:readonly`, `drive:file:download`, `drive:file:upload`
  - `mindnote:node:read`
- **Bulk-import file:** add `scopes.import.json` at the repo root, shaped for the developer console's bulk import: `{"scopes":{"tenant":[],"user":[…FEISHU_SCOPES]}}`. A test pins it to `src/scopes.ts`, alongside the existing README/AGENTS scope-block tests.
- **Re-authorization.** Existing deployers enable the new scopes, publish a new version and reconnect, once.

## Region
Paths are the same on both regions; the existing rewrite maps the hosts.

| API | On Lark |
|---|---|
| Sheets v2/v3, Bitable v1, Drive v1, Wiki v2 | Documented |
| Slides AI XML | Generally available on Lark since 2026-05 (larksuite/cli #1033) |
| Base v3 records, Mindnote v1 | **Unverified** |

Lark stays **beta**. The README notes that a Lark console may not offer every scope yet; if a scope is missing, the matching tool returns the Feishu error as-is. No region-specific code.

## Port hazards (implementation rules)
1. **Re-apply hunks; never overwrite files.**
   - `src/feishu/client.ts`: add rules; keep the `rewriteUrlForRegion` import and call.
   - `src/mcp/doc-delete.ts`: keep the empty-title guard.
   - `src/mcp/server.ts`: keep the server name `lark-general-connector`.
   - `src/index.ts` and `src/auth/*`: no change.
   - New files (`src/mcp/doc-{sheet,bitable,slides,file,mindnote}.ts`) may be ported whole.
2. **Include the private hotfix.** `replace_slide` query params, and the `fetch_doc` type gate before the MCP backend.
3. **De-personalize every fixture and test.**
   - Hosts: `example.feishu.cn`.
   - Users: `ou_example0000000000000000000000`.
   - Titles: neutral examples like "Weekly summary (example)", "Release schedule (example)", "Demo deck".
   - Tokens: synthetic values that keep the real format/length.
   - Before each push, check that `scripts/check-no-secrets.mjs` and CI gitleaks are green, and that `rg` shows no tenant subdomain or real `ou_` id.
4. **Region tests.** Every new tool's test asserts that with `FEISHU_REGION=lark` the outbound host is `open.larksuite.com` and the allowlist decision is unchanged.

## Docs (both READMEs mirror; only 飞书/Feishu or Lark; no country or market words; keep the current friendly tone)
- **Intro examples.** Add "Read the weekly summary sheet and tell me who hasn't filled it in yet." / "读一下周报表格，看看谁还没填。"
- **"What it can and cannot do" table.**
  - New row **Sheets, Bases, slides, files** / **表格、多维表格、幻灯片、文件**:
    - Can: read and write cells (formulas too), read and edit Base records and fields, read and edit slide pages, read small files (≤256 KiB) and upload files (≤10 MiB), read mind notes.
    - Cannot: edit mind notes, or delete anything inside a wiki.
  - Delete row widened to "docs, sheets, Bases, slides and files in your own cloud space".
  - One plain sentence: deleting a Base field or record, or a slide page, can't be undone, so the AI checks with you first.
- **Setup ④.** Mention the bulk-import file: "Tip: in **Permissions & Scopes**, use bulk import (批量导入) and paste `scopes.import.json`."
- **FAQ.**
  - New entry **"I updated the connector. How do I turn on the new features?"** / **"更新了连接器，新功能怎么打开？"**: redeploy, enable the new scopes (or import the JSON again), publish a new version, disconnect and reconnect.
  - Lark entry: add "A Lark console may not offer every scope yet. If one is missing, that one feature won't work; the rest still do."
- **Technical reference.**
  - "Twenty-five tools", plus a bullet listing the 9 new tools.
  - The `delete_doc` line lists the five types.
  - File limits, and that re-upload makes a new token.
  - Scope list regenerated.
- **AGENTS.md.**
  - Safety line: "Doc delete only moves one cloud-space docx, sheet, bitable, slides or file …".
  - Scope block regenerated.
  - Mention `scopes.import.json`.
  - Short "Upgrade an existing Worker" paragraph.
  - "Never widen scopes …" stays (deploy-time rule).
- **Wizard.** No logic change. The "Add the scopes" pause mentions `scopes.import.json`; tests updated if pinned.
- **CONTEXT.md.** Add *File inline cap* and *In-doc delete*.

## Testing
Vitest with de-personalized fixtures, following the existing `test/fake-feishu.ts` pattern. Each ticket ships its tests, keeps `npm test` green, and adds no network calls.

## Blocking graph
```
01 ─┬─ 02
    ├─ 03 ── 04
    ├─ 05
    ├─ 06 ── 08
    ├─ 07
    └─ 09  (also needs 03, 05, 06, 07)
10 (needs 01–09) ── 11 live acceptance (owner)
```

## Out of scope
- Mind note writes.
- Creating mind notes.
- Permanent delete.
- Any chat or contact write.
- Region-specific code paths.
