# 部署指南

本页面给出新设备上的最小部署方式。目标是把已经优化过的 K Filesystem MCP 快速装到另一台机器上，并让 Codex 默认用上它。

## 1. 准备仓库

把 `k-filesystem-mcp` 仓库复制到新设备，或者直接重新克隆到本地目标目录。

## 2. 安装依赖

在仓库根目录安装一次运行依赖：

```bash
npm install
```

仓库已经包含 `dist/`，这一步只安装依赖。正常使用不需要重新构建。

## 3. 运行检查

正常情况下，Codex 会根据 MCP 配置自动启动服务器。需要手动验证时，可以在仓库根目录执行：

```bash
node dist/index.js
```

## 4. 配置 Codex

在 Codex 的 MCP 配置里，把这个服务器作为文件系统 MCP 使用，名称建议保留 `fs_k` 或带 `K` 标识，方便和旧版区分。

建议在 Windows 下通过 `cmd /c` 执行仓库里的 `.cmd` 包装脚本：

```toml
[mcp_servers.fs_k]
type = "stdio"
command = "cmd"
args = ["/c", "C:\\path\\to\\k-filesystem-mcp\\k-mcp-server-filesystem.cmd"]
enabled = true
```

把 `args` 第二项替换成你本地 `k-mcp-server-filesystem.cmd` 的绝对路径。例如本机可以是：

```toml
[mcp_servers.fs_k]
type = "stdio"
command = "cmd"
args = ["/c", "C:\\Users\\Administrator\\.codex\\mcp-servers\\k-filesystem\\k-mcp-server-filesystem.cmd"]
enabled = true
```

如果不是 Windows，再退回到仓库根目录的 `node dist/index.js`。

然后加入一条默认偏好：优先使用 `mcp__fs_k` 处理文件系统操作。规则可以放在仓库根目录的 `AGENTS.md`，也可以放在子目录做局部覆盖；想让多个本地仓库继承同一规则时，可以放在它们共同的父目录，例如用户主目录。真正跨无关路径的个人全局默认，建议放到 Codex 全局指导或全局配置里。

可直接参考：

- `examples/AGENTS.example.md`
- `examples/k-filesystem-mcp-rule.example.md`

## 5. 首次检查

首次配置并重启 Codex 后，建议用一个临时文件做最小检查：

- `list_allowed_directories`
- `read_text_file`
- `edit_file`
- `search_text`

如果这些工具都正常，说明服务器和 Codex 连接基本可用。

## 6. 常见问题

- 如果 Codex 还在使用旧规则，先同步 `AGENTS.md` 或等价规则文件。
- 如果编辑类操作反复失败，优先看 `edit_error.code`、候选数、候选行号和锚点信息，再缩小范围重试。
- 如果只需要读一段文件，不要整文件读取，改用范围读取。
