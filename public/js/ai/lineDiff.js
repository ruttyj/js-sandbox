// Line diffs for the changes Claude proposes in the chat, shown before the user applies them.
//
//   diffLines('a\nb\nc', 'a\nB\nc')
//   // -> [{ type: 'same', text: 'a', oldLine: 1, newLine: 1 },
//   //     { type: 'remove', text: 'b', oldLine: 2, newLine: null },
//   //     { type: 'add', text: 'B', oldLine: null, newLine: 2 },
//   //     { type: 'same', text: 'c', oldLine: 3, newLine: 3 }]
//
// It's the classic longest-common-subsequence diff, which costs old lines x new lines; code past
// DIFF_LINE_LIMIT lines on both sides is shown as all removed then all added instead.

const DIFF_LINE_LIMIT = 3000;
const DIFF_CONTEXT_LINES = 3;

/**
 * The length of the longest common subsequence of a[i..] and b[j..], for every i and j.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Uint32Array[]} lengths[i][j]; one extra row and column of zeros at the end.
 */
const commonSuffixLengths = (a, b) => {
    const lengths = [];
    for (let i = 0; i <= a.length; i++) {
        lengths.push(new Uint32Array(b.length + 1));
    }

    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            if (a[i] === b[j]) {
                lengths[i][j] = lengths[i + 1][j + 1] + 1;
            } else {
                lengths[i][j] = Math.max(lengths[i + 1][j], lengths[i][j + 1]);
            }
        }
    }
    return lengths;
};

// Every old line removed, then every new line added.
const replaceAllRows = (oldLines, newLines) => {
    const rows = [];
    oldLines.forEach((text, index) => rows.push({ type: 'remove', text, oldLine: index + 1, newLine: null }));
    newLines.forEach((text, index) => rows.push({ type: 'add', text, oldLine: null, newLine: index + 1 }));
    return rows;
};

/**
 * @param {string} oldText
 * @param {string} newText
 * @returns {{ type: 'same'|'add'|'remove', text: string, oldLine: number|null, newLine: number|null }[]}
 *     Line numbers start at 1; null on the side a line isn't in.
 */
const diffLines = (oldText, newText) => {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    if (oldLines.length > DIFF_LINE_LIMIT && newLines.length > DIFF_LINE_LIMIT) {
        return replaceAllRows(oldLines, newLines);
    }

    const lengths = commonSuffixLengths(oldLines, newLines);
    const rows = [];
    let i = 0;
    let j = 0;
    while (i < oldLines.length || j < newLines.length) {
        const bothLeft = i < oldLines.length && j < newLines.length;
        if (bothLeft && oldLines[i] === newLines[j]) {
            rows.push({ type: 'same', text: oldLines[i], oldLine: i + 1, newLine: j + 1 });
            i++;
            j++;
            continue;
        }

        // Remove first when that keeps as much in common as adding would, so a changed line reads
        // as the old line followed by the new one.
        const removeKeepsMore = j >= newLines.length || (i < oldLines.length && lengths[i + 1][j] >= lengths[i][j + 1]);
        if (removeKeepsMore) {
            rows.push({ type: 'remove', text: oldLines[i], oldLine: i + 1, newLine: null });
            i++;
        } else {
            rows.push({ type: 'add', text: newLines[j], oldLine: null, newLine: j + 1 });
            j++;
        }
    }
    return rows;
};

/**
 * The rows worth showing: every change with a few unchanged lines around it. Each longer run of
 * unchanged lines becomes one { type: 'skip', count } row.
 * @param {Object[]} rows From diffLines.
 * @returns {Object[]}
 */
const collapseDiffContext = (rows) => {
    const isNearChange = rows.map(() => false);
    rows.forEach((row, index) => {
        if (row.type === 'same') {
            return;
        }
        const from = Math.max(0, index - DIFF_CONTEXT_LINES);
        const to = Math.min(rows.length - 1, index + DIFF_CONTEXT_LINES);
        for (let near = from; near <= to; near++) {
            isNearChange[near] = true;
        }
    });

    const shown = [];
    let skipped = 0;
    rows.forEach((row, index) => {
        if (isNearChange[index]) {
            if (skipped) {
                shown.push({ type: 'skip', count: skipped });
                skipped = 0;
            }
            shown.push(row);
            return;
        }
        skipped++;
    });
    if (skipped) {
        shown.push({ type: 'skip', count: skipped });
    }
    return shown;
};

// How many lines a diff adds and removes, for its header: { added, removed }.
const countDiffChanges = (rows) => {
    let added = 0;
    let removed = 0;
    for (const row of rows) {
        if (row.type === 'add') {
            added++;
        } else if (row.type === 'remove') {
            removed++;
        }
    }
    return { added, removed };
};
