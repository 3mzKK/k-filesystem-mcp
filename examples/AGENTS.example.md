# Workspace Instructions

## K Filesystem MCP

Prefer `mcp__fs_k` over shell commands for filesystem operations it directly supports.

- Known text file: use `read_text_file` with `head`, `tail`, `start_line`/`end_line`, `max_lines`, or `max_chars`.
- Several known files: use `read_multiple_files`; keep `read_concurrency` bounded for large batches.
- Find paths: use `search_files`; inspect `summary.timed_out`, `summary.searched_ms`, `summary.warnings`, and structured `summary.suggested_retry` before concluding absence. `directory_only: true` defaults to accurate `directory_strategy: "walk"`, so it preserves empty directories but should stay scoped with `max_depth`, `limit`, and `timeout_ms`. Use `directory_strategy: "rg_derived"` only when speed matters more than complete directory coverage; if `summary.source_stopped_by_limit` is true, increase `directory_source_limit` or switch to `walk`.
- Search contents: use `search_text`; use `output_mode: "files"` when paths are enough, `output_mode: "count"` when counts are enough, `timeout_ms` for broad normal searches, and sharded mode for broad coverage. If `summary.timed_out` is true, results are partial; follow structured `summary.suggested_retry`. Use `default_excludes: true` only when skipping common high-noise directories is acceptable and check `summary.applied_default_excludes`. Use `shard_concurrency: 2` or `4` only on local SSD repositories when speed matters; keep `1` or `2` for network drives or busy machines.
- Browse a known directory: use `list_directory`; use `timeout_ms` for slow directories and `directory_tree` only for visual structure.
- Metadata: use `get_file_info` or `get_multiple_file_info`; keep `metadata_concurrency` lower on slow network drives or busy disks.
- Compare two text files: use `diff_text_files`.
- Small targeted edits: use `edit_file` with `expected_occurrences: 1` and line bounds when useful.
- New files or intentional whole-file replacement: use `write_file`.
- Copy, move, remove: use `copy_path`, `move_file`, and `remove_path`; keep recursive copy/remove preflights bounded with `max_entries` and `timeout_ms`, and inspect `move_file` post-failure `source_exists` / `destination_exists` plus `errors` before retrying.

`anchor_mode: "exact"` is the default for `beforeText`/`afterText` anchors. Use `anchor_mode: "flexible"` only for line-level trim matching, not general fuzzy matching.

Use shell commands for builds, scripts, process inspection, syntax checks, and operations outside K MCP capabilities.
