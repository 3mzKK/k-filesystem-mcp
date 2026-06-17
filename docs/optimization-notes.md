# Optimization Notes

This page keeps only the user-visible optimization themes worth knowing about.

## Main Optimizations

- Range reads and tail reads reduce unnecessary whole-file reads.
- Batch file reads reduce repeated requests.
- Search output is tuned for lower token usage and supports sharded continuation.
- Directory browsing includes summaries, stable sorting, and tighter output control.
- Metadata queries support batch reads, bounded `metadata_concurrency`, and more consistent structured errors.
- Diff output avoids wasting context on very long lines or huge diffs.
- `edit_file` includes anchor edits, batch application from the original range, structured diagnostics, and shorter failure messages.
- `write_file`, `copy_path`, `move_file`, and `remove_path` include overwrite guards, previews, recursive bounds, timing/status fields, and structured errors. `copy_path` now preflights real recursive directory copies with `max_entries` and `timeout_ms`.
- Read/edit/write/diff/search outputs are compressed so they return only what is needed to decide the next step.

## Design Principles

- Avoid repeated reads and repeated failures.
- Prefer structured status over large natural-language output.
- Make tool boundaries clear so Codex picks the right tool.
- Keep high-risk actions conservative and low-risk precise actions lightweight.

## Usage Suggestions

- Prefer range reads for known files instead of whole-file reads.
- Batch known files together.
- Use paths or counts instead of full content when that is enough.
- Read the smallest target range before editing, and add anchors only when needed.
- Decide on risk before copy, move, delete, or overwrite operations.
