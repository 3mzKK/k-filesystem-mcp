# Security Notes

K Filesystem MCP runs in global local filesystem mode.

That means it can read, write, copy, move, and remove any file the current OS user can access. This is suitable for private local Codex workflows, but not for exposing as a remote shared file service.

## Usage Boundaries

- Use it only in trusted local personal environments.
- Do not expose it to remote clients.
- Do not run it where untrusted users can connect.
- Do not treat it like a sandbox.

## High-Risk Actions

Use `dryRun: true` first for:

- Overwriting important existing files.
- Deleting user or project data.
- Recursive directory deletion.
- Copying large directories or directories with unclear source or destination.
- Broad batch edits with unclear scope.

Low-risk, small exact edits on a freshly read target range can skip dry-run to save one round trip.

## Existing Guards

- `write_file` requires explicit `overwrite: true` for existing files.
- Large replacements that shrink a file substantially trigger the major overwrite guard unless `allow_major_overwrite: true` is set.
- `write_file` can use `backup_existing: true`, but it defaults off to avoid noisy backup files.
- `remove_path` defaults to dry-run.
- Non-empty directory removal requires `recursive: true`.
- Recursive removal is bounded by `max_entries`.
- `copy_path` refuses existing destinations by default, so directories are not merged silently. Real recursive directory copies are preflight-bounded by `max_entries` and `timeout_ms` before copying starts.

## Recommended Habits

- Make paths specific before deleting.
- Check structured status fields during copy, move, and delete operations.
- When a structured `code` appears, adjust parameters or narrow the range instead of retrying blindly.
- For long logs, long docs, and record files, prefer `edit_file` for append or local edits instead of whole-file overwrite.
