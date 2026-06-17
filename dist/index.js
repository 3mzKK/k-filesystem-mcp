#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "fs/promises";
import { createReadStream } from "fs";
import { spawn } from "child_process";
import readline from "readline";
import path from "path";
import { z } from "zod";
import { minimatch } from "minimatch";
import {
// Function imports
formatSize, validatePath, getFileStats, readFileContent, writeFileContent, applyFileEdits, tailFile, headFile, createUnifiedDiff, normalizeLineEndings, EditFileMatchError, } from './lib.js';
console.error("K Filesystem MCP running in global filesystem mode.");
// Schema definitions
const TextOutputLimitShape = {
    max_chars: z.number().int().positive().max(1000000).optional().describe('If provided, truncates text output after this many characters'),
    max_lines: z.number().int().positive().max(100000).optional().describe('If provided, truncates text output after this many lines')
};
const CompactOutputShape = {
    compact: z.boolean().optional().default(false).describe('If true, returns concise text content while preserving structured results'),
    output_mode: z.enum(['both', 'text', 'structured']).optional().default('both').describe('Controls duplicated large output: both keeps default text plus structured data, text omits heavy structured arrays, structured returns concise text plus structured data')
};
const SearchOutputModeShape = {
    output_mode: z.enum(['content', 'files', 'count', 'compact', 'structured', 'text', 'both']).optional().describe('Controls search output mode. content=full matches, files=paths only, count=per-file counts, compact=concise output. structured/text/both are compatibility aliases.'),
    paths_only: z.boolean().optional().describe('Compatibility alias for output_mode=files'),
    count_only: z.boolean().optional().describe('Compatibility alias for output_mode=count'),
    compact: z.boolean().optional().default(false).describe('If true, returns concise text content while preserving structured results'),
    context_before: z.number().int().min(0).max(20).optional().describe('Number of context lines before each match'),
    context_after: z.number().int().min(0).max(20).optional().describe('Number of context lines after each match'),
    context: z.number().int().min(0).max(20).optional().describe('Shortcut to set both context_before and context_after'),
    type: z.string().optional().describe('Optional ripgrep type filter such as js, ts, py, rust, go, java, css, html, or markdown')
};
const DiffOutputLimitShape = {
    max_diff_lines: z.number().int().positive().max(10000).optional().default(200).describe('Maximum unified diff lines to return'),
    max_diff_chars: z.number().int().min(500).max(1000000).optional().default(20000).describe('Maximum total diff characters to return. Minimum 500 so truncation markers remain useful'),
    max_diff_line_chars: z.number().int().min(200).max(100000).optional().default(2000).describe('Maximum characters to return for any single diff line. Minimum 200 so truncation markers remain useful')
};
const DiffTextFilesOutputLimitShape = {
    ...DiffOutputLimitShape,
    max_diff_lines: z.number().int().positive().max(10000).optional().default(300).describe('Maximum unified diff lines to return')
};
const DEFAULT_FULL_READ_MAX_BYTES = 1024 * 1024;
const DEFAULT_SEARCH_TIMEOUT_MS = 120000;
const DEFAULT_SEARCH_EXCLUDE_PATTERNS = [
    '**/.git/**',
    '**/node_modules/**',
    '**/.cache/**',
    '**/.turbo/**',
    '**/.next/**',
    '**/.nuxt/**',
    '**/coverage/**'
];
const ReadTextFileArgsSchema = z.object({
    path: z.string(),
    tail: z.number().int().positive().max(100000).optional().describe('If provided, returns only the last N lines of the file'),
    head: z.number().int().positive().max(100000).optional().describe('If provided, returns only the first N lines of the file'),
    start_line: z.number().int().positive().optional().describe('If provided with end_line, returns the inclusive 1-based line range starting at this line'),
    end_line: z.number().int().positive().optional().describe('If provided with start_line, returns the inclusive 1-based line range ending at this line'),
    include_line_numbers: z.boolean().optional().describe('If true, prefixes each returned line with its 1-based line number'),
    allow_full_read: z.boolean().optional().default(false).describe('If true, allows unbounded full-file reads above the default safety threshold'),
    max_full_read_bytes: z.number().int().positive().max(100 * 1024 * 1024).optional().default(DEFAULT_FULL_READ_MAX_BYTES).describe('Maximum file size for unbounded full-file reads unless allow_full_read or max_chars is provided'),
    ...TextOutputLimitShape
});
const ReadMediaFileArgsSchema = z.object({
    path: z.string(),
    max_bytes: z.number().int().positive().max(100 * 1024 * 1024).optional().default(5 * 1024 * 1024).describe('Maximum file size to read as base64. Defaults to 5 MiB to avoid huge MCP responses')
});
const ReadMultipleFilesArgsSchema = z.object({
    paths: z
        .array(z.string())
        .min(1, "At least one file path must be provided")
        .describe("Array of file paths to read. Each path must be a string pointing to a readable file.")
        .optional(),
    files: z
        .array(ReadTextFileArgsSchema)
        .describe("Array of file read requests. Each item supports path plus optional head, tail, start_line/end_line, and include_line_numbers.")
        .optional(),
    include_line_numbers: z.boolean().optional().describe('If true, prefixes each returned line with its 1-based line number unless overridden per file'),
    read_concurrency: z.number().int().positive().max(128).optional().default(32).describe('Maximum number of files to read concurrently. Defaults to 32 to avoid excessive filesystem pressure.'),
    ...TextOutputLimitShape
});
const WriteFileArgsSchema = z.object({
    path: z.string(),
    content: z.string(),
    overwrite: z.boolean().optional().default(false).describe('Must be true to overwrite an existing file'),
    allow_major_overwrite: z.boolean().optional().default(false).describe('If true, allows replacing a large existing file with much shorter content; otherwise this risky overwrite is refused'),
    backup_existing: z.boolean().optional().default(false).describe('If true, creates a timestamped .bak copy before a real existing-file overwrite that changes content. Defaults to false to avoid backup file noise'),
    dryRun: z.boolean().optional().default(false).describe('If true, reports what would happen and returns a bounded diff without writing'),
    dry_run: z.boolean().optional().describe('Compatibility alias for dryRun'),
    create_parent_dirs: z.boolean().optional().default(false).describe('If true, creates missing parent directories before creating a new file'),
    newline: z.enum(['lf', 'crlf']).optional().describe('New files only: newline style to use. Existing-file overwrites preserve the original style'),
    bom: z.boolean().optional().describe('New files only: whether to write a UTF-8 BOM. Existing-file overwrites preserve the original BOM behavior'),
    ...DiffOutputLimitShape
});
const EditOperation = z.object({
    oldText: z.string().optional().describe('Text to search for. Optional when beforeText and afterText define the replacement region'),
    newText: z.string().describe('Text to replace with'),
    beforeText: z.string().optional().describe('Optional anchor before the replacement region. Exact by default; set anchor_mode=flexible only for line-level trim matching fallback. If oldText is omitted, beforeText and afterText replace the content between anchors'),
    afterText: z.string().optional().describe('Optional anchor after the replacement region. Exact by default; set anchor_mode=flexible only for line-level trim matching fallback. If oldText is omitted, beforeText and afterText replace the content between anchors'),
    expected_occurrences: z.number().int().positive().optional().describe('If provided, reject the edit unless oldText matches exactly this many times in the target range'),
    start_line: z.number().int().positive().optional().describe('Optional inclusive 1-based start line limiting where this edit may match'),
    end_line: z.number().int().positive().optional().describe('Optional inclusive 1-based end line limiting where this edit may match'),
    match_mode: z.enum(['auto', 'exact', 'flexible']).optional().default('auto').describe('How to match oldText: exact only, flexible line/whitespace matching only, or auto exact-then-flexible'),
    anchor_mode: z.enum(['exact', 'flexible']).optional().default('exact').describe('How to match beforeText/afterText anchors: exact by default, or explicit flexible line-level trim matching')
});
const EditFileArgsSchema = z.object({
    path: z.string(),
    edits: z.array(EditOperation).optional(),
    oldText: z.string().optional().describe('Single-edit shortcut: text to search for'),
    newText: z.string().optional().describe('Single-edit shortcut: replacement text'),
    beforeText: z.string().optional().describe('Single-edit shortcut: anchor before the replacement region'),
    afterText: z.string().optional().describe('Single-edit shortcut: anchor after the replacement region'),
    expected_occurrences: z.number().int().positive().optional().describe('Single-edit shortcut: expected match count'),
    start_line: z.number().int().positive().optional().describe('Single-edit shortcut: inclusive 1-based start line'),
    end_line: z.number().int().positive().optional().describe('Single-edit shortcut: inclusive 1-based end line'),
    match_mode: z.enum(['auto', 'exact', 'flexible']).optional().default('auto').describe('Single-edit shortcut: match mode'),
    anchor_mode: z.enum(['exact', 'flexible']).optional().default('exact').describe('Single-edit shortcut: beforeText/afterText anchor match mode; flexible is line-level trim matching'),
    dryRun: z.boolean().optional().default(false).describe('Preview changes using git-style diff format'),
    dry_run: z.boolean().optional().describe('Compatibility alias for dryRun'),
    ...DiffOutputLimitShape
});
const TextTruncationOutputSchema = {
    truncated: z.boolean().optional(),
    truncated_by: z.array(z.string()).optional(),
    original_lines: z.number().optional(),
    returned_lines: z.number().optional(),
    omitted_lines: z.number().optional(),
    original_chars: z.number().optional(),
    returned_chars: z.number().optional(),
    omitted_chars: z.number().optional()
};
const TextSelectionOutputSchema = {
    selection: z.enum(['full', 'head', 'tail', 'range']).optional(),
    requested_lines: z.number().nullable().optional(),
    start_line: z.number().nullable().optional(),
    end_line: z.number().nullable().optional(),
    returned_start_line: z.number().nullable().optional(),
    returned_end_line: z.number().nullable().optional(),
    returned_selection_lines: z.number().optional(),
    completed_requested_range: z.boolean().optional(),
    reached_eof: z.boolean().optional()
};
const StructuredErrorOutputSchema = {
    error: z.string().nullable().optional(),
    error_type: z.string().optional(),
    code: z.string().nullable().optional()
};
const TextContentOutputSchema = {
    content: z.string(),
    ...TextSelectionOutputSchema,
    ...TextTruncationOutputSchema
};
const FileMutationOutputSchema = {
    content: z.string(),
    path: z.string().optional(),
    changed: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    action: z.string().optional(),
    edits_applied: z.number().optional(),
    edits: z.array(z.record(z.any())).optional(),
    edit_application: z.string().optional(),
    range_basis: z.string().optional(),
    diff_truncated: z.boolean().optional(),
    diff_omitted_lines: z.number().optional(),
    diff_omitted_chars: z.number().optional(),
    major_overwrite_guard_triggered: z.boolean().optional(),
    old_chars: z.number().optional(),
    new_chars: z.number().optional(),
    new_to_old_ratio: z.number().optional(),
    backup_created: z.boolean().optional(),
    backup_path: z.string().nullable().optional(),
    ...StructuredErrorOutputSchema,
    edit_error: z.record(z.any()).optional(),
    newline_preserved: z.string().nullable().optional(),
    bom_preserved: z.boolean().nullable().optional(),
    newline_written: z.string().nullable().optional(),
    bom_written: z.boolean().nullable().optional()
};
const DiffTextFilesArgsSchema = z.object({
    left_path: z.string(),
    right_path: z.string(),
    context_lines: z.number().int().min(0).max(20).optional().default(3).describe('Number of unchanged context lines to include around changes'),
    ignore_whitespace: z.boolean().optional().default(false).describe('If true, compares whitespace-normalized text and returns a whitespace-normalized diff'),
    max_file_bytes: z.number().int().positive().max(100 * 1024 * 1024).optional().default(5 * 1024 * 1024).describe('Maximum size for each input file. Defaults to 5 MiB'),
    ...DiffTextFilesOutputLimitShape,
    ...CompactOutputShape
});
const CreateDirectoryArgsSchema = z.object({
    path: z.string(),
});
const DirectoryListArgsShape = {
    path: z.string(),
    limit: z.number().int().positive().max(10000).optional().describe('Maximum number of entries to return'),
    glob: z.string().optional().describe('Optional glob pattern used to include entries by name or relative path'),
    excludePatterns: z.array(z.string()).optional().default([]).describe('Optional glob patterns used to exclude entries by name or relative path'),
    file_only: z.boolean().optional().describe('If true, returns only files'),
    directory_only: z.boolean().optional().describe('If true, returns only directories'),
    max_depth: z.number().int().positive().max(10).optional().default(1).describe('Maximum directory depth to list, starting at 1 for the direct children'),
    timeout_ms: z.number().int().min(0).max(1800000).optional().default(0).describe('Optional timeout in milliseconds for directory traversal. Use 0 to disable. Timed-out calls return partial results when possible.'),
    stat_concurrency: z.number().int().positive().max(128).optional().default(16).describe('Maximum concurrent stat operations when sizes are requested'),
    ...TextOutputLimitShape
};
const ListDirectoryArgsSchema = z.object(DirectoryListArgsShape);
const ListDirectoryWithSizesArgsSchema = z.object({
    ...DirectoryListArgsShape,
    sortBy: z.enum(['name', 'size']).optional().default('name').describe('Sort entries by name or size'),
});
const DirectoryTreeArgsSchema = z.object({
    path: z.string(),
    excludePatterns: z.array(z.string()).optional().default([]),
    max_depth: z.number().int().positive().max(20).optional().default(3).describe('Maximum directory depth to include, starting at 1 for direct children'),
    limit: z.number().int().positive().max(50000).optional().default(1000).describe('Maximum number of entries to include in the tree'),
    timeout_ms: z.number().int().min(0).max(1800000).optional().default(0).describe('Optional timeout in milliseconds for tree traversal. Use 0 to disable. Timed-out calls return a partial tree summary.'),
    sortBy: z.enum(['name', 'type', 'none']).optional().default('name').describe('Sort tree entries by name, by type then name, or preserve filesystem order'),
    ...CompactOutputShape,
    ...TextOutputLimitShape
});
const MoveFileArgsSchema = z.object({
    source: z.string(),
    destination: z.string(),
    dryRun: z.boolean().optional().default(false).describe('If true, reports what would happen without moving anything'),
    dry_run: z.boolean().optional().describe('Compatibility alias for dryRun'),
});
const SearchFilesArgsSchema = z.object({
    path: z.string(),
    pattern: z.string().optional().describe('Glob-style file pattern. Kept for backward compatibility; prefer glob for new calls.'),
    glob: z.string().optional().describe('Glob-style file pattern, such as *.c or **/*.ts'),
    excludePatterns: z.array(z.string()).optional().default([]).describe('Optional glob patterns for files or directories to exclude'),
    limit: z.number().int().positive().max(50000).optional().default(1000).describe('Maximum number of paths to return'),
    max_depth: z.number().int().positive().max(50).optional().describe('Maximum directory depth to search'),
    file_only: z.boolean().optional().describe('If true, returns only files. This is the default unless directory_only is true.'),
    directory_only: z.boolean().optional().describe('If true, returns only directories using bounded directory traversal instead of rg --files'),
    directory_strategy: z.enum(['walk', 'rg_derived']).optional().default('walk').describe('When directory_only is true, walk=accurate traversal including empty directories; rg_derived=fast directories derived from rg --files and may miss empty or ignored-only directories.'),
    directory_source_limit: z.number().int().positive().max(50000).optional().describe('For directory_strategy=rg_derived, maximum source file paths to scan before deriving directories. Increase when source_stopped_by_limit is true.'),
    hidden: z.boolean().optional().default(false).describe('If true, passes --hidden to rg so hidden files and directories are included'),
    no_ignore: z.boolean().optional().default(false).describe('If true, passes --no-ignore to rg so ignore files are not respected'),
    follow_symlinks: z.boolean().optional().default(false).describe('If true, passes --follow to rg so symbolic links are followed'),
    timeout_ms: z.number().int().min(0).max(1800000).optional().default(DEFAULT_SEARCH_TIMEOUT_MS).describe('Timeout in milliseconds for rg-backed file searches. Use 0 to disable. Timed-out searches return partial results with timed_out=true.'),
    default_excludes: z.boolean().optional().default(false).describe('If true, visibly applies common high-noise excludes such as .git, node_modules, .cache, .turbo, .next, .nuxt, and coverage. Defaults to false to preserve complete search coverage.'),
    ...CompactOutputShape,
    ...TextOutputLimitShape
});
const SearchTextArgsSchema = z.object({
    path: z.string(),
    pattern: z.string(),
    glob: z.string().optional().describe('Optional glob pattern for files to include, such as *.c or **/*.ts'),
    excludePatterns: z.array(z.string()).optional().default([]).describe('Optional glob patterns for files or directories to exclude'),
    ...SearchOutputModeShape,
    context_lines: z.number().int().min(0).max(20).optional().default(0).describe('Compatibility alias for context_before/context_after'),
    max_results: z.number().int().positive().max(1000).optional().default(100).describe('Maximum number of matching lines to return'),
    case_sensitive: z.boolean().optional().default(false).describe('If true, search is case-sensitive'),
    regex: z.boolean().optional().default(false).describe('If true, pattern is treated as a regular expression; otherwise it is searched literally'),
    hidden: z.boolean().optional().default(false).describe('If true, passes --hidden to rg so hidden files and directories are included'),
    no_ignore: z.boolean().optional().default(false).describe('If true, passes --no-ignore to rg so ignore files are not respected'),
    follow_symlinks: z.boolean().optional().default(false).describe('If true, passes --follow to rg so symbolic links are followed'),
    max_match_chars: z.number().int().positive().max(10000).optional().describe('If provided, truncates each returned matching/context line text to this many characters'),
    sharded: z.boolean().optional().default(false).describe('If true, searches large repositories shard by shard and returns JSON with searched and remaining shard summary'),
    shard_depth: z.number().int().positive().max(4).optional().default(1).describe('Directory depth used to build shards when sharded is true'),
    include_shards: z.array(z.string()).optional().describe('When sharded is true, search only these shard relative paths, such as ".", "drivers", or "foundation/communication"'),
    exclude_shards: z.array(z.string()).optional().describe('When sharded is true, skip these shard relative paths'),
    shard_concurrency: z.number().int().positive().max(8).optional().default(1).describe('Maximum number of shards to search in parallel when sharded is true. Defaults to 1; use 2-4 for local SSD repositories and keep 1-2 for network drives.'),
    timeout_ms: z.number().int().min(0).max(1800000).optional().default(DEFAULT_SEARCH_TIMEOUT_MS).describe('Timeout in milliseconds. Normal searches time out per rg process; sharded searches use it as the total sharded search timeout. Use 0 to disable. Timed-out searches return partial results with timed_out=true.'),
    default_excludes: z.boolean().optional().default(false).describe('If true, visibly applies common high-noise excludes such as .git, node_modules, .cache, .turbo, .next, .nuxt, and coverage. Defaults to false to preserve complete search coverage.'),
    ...TextOutputLimitShape
});
const GetFileInfoArgsSchema = z.object({
    path: z.string(),
});
const GetMultipleFileInfoArgsSchema = z.object({
    paths: z.array(z.string()).min(1).max(1000).describe('Paths to inspect. Missing or inaccessible paths are returned as per-entry errors instead of failing the whole call.'),
    metadata_concurrency: z.number().int().positive().max(128).optional().default(32).describe('Maximum number of metadata checks to run concurrently. Lower this for slow network drives or busy disks.'),
    max_lines: z.number().int().positive().max(100000).optional().describe('If provided, truncates text output after this many lines'),
    max_chars: z.number().int().positive().max(1000000).optional().describe('If provided, truncates text output after this many characters'),
    ...CompactOutputShape
});
const CopyPathArgsSchema = z.object({
    source: z.string(),
    destination: z.string(),
    overwrite: z.boolean().optional().default(false).describe('If true, allows replacing an existing destination'),
    dryRun: z.boolean().optional().default(false).describe('If true, reports what would happen without copying anything'),
    dry_run: z.boolean().optional().describe('Compatibility alias for dryRun'),
    recursive: z.boolean().optional().default(false).describe('Required for copying directories'),
    create_parent_dirs: z.boolean().optional().default(false).describe('If true, creates missing destination parent directories before copying'),
    preserve_timestamps: z.boolean().optional().default(false).describe('If true, preserves source timestamps when supported'),
    max_entries: z.number().int().positive().max(1000000).optional().default(100000).describe('Maximum entries allowed for real recursive directory copies and preflight summaries'),
    timeout_ms: z.number().int().min(0).max(1800000).optional().default(120000).describe('Timeout in milliseconds for copy preflight traversal. Use 0 to disable. Real fs copy is not interrupted mid-operation; timeout prevents starting copies whose preflight takes too long.'),
    preview_max_entries: z.number().int().positive().max(100000).optional().default(10000).describe('For directory dry runs, stop preview traversal after this many entries'),
    preview_entries: z.number().int().min(0).max(200).optional().default(20).describe('For directory dry runs, include up to this many relative sample entries in the preview')
});
const RemovePathArgsSchema = z.object({
    path: z.string(),
    dryRun: z.boolean().optional().default(true).describe('Defaults to true. Pass dryRun=false only after reviewing the preview.'),
    dry_run: z.boolean().optional().describe('Compatibility alias for dryRun'),
    recursive: z.boolean().optional().default(false).describe('Required for removing non-empty directories'),
    max_entries: z.number().int().positive().max(100000).optional().default(1000).describe('Maximum entries to inspect/delete for recursive directory removals'),
    timeout_ms: z.number().int().min(0).max(1800000).optional().default(120000).describe('Timeout in milliseconds for removal preflight traversal. Use 0 to disable. Timed-out previews return structured timeout status without deleting.'),
    allow_missing: z.boolean().optional().default(false).describe('If true, missing paths are treated as a no-op'),
    sample_entries: z.number().int().min(0).max(200).optional().default(20).describe('Include up to this many relative sample entries in dry-run previews')
});
// Server setup
const server = new McpServer({
    name: "k-filesystem-server",
    version: "0.3.0-k",
});
// Reads a file as a stream of buffers, concatenates them, and then encodes
// the result to a Base64 string. This is a memory-efficient way to handle
// binary data from a stream before the final encoding.
async function readFileAsBase64Stream(filePath) {
    return new Promise((resolve, reject) => {
        const stream = createReadStream(filePath);
        const chunks = [];
        stream.on('data', (chunk) => {
            chunks.push(chunk);
        });
        stream.on('end', () => {
            const finalBuffer = Buffer.concat(chunks);
            resolve(finalBuffer.toString('base64'));
        });
        stream.on('error', (err) => reject(err));
    });
}
async function readLineRange(filePath, startLine, endLine) {
    if (startLine > endLine) {
        throw new Error("start_line must be less than or equal to end_line");
    }
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const reader = readline.createInterface({
        input: stream,
        crlfDelay: Infinity
    });
    const lines = [];
    let lineNumber = 0;
    let stoppedAtEndLine = false;
    try {
        for await (const line of reader) {
            lineNumber++;
            if (lineNumber >= startLine) {
                lines.push(line);
            }
            if (lineNumber >= endLine) {
                stoppedAtEndLine = true;
                reader.close();
                stream.destroy();
                break;
            }
        }
    }
    finally {
        reader.close();
        stream.destroy();
    }
    return {
        content: lines.join('\n'),
        selection: 'range',
        start_line: startLine,
        end_line: endLine,
        returned_start_line: lines.length > 0 ? startLine : null,
        returned_end_line: lines.length > 0 ? startLine + lines.length - 1 : null,
        returned_selection_lines: lines.length,
        completed_requested_range: stoppedAtEndLine,
        reached_eof: !stoppedAtEndLine
    };
}
function addLineNumbers(content, startLine = 1) {
    return content.split('\n').map((line, index) => `${String(startLine + index).padStart(4, ' ')}: ${line}`).join('\n');
}
function limitTextOutput(text, args = {}) {
    let result = text;
    const notes = [];
    const truncatedBy = [];
    const originalLines = text.length === 0 ? 0 : text.split('\n').length;
    const summary = {
        truncated: false,
        truncated_by: truncatedBy,
        original_lines: originalLines,
        returned_lines: originalLines,
        omitted_lines: 0,
        original_chars: text.length,
        returned_chars: text.length,
        omitted_chars: 0
    };
    if (args.max_lines !== undefined) {
        const lines = result.split('\n');
        if (lines.length > args.max_lines) {
            result = lines.slice(0, args.max_lines).join('\n');
            notes.push(`lines ${args.max_lines}/${lines.length}`);
            truncatedBy.push('max_lines');
            summary.truncated = true;
            summary.omitted_lines += lines.length - args.max_lines;
        }
    }
    if (args.max_chars !== undefined && result.length > args.max_chars) {
        const originalLength = result.length;
        result = result.slice(0, args.max_chars);
        notes.push(`chars ${args.max_chars}/${originalLength}`);
        truncatedBy.push('max_chars');
        summary.truncated = true;
        summary.omitted_chars += originalLength - args.max_chars;
    }
    summary.returned_lines = result.length === 0 ? 0 : result.split('\n').length;
    summary.returned_chars = result.length;
    summary.omitted_chars += Math.max(0, summary.original_chars - result.length - summary.omitted_chars);
    if (notes.length > 0) {
        result += `\n[K MCP output truncated: ${notes.join(', ')}. Increase max_lines/max_chars or narrow the request for complete output.]`;
    }
    return { text: result, ...summary };
}
function formatTruncationStructured(limited) {
    return {
        truncated: limited.truncated,
        truncated_by: limited.truncated_by,
        original_lines: limited.original_lines,
        returned_lines: limited.returned_lines,
        omitted_lines: limited.omitted_lines,
        original_chars: limited.original_chars,
        returned_chars: limited.returned_chars,
        omitted_chars: limited.omitted_chars
    };
}
function makeTextResponse(limited, structured = {}) {
    return {
        content: [{ type: "text", text: limited.text }],
        structuredContent: { content: limited.text, ...formatTruncationStructured(limited), ...structured }
    };
}
function wantsStructuredOnly(args = {}) {
    return args.compact === true || args.output_mode === 'structured' || args.output_mode === 'compact';
}
function wantsTextOnly(args = {}) {
    return args.output_mode === 'text';
}
function applyOutputMode(structuredContent, args = {}, heavyKeys = []) {
    if (!wantsTextOnly(args)) {
        return structuredContent;
    }
    const slim = { ...structuredContent };
    for (const key of heavyKeys) {
        delete slim[key];
    }
    return slim;
}
function compactText(text, args = {}, fallbackText = text) {
    return wantsStructuredOnly(args) ? fallbackText : text;
}
function summarizeDirectoryEntries(entries, args, extra = {}) {
    const fileCount = entries.filter((entry) => !entry.isDirectory).length;
    const directoryCount = entries.filter((entry) => entry.isDirectory).length;
    return {
        result_count: entries.length,
        limit: args.limit ?? null,
        stopped_by_limit: args.limit !== undefined && entries.length >= args.limit,
        max_depth: args.max_depth ?? 1,
        file_count: fileCount,
        directory_count: directoryCount,
        ...extra
    };
}
function applyRipgrepCoverageFlags(rgArgs, args) {
    if (args.hidden) {
        rgArgs.push('--hidden');
    }
    if (args.no_ignore) {
        rgArgs.push('--no-ignore');
    }
    if (args.follow_symlinks) {
        rgArgs.push('--follow');
    }
}
function getAppliedSearchExcludePatterns(args) {
    return args.default_excludes ? DEFAULT_SEARCH_EXCLUDE_PATTERNS : [];
}
function applyDefaultSearchExcludes(rgArgs, args) {
    const applied = getAppliedSearchExcludePatterns(args);
    for (const excludePattern of applied) {
        rgArgs.push('--glob', `!${excludePattern}`);
    }
    return applied;
}
function summarizeRipgrepStderr(stderr) {
    const lines = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length === 0) {
        return null;
    }
    const sampleWarnings = lines.slice(0, 3).map((line) => line.length > 300 ? `${line.slice(0, 300)}...` : line);
    return {
        warnings_count: lines.length,
        sample_warnings: sampleWarnings,
        suppressed_warnings: Math.max(0, lines.length - sampleWarnings.length)
    };
}
function formatRipgrepFailure(commandName, code, stderr) {
    const warningSummary = summarizeRipgrepStderr(stderr);
    if (!warningSummary) {
        return `${commandName} exited with code ${code}`;
    }
    return `${commandName} exited with code ${code}; stderr lines=${warningSummary.warnings_count}; sample=${warningSummary.sample_warnings.join(' | ')}`;
}
function makeSearchSuggestedRetry(summary) {
    if (summary.timed_out) {
        if (summary.directory_strategy === 'walk') {
            return {
                reason: 'timed_out',
                message: 'Directory-only search timed out with partial results. Narrow path/glob/max_depth, raise timeout_ms, or use normal file search when directory completeness is not required.',
                next_args: {
                    timeout_ms: Math.max(summary.timeout_ms ?? DEFAULT_SEARCH_TIMEOUT_MS, 60000),
                    max_depth: summary.max_depth,
                    directory_only: true
                },
                notes: ['Do not conclude directory absence from timed-out results.', 'directory_only uses accurate walking so empty directories are preserved.']
            };
        }
        if (summary.shard_count !== undefined) {
            return {
                reason: 'timed_out',
                message: 'Search timed out with partial sharded results. Continue remaining_shards, rerun partial_shards if full coverage matters, or narrow the query.',
                next_args: {
                    sharded: true,
                    include_shards: summary.remaining_shards ?? [],
                    timeout_ms: Math.max(summary.timeout_ms ?? DEFAULT_SEARCH_TIMEOUT_MS, 60000),
                    output_mode: summary.mode === 'matches' ? 'files' : undefined
                },
                notes: ['Do not conclude absence from incomplete sharded results.', 'Rerun partial_shards separately when full coverage matters.']
            };
        }
        return {
            reason: 'timed_out',
            message: 'Search timed out with partial results. Narrow scope, use a cheaper output mode, raise timeout_ms, or switch to sharded search.',
            next_args: {
                sharded: true,
                timeout_ms: Math.max(summary.timeout_ms ?? DEFAULT_SEARCH_TIMEOUT_MS, 60000),
                output_mode: summary.mode === 'matches' ? 'files' : summary.mode === 'count_only' ? 'count' : undefined
            },
            notes: ['Do not conclude absence from timed-out results.', 'For path discovery, prefer search_files or output_mode=files.']
        };
    }
    if (summary.derived_from_files) {
        const sourceLimit = summary.directory_source_limit;
        return {
            reason: summary.source_stopped_by_limit ? 'directory_source_limit' : 'derived_from_files',
            message: summary.source_stopped_by_limit
                ? 'Directory results were derived from a limited rg --files source list. Increase directory_source_limit or switch to directory_strategy=walk when complete directory coverage matters.'
                : 'Directory results were derived from rg --files and may omit empty or ignored-only directories. Use directory_strategy=walk when complete directory coverage matters.',
            next_args: {
                directory_only: true,
                directory_strategy: summary.source_stopped_by_limit ? 'rg_derived' : 'walk',
                directory_source_limit: summary.source_stopped_by_limit && sourceLimit ? Math.min(sourceLimit * 2, 50000) : undefined,
                timeout_ms: Math.max(summary.timeout_ms ?? DEFAULT_SEARCH_TIMEOUT_MS, 60000)
            },
            notes: ['Do not use rg-derived directory results to prove a directory is absent.']
        };
    }
    if (summary.stopped_by_max_results) {
        return {
            reason: 'max_results',
            message: 'Search stopped after reaching max_results. Narrow scope, use files/count mode, or increase max_results if more results are needed.',
            next_args: {
                max_results: summary.max_results ? Math.min(summary.max_results * 2, 1000) : undefined,
                output_mode: summary.mode === 'matches' ? 'files' : undefined
            },
            notes: ['Results are complete only up to max_results.']
        };
    }
    if (summary.stopped_by_limit) {
        return {
            reason: 'limit',
            message: 'File search stopped after reaching limit. Narrow path/glob/max_depth or increase limit if more paths are needed.',
            next_args: {
                limit: summary.limit ? Math.min(summary.limit * 2, 50000) : undefined
            },
            notes: ['Returned paths are complete only up to limit.']
        };
    }
    return null;
}
function makeSearchSuggestedRetryText(suggestedRetry) {
    return suggestedRetry?.message ?? null;
}
function normalizeDryRun(args) {
    if (args.dry_run !== undefined) {
        return { ...args, dryRun: args.dry_run };
    }
    return args;
}
function normalizeSearchArgs(args) {
    const outputMode = args.output_mode;
    const pathsOnly = outputMode === 'files' ? true : outputMode === 'content' || outputMode === 'compact' || outputMode === 'both' || outputMode === 'structured' || outputMode === 'text' ? false : Boolean(args.paths_only);
    const countOnly = outputMode === 'count' ? true : outputMode === 'content' || outputMode === 'files' || outputMode === 'compact' || outputMode === 'both' || outputMode === 'structured' || outputMode === 'text' ? false : Boolean(args.count_only);
    const contextValue = args.context ?? args.context_lines ?? 0;
    return {
        ...args,
        compact: args.compact === true || outputMode === 'compact',
        output_mode: outputMode === 'files' || outputMode === 'count' || outputMode === 'content' || outputMode === 'compact' ? 'both' : outputMode,
        paths_only: pathsOnly,
        count_only: countOnly,
        context_before: args.context_before ?? contextValue,
        context_after: args.context_after ?? contextValue
    };
}
function normalizeEditFileArgs(args) {
    const normalized = normalizeDryRun(args);
    const hasShortcut = normalized.oldText !== undefined || normalized.newText !== undefined || normalized.beforeText !== undefined || normalized.afterText !== undefined;
    const hasEdits = normalized.edits !== undefined;
    if (hasShortcut && hasEdits) {
        throw new Error('Use either edits array or top-level edit shortcut fields, not both.');
    }
    if (hasShortcut) {
        if (normalized.newText === undefined) {
            throw new Error('Single-edit shortcut requires newText.');
        }
        return {
            ...normalized,
            edits: [{
                    oldText: normalized.oldText,
                    newText: normalized.newText,
                    beforeText: normalized.beforeText,
                    afterText: normalized.afterText,
                    expected_occurrences: normalized.expected_occurrences,
                    start_line: normalized.start_line,
                    end_line: normalized.end_line,
                    match_mode: normalized.match_mode,
                    anchor_mode: normalized.anchor_mode
                }]
        };
    }
    if (!Array.isArray(normalized.edits) || normalized.edits.length === 0) {
        throw new Error('edit_file requires either a non-empty edits array or top-level oldText/newText.');
    }
    return normalized;
}
function formatErrorStructured(error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    return {
        error: error instanceof Error ? error.message : String(error),
        error_type: error instanceof Error ? error.name : typeof error,
        code: typeof code === 'string' ? code : null
    };
}
function makeCodedError(message, code, name = 'OperationGuardError') {
    const error = new Error(message);
    error.name = name;
    error.code = code;
    return error;
}
function makeOperationFailureResponse(error, structured = {}) {
    const text = error instanceof Error ? error.message : String(error);
    return {
        content: [{ type: "text", text }],
        structuredContent: { content: text, ...structured, changed: false, ...formatErrorStructured(error) }
    };
}
function summarizeOperationErrors(errors) {
    const items = Array.isArray(errors) ? errors : [errors];
    const messages = items
        .map((error) => error instanceof Error ? error.message : String(error))
        .filter(Boolean);
    if (messages.length === 0) {
        return null;
    }
    const sampleErrors = messages.slice(0, 3).map((message) => message.length > 300 ? `${message.slice(0, 300)}...` : message);
    return {
        errors_count: messages.length,
        sample_errors: sampleErrors,
        suppressed_errors: Math.max(0, messages.length - sampleErrors.length)
    };
}
function makeTimeoutError(message, code, name = 'TimeoutError') {
    return makeCodedError(message, code, name);
}
function createCancellationSignal() {
    return { cancelled: false };
}
function assertNotCancelled(signal) {
    if (signal?.cancelled) {
        throw makeTimeoutError('Operation cancelled', 'OPERATION_CANCELLED', 'OperationCancelledError');
    }
}
async function withTimeout(promise, timeoutMs, makeError, signal) {
    if (!timeoutMs || timeoutMs <= 0) {
        return promise;
    }
    let timeoutHandle;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    if (signal) {
                        signal.cancelled = true;
                    }
                    reject(makeError());
                }, timeoutMs);
            })
        ]);
    }
    finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}
