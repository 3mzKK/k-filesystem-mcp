# Codex Usage Guide

This guide helps Codex or a similar local coding agent choose the right filesystem tool faster and with fewer retries.

## Core Rules

- Find the path first, then read the content.
- Prefer `read_text_file` for known files and `read_multiple_files` for batch reads.
- Use `search_text` with `output_mode: "files"` when paths are enough, or `search_files` when you only need path discovery.
- Use `search_text` with `output_mode: "count"` when only counts matter.
- Prefer the matching tool for known ranges, directories, metadata, and diffs instead of guessing through shell commands.

## Reading And Searching

- For known text files, prefer range reads over whole-file reads.
- Start with the smallest useful range, then continue using returned line metadata.
- Batch the same known-file set through `read_multiple_files` whenever possible.
- Prefer compact, structured, files, or count output modes when searching.
- Use `timeout_ms` to bound broad normal `search_text` and rg-backed `search_files`. If a search returns `summary.timed_out`, treat results as partial and follow structured `summary.suggested_retry`; use `summary.suggested_retry_text` only as the human-readable short explanation. Use `summary.searched_ms` to judge whether the scope is too broad, and `summary.warnings` for compressed rg stderr diagnostics.
- Use `default_excludes: true` only when skipping common high-noise directories is acceptable; check `summary.applied_default_excludes` because this reduces coverage.
- For broad searches, use `search_text` sharded mode. Use `shard_concurrency: 2` or `4` only when parallel shard search is worth the extra disk and CPU pressure; keep lower values for network drives. If results are incomplete, continue `remaining_shards` instead of repeating the same large search.
- If the file location is unclear, use `search_files` first, then read content.

## Directories And Metadata

- Use `list_directory` for known directories.
- Use `directory_tree` for structure only; it is not proof that a file does not exist.
- Use `list_directory_with_sizes` when file sizes matter.
- Use `get_file_info` for a single path and `get_multiple_file_info` for multiple paths.
- Use `diff_text_files` when comparing two files.

## Editing And Writing

- Prefer `edit_file` for small changes.
- Read the smallest target range first.
- Give `edit_file` a unique match or a narrow line range when possible.
- Use `beforeText` / `afterText` anchors when the changing middle drifts.
- `anchor_mode: "exact"` is the default.
- `anchor_mode: "flexible"` is only for line-level trim matching.
- Use `write_file` for new files or deliberate whole-file replacement.
- Check risk before `write_file` overwrites, and use dry-run when needed.
- Use `apply_patch` for more complex patches.

## Risk Control

- Reserve `dryRun: true` for risky overwrites, deletions, ambiguous edits, or important data.
- For obviously safe small edits, skip dry-run to save a round trip.
- Check structured status before copy, move, or delete operations.
- When a failure returns a structured error code, narrow the range, change anchors, or switch strategies instead of repeating the same parameters.
