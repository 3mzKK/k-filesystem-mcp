# Tool Reference

This is not a full API schema. It is a tool-choice guide for users and coding agents.

## Reading

- `read_text_file`: read known text files. Good for `head`, `tail`, `start_line/end_line`, line numbers, `max_lines`, `max_chars`, and range reads. Range reads return returned line numbers, EOF state, and whether the requested range was complete.
- `read_multiple_files`: read several known files or ranges at once. Good for replacing repeated single-file reads; `read_concurrency` bounds parallel file reads so large batches do not create excessive filesystem pressure. If only some entries fail, retry only the failed or incomplete ones.
- `read_media_file`: read local image or audio bytes as base64. It has a size limit by default and should not be used for text.

## Searching

- `search_files`: find files by path or glob. Good for unknown file paths. Supports `timeout_ms`; if it times out, returned paths are partial and `summary.suggested_retry` explains the next safer retry. Normal file search uses `rg --files`; `directory_only: true` defaults to `directory_strategy: "walk"`, which uses accurate directory walking so empty directories are preserved and timeout/partial summaries are available. `directory_strategy: "rg_derived"` is faster because it derives directories from `rg --files`, but it may omit empty directories and ignored-only directories, so do not use it to prove absence. In `rg_derived` mode, `directory_source_limit` bounds the source file list used to derive directories; inspect `summary.source_stopped_by_limit`, `summary.directory_source_limit`, and `summary.suggested_retry` before deciding whether to increase the source limit or switch to `walk`. Summaries include `searched_ms`; rg warnings are compressed under `summary.warnings`. Do not use `directory_tree` to prove absence.
- `search_text`: search file contents. Supports `output_mode: "files" | "count" | "content" | "compact" | "structured" | "text" | "both"`, plus `context_before`, `context_after`, `context`, `type`, `timeout_ms`, and `max_match_chars`. Normal timed-out searches return partial results with `summary.timed_out`, `summary.searched_ms`, structured `summary.suggested_retry`, and human-readable `summary.suggested_retry_text`.
- `default_excludes`: opt-in for `search_files` and `search_text`. When `true`, common high-noise directories such as `.git`, `node_modules`, `.cache`, `.turbo`, `.next`, `.nuxt`, and `coverage` are skipped and reported in `summary.applied_default_excludes`. It defaults to `false` to preserve complete coverage.
- `search_text` sharded mode: use `sharded: true` for broad searches. Use `shard_concurrency: 2` or `4` on local SSD repositories when speed matters; keep `1` or `2` for network drives or when the machine is already busy. If results are incomplete, continue with `include_shards` and the returned `remaining_shards`; handle `partial_shards` and `failed_shards` separately when needed.
- Coverage flags: `hidden`, `no_ignore`, and `follow_symlinks` broaden coverage and may slow or noisify output, so use them only when needed.

## Directories And Metadata

- `list_directory`: browse a known directory with filters, depth, limits, optional `timeout_ms`, and summaries.
- `list_directory_with_sizes`: use when file sizes matter. It only measures the final listed entries, not a full top-N scan of everything, and supports optional `timeout_ms`.
- `directory_tree`: inspect structure. It supports `sortBy: "name" | "type" | "none"`, optional `timeout_ms`, compact output, and bounds. It is not a proof of absence.
- `get_file_info`: structured metadata for one file or directory, useful as a replacement for single-path `Get-Item`.
- `get_multiple_file_info`: batch metadata with per-path error details and bounded `metadata_concurrency`; when a batch partially fails, retry only the failed paths. Lower `metadata_concurrency` for slow network drives or busy disks.

## Comparison And Editing

- `diff_text_files`: compare two local text files with a bounded unified diff. It can replace reading both files first and reduces token cost on large diffs.
- `edit_file`: small exact edits, ranged edits, and anchor edits. Good for local changes in existing files. Supports `oldText` / `newText`, `edits`, `start_line/end_line`, `expected_occurrences`, `match_mode`, `beforeText` / `afterText`, and `anchor_mode`.
- `write_file`: create a new file or deliberately replace an entire file. Existing-file overwrites require explicit `overwrite: true`; use `dryRun`, `allow_major_overwrite`, `backup_existing`, `newline`, and `bom` when needed. For long documents, prefer `edit_file` for append or local changes.

## Path Operations

- `create_directory`: create directories, including nested ones.
- `copy_path`: copy files or directories. Directory copies require `recursive: true`; existing directory destinations are rejected, and higher-risk directory copies should use dry-run first. Real recursive directory copies run a cancellable preflight bounded by `max_entries` and `timeout_ms`; results include `elapsed_ms`, and failures include `partial` plus compressed `errors`.
- `move_file`: move or rename. Existing destinations are rejected; simple moves to a fresh target can usually run directly. Execution failures return `elapsed_ms`, compressed `errors`, post-failure `source_exists` / `destination_exists`, and a `CROSS_DEVICE_MOVE_UNSUPPORTED` code plus suggested action for cross-volume moves.
- `remove_path`: delete files or directories. It defaults to dry-run; non-empty directory removal requires `recursive: true`, and recursive deletion is bounded by `max_entries`. Removal preflight now supports `timeout_ms`, `elapsed_ms`, `timed_out`, `partial`, and compressed `errors`.

## `edit_file` Diagnostics

Common error codes:

- `MATCH_NOT_FOUND`: no match was found.
- `AMBIGUOUS_MATCH`: the match is not unique.
- `EMPTY_MATCH_TEXT`: `oldText` is empty.
- `EMPTY_ANCHOR_TEXT`: `beforeText` or `afterText` is empty.

Handling rules:

- Do not repeat the same failing parameters.
- Inspect `edit_error` candidate counts, candidate lines, match mode, and anchor mode first.
- If needed, reread the smallest target range and add `start_line/end_line` plus `expected_occurrences: 1`.
- `anchor_mode: "flexible"` is only for line-level trim matching, not general fuzzy matching.
