# 08 delete_doc for sheet, bitable, slides, file
Blocked by: 06

## What
- Re-apply the private hunks to the OSS `src/mcp/doc-delete.ts`; do not overwrite the file.
- Title source: docx keeps its current path; other types use `metas/batch_query` with the matching `doc_type`.
- Wiki guard: `get_node?token=<obj>&obj_type=<type>`. If a node is found, refuse.
- **Empty-title guard kept and extended:** an empty or missing live title refuses for every type.
- DELETE `drive/v1/files/{token}?type=<type>` only.

## Acceptance
Tests for every type:
- a wiki-hosted item is refused before DELETE;
- a wrong title is refused;
- an empty live title is refused;
- the happy path sends exactly one DELETE with the right `type`.

The existing docx tests stay green.
