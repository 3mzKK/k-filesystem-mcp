# K Filesystem MCP

[English](README.md) | 中文

K Filesystem MCP 是基于官方 MCP filesystem server 修改的 K 版，主要面向 Codex 本地开发工作流。

它保留了 `@modelcontextprotocol/server-filesystem` 的基本用途，同时补强了高频文件操作、结构化输出、安全编辑/写入、可控搜索和更清晰的工具边界，目标是让 Codex 更少走弯路、更少重复尝试。

## 安全警告

这个服务器运行在全局本地文件系统模式。它可以读取、写入、复制、移动和删除当前操作系统用户有权限访问的文件。

只建议在可信的本地环境中使用。不要暴露给远程客户端、共享机器或不可信用户。

## 这个版本优化了什么

- 常见文件操作更少依赖 shell / PowerShell。
- 通过范围读取、compact 输出、结构化摘要、有边界 diff 和长行保护，减少上下文消耗。
- 通过精确范围、锚点编辑、稳定错误码和更短的编辑诊断，减少反复失败。
- 通过覆盖护栏、删除预览、递归删除边界、可选备份、换行/BOM 保留和按风险使用 dry-run，提高安全性。
- 通过 rg 支持的搜索模式、普通搜索超时部分返回、分片续搜、可选分片并发、suggested_retry、可选 default_excludes、partial shard 提示和显式覆盖开关，提高大范围搜索效率。

## 主要工具

- `read_text_file`：已知文本文件的读取，支持 `head`、`tail`、`start_line` / `end_line`、行号、输出限制和 selection 元数据。
- `read_multiple_files`：多文件或多范围批量读取，支持有边界的 `read_concurrency`，并带每个文件的成功/失败元数据。
- `search_files`：按路径查找文件，支持 glob、深度、timeout、可选 default_excludes、hidden/no-ignore/symlink、compact 输出、结果摘要、准确且支持 timeout 的 `directory_only` 遍历，以及完整性不重要时显式使用且可用 `directory_source_limit` 控制源文件扫描上限的快速 `rg_derived` 目录策略。
- `search_text`：内容搜索，支持输出模式、上下文控制、类型过滤、timeout、可选 default_excludes、最长匹配行限制、分片续搜、可选 `shard_concurrency` 和 rg 快速路径。
- `list_directory`、`list_directory_with_sizes`、`directory_tree`：有边界目录浏览、按大小列表和稳定的结构树输出。
- `get_file_info`、`get_multiple_file_info`：单路径或多路径结构化元数据，大批量时可用 `metadata_concurrency` 控制并发。
- `diff_text_files`：两个本地文本文件的有边界 unified diff。
- `edit_file`：精确编辑、行范围编辑、锚点编辑、顶层单编辑快捷方式、原始范围批量应用和结构化诊断。
- `write_file`：新建文件或明确整文件替换，带覆盖护栏、有边界 diff、可选备份和换行/BOM 处理。
- `copy_path`、`move_file`、`remove_path`：带有边界 preflight、timeout 状态字段、耗时、失败后路径状态和压缩错误的复制、移动和删除工具。
- `read_media_file`：对本地图片或音频做有边界的 base64 读取。

## 安装

克隆或复制本仓库后，在仓库根目录安装一次运行依赖：

```bash
npm install
```

仓库已经包含 `dist/`，这一步只安装依赖。正常使用不需要重新构建。

## 运行检查

正常情况下，Codex 会根据下面的 MCP 配置自动启动服务器。需要手动验证时，可以在仓库根目录执行：

```bash
node dist/index.js
```

## Codex 配置

给这个仓库单独配置一个 MCP 服务器，名称建议短一点，比如 `fs_k`。把它写进 Codex 会加载的 `config.toml`，通常是你自己的 Codex 用户级配置。

建议配置：

```toml
[mcp_servers.fs_k]
type = "stdio"
command = "cmd"
args = ["/c", "C:\\path\\to\\k-filesystem-mcp\\k-mcp-server-filesystem.cmd"]
enabled = true
```

把 `args` 第二项替换成你本地 `k-mcp-server-filesystem.cmd` 的绝对路径。Windows 下通过 `cmd /c` 启动包装脚本兼容性最好；如果不是 Windows，再退回到仓库根目录的 `node dist/index.js`。

重启后，Codex 应该会出现 `mcp__fs_k` 前缀的工具。然后在工作区规则里让 Codex 优先使用 `mcp__fs_k` 做文件系统工作，同时把构建、脚本和进程类任务留给 shell / PowerShell。

实际使用时，把 `AGENTS.md` 放在仓库根目录；如果只想让规则作用于某个子目录，也可以放在对应子目录。想让多个本地仓库都继承同一条规则时，可以把 `AGENTS.md` 放在它们共同的父目录，例如用户主目录。真正跨无关路径的个人全局默认，建议放到 Codex 全局指导或全局配置里，而不是依赖某个仓库的 `AGENTS.md`。示例文件放在 `examples/` 目录。

可参考：

- [`examples/AGENTS.example.md`](examples/AGENTS.example.md)
- [`examples/k-filesystem-mcp-rule.example.md`](examples/k-filesystem-mcp-rule.example.md)

核心路由原则很简单：

- 有对应工具时，优先用 K MCP 处理读取、搜索、浏览、元数据、diff、编辑、写入、复制、移动和删除。
- 构建、脚本、动态生成、进程检查、语法检查，以及 MCP 不覆盖的工作，再用 shell / PowerShell。
- 有风险的写入、递归删除、范围不清的编辑和重要用户/项目数据，才用 `dryRun: true`；低风险精确编辑可以直接做。
- 改完 MCP 配置或工作区规则后，重启 Codex，让新路由生效。

## 文档

- [部署指南](docs/deployment.zh-CN.md)
- [Codex 使用建议](docs/codex-usage.zh-CN.md)
- [工具参考](docs/tool-reference.zh-CN.md)
- [安全说明](docs/security.zh-CN.md)
- [优化记录](docs/optimization-notes.zh-CN.md)
- [English docs](docs/deployment.md), [codex-usage.md](docs/codex-usage.md), [tool-reference.md](docs/tool-reference.md), [security.md](docs/security.md), [optimization-notes.md](docs/optimization-notes.md)

## 上游项目

本项目是官方 MCP filesystem server 的 K 版修改：

- `@modelcontextprotocol/server-filesystem`
- https://github.com/modelcontextprotocol/servers

本项目不是官方项目，也不代表上游项目背书。

## 许可证

MIT。见 `LICENSE` 和 `NOTICE.md`。
