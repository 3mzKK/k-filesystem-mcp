import fs from "fs/promises";
import path from "path";
import { randomBytes } from 'crypto';
import { createTwoFilesPatch } from 'diff';
import { normalizePath, expandHome } from './path-utils.js';
// Pure Utility Functions
export function formatSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0)
        return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    if (i < 0 || i === 0)
        return `${bytes} ${units[0]}`;
    const unitIndex = Math.min(i, units.length - 1);
    return `${(bytes / Math.pow(1024, unitIndex)).toFixed(2)} ${units[unitIndex]}`;
}
export function normalizeLineEndings(text) {
    return text.replace(/\r\n/g, '\n');
}
function detectNewlineStyle(text) {
    const crlfCount = (text.match(/\r\n/g) || []).length;
    const lfCount = (text.match(/(?<!\r)\n/g) || []).length;
    return crlfCount > lfCount ? '\r\n' : '\n';
}
function applyNewlineStyle(text, newline) {
    const normalized = normalizeLineEndings(text);
    return newline === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
}
function splitBom(text) {
    return text.charCodeAt(0) === 0xFEFF
        ? { hasBom: true, content: text.slice(1) }
        : { hasBom: false, content: text };
}
function addBomIfNeeded(text, hasBom) {
    return hasBom ? `\uFEFF${text}` : text;
}
async function readExistingTextFileWithFormat(filePath) {
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const { hasBom, content } = splitBom(rawContent);
    return {
        content,
        hasBom,
        newline: detectNewlineStyle(content)
    };
}
function truncateDiffLine(line, maxLineChars) {
    if (line.length <= maxLineChars) {
        return { line, omittedChars: 0 };
    }
    const marker = `[K MCP line truncated: omitted ${line.length - maxLineChars} chars]`;
    const keepChars = Math.max(0, maxLineChars - marker.length);
    return {
        line: `${line.slice(0, keepChars)}${marker}`,
        omittedChars: line.length - keepChars
    };
}
function limitDiffOutput(diff, options = {}) {
    const maxLines = options.maxLines ?? 200;
    const maxChars = options.maxChars ?? 20000;
    const maxLineChars = options.maxLineChars ?? 2000;
    const lines = diff.split('\n');
    const limitedLines = [];
    let omittedLines = 0;
    let omittedChars = 0;
    let currentChars = 0;
    let truncated = false;
    for (let i = 0; i < lines.length; i++) {
        if (limitedLines.length >= maxLines) {
            omittedLines = lines.length - i;
            omittedChars += Math.max(0, diff.length - currentChars);
            truncated = true;
            break;
        }
        const lineResult = truncateDiffLine(lines[i], maxLineChars);
        omittedChars += lineResult.omittedChars;
        let nextLine = lineResult.line;
        if (currentChars + nextLine.length > maxChars) {
            const remainingChars = Math.max(0, maxChars - currentChars);
            const marker = `[K MCP diff truncated: character limit reached; omitted ${diff.length - currentChars} chars. Increase max_diff_chars for more context.]`;
            const keepChars = Math.max(0, remainingChars - marker.length);
            if (keepChars > 0 || limitedLines.length === 0) {
                limitedLines.push(`${nextLine.slice(0, keepChars)}${marker}`);
            }
            omittedLines = lines.length - i - 1;
            omittedChars += Math.max(0, nextLine.length - keepChars) + lines.slice(i + 1).reduce((total, line) => total + line.length + 1, 0);
            truncated = true;
            break;
        }
        limitedLines.push(nextLine);
        currentChars += nextLine.length + 1;
        if (lineResult.omittedChars > 0) {
            truncated = true;
        }
    }
    if (omittedLines > 0) {
        limitedLines.push(`[K MCP diff truncated: omitted ${omittedLines} lines. Increase max_diff_lines for more context.]`);
    }
    return {
        diff: limitedLines.join('\n'),
        truncated,
        omittedLines,
        omittedChars
    };
}
export function createUnifiedDiff(originalContent, newContent, filepath = 'file', maxLinesOrOptions = 200, contextLines) {
    // Ensure consistent line endings for diff
    const normalizedOriginal = normalizeLineEndings(originalContent);
    const normalizedNew = normalizeLineEndings(newContent);
    const diffOptions = typeof maxLinesOrOptions === 'object'
        ? maxLinesOrOptions
        : { maxLines: maxLinesOrOptions, contextLines };
    const options = diffOptions.contextLines === undefined ? undefined : { context: diffOptions.contextLines };
    return limitDiffOutput(createTwoFilesPatch(filepath, filepath, normalizedOriginal, normalizedNew, 'original', 'modified', options), diffOptions);
}
function formatDiff(diff) {
    let numBackticks = 3;
    while (diff.includes('`'.repeat(numBackticks))) {
        numBackticks++;
    }
    return `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;
}
async function atomicWriteText(filePath, content) {
    const tempPath = `${filePath}.${randomBytes(16).toString('hex')}.tmp`;
    try {
        await fs.writeFile(tempPath, content, 'utf-8');
        await fs.rename(tempPath, filePath);
    }
    catch (error) {
        try {
            await fs.unlink(tempPath);
        }
        catch { }
        throw error;
    }
}
function findExactMatchIndexes(text, searchText, startOffset = 0, endOffset = text.length) {
    if (searchText.length === 0) {
        throw new Error('oldText cannot be empty');
    }
    const indexes = [];
    let index = text.indexOf(searchText, startOffset);
    while (index !== -1 && index + searchText.length <= endOffset) {
        indexes.push(index);
        index = text.indexOf(searchText, index + searchText.length);
    }
    return indexes;
}
function getLineOffsets(text) {
    const offsets = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            offsets.push(i + 1);
        }
    }
    return offsets;
}
function getEditRangeOffsets(text, edit) {
    const hasStart = edit.start_line !== undefined;
    const hasEnd = edit.end_line !== undefined;
    if (hasStart !== hasEnd) {
        throw new Error('start_line and end_line must be provided together');
    }
    if (!hasStart) {
        return { startOffset: 0, endOffset: text.length, startLineIndex: 0, endLineIndex: text.split('\n').length };
    }
    if (edit.start_line > edit.end_line) {
        throw new Error('start_line must be less than or equal to end_line');
    }
    const offsets = getLineOffsets(text);
    const lineCount = offsets.length;
    if (edit.start_line > lineCount) {
        throw new Error(`start_line ${edit.start_line} is beyond file line count ${lineCount}`);
    }
    const startLineIndex = edit.start_line - 1;
    const endLineIndex = Math.min(edit.end_line, lineCount);
    return {
        startOffset: offsets[startLineIndex],
        endOffset: endLineIndex < offsets.length ? offsets[endLineIndex] : text.length,
        startLineIndex,
        endLineIndex
    };
}
function findLineIndexForOffset(lineOffsets, offset) {
    let low = 0;
    let high = lineOffsets.length - 1;
    let result = 0;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (lineOffsets[mid] <= offset) {
            result = mid;
            low = mid + 1;
        }
        else {
            high = mid - 1;
        }
    }
    return result;
}
function findFlexibleLineMatches(contentLines, oldLines, startLineIndex, endLineIndex) {
    const matches = [];
    const maxStart = endLineIndex - oldLines.length;
    for (let i = startLineIndex; i <= maxStart; i++) {
        const potentialMatch = contentLines.slice(i, i + oldLines.length);
        const isMatch = oldLines.every((oldLine, j) => {
            const contentLine = potentialMatch[j];
            return oldLine.trim() === contentLine.trim();
        });
        if (isMatch) {
            matches.push(i);
        }
    }
    return matches;
}
export class EditFileMatchError extends Error {
    constructor(message, details) {
        super(message);
        this.name = 'EditFileMatchError';
        this.details = details;
    }
}
function previewText(text, maxChars = 80) {
    const normalized = normalizeLineEndings(text).replace(/\s+/g, ' ').trim();
    return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized;
}
function buildEditSearchPreview(edit) {
    if (edit.oldText !== undefined) {
        return previewText(edit.oldText);
    }
    const beforePreview = edit.beforeText !== undefined ? `before=${previewText(edit.beforeText, 30)}` : null;
    const afterPreview = edit.afterText !== undefined ? `after=${previewText(edit.afterText, 30)}` : null;
    const parts = [beforePreview, afterPreview].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : '';
}
function buildEditMatchDetails(edit, editIndex, actualCount, matchType) {
    const details = {
        edit_index: editIndex,
        edit_number: editIndex + 1,
        expected_occurrences: edit.expected_occurrences ?? 1,
        actual_occurrences: actualCount,
        match_type: matchType,
        match_mode: edit.match_mode ?? 'auto',
        anchor_mode: edit.anchor_mode ?? 'exact',
        start_line: edit.start_line ?? null,
        end_line: edit.end_line ?? null,
        search_preview: buildEditSearchPreview(edit)
    };
    if (matchType.startsWith('anchor-')) {
        if (edit.beforeText !== undefined) {
            details.beforeText_preview = previewText(edit.beforeText);
        }
        if (edit.afterText !== undefined) {
            details.afterText_preview = previewText(edit.afterText);
        }
    }
    else if (edit.oldText === undefined && details.search_preview === '') {
        details.search_preview = buildEditSearchPreview(edit);
    }
    return details;
}
function formatEditMatchErrorMessage(details) {
    const anchorMode = details.anchor_mode ? `; anchor_mode=${details.anchor_mode}` : '';
    const candidateLines = Array.isArray(details.candidate_lines) && details.candidate_lines.length > 0 ? `; candidate_lines=${details.candidate_lines.join(',')}` : '';
    return `Edit ${details.edit_number} match failed: expected ${details.expected_occurrences} occurrence(s), found ${details.actual_occurrences}; match_type=${details.match_type}; match_mode=${details.match_mode}${anchorMode}; lines=${details.start_line ?? 'any'}-${details.end_line ?? 'any'}${candidateLines}; search_preview="${details.search_preview}"`;
}
function assertExpectedOccurrences(edit, editIndex, actualCount, matchType) {
    const expected = edit.expected_occurrences ?? 1;
    if (actualCount !== expected) {
        const details = buildEditMatchDetails(edit, editIndex, actualCount, matchType);
        throw new EditFileMatchError(formatEditMatchErrorMessage(details), details);
    }
}
function throwEmptyEditTextError(edit, editIndex, fieldName, matchType) {
    const details = {
        ...buildEditMatchDetails(edit, editIndex, 0, matchType),
        code: fieldName === 'oldText' ? 'EMPTY_MATCH_TEXT' : 'EMPTY_ANCHOR_TEXT',
        empty_field: fieldName
    };
    throw new EditFileMatchError(`Edit ${details.edit_number} ${fieldName} cannot be empty; match_type=${matchType}; match_mode=${details.match_mode}; anchor_mode=${details.anchor_mode}; lines=${details.start_line ?? 'any'}-${details.end_line ?? 'any'}`, details);
}
function toAnchorCandidate(offset, length, lineOffsets) {
    const lineIndex = findLineIndexForOffset(lineOffsets, offset);
    const endOffset = offset + length;
    const endLineIndex = findLineIndexForOffset(lineOffsets, endOffset);
    return {
        startOffset: offset,
        endOffset,
        start_line: lineIndex + 1,
        end_line: endLineIndex + 1
    };
}
function summarizeAnchorCandidates(candidates, limit = 5) {
    const limited = candidates.slice(0, limit);
    const summary = {
        candidate_count: candidates.length,
        candidate_lines: limited.map((candidate) => candidate.start_line),
        candidates_truncated: candidates.length > limit
    };
    if (limited.some((candidate) => candidate.start_line !== candidate.end_line)) {
        summary.candidate_line_ranges = limited.map((candidate) => ({
            start_line: candidate.start_line,
            end_line: candidate.end_line
        }));
    }
    return summary;
}
function findFlexibleAnchorMatches(contentLines, anchorText, lineOffsets, startOffset, endOffset) {
    const normalizedAnchor = normalizeLineEndings(anchorText);
    const anchorLines = normalizedAnchor.split('\n');
    const startLineIndex = findLineIndexForOffset(lineOffsets, startOffset);
    const endLineIndex = findLineIndexForOffset(lineOffsets, endOffset);
    const matches = [];
    const maxStart = endLineIndex - anchorLines.length + 1;
    for (let i = startLineIndex; i <= maxStart; i++) {
        const potentialMatch = contentLines.slice(i, i + anchorLines.length);
        const isMatch = anchorLines.every((anchorLine, j) => {
            const contentLine = potentialMatch[j];
            return contentLine !== undefined && anchorLine.trim() === contentLine.trim();
        });
        if (isMatch) {
            const matchStartOffset = lineOffsets[i];
            const matchEndLineIndex = i + anchorLines.length;
            const matchEndOffset = matchEndLineIndex < lineOffsets.length ? lineOffsets[matchEndLineIndex] : endOffset;
            matches.push({
                startOffset: matchStartOffset,
                endOffset: Math.min(matchEndOffset, endOffset),
                start_line: i + 1,
                end_line: Math.min(matchEndLineIndex, lineOffsets.length)
            });
        }
    }
    return matches.filter((match) => match.startOffset >= startOffset && match.endOffset <= endOffset);
}
function findAnchorCandidates(content, contentLines, anchorText, lineOffsets, startOffset, endOffset, anchorMode) {
    if (anchorMode === 'flexible') {
        return findFlexibleAnchorMatches(contentLines, anchorText, lineOffsets, startOffset, endOffset);
    }
    const normalizedAnchor = normalizeLineEndings(anchorText);
    return findExactMatchIndexes(content, normalizedAnchor, startOffset, endOffset)
        .map((offset) => toAnchorCandidate(offset, normalizedAnchor.length, lineOffsets));
}
function resolveEditAnchors(content, edit, editIndex, lineOffsets, baseStartOffset, baseEndOffset) {
    let startOffset = baseStartOffset;
    let endOffset = baseEndOffset;
    let startLineIndex = findLineIndexForOffset(lineOffsets, startOffset);
    let endLineIndex = findLineIndexForOffset(lineOffsets, endOffset);
    const anchorMode = edit.anchor_mode ?? 'exact';
    const contentLines = anchorMode === 'flexible' ? content.split('\n') : [];
    const detailsBase = {
        edit_index: editIndex,
        edit_number: editIndex + 1,
        expected_occurrences: edit.expected_occurrences ?? 1,
        match_mode: edit.match_mode ?? 'auto',
        anchor_mode: anchorMode,
        start_line: edit.start_line ?? null,
        end_line: edit.end_line ?? null,
        beforeText_preview: edit.beforeText !== undefined ? previewText(edit.beforeText) : null,
        afterText_preview: edit.afterText !== undefined ? previewText(edit.afterText) : null,
        search_preview: buildEditSearchPreview(edit)
    };
    if (edit.beforeText !== undefined) {
        if (normalizeLineEndings(edit.beforeText).length === 0) {
            throwEmptyEditTextError(edit, editIndex, 'beforeText', 'anchor-before');
        }
        const beforeMatches = findAnchorCandidates(content, contentLines, edit.beforeText, lineOffsets, startOffset, endOffset, anchorMode);
        if (beforeMatches.length !== 1) {
            const details = { ...detailsBase, actual_occurrences: beforeMatches.length, match_type: 'anchor-before', ...summarizeAnchorCandidates(beforeMatches) };
            throw new EditFileMatchError(formatEditMatchErrorMessage(details), details);
        }
        startOffset = beforeMatches[0].endOffset;
        startLineIndex = findLineIndexForOffset(lineOffsets, startOffset);
    }
    if (edit.afterText !== undefined) {
        if (normalizeLineEndings(edit.afterText).length === 0) {
            throwEmptyEditTextError(edit, editIndex, 'afterText', 'anchor-after');
        }
        const afterMatches = findAnchorCandidates(content, contentLines, edit.afterText, lineOffsets, startOffset, endOffset, anchorMode);
        if (afterMatches.length !== 1) {
            const details = { ...detailsBase, actual_occurrences: afterMatches.length, match_type: 'anchor-after', ...summarizeAnchorCandidates(afterMatches) };
            throw new EditFileMatchError(formatEditMatchErrorMessage(details), details);
        }
        endOffset = afterMatches[0].startOffset;
        endLineIndex = findLineIndexForOffset(lineOffsets, endOffset);
    }
    if (startOffset > endOffset) {
        const details = { ...detailsBase, actual_occurrences: 0, match_type: 'anchor-range' };
        throw new EditFileMatchError(`Edit ${details.edit_number} anchor range is empty or inverted; search_preview="${details.search_preview}"`, details);
    }
    return { startOffset, endOffset, startLineIndex, endLineIndex, beforeText: edit.beforeText ?? null, afterText: edit.afterText ?? null };
}
function formatNewFileContent(content, options) {
    const newline = options.newline === 'crlf' ? '\r\n' : '\n';
    const hasBom = options.bom === true;
    return addBomIfNeeded(applyNewlineStyle(content, newline), hasBom);
}
function getMajorOverwriteGuard(oldContent, newContent) {
    const oldChars = oldContent.length;
    const newChars = newContent.length;
    const ratio = oldChars === 0 ? 1 : newChars / oldChars;
    const triggered = oldChars >= 10000 && newChars <= 0.5 * oldChars && oldChars - newChars >= 5000;
    return {
        triggered,
        oldChars,
        newChars,
        ratio: Number(ratio.toFixed(4))
    };
}
function getDiffLimitOptions(options, defaultMaxLines = 200) {
    return {
        maxLines: options.max_diff_lines ?? defaultMaxLines,
        maxChars: options.max_diff_chars ?? 20000,
        maxLineChars: options.max_diff_line_chars ?? 2000
    };
}
function createBackupPath(filePath) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${filePath}.${stamp}.${randomBytes(4).toString('hex')}.bak`;
}
// Security & Validation Functions
export async function validatePath(requestedPath, options = {}) {
    const expandedPath = expandHome(requestedPath);
    const absolute = path.isAbsolute(expandedPath)
        ? path.resolve(expandedPath)
        : path.resolve(process.cwd(), expandedPath);
    // K filesystem MCP intentionally allows global local filesystem access.
    // Keep path resolution and parent-directory checks, but do not apply an allowlist.
    try {
        const realPath = await fs.realpath(absolute);
        return realPath;
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            const parentDir = path.dirname(absolute);
            try {
                await fs.realpath(parentDir);
                return absolute;
            }
            catch {
                if (options.allowMissingParent) {
                    return absolute;
                }
                throw new Error(`Parent directory does not exist: ${parentDir}`);
            }
        }
        throw error;
    }
}
// File Operations
export async function getFileStats(filePath) {
    const stats = await fs.stat(filePath);
    return {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        accessed: stats.atime,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        permissions: stats.mode.toString(8).slice(-3),
    };
}
export async function readFileContent(filePath, encoding = 'utf-8') {
    return await fs.readFile(filePath, encoding);
}
export async function writeFileContent(filePath, content, options = {}) {
    const diffOptions = getDiffLimitOptions(options, 200);
    let existing;
    try {
        existing = await readExistingTextFileWithFormat(filePath);
    }
    catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
    if (!existing) {
        const formattedContent = formatNewFileContent(content, options);
        const structured = {
            path: filePath,
            changed: !options.dryRun,
            dryRun: Boolean(options.dryRun),
            action: 'create',
            diff_truncated: false,
            diff_omitted_lines: 0,
            diff_omitted_chars: 0,
            backup_created: false,
            backup_path: null,
            error: null,
            newline_preserved: null,
            bom_preserved: null,
            newline_written: (options.newline === 'crlf' ? 'CRLF' : 'LF'),
            bom_written: options.bom === true
        };
        if (options.dryRun) {
            return {
                text: `Dry run: would create ${filePath} (${formattedContent.length} characters).`,
                structured
            };
        }
        if (options.create_parent_dirs) {
            await fs.mkdir(path.dirname(filePath), { recursive: true });
        }
        // Security: 'wx' flag ensures exclusive creation - fails if file/symlink exists,
        // preventing writes through pre-existing symlinks.
        await fs.writeFile(filePath, formattedContent, { encoding: "utf-8", flag: 'wx' });
        return {
            text: `Successfully created ${filePath}`,
            structured
        };
    }
    if (!options.overwrite) {
        throw new Error(`File already exists: ${filePath}. Pass overwrite: true to replace it.`);
    }
    const formattedContent = addBomIfNeeded(applyNewlineStyle(content, existing.newline), existing.hasBom);
    const oldDisplayContent = existing.content;
    const newDisplayContent = splitBom(formattedContent).content;
    const majorOverwrite = getMajorOverwriteGuard(oldDisplayContent, newDisplayContent);
    const { diff, truncated, omittedLines, omittedChars } = createUnifiedDiff(oldDisplayContent, newDisplayContent, filePath, diffOptions);
    const formattedDiff = formatDiff(diff);
    const structured = {
        path: filePath,
        changed: !options.dryRun && oldDisplayContent !== newDisplayContent,
        dryRun: Boolean(options.dryRun),
        action: 'overwrite',
        diff_truncated: truncated,
        diff_omitted_lines: omittedLines,
        diff_omitted_chars: omittedChars,
        major_overwrite_guard_triggered: majorOverwrite.triggered && !options.allow_major_overwrite,
        old_chars: majorOverwrite.oldChars,
        new_chars: majorOverwrite.newChars,
        new_to_old_ratio: majorOverwrite.ratio,
        backup_created: false,
        backup_path: null,
        error: null,
        newline_preserved: existing.newline === '\r\n' ? 'CRLF' : 'LF',
        bom_preserved: existing.hasBom
    };
    if (options.dryRun) {
        return {
            text: `Dry run: would overwrite ${filePath}\n\n${formattedDiff}`,
            structured
        };
    }
    if (majorOverwrite.triggered && !options.allow_major_overwrite) {
        const percent = (majorOverwrite.ratio * 100).toFixed(1);
        const error = `Refusing major overwrite of ${filePath}: existing content has ${majorOverwrite.oldChars} chars, new content has ${majorOverwrite.newChars} chars (${percent}% of original). Use dryRun: true to inspect the diff, use edit_file for targeted changes, or pass allow_major_overwrite: true if this large shrink is intentional.`;
        return {
            text: error,
            structured: {
                ...structured,
                changed: false,
                error,
                error_type: 'MajorOverwriteGuardError',
                code: 'MAJOR_OVERWRITE_GUARD'
            }
        };
    }
    if (options.backup_existing && oldDisplayContent !== newDisplayContent) {
        const backupPath = createBackupPath(filePath);
        await fs.copyFile(filePath, backupPath);
        structured.backup_created = true;
        structured.backup_path = backupPath;
    }
    await atomicWriteText(filePath, formattedContent);
    return {
        text: `Successfully overwrote ${filePath}\n\n${formattedDiff}`,
        structured
    };
}
export async function applyFileEdits(filePath, edits, dryRun = false, options = {}) {
    const diffOptions = getDiffLimitOptions(options, 200);
    const existing = await readExistingTextFileWithFormat(filePath);
    const content = normalizeLineEndings(existing.content);
    const originalLineOffsets = getLineOffsets(content);
    const originalContentLines = content.split('\n');
    const plannedEdits = [];
    const editSummaries = [];
    for (let editIndex = 0; editIndex < edits.length; editIndex++) {
        const edit = edits[editIndex];
        const normalizedOld = edit.oldText !== undefined ? normalizeLineEndings(edit.oldText) : undefined;
        const normalizedNew = normalizeLineEndings(edit.newText);
        if (normalizedOld !== undefined && normalizedOld.length === 0) {
            throwEmptyEditTextError(edit, editIndex, 'oldText', 'oldText');
        }
        const { startOffset, endOffset, startLineIndex, endLineIndex } = getEditRangeOffsets(content, edit);
        const matchMode = edit.match_mode ?? 'auto';
        const anchorMode = edit.anchor_mode ?? 'exact';
        const anchorUsed = edit.beforeText !== undefined || edit.afterText !== undefined;
        const anchoredRange = edit.beforeText !== undefined || edit.afterText !== undefined
            ? resolveEditAnchors(content, edit, editIndex, originalLineOffsets, startOffset, endOffset)
            : { startOffset, endOffset, startLineIndex, endLineIndex };
        const searchStartOffset = anchoredRange.startOffset;
        const searchEndOffset = anchoredRange.endOffset;
        const exactMatches = matchMode !== 'flexible' && edit.oldText !== undefined
            ? findExactMatchIndexes(content, normalizedOld, searchStartOffset, searchEndOffset)
            : [];
        if (exactMatches.length > 0) {
            assertExpectedOccurrences(edit, editIndex, exactMatches.length, 'exact');
            const matchIndex = exactMatches[0];
            plannedEdits.push({
                editIndex,
                startOffset: matchIndex,
                endOffset: matchIndex + normalizedOld.length,
                replacement: normalizedNew
            });
            editSummaries.push({
                match_type: 'exact',
                matches: exactMatches.length,
                expected_occurrences: edit.expected_occurrences ?? 1,
                start_line: edit.start_line ?? null,
                end_line: edit.end_line ?? null,
                match_mode: matchMode,
                anchor_used: anchorUsed,
                anchor_mode: anchorMode,
                original_start_offset: matchIndex,
                original_end_offset: matchIndex + normalizedOld.length
            });
            continue;
        }
        if (matchMode === 'exact' && edit.oldText !== undefined) {
            assertExpectedOccurrences(edit, editIndex, exactMatches.length, 'exact');
            throw new Error(`Could not find exact match for edit ${editIndex + 1}: ${previewText(edit.oldText)}`);
        }
        const { startOffset: effectiveStartOffset, endOffset: effectiveEndOffset, startLineIndex: effectiveStartLineIndex, endLineIndex: effectiveEndLineIndex } = anchoredRange;
        if (edit.oldText === undefined) {
            if (edit.beforeText === undefined || edit.afterText === undefined) {
                throw new Error('Anchor-based replacement requires beforeText and afterText when oldText is omitted.');
            }
            const replacement = normalizedNew;
            plannedEdits.push({
                editIndex,
                startOffset: effectiveStartOffset,
                endOffset: effectiveEndOffset,
                replacement
            });
            editSummaries.push({
                match_type: 'anchor-range',
                matches: 1,
                expected_occurrences: edit.expected_occurrences ?? 1,
                start_line: edit.start_line ?? null,
                end_line: edit.end_line ?? null,
                match_mode: matchMode,
                anchor_used: anchorUsed,
                anchor_mode: anchorMode,
                original_start_offset: effectiveStartOffset,
                original_end_offset: effectiveEndOffset,
                beforeText_preview: edit.beforeText !== undefined ? previewText(edit.beforeText) : null,
                afterText_preview: edit.afterText !== undefined ? previewText(edit.afterText) : null
            });
            continue;
        }
        const oldLines = normalizedOld.split('\n');
        const flexibleMatches = findFlexibleLineMatches(originalContentLines, oldLines, effectiveStartLineIndex, effectiveEndLineIndex);
        assertExpectedOccurrences(edit, editIndex, flexibleMatches.length, 'flexible');
        if (flexibleMatches.length === 0) {
            throw new Error(`Could not find flexible match for edit ${editIndex + 1}: ${previewText(edit.oldText)}`);
        }
        const matchLineIndex = flexibleMatches[0];
        const originalIndent = originalContentLines[matchLineIndex].match(/^\s*/)?.[0] || '';
        const newLines = normalizedNew.split('\n').map((line, j) => {
            if (j === 0)
                return originalIndent + line.trimStart();
            const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] || '';
            const newIndent = line.match(/^\s*/)?.[0] || '';
            if (oldIndent && newIndent) {
                const relativeIndent = newIndent.length - oldIndent.length;
                return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart();
            }
            return line;
        });
        let replacement = newLines.join('\n');
        const flexibleStartOffset = originalLineOffsets[matchLineIndex];
        const flexibleEndLineIndex = matchLineIndex + oldLines.length;
        const flexibleEndOffset = flexibleEndLineIndex < originalLineOffsets.length ? originalLineOffsets[flexibleEndLineIndex] : content.length;
        const replacedText = content.slice(flexibleStartOffset, flexibleEndOffset);
        if (replacedText.endsWith('\n') && !replacement.endsWith('\n')) {
            replacement += '\n';
        }
        plannedEdits.push({
            editIndex,
            startOffset: flexibleStartOffset,
            endOffset: flexibleEndOffset,
            replacement
        });
        editSummaries.push({
            match_type: 'flexible',
            matches: flexibleMatches.length,
            expected_occurrences: edit.expected_occurrences ?? 1,
            start_line: edit.start_line ?? null,
            end_line: edit.end_line ?? null,
            match_mode: matchMode,
            anchor_used: anchorUsed,
            anchor_mode: anchorMode,
            original_start_offset: flexibleStartOffset,
            original_end_offset: flexibleEndOffset,
            beforeText_preview: edit.beforeText !== undefined ? previewText(edit.beforeText) : null,
            afterText_preview: edit.afterText !== undefined ? previewText(edit.afterText) : null
        });
    }
    const sortedByStart = [...plannedEdits].sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
    for (let i = 1; i < sortedByStart.length; i++) {
        if (sortedByStart[i].startOffset < sortedByStart[i - 1].endOffset) {
            throw new Error(`Overlapping edits are not allowed: edit ${sortedByStart[i - 1].editIndex + 1} overlaps edit ${sortedByStart[i].editIndex + 1}`);
        }
    }
    let modifiedContent = content;
    for (const planned of [...plannedEdits].sort((a, b) => b.startOffset - a.startOffset || b.endOffset - a.endOffset)) {
        modifiedContent = modifiedContent.slice(0, planned.startOffset) + planned.replacement + modifiedContent.slice(planned.endOffset);
    }
    const { diff, truncated, omittedLines, omittedChars } = createUnifiedDiff(content, modifiedContent, filePath, diffOptions);
    const formattedDiff = formatDiff(diff);
    const structured = {
        path: filePath,
        changed: !dryRun && content !== modifiedContent,
        dryRun: Boolean(dryRun),
        edits_applied: editSummaries.length,
        edit_application: 'original_offsets_bottom_up',
        range_basis: 'original',
        edits: editSummaries,
        diff_truncated: truncated,
        diff_omitted_lines: omittedLines,
        diff_omitted_chars: omittedChars,
        newline_preserved: existing.newline === '\r\n' ? 'CRLF' : 'LF',
        bom_preserved: existing.hasBom
    };
    if (!dryRun) {
        const formattedContent = addBomIfNeeded(applyNewlineStyle(modifiedContent, existing.newline), existing.hasBom);
        await atomicWriteText(filePath, formattedContent);
    }
    return {
        text: formattedDiff,
        structured
    };
}
// Memory-efficient implementation to get the last N lines of a file
export async function tailFile(filePath, numLines) {
    const CHUNK_SIZE = 1024; // Read 1KB at a time
    const stats = await fs.stat(filePath);
    const fileSize = stats.size;
    if (fileSize === 0)
        return '';
    // Open file for reading
    const fileHandle = await fs.open(filePath, 'r');
    try {
        const lines = [];
        let position = fileSize;
        let chunk = Buffer.alloc(CHUNK_SIZE);
        let linesFound = 0;
        let remainingText = '';
        // Read chunks from the end of the file until we have enough lines
        while (position > 0 && linesFound < numLines) {
            const size = Math.min(CHUNK_SIZE, position);
            position -= size;
            const { bytesRead } = await fileHandle.read(chunk, 0, size, position);
            if (!bytesRead)
                break;
            // Get the chunk as a string and prepend any remaining text from previous iteration
            const readData = chunk.slice(0, bytesRead).toString('utf-8');
            const chunkText = readData + remainingText;
            // Split by newlines and count
            const chunkLines = normalizeLineEndings(chunkText).split('\n');
            // If this isn't the end of the file, the first line is likely incomplete
            // Save it to prepend to the next chunk
            if (position > 0) {
                remainingText = chunkLines[0];
                chunkLines.shift(); // Remove the first (incomplete) line
            }
            // Add lines to our result (up to the number we need)
            for (let i = chunkLines.length - 1; i >= 0 && linesFound < numLines; i--) {
                lines.unshift(chunkLines[i]);
                linesFound++;
            }
        }
        return lines.join('\n');
    }
    finally {
        await fileHandle.close();
    }
}
// New function to get the first N lines of a file
export async function headFile(filePath, numLines) {
    const fileHandle = await fs.open(filePath, 'r');
    try {
        const lines = [];
        let buffer = '';
        let bytesRead = 0;
        const chunk = Buffer.alloc(1024); // 1KB buffer
        // Read chunks and count lines until we have enough or reach EOF
        while (lines.length < numLines) {
            const result = await fileHandle.read(chunk, 0, chunk.length, bytesRead);
            if (result.bytesRead === 0)
                break; // End of file
            bytesRead += result.bytesRead;
            buffer += chunk.slice(0, result.bytesRead).toString('utf-8');
            const newLineIndex = buffer.lastIndexOf('\n');
            if (newLineIndex !== -1) {
                const completeLines = buffer.slice(0, newLineIndex).split('\n');
                buffer = buffer.slice(newLineIndex + 1);
                for (const line of completeLines) {
                    lines.push(line);
                    if (lines.length >= numLines)
                        break;
                }
            }
        }
        // If there is leftover content and we still need lines, add it
        if (buffer.length > 0 && lines.length < numLines) {
            lines.push(buffer);
        }
        return lines.join('\n');
    }
    finally {
        await fileHandle.close();
    }
}
