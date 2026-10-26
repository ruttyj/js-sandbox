// Diffs: line diffs of an agent's Edit calls, parsing of git patches, and the
// HTML for both. Lines come out as { type: add | del | ctx | hunk | meta,
// text, oldNo?, newNo? }.

import { escapeHtml } from './format.js';

// Above this many cells the LCS table is too slow to build in the browser;
// the edit is then shown as all-removed then all-added.
const MAX_LCS_CELLS = 400_000;

// --- Line diff ---------------------------------------------------------------

const splitLines = (text) => {
    return String(text ?? '').replace(/\r\n/g, '\n').split('\n');
};

// Longest-common-subsequence table, filled from the end so a forward walk
// can read off the diff. table[i][j] = LCS length of a[i..] and b[j..].
const buildLcsTable = (a, b) => {
    const table = [];
    for (let i = 0; i <= a.length; i++) {
        table.push(new Uint32Array(b.length + 1));
    }

    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            if (a[i] === b[j]) {
                table[i][j] = table[i + 1][j + 1] + 1;
            } else {
                table[i][j] = Math.max(table[i + 1][j], table[i][j + 1]);
            }
        }
    }
    return table;
};

const replaceAllLines = (a, b) => {
    const lines = [];
    for (const text of a) {
        lines.push({ type: 'del', text });
    }
    for (const text of b) {
        lines.push({ type: 'add', text });
    }
    return lines;
};

// The lines of oldText -> newText, numbered as in the snippet.
export const lineDiff = (oldText, newText) => {
    const a = oldText === '' ? [] : splitLines(oldText);
    const b = newText === '' ? [] : splitLines(newText);
    if (a.length * b.length > MAX_LCS_CELLS) {
        return replaceAllLines(a, b);
    }

    const table = buildLcsTable(a, b);
    const lines = [];
    let i = 0;
    let j = 0;

    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            lines.push({ type: 'ctx', text: a[i], oldNo: i + 1, newNo: j + 1 });
            i++;
            j++;
        } else if (table[i + 1][j] >= table[i][j + 1]) {
            lines.push({ type: 'del', text: a[i], oldNo: i + 1 });
            i++;
        } else {
            lines.push({ type: 'add', text: b[j], newNo: j + 1 });
            j++;
        }
    }

    for (; i < a.length; i++) {
        lines.push({ type: 'del', text: a[i], oldNo: i + 1 });
    }
    for (; j < b.length; j++) {
        lines.push({ type: 'add', text: b[j], newNo: j + 1 });
    }
    return lines;
};

// --- Patch parsing -----------------------------------------------------------

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

const stripPrefix = (path) => {
    return path.replace(/^[ab]\//, '');
};

const createFile = (line) => {
    // "diff --git a/x b/x": the +++/--- lines below give the paths more
    // reliably, but this is all there is for binary files and pure renames.
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    return {
        oldPath: match ? match[1] : '',
        path: match ? match[2] : '',
        status: 'modified',
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
    };
};

const applyHeaderLine = (file, line) => {
    if (line.startsWith('new file mode')) {
        file.status = 'added';
    } else if (line.startsWith('deleted file mode')) {
        file.status = 'deleted';
    } else if (line.startsWith('rename from ')) {
        file.status = 'renamed';
        file.oldPath = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) {
        file.path = line.slice('rename to '.length);
    } else if (line.startsWith('Binary files')) {
        file.binary = true;
    } else if (line.startsWith('--- ') && line !== '--- /dev/null') {
        file.oldPath = stripPrefix(line.slice(4));
    } else if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
        file.path = stripPrefix(line.slice(4));
    }
};

const applyHunkLine = (file, hunk, line) => {
    const marker = line[0];

    if (marker === '+') {
        hunk.lines.push({ type: 'add', text: line.slice(1), newNo: hunk.newNo++ });
        file.additions += 1;
    } else if (marker === '-') {
        hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: hunk.oldNo++ });
        file.deletions += 1;
    } else if (marker === '\\') {
        hunk.lines.push({ type: 'meta', text: line });
    } else {
        hunk.lines.push({ type: 'ctx', text: line.slice(1), oldNo: hunk.oldNo++, newNo: hunk.newNo++ });
    }
};

