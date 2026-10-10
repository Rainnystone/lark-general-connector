# 06 read_file + write_file
Blocked by: 01

## What
- Read: `drive/v1/metas/batch_query` metadata, plus download inlined when ≤256 KiB (UTF-8 text as text, otherwise base64). Over the cap returns `too_large:true` with the size.
- Write: `upload_all` up to 10 MiB. The description says a re-upload creates a new file_token. Re-apply the `src/feishu/media.ts` hunks.

## Acceptance
- Tests: cap boundaries (equal to and one over); upload multipart shape; refusal over 10 MiB before any outbound call.
