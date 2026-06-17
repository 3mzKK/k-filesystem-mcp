# 工具参考

这不是完整 API schema，而是给使用者和 coding agent 的工具选择说明。

## 读取

- `read_text_file`：读取已知文本文件。适合 `head`、`tail`、`start_line/end_line`、行号、`max_lines`、`max_chars` 和范围读取。范围读取会返回实际返回行号、是否到 EOF、请求范围是否完整等 metadata。
- `read_multiple_files`：一次读取多个已知文件或多个范围。适合替代多次单文件读取；`read_concurrency` 会限制并发读文件数量，避免大批量读取给文件系统太大压力。它会返回 per-file 成功/失败信息；如果只有部分失败，只重试失败或未完成的条目。
- `read_media_file`：读取本地图片或音频为 base64。默认有大小限制，不应用来读文本。

## 搜索

- `search_files`：按路径或 glob 查找文件。适合找未知文件路径。支持 `timeout_ms`；如果超时，返回的是部分路径，`summary.suggested_retry` 会说明更合适的下一次搜索方式。普通文件搜索使用 `rg --files`；`directory_only: true` 默认使用 `directory_strategy: "walk"`，会做准确目录遍历，因此能保留空目录，也支持 timeout/partial summary。`directory_strategy: "rg_derived"` 更快，因为它从 `rg --files` 结果反推目录，但可能漏空目录和只有 ignored 文件的目录，所以不能用来证明目录不存在。`rg_derived` 模式可用 `directory_source_limit` 限制用于反推目录的源文件数量；如果 `summary.source_stopped_by_limit` 为 true，先看 `summary.directory_source_limit` 和 `summary.suggested_retry`，再决定提高源文件上限或切换到 `walk`。summary 会包含 `searched_ms`，rg warning 会压缩到 `summary.warnings`。不要用 `directory_tree` 来证明文件不存在。
- `search_text`：搜索文件内容。支持 `output_mode: "files" | "count" | "content" | "compact" | "structured" | "text" | "both"`，也支持 `context_before`、`context_after`、`context`、`type`、`timeout_ms`、`max_match_chars`。普通搜索超时时会返回部分结果，并设置 `summary.timed_out`、`summary.searched_ms`、结构化 `summary.suggested_retry` 和人读摘要 `summary.suggested_retry_text`。
- `default_excludes`：`search_files` 和 `search_text` 的显式开关。设为 `true` 时，会跳过 `.git`、`node_modules`、`.cache`、`.turbo`、`.next`、`.nuxt`、`coverage` 等常见高噪声目录，并在 `summary.applied_default_excludes` 里列出。默认是 `false`，保证完整覆盖。
- `search_text` 分片模式：大范围搜索时可用 `sharded: true`。本地 SSD 仓库需要速度时可用 `shard_concurrency: 2` 或 `4`；网络盘或机器已经繁忙时保持 `1` 或 `2`。如果结果不完整，用 `include_shards` 继续 `remaining_shards`，必要时再单独处理 `partial_shards` 和 `failed_shards`，不要重复跑同一个大搜索。
- 覆盖开关：`hidden`、`no_ignore`、`follow_symlinks` 会扩大搜索范围，也可能变慢或变吵，只在明确需要时使用。

## 目录与元数据

- `list_directory`：浏览已知目录，支持过滤、深度、限制、可选 `timeout_ms` 和摘要。
- `list_directory_with_sizes`：需要文件大小时使用。它只统计最终列表里的条目，不是默认的全目录 top-N 扫描，并支持可选 `timeout_ms`。
- `directory_tree`：查看结构树，支持 `sortBy: "name" | "type" | "none"`、可选 `timeout_ms`、compact 输出和输出限制。不用于证明文件不存在。
- `get_file_info`：读取单个文件或目录的结构化元数据，适合替代单路径 `Get-Item`。
- `get_multiple_file_info`：批量读取元数据，并保留每个路径的错误信息；支持有边界的 `metadata_concurrency`，网络盘或繁忙磁盘可调低；批量失败时只重试失败路径。

## 对比与修改

- `diff_text_files`：比较两个本地文本文件，输出有边界的 unified diff。适合替代先读两个文件再比较，也能减少长 diff 的 token 消耗。
- `edit_file`：小范围精确编辑、行范围编辑、锚点编辑。适合已有文件里的局部修改；支持 `oldText` / `newText`、`edits`、`start_line/end_line`、`expected_occurrences`、`match_mode`、`beforeText` / `afterText` 和 `anchor_mode`。
- `write_file`：新建文件或明确整文件替换。覆盖已有文件必须显式 `overwrite: true`，必要时再配合 `dryRun`、`allow_major_overwrite`、`backup_existing`、`newline` 和 `bom`；长文档追加或局部修改优先用 `edit_file`。

## 路径操作

- `create_directory`：创建目录，支持多级目录。
- `copy_path`：复制文件或目录。目录复制需要 `recursive: true`，已有目录目标会拒绝，避免意外合并；风险较高的目录复制先 dry-run。真实递归目录复制会先做受 `max_entries` 和 `timeout_ms` 约束且可取消的 preflight；结果包含 `elapsed_ms`，失败时包含 `partial` 和压缩后的 `errors`。
- `move_file`：移动或重命名。目标存在时拒绝；简单明确的新目标可以直接执行。执行失败时会返回 `elapsed_ms`、压缩 `errors`、失败后的 `source_exists` / `destination_exists`；跨卷移动会返回 `CROSS_DEVICE_MOVE_UNSUPPORTED` 和建议动作。
- `remove_path`：删除文件或目录。默认 dry-run；非空目录需要 `recursive: true`，递归删除受 `max_entries` 约束。删除 preflight 支持 `timeout_ms`、`elapsed_ms`、`timed_out`、`partial` 和压缩后的 `errors`。

## edit_file 诊断

常见错误码：

- `MATCH_NOT_FOUND`：没有找到匹配。
- `AMBIGUOUS_MATCH`：匹配数量不唯一。
- `EMPTY_MATCH_TEXT`：`oldText` 为空。
- `EMPTY_ANCHOR_TEXT`：`beforeText` 或 `afterText` 为空。

处理原则：

- 不要重复提交同一个失败参数。
- 先看 `edit_error` 的候选数量、候选行号、匹配模式和锚点模式。
- 必要时重读最小目标范围，加上 `start_line/end_line` 和 `expected_occurrences: 1`。
- `anchor_mode: "flexible"` 只做行级 trim 匹配，不是通用模糊匹配。
