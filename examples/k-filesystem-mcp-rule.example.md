# K Filesystem MCP Rule Example

Use K Filesystem MCP for filesystem inspection and mutation when a matching tool exists.

Efficiency rules:
- Locate first, then read the smallest useful range.
- Batch independent known reads with `read_multiple_files`; keep `read_concurrency` bounded for large batches.
- Batch metadata with `get_multiple_file_info`; lower `metadata_concurrency` for slow network drives or busy disks.
- Use compact or structured output modes for large result sets.
- Bound large outputs and traversals with `max_lines`, `max_chars`, `limit`, `max_depth`, `timeout_ms`, `max_diff_chars`, or `max_diff_line_chars`.
- For directory-only file searches, use accurate `directory_strategy: "walk"` by default; use `directory_strategy: "rg_derived"` only when fast approximate directory discovery is acceptable. If `source_stopped_by_limit` is true, follow `suggested_retry`, increase `directory_source_limit`, or switch to `walk` when accuracy matters.

Edit rules:
- Use `edit_file` for small exact edits to existing files.
- Use `start_line` and `end_line` when repeated text may exist.
- Use `beforeText` and `afterText` anchors when stable surrounding text is easier than matching the changing middle.
- Keep `anchor_mode: "exact"` by default.
- Use `anchor_mode: "flexible"` only for line-level trim matching.
- Inspect `edit_error.code`, `match_type`, `match_mode`, `anchor_mode`, `search_preview`, `candidate_count`, and `candidate_lines` before retrying.

Safety rules:
- Use `dryRun: true` for risky overwrites, recursive deletion, ambiguous edits, or operations affecting user/project data.
- Skip dry-run for clear low-risk edits after reading the target range.
- `move_file` execution failures include `elapsed_ms`, compressed `errors`, post-failure path state, and cross-device guidance; inspect those fields before retrying.
- `remove_path` defaults to dry-run and should stay bounded with `max_entries` and `timeout_ms` for recursive deletion preflights.
