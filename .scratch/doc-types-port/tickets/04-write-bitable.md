# 04 write_bitable
Blocked by: 03

## What
- `create_app`, `create_field`, `update_field`, `delete_field`, `create_record`, `update_record`, `delete_record`.
- The description says delete_field and delete_record are irreversible and need no title confirmation (in-doc delete).

## Acceptance
- Request-shape tests per action.
- The DELETE rules allow only the field/record paths, never app or table delete.
