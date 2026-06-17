# Codex 使用建议

这是一份给 Codex 或类似本地 coding agent 的使用提示，目标是更快找到合适工具，减少重复尝试。

## 基本原则

- 先找路径，再读内容。
- 已知文件优先用 `read_text_file`，多文件批量读优先用 `read_multiple_files`。
- 只需要路径时，用 `search_text: output_mode: "files"` 或 `search_files`。
- 只需要计数时，用 `search_text: output_mode: "count"`。
- 已知范围、目录、元数据和 diff 这些都优先走对应工具，不要先用 shell 再猜。

## 读取与搜索

- 已知文本文件，不要整文件读大文件，优先范围读取。
- 读取时优先用最小可用范围，再按返回的 line metadata 继续。
- 批量读取同一批已知文件时，尽量一次发给 `read_multiple_files`。
- 搜索时优先用 `compact`、`structured`、`files` 或 `count` 这类更省输出的模式。
- 用 `timeout_ms` 约束大范围普通 `search_text` 和基于 rg 的 `search_files`；如果返回 `summary.timed_out`，结果只是部分结果，要按结构化 `summary.suggested_retry` 继续，不要直接判断不存在；`summary.suggested_retry_text` 只是给人看的短说明。用 `summary.searched_ms` 判断范围是否过大，用 `summary.warnings` 查看压缩后的 rg stderr 诊断。
- 只有接受跳过常见高噪声目录时才用 `default_excludes: true`；要检查 `summary.applied_default_excludes`，因为这会降低覆盖范围。
- 大范围搜索优先用 `search_text` 的分片模式；只有并行分片搜索值得额外磁盘和 CPU 压力时，才用 `shard_concurrency: 2` 或 `4`，网络盘保持较低值。如果结果不完整，继续 `remaining_shards`，不要重跑同一个大搜索。
- 只要文件位置不确定，先用 `search_files` 找路径，再读内容。

## 目录与元数据

- 已知目录优先用 `list_directory`。
- 需要看结构时，用 `directory_tree`；它只适合看结构，不适合证明文件不存在。
- 需要大小时，用 `list_directory_with_sizes`。
- 需要单个路径信息时，用 `get_file_info`；多个路径一起看时，用 `get_multiple_file_info`。
- 需要比较两个文件时，用 `diff_text_files`。

## 编辑与写入

- 小改动优先 `edit_file`。
- 先读最小目标范围，再改。
- `edit_file` 默认按精确匹配处理，优先给出明确的行范围或唯一匹配文本。
- 重复文本容易误伤时，优先用 `beforeText` / `afterText` 锚点。
- `anchor_mode: "exact"` 是默认。
- `anchor_mode: "flexible"` 只用于整行 trim 匹配。
- 新文件或明确整文件替换用 `write_file`。
- `write_file` 覆盖已有内容前，先判断风险，再决定是否 dry-run。
- 复杂补丁再用 `apply_patch`。

## 风险控制

- `dryRun: true` 只留给有风险的覆盖、删除、模糊编辑或重要数据。
- 对明显安全的小范围编辑，可以直接做，减少一次往返。
- 删除、复制和移动前先看工具返回的结构化状态，再决定是否继续。
- 失败时先看结构化错误码，再决定是缩小范围、换锚点，还是改成补丁式修改。
