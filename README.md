# K Filesystem MCP

English | [中文](README.zh-CN.md)

K Filesystem MCP is a K edition of the official MCP filesystem server, tuned for Codex-style local development workflows.

It keeps the general purpose of `@modelcontextprotocol/server-filesystem`, then adds faster high-frequency file operations, bounded output, structured status fields, safer edit/write behavior, and clearer tool descriptions so coding agents can choose the right filesystem tool with fewer retries.

## Security Warning

This server runs in global local filesystem mode. It can read, write, copy, move, and remove any file that the current OS user can access.

Use it only in trusted local environments. Do not expose it to remote clients, shared machines, or untrusted users.

## What This Edition Optimizes

- Fewer shell/PowerShell calls for common filesystem work.
- Smaller context usage through range reads, compact output, structured summaries, bounded diffs, and long-line guards.
- Fewer failed edit attempts through exact ranges, anchor-based edits, stable error codes, and concise edit diagnostics.
- Safer mutations through overwrite guards, deletion previews, recursive deletion bounds, optional backups, newline/BOM preservation, and dry-run support where risk justifies it.
- Better broad search behavior through rg-backed search modes, bounded normal-search timeouts with partial results, sharded continuation, optional shard concurrency, suggested retries, opt-in default excludes, partial-shard reporting, and explicit hidden/ignored/symlink coverage flags.

## Main Tools

- `read_text_file`: read known text files with `head`, `tail`, `start_line` / `end_line`, line numbers, output bounds, and selection metadata.
- `read_multiple_files`: batch reads for known files or ranges, with bounded `read_concurrency` and per-file success/error metadata.
- `search_files`: find paths with glob, depth, timeout, optional default excludes, hidden/no-ignore/symlink flags, compact output, result summaries, accurate timeout-aware `directory_only` walking, and an explicit fast `rg_derived` directory strategy with `directory_source_limit` when completeness is not required.
- `search_text`: search file contents with output modes, context controls, type filters, timeout, optional default excludes, max match length, sharded continuation, optional `shard_concurrency`, and rg-backed fast paths.
- `list_directory`, `list_directory_with_sizes`, `directory_tree`: bounded directory browsing, size-aware listing, and stable visual tree output.
- `get_file_info`, `get_multiple_file_info`: structured metadata for one or many paths, with bounded `metadata_concurrency` for large batches.
- `diff_text_files`: bounded unified diffs for two local text files.
- `edit_file`: exact edits, ranged edits, anchor edits, top-level single-edit shortcuts, original-range batch application, and structured diagnostics.
- `write_file`: create files or intentionally replace whole files with overwrite guards, bounded diffs, optional backups, and newline/BOM handling.
- `copy_path`, `move_file`, `remove_path`: guarded copy, move, and deletion tools with bounded preflight where applicable, timeout-aware status fields, elapsed time, post-failure path state, and compressed errors.
- `read_media_file`: bounded base64 reads for local images or audio.

## Install

Clone or copy this repository, then install runtime dependencies once:

```bash
npm install
```

The repository already includes `dist/`, so this step installs dependencies only. No build step is required for normal use.

## Run Check

Codex normally starts the server from the MCP configuration below. To verify the server manually, run this from the repository root:

```bash
node dist/index.js
```

## Codex Configuration

Use a dedicated MCP server entry for this repository, with a short name such as `fs_k`. Put it in the Codex `config.toml` that your Codex installation loads, usually the user-level config under your Codex home directory.

Recommended configuration:

```toml
[mcp_servers.fs_k]
type = "stdio"
command = "cmd"
args = ["/c", "C:\\path\\to\\k-filesystem-mcp\\k-mcp-server-filesystem.cmd"]
enabled = true
```

Replace the second `args` entry with the absolute path to your local `k-mcp-server-filesystem.cmd`. On Windows, launching the wrapper through `cmd /c` is the most compatible form. If you are not using Windows, run the server with `node dist/index.js` from the repository root instead.

After restart, Codex should expose tools with the `mcp__fs_k` prefix. Then add a workspace rule that prefers `mcp__fs_k` for filesystem work and keeps shell/PowerShell for build, script, and process tasks.

Place your real `AGENTS.md` at the repository root, or in a nested subdirectory when you need subtree-specific instructions. To make the rule apply across many local repositories under one parent folder, put `AGENTS.md` in that parent folder, such as your user home directory. For truly global personal defaults across unrelated paths, use Codex global guidance/config instead of relying on a repository `AGENTS.md`. Example files live under `examples/`.

A minimal rule is provided in:

- [`examples/AGENTS.example.md`](examples/AGENTS.example.md)
- [`examples/k-filesystem-mcp-rule.example.md`](examples/k-filesystem-mcp-rule.example.md)

The important routing idea is simple:

- Use K MCP for reads, searches, listings, metadata, diffs, edits, writes, copies, moves, and removals when a matching tool exists.
- Use shell/PowerShell for builds, scripts, dynamic generation, process inspection, syntax checks, and work outside MCP capabilities.
- Use `dryRun: true` for risky writes, recursive deletion, broad/ambiguous edits, and important user/project data; skip it for clear low-risk exact edits.
- Restart Codex after changing the MCP config or workspace rules so the new routing is picked up.

## Documentation

- [Deployment guide](docs/deployment.md)
- [Codex usage guide](docs/codex-usage.md)
- [Tool reference](docs/tool-reference.md)
- [Security notes](docs/security.md)
- [Optimization notes](docs/optimization-notes.md)
- [Chinese docs](docs/deployment.zh-CN.md), [codex-usage.zh-CN.md](docs/codex-usage.zh-CN.md), [tool-reference.zh-CN.md](docs/tool-reference.zh-CN.md), [security.zh-CN.md](docs/security.zh-CN.md), [optimization-notes.zh-CN.md](docs/optimization-notes.zh-CN.md)

## Upstream

This project is a modified K edition of the official MCP filesystem server:

- `@modelcontextprotocol/server-filesystem`
- https://github.com/modelcontextprotocol/servers

It is not affiliated with or endorsed by the upstream project.

## License

MIT. See `LICENSE` and `NOTICE.md`.