// Parses `git diff` output into files:
// [{ path, oldPath, status: modified | added | deleted | renamed, binary,
//    additions, deletions, hunks: [{ header, lines }] }]
export const parsePatch = (patch) => {
    const files = [];
    let file = null;
    let hunk = null;

    for (const line of String(patch ?? '').split('\n')) {
        if (line.startsWith('diff --git ')) {
            file = createFile(line);
            hunk = null;
            files.push(file);
            continue;
        }

        if (!file) {
            continue;
        }

        const hunkMatch = HUNK_HEADER.exec(line);
        if (hunkMatch) {
            hunk = { header: line, context: hunkMatch[3].trim(), oldNo: Number(hunkMatch[1]), newNo: Number(hunkMatch[2]), lines: [] };
            file.hunks.push(hunk);
        } else if (hunk && line !== '') {
            applyHunkLine(file, hunk, line);
        } else if (!hunk) {
            applyHeaderLine(file, line);
        }
    }
    return files;
};

// --- Rendering ---------------------------------------------------------------

// Marks the part of a changed line that differs from its counterpart, by
// trimming their common prefix and suffix, e.g.
//   "const limit = 10;" vs "const limit = 25;" -> highlights "10" and "25".
const highlightPair = (oldText, newText) => {
    let prefix = 0;
    const shortest = Math.min(oldText.length, newText.length);
    while (prefix < shortest && oldText[prefix] === newText[prefix]) {
        prefix++;
    }

    let suffix = 0;
    while (
        suffix < shortest - prefix
        && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
    ) {
        suffix++;
    }

    const wrap = (text) => {
        const head = escapeHtml(text.slice(0, prefix));
        const middle = escapeHtml(text.slice(prefix, text.length - suffix));
        const tail = escapeHtml(text.slice(text.length - suffix));
        if (middle === '') {
            return head + tail;
        }
        return `${head}<mark>${middle}</mark>${tail}`;
    };
    return { oldHtml: wrap(oldText), newHtml: wrap(newText) };
};

// Pairs each run of removed lines with the added lines right after it, so
// a modified line is shown with the changed part highlighted.
const withIntralineHighlights = (lines) => {
    const html = lines.map((line) => escapeHtml(line.text));
    let index = 0;

    while (index < lines.length) {
        if (lines[index].type !== 'del') {
            index++;
            continue;
        }

        const delStart = index;
        while (index < lines.length && lines[index].type === 'del') {
            index++;
        }
        const addStart = index;
        while (index < lines.length && lines[index].type === 'add') {
            index++;
        }

        const pairs = Math.min(addStart - delStart, index - addStart);
        for (let offset = 0; offset < pairs; offset++) {
            const { oldHtml, newHtml } = highlightPair(lines[delStart + offset].text, lines[addStart + offset].text);
            html[delStart + offset] = oldHtml;
            html[addStart + offset] = newHtml;
        }
    }
    return html;
};

const SIGNS = { add: '+', del: '−', ctx: ' ', meta: ' ' };

const renderLines = (lines) => {
    const html = withIntralineHighlights(lines);
    const rows = [];

    for (const [index, line] of lines.entries()) {
        rows.push(
            `<tr class="dl dl-${line.type}">`
            + `<td class="dl-no">${line.oldNo ?? ''}</td>`
            + `<td class="dl-no">${line.newNo ?? ''}</td>`
            + `<td class="dl-sign">${SIGNS[line.type] ?? ''}</td>`
            + `<td class="dl-code">${html[index] || ' '}</td>`
            + '</tr>',
        );
    }
    return rows.join('');
};

// A table for one Edit (or a Write, with oldText ''), e.g. in the feed.
export const renderLineDiff = (oldText, newText) => {
    const lines = lineDiff(oldText, newText);
    return `<table class="diff-table">${renderLines(lines)}</table>`;
};

export const renderPatchFile = (file) => {
    if (file.binary) {
        return '<div class="diff-empty">Binary file</div>';
    }

    if (file.hunks.length === 0) {
        return '<div class="diff-empty">No content changes</div>';
    }

    const parts = [];
    for (const hunk of file.hunks) {
        const context = hunk.context ? ` <span class="dl-hunk-context">${escapeHtml(hunk.context)}</span>` : '';
        // "@@ -1,4 +1,5 @@ function foo()" -> "@@ -1,4 +1,5 @@", with the
        // enclosing function shown separately.
        const range = hunk.header.replace(/^(@@ [^@]* @@).*$/, '$1');
        parts.push(`<tr class="dl dl-hunk"><td class="dl-no" colspan="3">⋯</td><td class="dl-code">${escapeHtml(range)}${context}</td></tr>`);
        parts.push(renderLines(hunk.lines));
    }
    return `<table class="diff-table">${parts.join('')}</table>`;
};
