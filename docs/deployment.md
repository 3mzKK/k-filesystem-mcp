# Deployment Guide

This page describes the minimal setup for a new machine. The goal is to install K Filesystem MCP locally and make Codex use it by default.

## 1. Prepare The Repository

Copy this repository to the target machine, or clone it into a local directory.

## 2. Install Dependencies

From the repository root, install runtime dependencies once:

```bash
npm install
```

The repository already includes `dist/`, so this step installs dependencies only. No build step is required for normal use.

## 3. Run Check

Codex normally starts the server from the MCP configuration. To verify the server manually, run this from the repository root:

```bash
node dist/index.js
```

## 4. Configure Codex

Add this server to the Codex MCP configuration. Use a clear name such as `fs_k`, so it is easy to distinguish from other filesystem MCP servers.

On Windows, launch the `.cmd` wrapper through `cmd /c`:

```toml
[mcp_servers.fs_k]
type = "stdio"
command = "cmd"
args = ["/c", "C:\\path\\to\\k-filesystem-mcp\\k-mcp-server-filesystem.cmd"]
enabled = true
```

Replace the second `args` entry with the absolute path to your local `k-mcp-server-filesystem.cmd`. For example:

```toml
[mcp_servers.fs_k]
type = "stdio"
command = "cmd"
args = ["/c", "C:\\Users\\Administrator\\.codex\\mcp-servers\\k-filesystem\\k-mcp-server-filesystem.cmd"]
enabled = true
```

On non-Windows systems, run the server with `node dist/index.js` from the repository root.

Then add a default preference rule: use `mcp__fs_k` for supported filesystem work. Put `AGENTS.md` in the repository root for one repository, in a subdirectory for subtree-specific rules, or in a common parent directory such as the user home directory for many local repositories. For truly global personal defaults across unrelated paths, use Codex global guidance/config.

Reference examples:

- `examples/AGENTS.example.md`
- `examples/k-filesystem-mcp-rule.example.md`

## 5. First Check

After configuring and restarting Codex, test with a temporary file using:

- `list_allowed_directories`
- `read_text_file`
- `edit_file`
- `search_text`

If these work, the server and Codex connection are basically functional.

## 6. Troubleshooting

- If Codex still uses old behavior, update `AGENTS.md` or equivalent rules and restart Codex.
- If edits repeatedly fail, inspect `edit_error.code`, candidate counts, candidate lines, and anchor diagnostics before narrowing the range.
- If only a slice of a file is needed, use range reads instead of whole-file reads.
