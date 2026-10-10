# 09 fetch_doc type gate + routing descriptions
Blocked by: 01, 03, 05, 06, 07

## What
- `fetch_doc` resolves the ref (URL, wiki token or URL) before **either** backend. A non-docx type returns "this is a <type>; use <tool>" with no outbound docx call.
- Update the `fetch_doc` and `list_wiki_docs` descriptions to name the tool for each obj_type.

## Acceptance
- Tests: a `/sheets/` URL, a wiki sheet token and a wiki sheet URL each return the pointer.
- docx is unchanged on both `mcp` and `openapi` backends.
- The Lark `TOOL_BACKENDS` recipe is unchanged.