function truncateMatchText(text, maxChars) {
    if (maxChars === undefined || text.length <= maxChars) {
        return text;
    }
    return `${text.slice(0, maxChars)}...`;
}
function splitDisplayLines(text) {
    if (text.length === 0) {
        return [];
    }
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}
async function countNewlinesBefore(handle, endPosition, chunkSize) {
    let count = 0;
    let offset = 0;
    while (offset < endPosition) {
        const readSize = Math.min(chunkSize, endPosition - offset);
        const buffer = Buffer.allocUnsafe(readSize);
        await handle.read(buffer, 0, readSize, offset);
        for (let i = 0; i < readSize; i++) {
            if (buffer[i] === 10) {
                count++;
            }
        }
        offset += readSize;
    }
    return count;
}
async function readTailWithStartLine(filePath, numLines) {
    const stats = await fs.stat(filePath);
    if (stats.size === 0) {
        return { content: '', startLine: 1 };
    }
    const handle = await fs.open(filePath, 'r');
    const chunkSize = 64 * 1024;
    const chunks = [];
    let position = stats.size;
    let newlineCount = 0;
    let foundEnoughLines = false;
    try {
        while (position > 0) {
            const readSize = Math.min(chunkSize, position);
            position -= readSize;
            const buffer = Buffer.allocUnsafe(readSize);
            await handle.read(buffer, 0, readSize, position);
            chunks.unshift(buffer);
            for (let i = readSize - 1; i >= 0; i--) {
                if (buffer[i] === 10) {
                    newlineCount++;
                    if (newlineCount > numLines) {
                        foundEnoughLines = true;
                        break;
                    }
                }
            }
            if (foundEnoughLines) {
                break;
            }
        }
        const segment = Buffer.concat(chunks).toString('utf-8');
        const lines = splitDisplayLines(segment);
        const tailLines = lines.slice(-numLines);
        const skippedLinesInSegment = Math.max(0, lines.length - tailLines.length);
        if (!foundEnoughLines) {
            return { content: tailLines.join('\n'), startLine: skippedLinesInSegment + 1 };
        }
        const skippedLinesBeforeSegment = await countNewlinesBefore(handle, position, chunkSize);
        const startLine = Math.max(1, skippedLinesBeforeSegment + skippedLinesInSegment + 1);
        return {
            content: tailLines.join('\n'),
            startLine
        };
    }
    finally {
        await handle.close();
    }
}
async function readSelectedTextFile(filePath, args) {
    const maxFullReadBytes = args.max_full_read_bytes ?? DEFAULT_FULL_READ_MAX_BYTES;
    const hasRangeStart = args.start_line !== undefined;
    const hasRangeEnd = args.end_line !== undefined;
    if (hasRangeStart !== hasRangeEnd) {
        throw new Error("start_line and end_line must be specified together");
    }
    const selectionCount = (args.head !== undefined ? 1 : 0) + (args.tail !== undefined ? 1 : 0) + (hasRangeStart ? 1 : 0);
    if (selectionCount > 1) {
        throw new Error("Cannot combine head, tail, or start_line/end_line parameters");
    }
    let content;
    let startLine = 1;
    let selectionMetadata = {};
    if (args.include_line_numbers && args.tail !== undefined) {
        const tailResult = await readTailWithStartLine(filePath, args.tail);
        content = tailResult.content;
        startLine = tailResult.startLine;
        const returnedLines = splitDisplayLines(content).length;
        selectionMetadata = {
            selection: 'tail',
            requested_lines: args.tail,
            returned_start_line: returnedLines > 0 ? startLine : null,
            returned_end_line: returnedLines > 0 ? startLine + returnedLines - 1 : null,
            returned_selection_lines: returnedLines
        };
    }
    else if (args.tail !== undefined) {
        content = await tailFile(filePath, args.tail);
        selectionMetadata = {
            selection: 'tail',
            requested_lines: args.tail,
            returned_selection_lines: splitDisplayLines(content).length
        };
    }
    else if (args.head !== undefined) {
        content = await headFile(filePath, args.head);
        const returnedLines = splitDisplayLines(content).length;
        selectionMetadata = {
            selection: 'head',
            requested_lines: args.head,
            returned_start_line: returnedLines > 0 ? 1 : null,
            returned_end_line: returnedLines > 0 ? returnedLines : null,
            returned_selection_lines: returnedLines
        };
    }
    else if (hasRangeStart) {
        const rangeResult = await readLineRange(filePath, args.start_line, args.end_line);
        content = rangeResult.content;
        startLine = args.start_line;
        selectionMetadata = rangeResult;
        delete selectionMetadata.content;
    }
    else {
        const stats = await fs.stat(filePath);
        if (!args.allow_full_read && args.max_chars === undefined && stats.size > maxFullReadBytes) {
            throw new Error(`Refusing unbounded full-file read of ${filePath}: ${stats.size} bytes exceeds max_full_read_bytes ${maxFullReadBytes}. Use head, tail, start_line/end_line, max_chars, or allow_full_read=true.`);
        }
        content = await readFileContent(filePath);
        selectionMetadata = { selection: 'full' };
    }
    if (args.include_line_numbers) {
        content = addLineNumbers(content, startLine);
    }
    return { content, selectionMetadata };
}
function matchesDirectoryListPattern(value, pattern) {
    const directoryPattern = pattern.endsWith('/**') || pattern.endsWith('\\**')
        ? pattern.slice(0, -3)
        : undefined;
    return minimatch(value, pattern, { dot: true }) ||
        minimatch(path.basename(value), pattern, { dot: true }) ||
        (directoryPattern !== undefined && (minimatch(value, directoryPattern, { dot: true }) ||
            minimatch(path.basename(value), directoryPattern, { dot: true })));
}
function shouldIncludeDirectoryEntry(entry, args) {
    if (args.file_only && entry.isDirectory) {
        return false;
    }
    if (args.directory_only && !entry.isDirectory) {
        return false;
    }
    if (args.glob && !matchesDirectoryListPattern(entry.relativePath, args.glob)) {
        return false;
    }
    const excludePatterns = args.excludePatterns ?? [];
    return !excludePatterns.some((pattern) => matchesDirectoryListPattern(entry.relativePath, pattern));
}
function sortDirectoryEntries(entries, sortBy) {
    if (sortBy === 'none') {
        return entries;
    }
    return [...entries].sort((a, b) => {
        if (sortBy === 'type') {
            const typeCompare = Number(b.isDirectory()) - Number(a.isDirectory());
            if (typeCompare !== 0) {
                return typeCompare;
            }
        }
        return a.name.localeCompare(b.name);
    });
}
function serializeFileInfo(requestedPath, resolvedPath, info) {
    return {
        path: requestedPath,
        resolved_path: resolvedPath,
        exists: true,
        type: info.isDirectory ? 'directory' : info.isFile ? 'file' : 'other',
        size: info.size,
        created: info.created.toISOString(),
        modified: info.modified.toISOString(),
        accessed: info.accessed.toISOString(),
        isDirectory: info.isDirectory,
        isFile: info.isFile,
        permissions: info.permissions,
        error: null
    };
}
function normalizeWhitespaceForDiff(text) {
    return normalizeLineEndings(text)
        .split('\n')
        .map((line) => line.trim().replace(/\s+/g, ' '))
        .join('\n');
}
function countTextLines(text) {
    if (text.length === 0) {
        return 0;
    }
    const lines = text.split('\n');
    return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}
