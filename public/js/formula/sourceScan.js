// Just enough tokenising of JavaScript source to tell code apart from strings and comments, shared
// by the engine (loop guards) and scopeCode.js (finding declarations). Regex literals and ${}
// inside template literals aren't recognised.
//
// Everything is private to the SourceScan closure except the names in its returned object, which
// are also exposed as globals for the other scripts.

const SourceScan = (() => {

    /**
     * Where a string, template literal or comment ends.
     * @typedef {Object} ScanResult
     * @property {number} end Index just past it.
     * @property {boolean} unterminated True when it runs to the end of the code without closing.
     */

    /**
     * Scans a // comment. It ends before its newline, so the newline still separates statements.
     * @param {string} code
     * @param {number} start Index of the comment's first "/".
     * @returns {ScanResult}
     */
    const scanLineComment = (code, start) => {
        const newline = code.indexOf('\n', start);
        if (newline === -1) {
            return { end: code.length, unterminated: false };
        }
        return { end: newline, unterminated: false };
    };

    /**
     * Scans a block comment.
     * @param {string} code
     * @param {number} start Index of the comment's "/".
     * @returns {ScanResult}
     */
    const scanBlockComment = (code, start) => {
        const close = code.indexOf('*/', start + 2);
        if (close === -1) {
            return { end: code.length, unterminated: true };
        }
        return { end: close + 2, unterminated: false };
    };

    /**
     * Scans a '...', "..." or `...` literal; a backslash escapes the character after it.
     * @param {string} code
     * @param {number} start Index of the opening quote.
     * @returns {ScanResult}
     */
    const scanQuoted = (code, start) => {
        const quote = code[start];
        let i = start + 1;

        while (i < code.length) {
            if (code[i] === '\\') {
                i += 2;
                continue;
            }
            if (code[i] === quote) {
                return { end: i + 1, unterminated: false };
            }
            i++;
        }

        return { end: code.length, unterminated: true };
    };

    /**
     * Scans the string, template literal or comment that starts at code[i], if there is one.
     * @param {string} code
     * @param {number} i
     * @returns {ScanResult|null} null when code[i] doesn't start one.
     */
    const scanLiteralOrComment = (code, i) => {
        const ch = code[i];
        const next = code[i + 1];

        if (ch === '/' && next === '/') {
            return scanLineComment(code, i);
        }
        if (ch === '/' && next === '*') {
            return scanBlockComment(code, i);
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            return scanQuoted(code, i);
        }
        return null;
    };

    const OPENING_BRACKETS = '([{';
    const CLOSING_BRACKETS = ')]}';

    /**
     * Finds the bracket that closes the one at code[open], skipping strings and comments.
     * @param {string} code
     * @param {number} open Index of the opening bracket, normally a "(".
     * @returns {{ close: number, semicolons: number[] }} close: its index, or -1 if it's never
     *     closed; semicolons: the indices of the ";"s directly inside it (not in nested brackets).
     */
    const matchParen = (code, open) => {
        const semicolons = [];
        let depth = 0;

        for (let i = open; i < code.length; i++) {
            const skipped = scanLiteralOrComment(code, i);
            if (skipped) {
                i = skipped.end - 1;
                continue;
            }

            const ch = code[i];
            if (OPENING_BRACKETS.includes(ch)) {
                depth++;
            } else if (CLOSING_BRACKETS.includes(ch)) {
                depth--;
                if (depth === 0) {
                    return { close: i, semicolons };
                }
            } else if (ch === ';' && depth === 1) {
                semicolons.push(i);
            }
        }

        return { close: -1, semicolons };
    };


    // --- Public API -------------------------------------------------------------------------------

    return Object.freeze({
        scanLiteralOrComment,
        matchParen,
        OPENING_BRACKETS,
        CLOSING_BRACKETS,
    });
})();

// Classic scripts share one global scope, so the public API is unpacked here for the files that
// follow (the same way vue-globals.js unpacks Vue).
const {
    scanLiteralOrComment,
    matchParen,
    OPENING_BRACKETS,
    CLOSING_BRACKETS,
} = SourceScan;
