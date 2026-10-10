# 05 read_slides + write_slides
Blocked by: 01

## What
- Read: `slides_ai/v1/xml_presentations/{id}`.
- Write: `create`, `add_slide`, `replace_slide`, `delete_slide`. For replace_slide, `slide_id` and `revision_id=-1` go in the **query** (private hotfix). The description says delete_slide is irreversible.
- Large XML is subject to the existing payload cap, which reports `too_large`.

## Acceptance
- Tests: the replace_slide URL carries the query params; the body carries only the replacement.
- Delete-slide shape test.
- Lark host test.
- If the diff passes about 300 lines, split into 05a (read) and 05b (write).