function summarizeUnifiedDiff(diff) {
    let addedLines = 0;
    let removedLines = 0;
    let changedHunks = 0;
    for (const line of diff.split('\n')) {
        if (line.startsWith('@@')) {
            changedHunks++;
        }
        else if (line.startsWith('+') && !line.startsWith('+++')) {
            addedLines++;
        }
        else if (line.startsWith('-') && !line.startsWith('---')) {
            removedLines++;
        }
    }
    return { addedLines, removedLines, changedHunks };
}
async function readTextForDiff(filePath, label, maxFileBytes) {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
        throw new Error(`${label} is not a regular file: ${filePath}`);
    }
    if (stats.size > maxFileBytes) {
        throw new Error(`${label} is ${stats.size} bytes, which exceeds max_file_bytes ${maxFileBytes}`);
    }
    return {
        size: stats.size,
        content: await readFileContent(filePath)
    };
}
async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    }
    catch {
        return false;
    }
}
async function getPathType(targetPath) {
    const stats = await fs.stat(targetPath);
    return stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
}
async function collectPathSummary(targetPath, maxEntries, sampleLimit = 0, signal) {
    assertNotCancelled(signal);
    const stats = await fs.stat(targetPath);
    const summary = {
        type: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
        entries: 1,
        files: stats.isFile() ? 1 : 0,
        directories: stats.isDirectory() ? 1 : 0,
        bytes: stats.isFile() ? stats.size : 0,
        sample_entries: sampleLimit > 0 ? ['.'] : [],
        truncated: false
    };
    if (signal) {
        signal.partial_summary = summary;
    }
    if (!stats.isDirectory()) {
        return summary;
    }
    async function walk(currentPath) {
        assertNotCancelled(signal);
        if (summary.entries >= maxEntries) {
            summary.truncated = true;
            return;
        }
        const entries = await fs.readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            assertNotCancelled(signal);
            if (summary.entries >= maxEntries) {
                summary.truncated = true;
                return;
            }
            summary.entries++;
            const fullPath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                summary.directories++;
                if (summary.sample_entries.length < sampleLimit) {
                    summary.sample_entries.push(path.relative(targetPath, fullPath) || '.');
                }
                await walk(fullPath);
                if (summary.truncated) {
                    return;
                }
            }
            else {
                summary.files++;
                const childStats = await fs.stat(fullPath);
                summary.bytes += childStats.size;
                if (summary.sample_entries.length < sampleLimit) {
                    summary.sample_entries.push(path.relative(targetPath, fullPath) || '.');
                }
            }
        }
    }
    await walk(targetPath);
    return summary;
}
async function collectRemovalSummary(targetPath, maxEntries, sampleLimit = 0, signal) {
    return collectPathSummary(targetPath, maxEntries, sampleLimit, signal);
}
async function applyStatsWithConcurrency(statTargets, concurrency) {
    let nextIndex = 0;
    const workerCount = Math.min(concurrency, statTargets.length);
    async function worker() {
        while (nextIndex < statTargets.length) {
            const currentIndex = nextIndex++;
            const target = statTargets[currentIndex];
            try {
                const stats = await fs.stat(target.fullPath);
                target.item.size = stats.size;
                target.item.mtime = stats.mtime;
            }
            catch { }
        }
    }
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));
    async function worker() {
        while (nextIndex < items.length) {
            const currentIndex = nextIndex++;
            results[currentIndex] = await mapper(items[currentIndex], currentIndex);
        }
    }
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}
async function collectDirectoryEntries(rootPath, args, includeSizes = false, signal) {
    if (args.file_only && args.directory_only) {
        throw new Error("file_only and directory_only cannot both be true");
    }
    const maxDepth = args.max_depth ?? 1;
    const limit = args.limit;
    const entries = [];
    const statTargets = [];
    if (signal) {
        signal.partial_entries = entries;
    }
    async function walk(currentPath, depth) {
        assertNotCancelled(signal);
        if (limit !== undefined && entries.length >= limit) {
            return;
        }
        const dirEntries = await fs.readdir(currentPath, { withFileTypes: true });
        for (const entry of dirEntries) {
            assertNotCancelled(signal);
            const fullPath = path.join(currentPath, entry.name);
            const relativePath = path.relative(rootPath, fullPath) || entry.name;
            const item = {
                name: entry.name,
                relativePath,
                isDirectory: entry.isDirectory(),
                size: 0,
                mtime: new Date(0)
            };
            if (shouldIncludeDirectoryEntry(item, args)) {
                entries.push(item);
                if (includeSizes) {
                    statTargets.push({ fullPath, item });
                }
                if (limit !== undefined && entries.length >= limit) {
                    return;
                }
            }
            if (entry.isDirectory() && depth < maxDepth) {
                await walk(fullPath, depth + 1);
                if (limit !== undefined && entries.length >= limit) {
                    return;
                }
            }
        }
    }
    await walk(rootPath, 1);
    if (includeSizes && statTargets.length > 0) {
        assertNotCancelled(signal);
        await applyStatsWithConcurrency(statTargets, args.stat_concurrency ?? 16);
    }
    return entries;
}
function runRipgrepSearch(rootPath, args, control = {}) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const rgArgs = ['--color', 'never'];
        if (args.paths_only) {
            rgArgs.push('--files-with-matches');
        }
        else if (args.count_only) {
            rgArgs.push('--count-matches', '--with-filename');
        }
        else {
            rgArgs.push('--json', '--line-number', '--with-filename');
        }
        if (!args.case_sensitive) {
            rgArgs.push('--ignore-case');
        }
        applyRipgrepCoverageFlags(rgArgs, args);
        if (!args.regex) {
            rgArgs.push('--fixed-strings');
        }
        if (args.type && args.type !== 'all') {
            rgArgs.push('--type', args.type);
        }
        if (args.context_before > 0) {
            rgArgs.push('--before-context', String(args.context_before));
        }
        if (args.context_after > 0) {
            rgArgs.push('--after-context', String(args.context_after));
        }
        if (args.glob) {
            rgArgs.push('--glob', args.glob);
        }
        const appliedDefaultExcludes = applyDefaultSearchExcludes(rgArgs, args);
        for (const excludePattern of args.excludePatterns ?? []) {
            rgArgs.push('--glob', `!${excludePattern}`);
        }
        rgArgs.push('--', args.pattern, rootPath);
        const child = spawn('rg', rgArgs, { windowsHide: true });
        control.children?.add(child);
        if (control.signal?.cancelled) {
            child.kill();
        }
        let stderr = '';
        let pending = '';
        let matchCount = 0;
        let settled = false;
        const results = [];
        let stoppedByMaxResults = false;
        let timedOut = false;
        const timeoutMs = args.timeout_ms ?? DEFAULT_SEARCH_TIMEOUT_MS;
        let timeoutHandle = null;
        const reachedResultLimit = () => args.count_only ? results.length >= args.max_results : matchCount >= args.max_results;
        const stopChild = () => {
            pending = '';
            child.stdout.pause();
            child.stdout.removeAllListeners('data');
            child.kill();
        };
        const buildSummary = (extra = {}) => {
            const summary = {
                match_count: matchCount,
                result_count: results.length,
                max_results: args.max_results,
                stopped_by_max_results: stoppedByMaxResults,
                timed_out: timedOut,
                timeout_ms: timeoutMs,
                searched_ms: Date.now() - startedAt,
                partial: timedOut || stoppedByMaxResults,
                default_excludes: args.default_excludes === true,
                applied_default_excludes: appliedDefaultExcludes,
                warnings: summarizeRipgrepStderr(stderr),
                mode: args.paths_only ? 'paths_only' : args.count_only ? 'count_only' : 'matches',
                ...extra
            };
            const suggestedRetry = makeSearchSuggestedRetry(summary);
            return {
                ...summary,
                suggested_retry: suggestedRetry,
                suggested_retry_text: makeSearchSuggestedRetryText(suggestedRetry)
            };
        };
        const finish = (callback, value) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
            control.children?.delete(child);
            callback(value);
        };
        const consumeLine = (line) => {
            if (control.signal?.cancelled || !line.trim() || reachedResultLimit()) {
                return;
            }
            if (args.paths_only) {
                const relativePath = path.relative(rootPath, line) || line;
                results.push({ type: 'path', path: relativePath });
                matchCount++;
                if (matchCount >= args.max_results) {
                    stoppedByMaxResults = true;
                    stopChild();
                }
                return;
            }
            if (args.count_only) {
                const separatorIndex = line.lastIndexOf(':');
                if (separatorIndex <= 0) {
                    return;
                }
                const absolutePath = line.slice(0, separatorIndex);
                const count = Number(line.slice(separatorIndex + 1));
                const safeCount = Number.isFinite(count) ? count : 0;
                const relativePath = path.relative(rootPath, absolutePath) || absolutePath;
                results.push({ type: 'count', path: relativePath, count: safeCount });
                matchCount += safeCount;
                if (results.length >= args.max_results) {
                    stoppedByMaxResults = true;
                    stopChild();
                }
                return;
            }
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                return;
            }
            if (event.type !== 'match' && event.type !== 'context') {
                return;
            }
            const data = event.data;
            const absolutePath = data.path?.text ?? '';
            const relativePath = path.relative(rootPath, absolutePath) || absolutePath;
            const text = truncateMatchText((data.lines?.text ?? '').replace(/\r?\n$/, ''), args.max_match_chars);
            results.push({
                type: event.type,
                path: relativePath,
                line: data.line_number,
                text
            });
            if (event.type === 'match') {
                matchCount++;
                if (matchCount >= args.max_results) {
                    stoppedByMaxResults = true;
                    stopChild();
                }
            }
        };
        child.stdout.on('data', (chunk) => {
            if (control.signal?.cancelled) {
                return;
            }
            pending += chunk.toString('utf-8');
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() ?? '';
            for (const line of lines) {
                consumeLine(line);
                if (reachedResultLimit()) {
                    break;
                }
            }
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf-8');
        });
        if (timeoutMs > 0) {
            timeoutHandle = setTimeout(() => {
                if (settled) {
                    return;
                }
                timedOut = true;
                stopChild();
            }, timeoutMs);
        }
        child.on('error', (error) => {
            finish(reject, new Error(`Failed to run rg: ${error.message}`));
        });
        child.on('close', (code) => {
            if (control.signal?.cancelled) {
                finish(resolve, {
                    results,
                    summary: buildSummary({ stopped_by_max_results: true, cancelled: true })
                });
                return;
            }
            if (pending) {
                consumeLine(pending);
            }
            if (settled) {
                return;
            }
            if (code !== 0 && code !== 1) {
                if (reachedResultLimit() || timedOut) {
                    finish(resolve, {
                        results,
                        summary: buildSummary({
                            stopped_by_max_results: stoppedByMaxResults || reachedResultLimit()
                        })
                    });
                    return;
                }
                finish(reject, new Error(formatRipgrepFailure('rg', code, stderr)));
                return;
            }
            finish(resolve, {
                results,
                summary: buildSummary()
            });
        });
    });
}
function formatSearchTextResults(results) {
    if (results.length === 0) {
        return 'No matches found';
    }
    return results.map((result) => {
        if (result.type === 'path') {
            return result.path;
        }
        if (result.type === 'count') {
            return `${result.path}:${result.count}`;
        }
        const marker = result.type === 'match' ? ':' : '-';
        return `${result.path}${marker}${result.line}${marker}${result.text}`;
    }).join('\n');
}
function countSearchResultItems(results) {
    return results.filter((result) => result.type === 'match' || result.type === 'path' || result.type === 'count').length;
}
function trimSearchResults(results, maxResults) {
    const trimmed = [];
    let count = 0;
    for (const result of results) {
        const countsTowardLimit = result.type === 'match' || result.type === 'path' || result.type === 'count';
        if (countsTowardLimit && count >= maxResults) {
            break;
        }
        trimmed.push(result);
        if (countsTowardLimit) {
            count++;
        }
    }
    return trimmed;
}
function deriveDirectorySearchFromFiles(fileResults, args) {
    const pattern = args.glob ?? args.pattern;
    const directories = new Set();
    for (const filePath of fileResults) {
        let current = path.dirname(filePath);
        while (current && current !== '.' && current !== path.dirname(current)) {
            const normalized = current.replace(/\\/g, '/');
            const depth = normalized.split('/').filter(Boolean).length;
            if (args.max_depth === undefined || depth <= args.max_depth) {
                directories.add(current);
            }
            current = path.dirname(current);
        }
    }
    let results = [...directories].filter((directoryPath) => {
        if (pattern && !matchesDirectoryListPattern(directoryPath, pattern)) {
            return false;
        }
        return !(args.excludePatterns ?? []).some((excludePattern) => matchesDirectoryListPattern(directoryPath, excludePattern));
    });
    results.sort((a, b) => a.localeCompare(b));
    const stoppedByLimit = results.length > args.limit;
    if (results.length > args.limit) {
        results = results.slice(0, args.limit);
    }
    return { results, stoppedByLimit };
}
function matchesShardFilter(shard, filters = []) {
    return filters.some((filter) => filter === shard || matchesDirectoryListPattern(shard, filter));
}
async function collectSearchShards(rootPath, args) {
    const shards = [];
    const rootDirectoryNames = [];
    async function walk(currentPath, depth) {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });
        let hasChildDirectory = false;
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const fullPath = path.join(currentPath, entry.name);
            const relativePath = path.relative(rootPath, fullPath);
            const shouldExclude = [...getAppliedSearchExcludePatterns(args), ...(args.excludePatterns ?? [])].some(pattern => matchesDirectoryListPattern(relativePath, pattern));
            if (shouldExclude) {
                continue;
            }
            if (currentPath === rootPath) {
                rootDirectoryNames.push(entry.name);
            }
            hasChildDirectory = true;
            if (depth >= args.shard_depth) {
                shards.push({
                    path: fullPath,
                    relativePath
                });
            }
            else {
                await walk(fullPath, depth + 1);
            }
        }
        if (!hasChildDirectory && currentPath === rootPath) {
            shards.push({
                path: rootPath,
                relativePath: "."
            });
        }
    }
    await walk(rootPath, 1);
    if (rootDirectoryNames.length > 0) {
        shards.unshift({
            path: rootPath,
            relativePath: ".",
            extraExcludePatterns: rootDirectoryNames.flatMap((name) => [name, `${name}/**`])
        });
    }
    const allShards = shards.length > 0 ? shards : [{ path: rootPath, relativePath: "." }];
    return allShards.filter((shard) => {
        if (args.include_shards?.length && !matchesShardFilter(shard.relativePath, args.include_shards)) {
            return false;
        }
        if (args.exclude_shards?.length && matchesShardFilter(shard.relativePath, args.exclude_shards)) {
            return false;
        }
        return true;
    });
}
async function runShardedRipgrepSearch(rootPath, args) {
    const startedAt = Date.now();
    const timeoutMs = args.timeout_ms ?? 120000;
    const shards = await collectSearchShards(rootPath, args);
    const shardSlots = new Array(shards.length);
    const searchedShardIndexes = new Set();
    const partialShardIndexes = new Set();
    const failedShards = [];
    const activeChildren = new Set();
    const control = { signal: { cancelled: false }, children: activeChildren };
    const concurrency = Math.max(1, Math.min(args.shard_concurrency ?? 1, 8, shards.length || 1));
    let timedOut = false;
    let stoppedByMaxResults = false;
    let nextIndex = 0;
    let resultCount = 0;
    const cancelActiveSearches = () => {
        control.signal.cancelled = true;
        for (const child of activeChildren) {
            child.kill();
        }
    };
    async function worker() {
        while (true) {
            const shardIndex = nextIndex++;
            if (shardIndex >= shards.length) {
                return;
            }
            if (resultCount >= args.max_results) {
                stoppedByMaxResults = true;
                cancelActiveSearches();
                return;
            }
            if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
                timedOut = true;
                cancelActiveSearches();
                return;
            }
            const shard = shards[shardIndex];
            try {
                const remainingMatches = Math.max(1, args.max_results - resultCount);
                const shardSearch = await runRipgrepSearch(shard.path, {
                    ...args,
                    excludePatterns: [...(args.excludePatterns ?? []), ...(shard.extraExcludePatterns ?? [])],
                    max_results: remainingMatches
                }, control);
                if (shardSearch.summary.stopped_by_max_results) {
                    stoppedByMaxResults = true;
                    partialShardIndexes.add(shardIndex);
                    cancelActiveSearches();
                }
                const shardResults = shardSearch.results.map((result) => {
                    const resultPath = shard.relativePath === "."
                        ? result.path
                        : path.join(shard.relativePath, result.path);
                    return {
                        ...result,
                        path: resultPath
                    };
                });
                shardSlots[shardIndex] = shardResults;
                resultCount += countSearchResultItems(shardResults);
                searchedShardIndexes.add(shardIndex);
                if (resultCount >= args.max_results) {
                    stoppedByMaxResults = true;
                    cancelActiveSearches();
                }
            }
            catch (error) {
                failedShards.push({
                    shard: shard.relativePath,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    const allResults = shardSlots.flatMap((items) => items ?? []);
    const results = trimSearchResults(allResults, args.max_results);
    if (countSearchResultItems(allResults) > countSearchResultItems(results)) {
        stoppedByMaxResults = true;
    }
    const searchedShards = shards
        .map((shard, index) => searchedShardIndexes.has(index) ? shard.relativePath : null)
        .filter((shard) => shard !== null);
    const partialShards = shards
        .map((shard, index) => partialShardIndexes.has(index) ? shard.relativePath : null)
        .filter((shard) => shard !== null);
    const failedShardNames = new Set(failedShards.map((failed) => failed.shard));
    const remainingShards = shards
        .filter((shard, index) => !searchedShardIndexes.has(index) && !failedShardNames.has(shard.relativePath))
        .map((shard) => shard.relativePath);
    const completed = !timedOut && !stoppedByMaxResults && remainingShards.length === 0 && failedShards.length === 0;
    const baseSummary = {
        completed,
        timed_out: timedOut,
        stopped_by_max_results: stoppedByMaxResults,
        timeout_ms: timeoutMs,
        searched_ms: Date.now() - startedAt,
        partial: !completed,
        shard_depth: args.shard_depth,
        shard_concurrency: concurrency,
        shard_count: shards.length,
        include_shards: args.include_shards ?? null,
        exclude_shards: args.exclude_shards ?? null,
        default_excludes: args.default_excludes === true,
        applied_default_excludes: getAppliedSearchExcludePatterns(args),
        searched_shards: searchedShards,
        remaining_shards: remainingShards,
        partial_shards: partialShards,
        failed_shards: failedShards,
        result_count: countSearchResultItems(results),
        mode: args.paths_only ? 'paths_only' : args.count_only ? 'count_only' : 'matches'
    };
    const suggestedRetry = makeSearchSuggestedRetry(baseSummary);
    return {
        results,
        summary: {
            ...baseSummary,
            suggested_retry: suggestedRetry,
            suggested_retry_text: makeSearchSuggestedRetryText(suggestedRetry)
        }
    };
}
function runRipgrepFiles(rootPath, args) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const rgArgs = ['--files', '--color', 'never'];
        const pattern = args.glob ?? args.pattern;
        applyRipgrepCoverageFlags(rgArgs, args);
        const appliedDefaultExcludes = applyDefaultSearchExcludes(rgArgs, args);
        if (args.max_depth !== undefined) {
            rgArgs.push('--max-depth', String(args.max_depth));
        }
        if (pattern) {
            rgArgs.push('--glob', pattern);
        }
        for (const excludePattern of args.excludePatterns ?? []) {
            rgArgs.push('--glob', `!${excludePattern}`);
        }
        rgArgs.push(rootPath);
        const child = spawn('rg', rgArgs, { windowsHide: true });
        let stderr = '';
        let pending = '';
        let settled = false;
        const results = [];
        let stoppedByLimit = false;
        let timedOut = false;
        const timeoutMs = args.timeout_ms ?? DEFAULT_SEARCH_TIMEOUT_MS;
        let timeoutHandle = null;
        const stopChild = () => {
            pending = '';
            child.stdout.pause();
            child.stdout.removeAllListeners('data');
            child.kill();
        };
        const buildSummary = (extra = {}) => {
            const summary = {
                result_count: results.length,
                limit: args.limit,
                stopped_by_limit: stoppedByLimit,
                timed_out: timedOut,
                timeout_ms: timeoutMs,
                searched_ms: Date.now() - startedAt,
                partial: timedOut || stoppedByLimit,
                default_excludes: args.default_excludes === true,
                applied_default_excludes: appliedDefaultExcludes,
                warnings: summarizeRipgrepStderr(stderr),
                ...extra
            };
            const suggestedRetry = makeSearchSuggestedRetry(summary);
            return {
                ...summary,
                suggested_retry: suggestedRetry,
                suggested_retry_text: makeSearchSuggestedRetryText(suggestedRetry)
            };
        };
        const finish = (callback, value) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
            callback(value);
        };
        const consumeLine = (line) => {
            if (!line.trim() || results.length >= args.limit) {
                return;
            }
            results.push(path.relative(rootPath, line) || line);
            if (results.length >= args.limit) {
                stoppedByLimit = true;
                stopChild();
            }
        };
        child.stdout.on('data', (chunk) => {
            pending += chunk.toString('utf-8');
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() ?? '';
            for (const line of lines) {
                consumeLine(line);
                if (results.length >= args.limit) {
                    break;
                }
            }
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf-8');
        });
        if (timeoutMs > 0) {
            timeoutHandle = setTimeout(() => {
                if (settled) {
                    return;
                }
                timedOut = true;
                stopChild();
            }, timeoutMs);
        }
        child.on('error', (error) => {
            finish(reject, new Error(`Failed to run rg --files: ${error.message}`));
        });
        child.on('close', (code) => {
            if (pending) {
                consumeLine(pending);
            }
            if (settled) {
                return;
            }
            if (code !== 0 && code !== 1) {
                if (results.length >= args.limit || timedOut) {
                    finish(resolve, {
                        results,
                        summary: buildSummary({ stopped_by_limit: stoppedByLimit || results.length >= args.limit })
                    });
                    return;
                }
                finish(reject, new Error(formatRipgrepFailure('rg --files', code, stderr)));
                return;
            }
            finish(resolve, {
                results,
                summary: buildSummary()
            });
        });
    });
}
// Tool registrations
// read_file (deprecated) and read_text_file
const readTextFileHandler = async (args) => {
    const validPath = await validatePath(args.path);
    const selected = await readSelectedTextFile(validPath, args);
    const limited = limitTextOutput(selected.content, args);
    return makeTextResponse(limited, selected.selectionMetadata);
};
server.registerTool("read_file", {
    title: "Read File (Deprecated)",
    description: "Read the complete contents of a file as text. DEPRECATED: Use read_text_file instead.",
    inputSchema: ReadTextFileArgsSchema.shape,
    outputSchema: TextContentOutputSchema,
    annotations: { readOnlyHint: true }
}, readTextFileHandler);
server.registerTool("read_text_file", {
    title: "Read Text File",
    description: "Use for known text file paths, especially when reading a specific range or needing line numbers. " +
        "Prefer this over PowerShell Get-Content. Use head/tail for file ends, start_line/end_line for inclusive 1-based ranges, " +
        "include_line_numbers for code review/debugging, and max_lines/max_chars to keep output bounded. " +
        "Range reads return structured selection metadata including returned_start_line, returned_end_line, completed_requested_range, and reached_eof. " +
        "When max_lines or max_chars truncates output, inspect structured truncation fields before deciding whether to narrow or continue reading. " +
        "Unbounded full-file reads above max_full_read_bytes are refused unless max_chars or allow_full_read=true is provided. " +
        "Do not use this to find unknown files; use search_files first. Operates on the file as text regardless of extension. " +
        "K filesystem MCP runs in global local filesystem mode.",
    inputSchema: {
        path: z.string(),
        tail: z.number().int().positive().max(100000).optional().describe("If provided, returns only the last N lines of the file"),
        head: z.number().int().positive().max(100000).optional().describe("If provided, returns only the first N lines of the file"),
        start_line: z.number().int().positive().optional().describe("If provided with end_line, returns the inclusive 1-based line range starting at this line"),
        end_line: z.number().int().positive().optional().describe("If provided with start_line, returns the inclusive 1-based line range ending at this line"),
        include_line_numbers: z.boolean().optional().describe("If true, prefixes each returned line with its 1-based line number"),
        allow_full_read: z.boolean().optional().default(false).describe("If true, allows unbounded full-file reads above the default safety threshold"),
        max_full_read_bytes: z.number().int().positive().max(100 * 1024 * 1024).optional().default(DEFAULT_FULL_READ_MAX_BYTES).describe("Maximum file size for unbounded full-file reads unless allow_full_read or max_chars is provided"),
        ...TextOutputLimitShape
    },
    outputSchema: TextContentOutputSchema,
    annotations: { readOnlyHint: true }
}, readTextFileHandler);
server.registerTool("read_media_file", {
    title: "Read Media File",
    description: "Read an image or audio file. Returns the base64 encoded data and MIME type. " +
        "Uses max_bytes with a 5 MiB default limit to avoid accidentally returning huge base64 responses. " +
        "K filesystem MCP runs in global local filesystem mode.",
    inputSchema: ReadMediaFileArgsSchema.shape,
    outputSchema: {
        content: z.array(z.object({
            type: z.enum(["image", "audio", "blob"]),
            data: z.string(),
            mimeType: z.string()
        }))
    },
    annotations: { readOnlyHint: true }
}, async (args) => {
    const validPath = await validatePath(args.path);
    const stats = await fs.stat(validPath);
    if (stats.size > args.max_bytes) {
        throw new Error(`Media file is ${stats.size} bytes, which exceeds max_bytes ${args.max_bytes}. Increase max_bytes only if this large base64 response is intended.`);
    }
    const extension = path.extname(validPath).toLowerCase();
    const mimeTypes = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
        ".svg": "image/svg+xml",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".flac": "audio/flac",
    };
    const mimeType = mimeTypes[extension] || "application/octet-stream";
    const data = await readFileAsBase64Stream(validPath);
    const type = mimeType.startsWith("image/")
        ? "image"
        : mimeType.startsWith("audio/")
            ? "audio"
            // Fallback for other binary types, not officially supported by the spec but has been used for some time
            : "blob";
    const contentItem = { type: type, data, mimeType };
    return {
        content: [contentItem],
        structuredContent: { content: [contentItem] }
    };
});
server.registerTool("read_multiple_files", {
    title: "Read Multiple Files",
    description: "Use when several known files need to be read or compared. Prefer the files array for per-file head, tail, " +
        "start_line/end_line, include_line_numbers, max_lines, and max_chars. This is better than repeated read_text_file calls " +
        "or parallel PowerShell Get-Content commands. Failed reads for individual files won't stop the entire operation. " +
        "Returns structured per-file results, selection metadata, summary counts, and error/error_type/code fields so failed reads can be retried selectively. " +
        "K filesystem MCP runs in global local filesystem mode.",
    inputSchema: ReadMultipleFilesArgsSchema.shape,
    outputSchema: {
        content: z.string(),
        results: z.array(z.object({
            path: z.string(),
            ok: z.boolean(),
            content: z.string().optional(),
            ...StructuredErrorOutputSchema,
            ...TextSelectionOutputSchema,
            ...TextTruncationOutputSchema
        })),
        summary: z.object({
            requested: z.number(),
            succeeded: z.number(),
            failed: z.number(),
            read_concurrency: z.number().optional(),
            ...TextTruncationOutputSchema
        })
    },
    annotations: { readOnlyHint: true }
}, async (args) => {
    const fileRequests = args.files ?? args.paths?.map((filePath) => ({ path: filePath })) ?? [];
    if (fileRequests.length === 0) {
        throw new Error("Either paths or files must contain at least one file request");
    }
    const readConcurrency = Math.max(1, Math.min(args.read_concurrency ?? 32, fileRequests.length || 1));
    const results = await mapWithConcurrency(fileRequests, readConcurrency, async (fileRequest) => {
        const filePath = fileRequest.path;
        try {
            const validPath = await validatePath(filePath);
            const request = {
                ...fileRequest,
                include_line_numbers: fileRequest.include_line_numbers ?? args.include_line_numbers
            };
            const selected = await readSelectedTextFile(validPath, request);
            const limited = limitTextOutput(selected.content, request);
            return { path: filePath, ok: true, content: limited.text, error: null, ...selected.selectionMetadata, ...formatTruncationStructured(limited) };
        }
        catch (error) {
            return { path: filePath, ok: false, ...formatErrorStructured(error) };
        }
    });
    const textParts = results.map((result) => result.ok
        ? `${result.path}:\n${result.content ?? ''}\n`
        : `${result.path}: Error - ${result.error}`);
    const summary = {
        requested: results.length,
        succeeded: results.filter((result) => result.ok).length,
        failed: results.filter((result) => !result.ok).length,
        read_concurrency: readConcurrency
    };
    const displayText = compactText(textParts.join("\n---\n"), args, `Read ${summary.succeeded}/${summary.requested} files (${summary.failed} failed).`);
    const limited = limitTextOutput(displayText, args);
    Object.assign(summary, formatTruncationStructured(limited));
    return {
        content: [{ type: "text", text: limited.text }],
        structuredContent: applyOutputMode({ content: limited.text, results, summary }, args, ['results'])
    };
});
server.registerTool("diff_text_files", {
    title: "Diff Text Files",
    description: "Compare two existing text files and return a bounded unified diff plus structured status. " +
        "Use this instead of reading both files into context, PowerShell Compare-Object, fc, or git diff when only a local two-file text comparison is needed. " +
        "It is read-only, checks max_file_bytes before reading, supports context_lines, ignore_whitespace, compact/output_mode, and bounded diff output using max_diff_lines, max_diff_chars, and max_diff_line_chars. " +
        "Reports line/hunk summary fields plus whether diff lines or characters were truncated. " +
        "K filesystem MCP runs in global local filesystem mode.",
    inputSchema: DiffTextFilesArgsSchema.shape,
    outputSchema: {
        content: z.string(),
        identical: z.boolean(),
        left_path: z.string(),
        right_path: z.string(),
        left_size: z.number(),
        right_size: z.number(),
        ignore_whitespace: z.boolean(),
        context_lines: z.number(),
        left_line_count: z.number(),
        right_line_count: z.number(),
        added_lines: z.number(),
        removed_lines: z.number(),
        changed_hunks: z.number(),
        diff: z.string(),
        diff_truncated: z.boolean(),
        diff_omitted_lines: z.number(),
        diff_omitted_chars: z.number()
    },
    annotations: { readOnlyHint: true }
}, async (args) => {
    const leftPath = await validatePath(args.left_path);
    const rightPath = await validatePath(args.right_path);
    const left = await readTextForDiff(leftPath, 'left_path', args.max_file_bytes);
    const right = await readTextForDiff(rightPath, 'right_path', args.max_file_bytes);
    const leftContent = args.ignore_whitespace ? normalizeWhitespaceForDiff(left.content) : left.content;
    const rightContent = args.ignore_whitespace ? normalizeWhitespaceForDiff(right.content) : right.content;
    const identical = leftContent === rightContent;
    const diffResult = identical
        ? { diff: '', truncated: false, omittedLines: 0, omittedChars: 0 }
        : createUnifiedDiff(leftContent, rightContent, `${leftPath} -> ${rightPath}`, {
            maxLines: args.max_diff_lines,
            maxChars: args.max_diff_chars,
            maxLineChars: args.max_diff_line_chars,
            contextLines: args.context_lines
        });
    const diffSummary = summarizeUnifiedDiff(diffResult.diff);
    const fullText = identical
        ? `Files are identical${args.ignore_whitespace ? ' after whitespace normalization' : ''}: ${args.left_path} and ${args.right_path}`
        : diffResult.diff;
    const text = compactText(fullText, args, identical
        ? fullText
        : `Files differ: ${args.left_path} and ${args.right_path}; ${diffSummary.changedHunks} hunks, +${diffSummary.addedLines}/-${diffSummary.removedLines}${diffResult.truncated ? `, ${diffResult.omittedLines} diff lines and ${diffResult.omittedChars} chars omitted` : ''}.`);
    return {
        content: [{ type: "text", text }],
        structuredContent: applyOutputMode({
            content: text,
            identical,
            left_path: leftPath,
            right_path: rightPath,
            left_size: left.size,
            right_size: right.size,
            ignore_whitespace: Boolean(args.ignore_whitespace),
            context_lines: args.context_lines,
            left_line_count: countTextLines(leftContent),
            right_line_count: countTextLines(rightContent),
            added_lines: diffSummary.addedLines,
            removed_lines: diffSummary.removedLines,
            changed_hunks: diffSummary.changedHunks,
            diff: diffResult.diff,
            diff_truncated: diffResult.truncated,
            diff_omitted_lines: diffResult.omittedLines,
            diff_omitted_chars: diffResult.omittedChars
        }, args, ['diff'])
    };
});
server.registerTool("write_file", {
    title: "Write File",
    description: "Create a new text file or overwrite an existing one only when overwrite=true. " +
        "Use dryRun=true to preview creates or existing-file overwrites. Existing-file overwrites preserve the original newline style and UTF-8 BOM behavior, " +
        "and return a bounded unified diff plus structured status. Use max_diff_chars/max_diff_line_chars to avoid huge diff output from long lines. " +
        "Large existing files cannot be replaced with much shorter content unless allow_major_overwrite=true; guarded refusals return structured error/error_type/code fields. " +
        "backup_existing=true can create a timestamped .bak before a real content-changing overwrite, but it defaults to false to avoid backup file noise. " +
        "For new files, use newline='lf'/'crlf' and bom=true/false only when the file format requires it. " +
        "Use create_parent_dirs=true only when missing parent directories should be created. " +
        "K filesystem MCP runs in global local filesystem mode.",
    inputSchema: WriteFileArgsSchema.shape,
    outputSchema: FileMutationOutputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true }
}, async (args) => {
    const normalizedArgs = normalizeDryRun(args);
    const validPath = await validatePath(normalizedArgs.path, { allowMissingParent: normalizedArgs.create_parent_dirs });
    const result = await writeFileContent(validPath, normalizedArgs.content, normalizedArgs);
    return {
        content: [{ type: "text", text: result.text }],
        structuredContent: { content: result.text, ...result.structured }
    };
});
server.registerTool("edit_file", {
    title: "Edit File",
    description: "Make line-based edits to a text file. Each edit replaces exact line sequences " +
        "with new content. By default each edit must match exactly once; use expected_occurrences to make that requirement explicit, " +
        "For a single simple edit, pass top-level oldText/newText instead of an edits array. " +
        "Use beforeText/afterText anchors when a stable surrounding region is easier to identify than the exact changing text; keep anchor_mode='exact' by default and switch to anchor_mode='flexible' only when line-level trim matching is truly needed. Omit oldText to replace the content between the anchors. " +
        "start_line/end_line to constrain a specific edit to an inclusive line range, and match_mode='exact' when flexible whitespace matching is not desired. Prefer dryRun=true before risky edits. " +
        "Multiple edits are matched against the original file and applied bottom-up, so earlier insertions do not shift later original line ranges. " +
        "Preserves the original newline style and UTF-8 BOM behavior. Returns a bounded git-style diff plus structured status; use max_diff_chars/max_diff_line_chars for risky long-line diffs. " +
        "K filesystem MCP runs in global local filesystem mode.",
    inputSchema: EditFileArgsSchema.shape,
    outputSchema: FileMutationOutputSchema,
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true }
}, async (args) => {
    const normalizedArgs = normalizeEditFileArgs(args);
    const validPath = await validatePath(normalizedArgs.path);
    let result;
    try {
        result = await applyFileEdits(validPath, normalizedArgs.edits, normalizedArgs.dryRun, normalizedArgs);
    }
    catch (error) {
        if (error instanceof EditFileMatchError) {
            const code = error.details?.code ?? (error.details?.actual_occurrences === 0 ? 'MATCH_NOT_FOUND' : 'AMBIGUOUS_MATCH');
            const text = error.message;
            return {
                content: [{ type: "text", text }],
                structuredContent: {
                    content: text,
                    path: validPath,
                    changed: false,
                    dryRun: Boolean(normalizedArgs.dryRun),
                    error: text,
                    error_type: error.name,
                    code,
                    edit_error: error.details
                }
            };
        }
        throw error;
    }
    return {
        content: [{ type: "text", text: result.text }],
        structuredContent: { content: result.text, ...result.structured }
    };
});
server.registerTool("create_directory", {
    title: "Create Directory",
    description: "Create a new directory or ensure a directory exists. Can create multiple " +
        "nested directories in one operation. If the directory already exists, " +
        "this operation will succeed silently. Perfect for setting up directory " +
        "structures for projects or ensuring required paths exist. K filesystem MCP runs in global local filesystem mode.",
    inputSchema: {
        path: z.string()
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false }
}, async (args) => {
    const validPath = await validatePath(args.path, { allowMissingParent: true });
    await fs.mkdir(validPath, { recursive: true });
    const text = `Successfully created directory ${args.path}`;
    return {
        content: [{ type: "text", text }],
        structuredContent: { content: text }
    };
});
server.registerTool("list_directory", {
    title: "List Directory",
    description: "Use for bounded directory browsing when you know the directory and need a compact listing. " +
        "Prefer this over PowerShell Get-ChildItem. Supports limit, glob, excludePatterns, file_only, directory_only, max_depth, timeout_ms, " +
        "max_lines, and max_chars. Use search_files to find unknown file paths across a repo; do not use directory_tree as a file finder. " +
        "K filesystem MCP runs in global local filesystem mode.",
    inputSchema: ListDirectoryArgsSchema.shape,
    outputSchema: TextContentOutputSchema,
    annotations: { readOnlyHint: true }
}, async (args) => {
    const validPath = await validatePath(args.path);
    const startedAt = Date.now();
    const signal = createCancellationSignal();
    let entries = [];
    let timedOut = false;
    try {
        entries = await withTimeout(collectDirectoryEntries(validPath, args, false, signal), args.timeout_ms, () => makeTimeoutError(`Timed out while listing directory after ${args.timeout_ms} ms: ${args.path}`, 'LIST_DIRECTORY_TIMEOUT', 'ListDirectoryTimeoutError'), signal);
    }
    catch (error) {
        if (!(error instanceof Error) || error.name !== 'ListDirectoryTimeoutError') {
            throw error;
        }
        timedOut = true;
        entries = signal.partial_entries ?? [];
    }
    const limited = limitTextOutput(entries
        .map((entry) => `${entry.isDirectory ? "[DIR]" : "[FILE]"} ${entry.relativePath}`)
        .join("\n") || "No entries found", args);
    const summary = summarizeDirectoryEntries(entries, args, {
        timed_out: timedOut,
        timeout_ms: args.timeout_ms,
        searched_ms: Date.now() - startedAt,
        partial: timedOut
    });
    const truncation = formatTruncationStructured(limited);
    return {
        content: [{ type: "text", text: limited.text }],
        structuredContent: { content: limited.text, ...truncation, summary: { ...summary, ...truncation } }
    };
});
server.registerTool("list_directory_with_sizes", {
    title: "List Directory with Sizes",
    description: "Use for bounded directory browsing when file sizes matter, such as finding large files under a known directory. " +
        "Supports limit, glob, excludePatterns, file_only, directory_only, max_depth, timeout_ms, sortBy, stat_concurrency, max_lines, and max_chars. " +
        "Note that limit is applied during traversal before final sorting, so this is not a full top-N-by-size scan unless the traversal scope is complete. " +
        "Use search_files to find unknown paths. K filesystem MCP runs in global local filesystem mode.",
    inputSchema: ListDirectoryWithSizesArgsSchema.shape,
    outputSchema: TextContentOutputSchema,
    annotations: { readOnlyHint: true }
}, async (args) => {
    const validPath = await validatePath(args.path);
    const startedAt = Date.now();
    const signal = createCancellationSignal();
    let detailedEntries = [];
    let timedOut = false;
    try {
        detailedEntries = await withTimeout(collectDirectoryEntries(validPath, args, true, signal), args.timeout_ms, () => makeTimeoutError(`Timed out while listing directory sizes after ${args.timeout_ms} ms: ${args.path}`, 'LIST_DIRECTORY_TIMEOUT', 'ListDirectoryTimeoutError'), signal);
    }
    catch (error) {
        if (!(error instanceof Error) || error.name !== 'ListDirectoryTimeoutError') {
            throw error;
        }
        timedOut = true;
        detailedEntries = signal.partial_entries ?? [];
    }
    // Sort entries based on sortBy parameter
    const sortedEntries = [...detailedEntries].sort((a, b) => {
        if (args.sortBy === 'size') {
            return b.size - a.size; // Descending by size
        }
        // Default sort by name
        return a.relativePath.localeCompare(b.relativePath);
    });
    // Format the output
    const formattedEntries = sortedEntries.map(entry => `${entry.isDirectory ? "[DIR]" : "[FILE]"} ${entry.relativePath.padEnd(60)} ${entry.isDirectory ? "" : formatSize(entry.size).padStart(10)}`);
    // Add summary
    const totalFiles = detailedEntries.filter(e => !e.isDirectory).length;
    const totalDirs = detailedEntries.filter(e => e.isDirectory).length;
    const totalSize = detailedEntries.reduce((sum, entry) => sum + (entry.isDirectory ? 0 : entry.size), 0);
    const summary = [
        "",
        `Total: ${totalFiles} files, ${totalDirs} directories`,
        `Combined size: ${formatSize(totalSize)}`
    ];
    const limited = limitTextOutput([...formattedEntries, ...summary].join("\n"), args);
    const contentBlock = { type: "text", text: limited.text };
    const structuredSummary = summarizeDirectoryEntries(detailedEntries, args, {
        total_size: totalSize,
        total_size_formatted: formatSize(totalSize),
        sortBy: args.sortBy,
        timed_out: timedOut,
        timeout_ms: args.timeout_ms,
        searched_ms: Date.now() - startedAt,
        partial: timedOut
    });
    const truncation = formatTruncationStructured(limited);
    return {
        content: [contentBlock],
        structuredContent: { content: limited.text, ...truncation, summary: { ...structuredSummary, ...truncation } }
    };
});
server.registerTool("directory_tree", {
    title: "Directory Tree",
    description: "Use only to understand directory structure visually as JSON, not to prove that a file does not exist. " +
        "For finding files, use search_files. The output includes tree plus summary with entries_returned, directories_visited, " +
        "truncated, truncated_reason, and depth_limit_reached. If truncated or depth_limit_reached is true, treat the tree as incomplete. " +
        "Use sortBy='name' for stable alphabetical output, sortBy='type' for directories first, or sortBy='none' to preserve filesystem order. " +
        "Supports timeout_ms, compact/output_mode, max_lines and max_chars to bound large or slow JSON output. K filesystem MCP runs in global local filesystem mode.",
    inputSchema: DirectoryTreeArgsSchema.shape,
    outputSchema: TextContentOutputSchema,
    annotations: { readOnlyHint: true }
}, async (args) => {
    const rootPath = await validatePath(args.path);
    const startedAt = Date.now();
    const signal = createCancellationSignal();
    const summary = {
        entries_returned: 0,
        directories_visited: 0,
        max_depth: args.max_depth,
        limit: args.limit,
        sortBy: args.sortBy,
        timeout_ms: args.timeout_ms,
        searched_ms: 0,
        timed_out: false,
        partial: false,
        truncated: false,
        truncated_reason: null,
        depth_limit_reached: false
    };
    async function buildTree(currentPath, depth) {
        assertNotCancelled(signal);
        if (summary.entries_returned >= args.limit) {
            summary.truncated = true;
            summary.truncated_reason = "entry limit reached";
            return [];
        }
        const validPath = await validatePath(currentPath);
        summary.directories_visited++;
        const entries = sortDirectoryEntries(await fs.readdir(validPath, { withFileTypes: true }), args.sortBy);
        const result = [];
        for (const entry of entries) {
            assertNotCancelled(signal);
            if (summary.entries_returned >= args.limit) {
                summary.truncated = true;
                summary.truncated_reason = "entry limit reached";
                break;
            }
            const relativePath = path.relative(rootPath, path.join(currentPath, entry.name));
            const shouldExclude = (args.excludePatterns ?? []).some(pattern => matchesDirectoryListPattern(relativePath, pattern));
            if (shouldExclude)
                continue;
            const entryData = {
                name: entry.name,
                type: entry.isDirectory() ? 'directory' : 'file'
            };
            summary.entries_returned++;
            if (entry.isDirectory()) {
                entryData.children = [];
                if (depth < args.max_depth) {
                    const subPath = path.join(currentPath, entry.name);
                    try {
                        entryData.children = await buildTree(subPath, depth + 1);
                    }
                    catch (error) {
                        if (!(error instanceof Error) || error.name !== 'OperationCancelledError') {
                            throw error;
                        }
                        summary.timed_out = true;
                        summary.partial = true;
                        summary.truncated = true;
                        summary.truncated_reason = 'timeout';
                    }
                }
                else {
                    summary.depth_limit_reached = true;
                }
            }
            result.push(entryData);
        }
        return result;
    }
    let treeData = [];
    try {
        treeData = await withTimeout(buildTree(rootPath, 1), args.timeout_ms, () => makeTimeoutError(`Timed out while building directory tree after ${args.timeout_ms} ms: ${args.path}`, 'DIRECTORY_TREE_TIMEOUT', 'DirectoryTreeTimeoutError'), signal);
    }
    catch (error) {
        if (!(error instanceof Error) || error.name !== 'DirectoryTreeTimeoutError') {
            throw error;
        }
        summary.timed_out = true;
        summary.partial = true;
        summary.truncated = true;
        summary.truncated_reason = 'timeout';
    }
    summary.searched_ms = Date.now() - startedAt;
    const output = {
        tree: treeData,
        summary
    };
    const rawText = JSON.stringify(output, null, 2);
    const summaryText = `Directory tree: ${summary.entries_returned} entries, ${summary.directories_visited} directories visited, truncated=${summary.truncated}, depth_limit_reached=${summary.depth_limit_reached}.`;
    const limited = limitTextOutput(compactText(rawText, args, summaryText), args);
    const contentBlock = { type: "text", text: limited.text };
    return {
        content: [contentBlock],
        structuredContent: applyOutputMode({ content: limited.text, tree: treeData, summary: { ...summary, ...formatTruncationStructured(limited) } }, args, ['tree'])
    };
});
server.registerTool("move_file", {
    title: "Move File",
    description: "Move or rename files and directories. Can move files between directories " +
        "and rename them in a single operation. If the destination exists, the " +
        "operation will fail. Use dryRun=true first for risky moves to verify source, destination, and parent directory checks. " +
        "Works across different directories and can be used for simple renaming within the same directory. " +
        "K filesystem MCP runs in global local filesystem mode.",
    inputSchema: MoveFileArgsSchema.shape,
    outputSchema: {
        content: z.string(),
        changed: z.boolean(),
        dryRun: z.boolean(),
        source: z.string(),
        destination: z.string(),
        source_exists: z.boolean(),
        destination_exists: z.boolean(),
        source_exists_before: z.boolean(),
        destination_exists_before: z.boolean(),
        destination_parent_exists: z.boolean(),
        destination_parent_exists_before: z.boolean(),
        elapsed_ms: z.number().optional(),
        errors: z.record(z.any()).nullable().optional(),
        suggested_action: z.string().nullable().optional(),
        ...StructuredErrorOutputSchema
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false }
}, async (args) => {
    const startedAt = Date.now();
    args = normalizeDryRun(args);
    const sourcePath = path.resolve(args.source);
    const destinationPath = path.resolve(args.destination);
    let sourceExists = false;
    let destinationExists = false;
    let destinationParentExists = false;
    let validSourcePath = sourcePath;
    let validDestPath = destinationPath;
    try {
        validSourcePath = await validatePath(args.source);
        sourceExists = true;
    }
    catch (error) {
        return makeOperationFailureResponse(makeCodedError(`Source does not exist or is not accessible: ${args.source}. ${error instanceof Error ? error.message : String(error)}`, 'SOURCE_NOT_ACCESSIBLE', 'MoveFileGuardError'), {
            source: path.resolve(args.source),
            destination: destinationPath,
            dryRun: Boolean(args.dryRun),
            source_exists: false,
            destination_exists: false,
            source_exists_before: false,
            destination_exists_before: false,
            destination_parent_exists: false,
            destination_parent_exists_before: false,
            elapsed_ms: Date.now() - startedAt,
            errors: summarizeOperationErrors(error)
        });
    }
    try {
        await fs.access(destinationPath);
        destinationExists = true;
    }
    catch { }
    const destinationParent = path.dirname(destinationPath);
    try {
        await fs.access(destinationParent);
        destinationParentExists = true;
    }
    catch { }
    if (destinationExists) {
        return makeOperationFailureResponse(makeCodedError(`Destination already exists: ${args.destination}`, 'DESTINATION_EXISTS', 'MoveFileGuardError'), {
            source: validSourcePath,
            destination: destinationPath,
            dryRun: Boolean(args.dryRun),
            source_exists: sourceExists,
            destination_exists: true,
            source_exists_before: sourceExists,
            destination_exists_before: true,
            destination_parent_exists: destinationParentExists,
            destination_parent_exists_before: destinationParentExists,
            elapsed_ms: Date.now() - startedAt,
            errors: null
        });
    }
    if (!destinationParentExists) {
        return makeOperationFailureResponse(makeCodedError(`Destination parent directory does not exist: ${destinationParent}`, 'DESTINATION_PARENT_MISSING', 'MoveFileGuardError'), {
            source: validSourcePath,
            destination: destinationPath,
            dryRun: Boolean(args.dryRun),
            source_exists: sourceExists,
            destination_exists: false,
            source_exists_before: sourceExists,
            destination_exists_before: false,
            destination_parent_exists: false,
            destination_parent_exists_before: false,
            elapsed_ms: Date.now() - startedAt,
            errors: null
        });
    }
    validDestPath = await validatePath(args.destination);
    const structuredBase = {
        changed: !args.dryRun,
        dryRun: Boolean(args.dryRun),
        source: validSourcePath,
        destination: validDestPath,
        source_exists: sourceExists,
        destination_exists: destinationExists,
        source_exists_before: sourceExists,
        destination_exists_before: destinationExists,
        destination_parent_exists: destinationParentExists,
        destination_parent_exists_before: destinationParentExists,
        elapsed_ms: Date.now() - startedAt,
        errors: null,
        suggested_action: null
    };
    if (args.dryRun) {
        const text = `Dry run: would move ${args.source} to ${args.destination}`;
        return {
            content: [{ type: "text", text }],
            structuredContent: { content: text, ...structuredBase, changed: false }
        };
    }
    try {
        await fs.rename(validSourcePath, validDestPath);
    }
    catch (error) {
        const sourceStillExists = await pathExists(validSourcePath);
        const destinationNowExists = await pathExists(validDestPath);
        const isCrossDevice = typeof error === 'object' && error !== null && 'code' in error && error.code === 'EXDEV';
        const failureError = isCrossDevice
            ? makeCodedError(`Move failed across devices or volumes: ${validSourcePath} -> ${validDestPath}`, 'CROSS_DEVICE_MOVE_UNSUPPORTED', 'MoveFileError')
            : error;
        return makeOperationFailureResponse(failureError, {
            ...structuredBase,
            changed: destinationNowExists && !sourceStillExists,
            source_exists: sourceStillExists,
            destination_exists: destinationNowExists,
            elapsed_ms: Date.now() - startedAt,
            errors: summarizeOperationErrors(error),
            suggested_action: isCrossDevice ? 'Use copy_path followed by remove_path after verifying the copy when cross-device move is intended.' : null
        });
    }
    const text = `Successfully moved ${args.source} to ${args.destination}`;
    const contentBlock = { type: "text", text };
    return {
        content: [contentBlock],
        structuredContent: { content: text, ...structuredBase, elapsed_ms: Date.now() - startedAt, errors: null, source_exists: false, destination_exists: true }
    };
});
server.registerTool("copy_path", {
    title: "Copy Path",
    description: "Copy a file or directory. Defaults to refusing existing destinations. " +
        "Use dryRun=true first for risky copies. Directory copies require recursive=true. " +
        "Directory dry runs report entry/file/directory/byte counts, truncation state, and sample entries. " +
        "Real recursive directory copies are preflight-bounded by max_entries and timeout_ms before copying starts; timeout_ms=0 disables the preflight timeout. " +
        "Copy failures return elapsed_ms, partial, and compressed errors. Use create_parent_dirs=true only when missing destination parents should be created. overwrite=true is only allowed for file-to-file replacement; existing directory destinations are refused to avoid accidental directory merges. " +
        "Returns structured source/destination preflight and copy status. K filesystem MCP runs in global local filesystem mode.",
    inputSchema: CopyPathArgsSchema.shape,
    outputSchema: {
        content: z.string(),
        changed: z.boolean(),
        dryRun: z.boolean(),
        action: z.string(),
        source: z.string(),
        destination: z.string(),
        source_type: z.string(),
        destination_type: z.string(),
        destination_exists: z.boolean(),
        destination_exists_before: z.boolean(),
        destination_parent_exists: z.boolean(),
        destination_parent_exists_before: z.boolean(),
        recursive: z.boolean(),
        overwrite: z.boolean(),
        create_parent_dirs: z.boolean(),
        preserve_timestamps: z.boolean(),
        max_entries: z.number().optional(),
        timeout_ms: z.number().optional(),
        elapsed_ms: z.number().optional(),
        timed_out: z.boolean().optional(),
        partial: z.boolean().optional(),
        preview_entries: z.number().optional(),
        preview_max_entries: z.number().optional(),
        entries: z.number().optional(),
        files: z.number().optional(),
        directories: z.number().optional(),
        bytes: z.number().optional(),
        truncated: z.boolean().optional(),
        sample_entries: z.array(z.string()).optional(),
        errors: z.record(z.any()).nullable().optional(),
        ...StructuredErrorOutputSchema
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false }
}, async (args) => {
    const startedAt = Date.now();
    args = normalizeDryRun(args);
    const validSourcePath = await validatePath(args.source);
    const sourceType = await getPathType(validSourcePath);
    if (sourceType === 'directory' && !args.recursive) {
        return makeOperationFailureResponse(makeCodedError(`Source is a directory. Pass recursive: true to copy directories: ${args.source}`, 'RECURSIVE_REQUIRED', 'CopyPathGuardError'), {
            dryRun: Boolean(args.dryRun),
            action: 'copy_directory',
            source: validSourcePath,
            destination: path.resolve(args.destination),
            source_type: sourceType,
            destination_type: 'unknown',
            destination_exists: false,
            destination_exists_before: false,
            destination_parent_exists: false,
            destination_parent_exists_before: false,
            recursive: false,
            overwrite: Boolean(args.overwrite),
            create_parent_dirs: Boolean(args.create_parent_dirs),
            preserve_timestamps: Boolean(args.preserve_timestamps),
            max_entries: args.max_entries,
            timeout_ms: args.timeout_ms,
            elapsed_ms: Date.now() - startedAt,
            partial: false
        });
    }
    const destinationPath = path.isAbsolute(args.destination)
        ? path.resolve(args.destination)
        : path.resolve(process.cwd(), args.destination);
    const destinationParent = path.dirname(destinationPath);
    const destinationExists = await pathExists(destinationPath);
    const destinationType = destinationExists ? await getPathType(destinationPath) : 'missing';
    const destinationParentExists = await pathExists(destinationParent);
    if (destinationExists && !args.overwrite) {
        return makeOperationFailureResponse(makeCodedError(`Destination already exists: ${args.destination}. Pass overwrite: true to replace it.`, 'DESTINATION_EXISTS', 'CopyPathGuardError'), {
            dryRun: Boolean(args.dryRun),
            action: sourceType === 'directory' ? 'copy_directory' : 'copy_file',
            source: validSourcePath,
            destination: destinationPath,
            source_type: sourceType,
            destination_type: destinationType,
            destination_exists: true,
            destination_exists_before: true,
            destination_parent_exists: destinationParentExists,
            destination_parent_exists_before: destinationParentExists,
            recursive: Boolean(args.recursive),
            overwrite: Boolean(args.overwrite),
            create_parent_dirs: Boolean(args.create_parent_dirs),
            preserve_timestamps: Boolean(args.preserve_timestamps),
            max_entries: args.max_entries,
            timeout_ms: args.timeout_ms,
            elapsed_ms: Date.now() - startedAt,
            partial: false
        });
    }
    if (destinationExists && args.overwrite && (sourceType === 'directory' || destinationType === 'directory')) {
        return makeOperationFailureResponse(makeCodedError(`Refusing to overwrite or merge directories with copy_path: source type is ${sourceType}, destination type is ${destinationType}. Choose a new destination or handle the directory replacement explicitly outside copy_path.`, 'DIRECTORY_OVERWRITE_REFUSED', 'CopyPathGuardError'), {
            dryRun: Boolean(args.dryRun),
            action: sourceType === 'directory' ? 'copy_directory' : 'copy_file',
            source: validSourcePath,
            destination: destinationPath,
            source_type: sourceType,
            destination_type: destinationType,
            destination_exists: true,
            destination_exists_before: true,
            destination_parent_exists: destinationParentExists,
            destination_parent_exists_before: destinationParentExists,
            recursive: Boolean(args.recursive),
            overwrite: Boolean(args.overwrite),
            create_parent_dirs: Boolean(args.create_parent_dirs),
            preserve_timestamps: Boolean(args.preserve_timestamps),
            max_entries: args.max_entries,
            timeout_ms: args.timeout_ms,
            elapsed_ms: Date.now() - startedAt,
            partial: false
        });
    }
    if (!destinationParentExists && !args.create_parent_dirs) {
        return makeOperationFailureResponse(makeCodedError(`Destination parent directory does not exist: ${destinationParent}. Pass create_parent_dirs: true to create it.`, 'DESTINATION_PARENT_MISSING', 'CopyPathGuardError'), {
            dryRun: Boolean(args.dryRun),
            action: sourceType === 'directory' ? 'copy_directory' : 'copy_file',
            source: validSourcePath,
            destination: destinationPath,
            source_type: sourceType,
            destination_type: destinationType,
            destination_exists: destinationExists,
            destination_exists_before: destinationExists,
            destination_parent_exists: false,
            destination_parent_exists_before: false,
            recursive: Boolean(args.recursive),
            overwrite: Boolean(args.overwrite),
            create_parent_dirs: Boolean(args.create_parent_dirs),
            preserve_timestamps: Boolean(args.preserve_timestamps),
            max_entries: args.max_entries,
            timeout_ms: args.timeout_ms,
            elapsed_ms: Date.now() - startedAt,
            partial: false
        });
    }
    const validDestinationPath = await validatePath(args.destination, { allowMissingParent: args.create_parent_dirs });
    const structured = {
        changed: !args.dryRun,
        dryRun: Boolean(args.dryRun),
        action: sourceType === 'directory' ? 'copy_directory' : 'copy_file',
        source: validSourcePath,
        destination: validDestinationPath,
        source_type: sourceType,
        destination_type: destinationType,
        destination_exists: destinationExists,
        destination_exists_before: destinationExists,
        destination_parent_exists: destinationParentExists,
        destination_parent_exists_before: destinationParentExists,
        recursive: Boolean(args.recursive),
        overwrite: Boolean(args.overwrite),
        create_parent_dirs: Boolean(args.create_parent_dirs),
        preserve_timestamps: Boolean(args.preserve_timestamps),
        max_entries: args.max_entries,
        timeout_ms: args.timeout_ms
    };
    if (args.dryRun) {
        let preview = {};
        let detail = '';
        if (sourceType === 'directory') {
            let summary;
            const signal = createCancellationSignal();
            try {
                summary = await withTimeout(collectPathSummary(validSourcePath, args.preview_max_entries, args.preview_entries, signal), args.timeout_ms, () => makeTimeoutError(`Timed out while previewing directory copy source after ${args.timeout_ms} ms: ${args.source}`, 'COPY_PREFLIGHT_TIMEOUT', 'CopyPathTimeoutError'), signal);
            }
            catch (error) {
                const partialSummary = signal.partial_summary ?? null;
                return makeOperationFailureResponse(error, {
                    ...structured,
                    elapsed_ms: Date.now() - startedAt,
                    timed_out: error instanceof Error && error.name === 'CopyPathTimeoutError',
                    partial: Boolean(partialSummary),
                    entries: partialSummary?.entries,
                    files: partialSummary?.files,
                    directories: partialSummary?.directories,
                    bytes: partialSummary?.bytes,
                    truncated: partialSummary ? true : undefined,
                    sample_entries: partialSummary?.sample_entries,
                    errors: summarizeOperationErrors(error)
                });
            }
            preview = {
                preview_entries: args.preview_entries,
                preview_max_entries: args.preview_max_entries,
                entries: summary.entries,
                files: summary.files,
                directories: summary.directories,
                bytes: summary.bytes,
                truncated: summary.truncated,
                sample_entries: summary.sample_entries
            };
            detail = ` (${summary.entries} entries: ${summary.files} files, ${summary.directories} directories, ${formatSize(summary.bytes)}${summary.truncated ? ', preview truncated' : ''})`;
        }
        const text = `Dry run: would copy ${args.source} to ${args.destination}${detail}`;
        return {
            content: [{ type: "text", text }],
            structuredContent: { content: text, ...structured, ...preview, changed: false, elapsed_ms: Date.now() - startedAt, timed_out: false, partial: false }
        };
    }
    let copySummary = null;
    if (sourceType === 'directory') {
        const signal = createCancellationSignal();
        try {
            copySummary = await withTimeout(collectPathSummary(validSourcePath, args.max_entries, 0, signal), args.timeout_ms, () => makeTimeoutError(`Timed out while checking directory copy source after ${args.timeout_ms} ms: ${args.source}`, 'COPY_PREFLIGHT_TIMEOUT', 'CopyPathTimeoutError'), signal);
        }
        catch (error) {
            const partialSummary = signal.partial_summary ?? null;
            return makeOperationFailureResponse(error, {
                ...structured,
                elapsed_ms: Date.now() - startedAt,
                timed_out: error instanceof Error && error.name === 'CopyPathTimeoutError',
                partial: Boolean(partialSummary),
                entries: partialSummary?.entries,
                files: partialSummary?.files,
                directories: partialSummary?.directories,
                bytes: partialSummary?.bytes,
                truncated: partialSummary ? true : undefined,
                errors: summarizeOperationErrors(error)
            });
        }
        if (copySummary.truncated || copySummary.entries > args.max_entries) {
            return makeOperationFailureResponse(makeCodedError(`Refusing to copy ${args.source}: entry count exceeds max_entries ${args.max_entries}. Run a dry run, narrow the source, or increase max_entries only after review.`, 'MAX_ENTRIES_EXCEEDED', 'CopyPathGuardError'), {
                ...structured,
                elapsed_ms: Date.now() - startedAt,
                timed_out: false,
                partial: false,
                entries: copySummary.entries,
                files: copySummary.files,
                directories: copySummary.directories,
                bytes: copySummary.bytes,
                truncated: copySummary.truncated
            });
        }
    }
    if (args.create_parent_dirs) {
        await fs.mkdir(destinationParent, { recursive: true });
    }
    try {
        await fs.cp(validSourcePath, validDestinationPath, {
            recursive: sourceType === 'directory',
            force: Boolean(args.overwrite),
            errorOnExist: !args.overwrite,
            preserveTimestamps: Boolean(args.preserve_timestamps)
        });
    }
    catch (error) {
        return makeOperationFailureResponse(error, {
            ...structured,
            elapsed_ms: Date.now() - startedAt,
            timed_out: false,
            partial: true,
            entries: copySummary?.entries,
            files: copySummary?.files,
            directories: copySummary?.directories,
            bytes: copySummary?.bytes,
            errors: summarizeOperationErrors(error)
        });
    }
    const text = `Successfully copied ${args.source} to ${args.destination}`;
    return {
        content: [{ type: "text", text }],
        structuredContent: {
            content: text,
            ...structured,
            destination_exists: true,
            destination_parent_exists: true,
            elapsed_ms: Date.now() - startedAt,
            timed_out: false,
            partial: false,
            entries: copySummary?.entries,
            files: copySummary?.files,
            directories: copySummary?.directories,
            bytes: copySummary?.bytes,
            errors: null
        }
    };
});
server.registerTool("remove_path", {
    title: "Remove Path",
    description: "Preview or remove a file or directory. Defaults to dryRun=true and should be previewed before real deletion. " +
        "Non-empty directories require recursive=true. Recursive removals are bounded by max_entries to avoid accidental large deletes. " +
        "Dry-run previews include entry/file/directory/byte counts and sample_entries for review. Preflight traversal supports timeout_ms and returns elapsed_ms, timed_out, partial, and compressed errors. " +
        "Use allow_missing=true only when a missing path should be a no-op. K filesystem MCP runs in global local filesystem mode.",
    inputSchema: RemovePathArgsSchema.shape,
    outputSchema: {
        content: z.string(),
        changed: z.boolean(),
        dryRun: z.boolean(),
        path: z.string(),
        existed: z.boolean(),
        type: z.string().nullable(),
        recursive: z.boolean(),
        max_entries: z.number(),
        timeout_ms: z.number().optional(),
        elapsed_ms: z.number().optional(),
        timed_out: z.boolean().optional(),
        partial: z.boolean().optional(),
        entries: z.number(),
        files: z.number(),
        directories: z.number(),
        bytes: z.number(),
        sample_entries: z.array(z.string()),
        truncated: z.boolean(),
        errors: z.record(z.any()).nullable().optional(),
        ...StructuredErrorOutputSchema
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true }
}, async (args) => {
    const startedAt = Date.now();
    args = normalizeDryRun(args);
    let validPath;
    try {
        validPath = await validatePath(args.path);
    }
    catch (error) {
        if (args.allow_missing) {
            const text = `Path does not exist; no-op: ${args.path}`;
            return {
                content: [{ type: "text", text }],
                structuredContent: {
                    content: text,
                    changed: false,
                    dryRun: Boolean(args.dryRun),
                    path: path.resolve(args.path),
                    existed: false,
                    type: null,
                    recursive: Boolean(args.recursive),
                    max_entries: args.max_entries,
                    timeout_ms: args.timeout_ms,
                    elapsed_ms: Date.now() - startedAt,
                    timed_out: false,
                    partial: false,
                    entries: 0,
                    files: 0,
                    directories: 0,
                    bytes: 0,
                    sample_entries: [],
                    truncated: false,
                    errors: null
                }
            };
        }
        return makeOperationFailureResponse(makeCodedError(`Path does not exist or is not accessible: ${args.path}. ${error instanceof Error ? error.message : String(error)}`, 'PATH_NOT_ACCESSIBLE', 'RemovePathGuardError'), {
            dryRun: Boolean(args.dryRun),
            path: path.resolve(args.path),
            existed: false,
            type: null,
            recursive: Boolean(args.recursive),
            max_entries: args.max_entries,
            timeout_ms: args.timeout_ms,
            elapsed_ms: Date.now() - startedAt,
            timed_out: false,
            partial: false,
            entries: 0,
            files: 0,
            directories: 0,
            bytes: 0,
            sample_entries: [],
            truncated: false,
            errors: summarizeOperationErrors(error)
        });
    }
    let summary;
    const signal = createCancellationSignal();
    try {
        summary = await withTimeout(collectRemovalSummary(validPath, args.max_entries, args.dryRun ? args.sample_entries : 0, signal), args.timeout_ms, () => makeTimeoutError(`Timed out while checking removal target after ${args.timeout_ms} ms: ${args.path}`, 'REMOVE_PREFLIGHT_TIMEOUT', 'RemovePathTimeoutError'), signal);
    }
    catch (error) {
        const partialSummary = signal.partial_summary ?? {
            type: null,
            entries: 0,
            files: 0,
            directories: 0,
            bytes: 0,
            sample_entries: [],
            truncated: true
        };
        return makeOperationFailureResponse(error, {
            dryRun: Boolean(args.dryRun),
            path: validPath,
            existed: true,
            type: partialSummary.type,
            recursive: Boolean(args.recursive),
            max_entries: args.max_entries,
            timeout_ms: args.timeout_ms,
            elapsed_ms: Date.now() - startedAt,
            timed_out: error instanceof Error && error.name === 'RemovePathTimeoutError',
            partial: true,
            entries: partialSummary.entries,
            files: partialSummary.files,
            directories: partialSummary.directories,
            bytes: partialSummary.bytes,
            sample_entries: partialSummary.sample_entries,
            truncated: true,
            errors: summarizeOperationErrors(error)
        });
    }
    if (summary.truncated || summary.entries > args.max_entries) {
        return makeOperationFailureResponse(makeCodedError(`Refusing to remove ${args.path}: entry count exceeds max_entries ${args.max_entries}. Narrow the target or increase max_entries only after review.`, 'MAX_ENTRIES_EXCEEDED', 'RemovePathGuardError'), {
            dryRun: Boolean(args.dryRun),
            path: validPath,
            existed: true,
            type: summary.type,
            recursive: Boolean(args.recursive),
            max_entries: args.max_entries,
            timeout_ms: args.timeout_ms,
            elapsed_ms: Date.now() - startedAt,
            timed_out: false,
            partial: false,
            entries: summary.entries,
            files: summary.files,
            directories: summary.directories,
            bytes: summary.bytes,
            sample_entries: summary.sample_entries,
            truncated: summary.truncated,
            errors: null
        });
    }
    if (summary.type === 'directory' && summary.entries > 1 && !args.recursive) {
        return makeOperationFailureResponse(makeCodedError(`Refusing to remove non-empty directory without recursive=true: ${args.path}`, 'RECURSIVE_REQUIRED', 'RemovePathGuardError'), {
            dryRun: Boolean(args.dryRun),
            path: validPath,
            existed: true,
            type: summary.type,
            recursive: false,
            max_entries: args.max_entries,
            timeout_ms: args.timeout_ms,
            elapsed_ms: Date.now() - startedAt,
            timed_out: false,
            partial: false,
            entries: summary.entries,
            files: summary.files,
            directories: summary.directories,
            bytes: summary.bytes,
            sample_entries: summary.sample_entries,
            truncated: summary.truncated,
            errors: null
        });
    }
    const structured = {
        changed: !args.dryRun,
        dryRun: Boolean(args.dryRun),
        path: validPath,
        existed: true,
        type: summary.type,
        recursive: Boolean(args.recursive),
        max_entries: args.max_entries,
        timeout_ms: args.timeout_ms,
        elapsed_ms: Date.now() - startedAt,
        timed_out: false,
        partial: false,
        entries: summary.entries,
        files: summary.files,
        directories: summary.directories,
        bytes: summary.bytes,
        sample_entries: summary.sample_entries,
        truncated: summary.truncated,
        errors: null
    };
    if (args.dryRun) {
        const sampleText = summary.sample_entries.length > 0 ? `; samples: ${summary.sample_entries.join(', ')}` : '';
        const text = `Dry run: would remove ${validPath} (${summary.entries} entries: ${summary.files} files, ${summary.directories} directories, ${formatSize(summary.bytes)}${sampleText})`;
        return {
            content: [{ type: "text", text }],
            structuredContent: { content: text, ...structured, changed: false }
        };
    }
    try {
        await fs.rm(validPath, {
            recursive: summary.type === 'directory' && Boolean(args.recursive),
            force: false
        });
    }
    catch (error) {
        return makeOperationFailureResponse(error, {
            ...structured,
            elapsed_ms: Date.now() - startedAt,
            timed_out: false,
            partial: true,
            errors: summarizeOperationErrors(error)
        });
    }
    const text = `Successfully removed ${validPath} (${summary.entries} entries: ${summary.files} files, ${summary.directories} directories)`;
    return {
        content: [{ type: "text", text }],
        structuredContent: { content: text, ...structured }
    };
});
server.registerTool("search_files", {
    title: "Search Files",
    description: "Use to find unknown file or directory paths by name/glob. Prefer this over PowerShell Get-ChildItem or directory_tree when locating files. " +
        "Uses ripgrep --files for fast file discovery by default and returns relative paths, one per line plus structured results and summary. Supports glob/pattern, excludePatterns, " +
        "limit, max_depth, timeout_ms, default_excludes, hidden, no_ignore, follow_symlinks, compact/output_mode, max_lines, and max_chars. Timed-out searches return partial results with timed_out, searched_ms, structured suggested_retry, suggested_retry_text, and compressed warnings. default_excludes is opt-in and reported in summary. Use directory_only only for bounded directory discovery; directory_strategy='walk' is accurate and preserves empty directories, while directory_strategy='rg_derived' is faster but may omit empty or ignored-only directories. Use search_text when searching file contents.",
    inputSchema: SearchFilesArgsSchema.shape,
    outputSchema: {
        content: z.string(),
        results: z.array(z.string()).optional(),
        summary: z.object({
            result_count: z.number(),
            limit: z.number(),
            stopped_by_limit: z.boolean(),
            timed_out: z.boolean().optional(),
            timeout_ms: z.number().optional(),
            searched_ms: z.number().optional(),
            partial: z.boolean().optional(),
            default_excludes: z.boolean().optional(),
            applied_default_excludes: z.array(z.string()).optional(),
            warnings: z.record(z.any()).nullable().optional(),
            suggested_retry: z.record(z.any()).nullable().optional(),
            suggested_retry_text: z.string().nullable().optional(),
            directory_strategy: z.string().optional(),
            derived_from_files: z.boolean().optional(),
            source_file_count: z.number().optional(),
            directory_source_limit: z.number().optional(),
            source_stopped_by_limit: z.boolean().optional(),
            source_timed_out: z.boolean().optional(),
            completeness_note: z.string().optional(),
            ...TextTruncationOutputSchema
        }).optional()
    },
    annotations: { readOnlyHint: true }
}, async (args) => {
    const validPath = await validatePath(args.path);
    if (args.file_only && args.directory_only) {
        throw new Error("file_only and directory_only cannot both be true");
    }
    const pattern = args.glob ?? args.pattern;
    let searchResult;
    if (args.directory_only) {
        const startedAt = Date.now();
        const timeoutMs = args.timeout_ms ?? DEFAULT_SEARCH_TIMEOUT_MS;
        if (args.directory_strategy === 'rg_derived') {
            const sourceLimit = args.directory_source_limit ?? Math.min(Math.max(args.limit * 20, args.limit), 50000);
            const fileSearch = await runRipgrepFiles(validPath, {
                ...args,
                glob: undefined,
                pattern: undefined,
                limit: sourceLimit
            });
            const derived = deriveDirectorySearchFromFiles(fileSearch.results, {
                ...args,
                glob: pattern,
                excludePatterns: [...getAppliedSearchExcludePatterns(args), ...(args.excludePatterns ?? [])]
            });
            searchResult = {
                results: derived.results,
                summary: {
                    result_count: derived.results.length,
                    source_file_count: fileSearch.results.length,
                    directory_source_limit: sourceLimit,
                    source_stopped_by_limit: fileSearch.summary.stopped_by_limit,
                    source_timed_out: fileSearch.summary.timed_out,
                    limit: args.limit,
                    stopped_by_limit: derived.stoppedByLimit || fileSearch.summary.stopped_by_limit,
                    timed_out: fileSearch.summary.timed_out,
                    timeout_ms: timeoutMs,
                    searched_ms: Date.now() - startedAt,
                    partial: true,
                    default_excludes: args.default_excludes === true,
                    applied_default_excludes: getAppliedSearchExcludePatterns(args),
                    warnings: fileSearch.summary.warnings,
                    directory_strategy: 'rg_derived',
                    derived_from_files: true,
                    completeness_note: 'Fast directory list derived from rg --files; empty directories and ignored-only directories may be missing.'
                }
            };
        }
        else {
            const signal = createCancellationSignal();
            let entries = [];
            let timedOut = false;
            try {
                const directoryArgs = {
                    glob: pattern,
                    excludePatterns: [...getAppliedSearchExcludePatterns(args), ...(args.excludePatterns ?? [])],
                    max_depth: args.max_depth ?? 10,
                    limit: args.limit,
                    directory_only: true
                };
                const directorySearch = collectDirectoryEntries(validPath, directoryArgs, false, signal);
                entries = await withTimeout(directorySearch, timeoutMs, () => makeTimeoutError(`Timed out while searching directories after ${timeoutMs} ms: ${args.path}`, 'SEARCH_FILES_TIMEOUT', 'SearchFilesTimeoutError'), signal);
            }
            catch (error) {
                if (!(error instanceof Error) || error.name !== 'SearchFilesTimeoutError') {
                    throw error;
                }
                timedOut = true;
                entries = signal.partial_entries ?? [];
            }
            const results = entries.map((entry) => entry.relativePath);
            searchResult = {
                results,
                summary: {
                    result_count: results.length,
                    limit: args.limit,
                    stopped_by_limit: results.length >= args.limit,
                    timed_out: timedOut,
                    timeout_ms: timeoutMs,
                    searched_ms: Date.now() - startedAt,
                    partial: timedOut || results.length >= args.limit,
                    default_excludes: args.default_excludes === true,
                    applied_default_excludes: getAppliedSearchExcludePatterns(args),
                    warnings: null,
                    directory_strategy: 'walk',
                    derived_from_files: false
                }
            };
        }
        searchResult.summary.suggested_retry = makeSearchSuggestedRetry(searchResult.summary);
        searchResult.summary.suggested_retry_text = makeSearchSuggestedRetryText(searchResult.summary.suggested_retry);
    }
    else {
        searchResult = await runRipgrepFiles(validPath, {
            ...args,
            glob: pattern
        });
    }
    const fullText = searchResult.results.length > 0 ? searchResult.results.join("\n") : "No matches found";
    const summaryText = `Found ${searchResult.summary.result_count} path(s); limit=${searchResult.summary.limit}; stopped_by_limit=${searchResult.summary.stopped_by_limit}.`;
    const limited = limitTextOutput(compactText(fullText, args, summaryText), args);
    return {
        content: [{ type: "text", text: limited.text }],
        structuredContent: applyOutputMode({ content: limited.text, results: searchResult.results, summary: { ...searchResult.summary, ...formatTruncationStructured(limited) } }, args, ['results'])
    };
});
server.registerTool("search_text", {
    title: "Search Text",
    description: "Use to search file contents. Prefer this over PowerShell Select-String or raw rg for repo inspection. " +
        "For small or scoped searches, use normal mode with path, pattern, glob, excludePatterns, context_before/context_after or context, and max_results; normal mode returns structured results and summary. " +
        "Use timeout_ms to bound broad normal searches; timed-out searches return partial results with timed_out, searched_ms, structured suggested_retry, suggested_retry_text, and compressed warnings. Use default_excludes=true only when skipping common high-noise directories is acceptable; applied excludes are reported in summary. Use output_mode=files to quickly locate matching paths, output_mode=count for per-file counts, type to narrow by file type when cheaper than a glob, max_match_chars to cap long matching lines, hidden/no_ignore/follow_symlinks to explicitly broaden rg coverage, and compact/output_mode to reduce duplicated output. " +
        "For very large repositories or when complete coverage matters, set sharded=true; use shard_concurrency=2-4 for local SSD repositories when speed matters and keep 1-2 for network drives. Sharded mode returns JSON with completed, timed_out, " +
        "stopped_by_max_results, shard_concurrency, searched_shards, partial_shards, failed_shards, and remaining_shards. If completed is false, do not conclude absence. " +
        "Use search_files instead when looking for file names or paths. K filesystem MCP searches in global local filesystem mode.",
    inputSchema: SearchTextArgsSchema.shape,
    outputSchema: {
        content: z.string(),
        results: z.array(z.record(z.any())).optional(),
        summary: z.record(z.any()).optional()
    },
    annotations: { readOnlyHint: true }
}, async (args) => {
    const normalizedArgs = normalizeSearchArgs(args);
    const validPath = await validatePath(normalizedArgs.path);
    if (normalizedArgs.sharded) {
        const output = await runShardedRipgrepSearch(validPath, normalizedArgs);
        const fullText = JSON.stringify(output, null, 2);
        const summaryText = `Search ${output.summary.completed ? 'completed' : 'incomplete'} in ${output.summary.searched_shards.length}/${output.summary.shard_count} shard(s); results=${output.summary.result_count}; mode=${output.summary.mode}.`;
        const limited = limitTextOutput(compactText(fullText, normalizedArgs, summaryText), normalizedArgs);
        return {
            content: [{ type: "text", text: limited.text }],
            structuredContent: applyOutputMode({ content: limited.text, ...output, summary: { ...output.summary, ...formatTruncationStructured(limited) } }, normalizedArgs, ['results'])
        };
    }
    const searchResult = await runRipgrepSearch(validPath, normalizedArgs);
    const fullText = formatSearchTextResults(searchResult.results);
    const summaryText = `Found ${searchResult.summary.result_count} result(s); mode=${searchResult.summary.mode}; stopped_by_max_results=${searchResult.summary.stopped_by_max_results}.`;
    const limited = limitTextOutput(compactText(fullText, normalizedArgs, summaryText), normalizedArgs);
    return {
        content: [{ type: "text", text: limited.text }],
        structuredContent: applyOutputMode({ content: limited.text, results: searchResult.results, summary: { ...searchResult.summary, ...formatTruncationStructured(limited) } }, normalizedArgs, ['results'])
    };
});
server.registerTool("get_file_info", {
    title: "Get File Info",
    description: "Retrieve detailed metadata about a file or directory. Returns comprehensive " +
        "information including size, creation time, last modified time, permissions, " +
        "and type as structured fields. This tool is perfect for understanding file characteristics " +
        "without reading the actual content. K filesystem MCP runs in global local filesystem mode.",
    inputSchema: GetFileInfoArgsSchema.shape,
    outputSchema: {
        content: z.string(),
        path: z.string(),
        resolved_path: z.string(),
        exists: z.boolean(),
        type: z.string(),
        size: z.number(),
        created: z.string(),
        modified: z.string(),
        accessed: z.string(),
        isDirectory: z.boolean(),
        isFile: z.boolean(),
        permissions: z.string(),
        error: z.string().nullable()
    },
    annotations: { readOnlyHint: true }
}, async (args) => {
    const validPath = await validatePath(args.path);
    const info = await getFileStats(validPath);
    const structured = serializeFileInfo(args.path, validPath, info);
    const text = JSON.stringify(structured, null, 2);
    return {
        content: [{ type: "text", text }],
        structuredContent: { content: text, ...structured }
    };
});
server.registerTool("get_multiple_file_info", {
    title: "Get Multiple File Info",
    description: "Retrieve metadata for several files or directories in one call. Prefer this over repeated get_file_info calls or PowerShell Get-Item loops. " +
        "Each result includes existence, type, size, timestamps, permissions, resolved path, and per-path error/error_type/code fields without failing the whole call. " +
        "Supports compact/output_mode, max_lines, and max_chars to keep output bounded. K filesystem MCP runs in global local filesystem mode.",
    inputSchema: GetMultipleFileInfoArgsSchema.shape,
    outputSchema: {
        content: z.string(),
        results: z.array(z.object({
            path: z.string(),
            resolved_path: z.string().nullable(),
            exists: z.boolean(),
            type: z.string().nullable(),
            size: z.number().nullable(),
            created: z.string().nullable(),
            modified: z.string().nullable(),
            accessed: z.string().nullable(),
            isDirectory: z.boolean().nullable(),
            isFile: z.boolean().nullable(),
            permissions: z.string().nullable(),
            ...StructuredErrorOutputSchema
        })),
        summary: z.object({
            requested: z.number(),
            found: z.number(),
            missing_or_error: z.number(),
            metadata_concurrency: z.number(),
            ...TextTruncationOutputSchema
        })
    },
    annotations: { readOnlyHint: true }
}, async (args) => {
    const metadataConcurrency = args.metadata_concurrency ?? 32;
    const results = await mapWithConcurrency(args.paths, metadataConcurrency, async (requestedPath) => {
        try {
            const validPath = await validatePath(requestedPath);
            const info = await getFileStats(validPath);
            return serializeFileInfo(requestedPath, validPath, info);
        }
        catch (error) {
            return {
                path: requestedPath,
                resolved_path: null,
                exists: false,
                type: null,
                size: null,
                created: null,
                modified: null,
                accessed: null,
                isDirectory: null,
                isFile: null,
                permissions: null,
                ...formatErrorStructured(error)
            };
        }
    });
    const summary = {
        requested: results.length,
        found: results.filter((result) => result.exists).length,
        missing_or_error: results.filter((result) => !result.exists).length,
        metadata_concurrency: metadataConcurrency
    };
    const rawText = JSON.stringify({ results, summary }, null, 2);
    const summaryText = `Metadata checked ${summary.requested} path(s): ${summary.found} found, ${summary.missing_or_error} missing/error.`;
    const limited = limitTextOutput(compactText(rawText, args, summaryText), args);
    return {
        content: [{ type: "text", text: limited.text }],
        structuredContent: applyOutputMode({ content: limited.text, results, summary: { ...summary, ...formatTruncationStructured(limited) } }, args, ['results'])
    };
});
server.registerTool("list_allowed_directories", {
    title: "List Access Mode",
    description: "Returns the filesystem access mode. K filesystem MCP runs in global mode and does not apply an internal allowed-directory allowlist.",
    inputSchema: {},
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true }
}, async () => {
    const text = "K filesystem MCP access mode: global local filesystem access. No internal allowed-directory allowlist is applied.";
    return {
        content: [{ type: "text", text }],
        structuredContent: { content: text }
    };
});
// Start server
async function runServer() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("K Filesystem MCP Server running on stdio with global filesystem access");
}
runServer().catch((error) => {
    console.error("Fatal error running server:", error);
    process.exit(1);
});
