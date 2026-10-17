// A scope (and the globals) is written as code, independent of Vue. The code text is the source
// of truth: the engine runs it as one program (see runScopeCode), and parsing it yields the
// scope's variables (its top-level declarations), which the editor and dashboard list.
//
//   // Description of the variable
//   // @tags: PROFIT, TAX
//   let Key = <expression>;
//
// Comment lines directly above a declaration become its description; "@tags:" and "@color:"
// lines set those fields ("// @group: ..." lines are ignored). Initial values are stored as
// "=<expression>" formulas (plain numbers ("4", "10k") and string literals as literal values);
// they're only used to show and merge declarations, never evaluated on their own.
//
// Uses globals from scripts loaded before it:
//   utils/colors.js        hslToHex, clamp, blendColors
//   utils/format.js        formatVarValue
//   utils/data.js          normalizeTags, normalizeVariable
//   formula/sourceScan.js  scanLiteralOrComment, matchParen, OPENING_BRACKETS, CLOSING_BRACKETS
//   formula/functions.js   FORMULA_FUNCTIONS
//   formula/itemRefs.js    ITEM_LOOKUP_FN, itemNameKey, findItem, buildItemLookup, buildItemRef
//   formula/engine.js      SCOPE_IMPORT_FN
//
// Sections: formulas <-> expressions -> generating code -> legacy item refs -> variable colors ->
// parsing code -> public API.
//
// Everything is private to the ScopeCode closure except the names in its returned object (see
// "Public API" at the bottom), which are also exposed as globals for the other scripts.

const ScopeCode = (() => {

    // --- Formulas <-> expressions -----------------------------------------------------------------

    const SCOPE_NUMBER_LITERAL = /^-?\d+(?:\.\d+)?\s*[kmbt]?$/i;
    const SCOPE_STRING_LITERAL = /^"(?:[^"\\\n]|\\.)*"$/;
    const SCOPE_DECLARATOR = /^\s*([A-Za-z_$][\w$]*)\s*(?:=\s*([\s\S]*?))?\s*$/;

    // "=a + b" -> "a + b", "10k" -> "10k", "text" -> "\"text\"", "" -> "null"
    const formulaToExpression = (formula) => {
        const raw = (formula ?? '').toString();
        if (raw.startsWith('=')) return raw.substring(1).trim() || 'null';
        if (raw.trim() === '') return 'null';
        if (SCOPE_NUMBER_LITERAL.test(raw.trim())) return raw.trim();
        return JSON.stringify(raw);
    };

    // The reverse: "a + b" -> "=a + b", "10k" -> "10k", "\"text\"" -> "text"
    const expressionToFormula = (expression) => {
        if (expression === '' || SCOPE_NUMBER_LITERAL.test(expression)) return expression;
        if (SCOPE_STRING_LITERAL.test(expression)) {
            try { return JSON.parse(expression); } catch (e) { /* fall through to a formula */ }
        }
        return '=' + expression;
    };

    // Collapses a multi-line expression or value onto one line.
    const toSingleLine = (text) => text.replace(/\s*\n\s*/g, ' ');


    // --- Generating code --------------------------------------------------------------------------

    // Builds code from variables alone (data saved before it was code, or merged in by an import).
    // source: { variables }
    const generateScopeCode = (source) => {
        const out = [];
        (source.variables || []).forEach(v => {
            if (v.name) out.push(`// ${v.name}`);
            if (v.tags && v.tags.length) out.push(`// @tags: ${v.tags.join(', ')}`);
            out.push(`const ${v.key} = ${formulaToExpression(v.formula)};`, '');
        });
        return out.join('\n').trimEnd() + '\n';
    };

    // Read-only preamble listing the global variables a scope's code can reference without
    // declaring them. (Item prices are listed in the item reference panel instead.)
    // globals: [{ variable, value, overridden }]; a variable with `returned` is a key the globals'
    // code returns without declaring it, so it has no formula to show.
    const generateImpliedCode = (globals) => {
        if (!globals.length) return '';
        const lines = globals.map(({ variable, value, overridden }) => {
            const shownValue = toSingleLine(formatVarValue(value));
            const note = overridden ? 'overridden by a local declaration' : `= ${shownValue}`;
            const expression = variable.returned
                ? '/* returned */ ' + shownValue
                : toSingleLine(formulaToExpression(variable.formula));
            return `const ${variable.key} = ${expression}; // ${note}`;
        });
        return ['// Global variables (edit on the Global Vars tab)', ...lines].join('\n');
    };


    // --- Legacy item refs -------------------------------------------------------------------------
    // I_<id>_H / I_<id>_L -> getOsrsItem('Name').highPrice / lowPrice.

    const LEGACY_ITEM_REF = /\bI_(\d+)_(H|L)\b/g;

    const legacyPriceField = (type) => (type === 'H' ? 'highPrice' : 'lowPrice');

    // "Ahrim's hood" -> "AhrimsHood", "Amulet of glory(4)" -> "AmuletOfGlory4"
    const itemVariableKey = (item) => {
        const words = item.name.replace(/['’]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
        const key = words.map(w => w[0].toUpperCase() + w.slice(1)).join('');
        if (!key) return `Item${item.id}`;
        return /^\d/.test(key) ? `Item${key}` : key;
    };

    // id -> how many times code refers to that (known) item.
    const countLegacyItemRefs = (code, items) => {
        const uses = new Map();
        for (const [, id] of (code || '').matchAll(LEGACY_ITEM_REF)) {
            if (items[id]) uses.set(id, (uses.get(id) || 0) + 1);
        }
        return uses;
    };

    // Upper-cased names a new const must not take: the code's own variables, the globals and the
    // built-ins.
    const namesTakenInCode = (code, reservedKeys) => new Set([
        ...parseScopeCode(code).variables.map(v => v.key),
        ...reservedKeys,
        ...Object.keys(FORMULA_FUNCTIONS),
        ITEM_LOOKUP_FN,
        SCOPE_IMPORT_FN,
    ].map(k => k.toUpperCase()));

    // base, or base2, base3, ... if that's taken (or is a browser global like `Image`). Claims it.
    const claimUniqueKey = (base, taken) => {
        let key = base;
        for (let n = 2; taken.has(key.toUpperCase()) || key in globalThis; n++) key = `${base}${n}`;
        taken.add(key.toUpperCase());
        return key;
    };

    // For a block of code (a scope's or the globals'): an item referenced more than once is fetched
    // once into a const declared at the top, and its refs become `Key.highPrice` / `Key.lowPrice`;
    // single refs are inlined.
    // items: { [id]: item }; unknown ids are left as they are. reservedKeys: keys the new consts
    // must not shadow (globals). Returns the code unchanged if there is nothing to migrate.
    const migrateLegacyItemRefs = (code, items, reservedKeys = []) => {
        const uses = countLegacyItemRefs(code, items);
        if (!uses.size) return code;

        const taken = namesTakenInCode(code, reservedKeys);
        const sharedKeys = new Map(); // id -> const key, for items referenced more than once
        uses.forEach((count, id) => {
            if (count >= 2) sharedKeys.set(id, claimUniqueKey(itemVariableKey(items[id]), taken));
        });

        const body = code.replace(LEGACY_ITEM_REF, (match, id, type) => {
            const item = items[id];
            if (!item) return match;
            const key = sharedKeys.get(id);
            return key ? `${key}.${legacyPriceField(type)}` : buildItemRef(item, type === 'H' ? 'HIGH' : 'LOW');
        });

        if (!sharedKeys.size) return body;
        const declarations = [...sharedKeys].map(([id, key]) =>
            `// ${items[id].name}\nconst ${key} = ${buildItemLookup(items[id])};`);
        return declarations.join('\n\n') + '\n\n' + body;
    };


    // --- Variable colors --------------------------------------------------------------------------

    // The new variable list for freshly parsed code. Keeps each variable's color and extra fields:
    // match by key, else by position when the variable at that position was renamed (so colors
    // don't flicker while typing a key).
    const mergeParsedVariables = (previous, parsedVariables) => {
        const byKey = new Map(previous.map(v => [v.key, v]));
        const newKeys = new Set(parsedVariables.map(v => v.key));
        return parsedVariables.map((parsed, index) => {
            const positional = previous[index];
            const prev = byKey.get(parsed.key)
                || (positional && !newKeys.has(positional.key) ? positional : null);
            return normalizeVariable({
                ...(prev || {}),
                key: parsed.key,
                name: parsed.name,
                formula: parsed.formula,
                tags: parsed.tags,
                color: parsed.color || prev?.color,
            });
        });
    };

    // getOsrsItem('Name') or getOsrsItem(5316). Groups: 1 the quote, 2 the (still escaped) name,
    // 3 the item ID.
    const ITEM_LOOKUP_CALL = /getOsrsItem\(\s*(?:(['"])((?:\\.|(?!\1).)*?)\1|(\d+))\s*\)/g;

    // A variable whose initial value is exactly one lookup, e.g. "=getOsrsItem('Magic seed');".
    const WHOLE_ITEM_LOOKUP = new RegExp(`^=\\s*${ITEM_LOOKUP_CALL.source}\\s*;?\\s*$`);

    // The text inside quotes, with backslash escapes removed: Ahrim\'s hood -> Ahrim's hood
    const unescapeQuoted = (text) => text.replace(/\\(.)/g, '$1');

    // The argument of an ITEM_LOOKUP_CALL match: the item ID as text, or the unescaped name.
    const itemLookupArg = (match) => {
        if (match[3] !== undefined) {
            return match[3];
        }
        return unescapeQuoted(match[2]);
    };

    // The item a variable holds, when its initial value is a single getOsrsItem(...) call.
    // "=getOsrsItem('Magic seed')" -> 'Magic seed'; "=getOsrsItem(5316);" -> '5316'.
    // Returns the call's argument (a name or an ID), or null for any other value.
    const formulaItemArg = (formula) => {
        const raw = (formula ?? '').toString();
        const call = WHOLE_ITEM_LOOKUP.exec(raw);
        if (!call) {
            return null;
        }
        return itemLookupArg(call);
    };

    // code with every string, template literal and comment replaced by a single space.
    const maskLiteralsAndComments = (code) => {
        let masked = '';
        for (let i = 0; i < code.length; i++) {
            const skipped = scanLiteralOrComment(code, i);
            if (skipped) {
                masked += ' ';
                i = skipped.end - 1;
                continue;
            }
            masked += code[i];
        }
        return masked;
    };

    // What an initial value reads: { keys, itemArgs }. keys are every identifier outside strings,
    // comments and property accesses (callers keep the ones that are variables); itemArgs are its
    // getOsrsItem arguments (names or IDs). Literal values read nothing.
    const formulaInputs = (formula) => {
        const raw = (formula ?? '').toString();
        if (!raw.startsWith('=')) return { keys: [], itemArgs: [] };
        const expression = raw.substring(1);
        const itemArgs = [...expression.matchAll(ITEM_LOOKUP_CALL)].map(itemLookupArg);
        const identifiers = maskLiteralsAndComments(expression).matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*/g);
        return { keys: [...new Set([...identifiers].map(m => m[0]))], itemArgs };
    };

    // Hue offsets for variables derived from the same inputs, so they stay distinguishable.
    const AUTO_COLOR_HUE_STEPS = [0, 14, -14, 28, -28, 42, -42];

    // { byId, byName } indexes over a list of items, in the shapes findItem takes.
    const indexItems = (items) => {
        const byId = {};
        const byName = new Map();
        for (const item of items) {
            if (item.id !== undefined) {
                byId[item.id] = item;
            }
            if (item.name) {
                byName.set(itemNameKey(item.name), item);
            }
        }
        return { byId, byName };
    };

    // The colors of what a variable reads: earlier variables (colorOf) and items.
    // coloredItems: indexItems() over the items that have a color.
    const inputColors = (variable, colorOf, coloredItems) => {
        const { keys, itemArgs } = formulaInputs(variable.formula);
        const itemColors = itemArgs
            .map(arg => findItem(arg, coloredItems.byId, coloredItems.byName)?.color)
            .filter(Boolean);
        return [
            ...keys.filter(k => k !== variable.key && colorOf.get(k)).map(k => colorOf.get(k)),
            ...itemColors,
        ];
    };

    // A blend of the input colors, a little lighter (one step of derivation further), turned by
    // the sibling's hue step.
    const derivedColor = (inputs, siblingIndex) => {
        const { h, s, l } = blendColors(inputs);
        const hue = (h + AUTO_COLOR_HUE_STEPS[siblingIndex % AUTO_COLOR_HUE_STEPS.length] + 360) % 360;
        return hslToHex(hue, clamp(s, 55, 95), clamp(l + 6, 35, 72));
    };

    // Recolors a scope's variables from their inputs (the variables declared before them and the
    // items their initial value reads), so derived values look related to what they're made from.
    // Variables that read nothing keep their color, as do lockedKeys (ones with a "// @color:" line).
    // globals: [{ key, color }]; items: [{ id, name, color }].
    // Returns { [key]: color } for the variables whose color changes.
    const autoVariableColors = (variables, { globals = [], items = [], lockedKeys = new Set() } = {}) => {
        const colorOf = new Map(globals.map(v => [v.key, v.color])); // key -> color, as variables are colored
        const coloredItems = indexItems(items);
        const siblingCounts = new Map(); // inputs signature -> variables colored from it so far
        const changes = {};

        variables.forEach(v => {
            const inputs = inputColors(v, colorOf, coloredItems);
            let color = v.color;
            if (inputs.length && !lockedKeys.has(v.key)) {
                const signature = [...new Set(inputs)].sort().join();
                const siblingIndex = siblingCounts.get(signature) || 0;
                siblingCounts.set(signature, siblingIndex + 1);
                color = derivedColor(inputs, siblingIndex);
                if (color !== v.color) changes[v.key] = color;
            }
            colorOf.set(v.key, color);
        });
        return changes;
    };


    // --- Parsing code: declarators ----------------------------------------------------------------

    // Splits text at commas outside brackets, strings and comments.
    const splitTopLevelCommas = (text) => {
        const parts = [];
        let depth = 0;
        let start = 0;
        for (let i = 0; i < text.length; i++) {
            const skipped = scanLiteralOrComment(text, i);
            if (skipped) {
                i = skipped.end - 1;
                continue;
            }
            const ch = text[i];
            if (OPENING_BRACKETS.includes(ch)) depth++;
            else if (CLOSING_BRACKETS.includes(ch)) depth--;
            else if (ch === ',' && depth === 0) {
                parts.push(text.slice(start, i));
                start = i + 1;
            }
        }
        parts.push(text.slice(start));
        return parts;
    };

    const OBJECT_PATTERN_PROPERTY = /^([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*(?:=[\s\S]*)?$/;

    // `{ A, B: Alias, C = 0 } = <expression>` -> [{ key: 'A', expression: '<expression>.A' },
    // { key: 'Alias', expression: '<expression>.B' }, ...]. null if the declarator isn't an object
    // pattern. Rest elements and nested patterns are skipped (they still work, just aren't listed).
    const parseObjectPattern = (declarator) => {
        const text = declarator.trim();
        if (!text.startsWith('{')) return null;
        const { close } = matchParen(text, 0);
        if (close === -1) return null;
        const init = text.slice(close + 1).match(/^\s*=\s*([\s\S]+)$/);
        if (!init) return null;

        // Simple sources (a name, a.b.c, or a call like importScope('X')) don't need parentheses.
        const source = init[1].trim();
        const base = /^[\w$.]+(?:\([^()]*\))?$/.test(source) ? source : `(${source})`;
        return splitTopLevelCommas(text.slice(1, close))
            .map(part => part.trim().match(OBJECT_PATTERN_PROPERTY))
            .filter(Boolean)
            .map(([, prop, alias]) => ({ key: alias || prop, expression: `${base}.${prop}` }));
    };

    // The names one declaration statement declares: `let a = 1, { b, c: d } = x` ->
    // [{ key: 'a', expression: '1' }, { key: 'b', expression: 'x.b' }, { key: 'd', expression: 'x.c' }].
    // Array and nested destructuring patterns aren't listed.
    const declaredBindings = (statement) => {
        const declarators = statement.replace(/^(?:const|let|var)\s+/, '');
        return splitTopLevelCommas(declarators).flatMap(declarator => {
            const destructured = parseObjectPattern(declarator);
            if (destructured) return destructured;
            const match = declarator.match(SCOPE_DECLARATOR);
            return match ? [{ key: match[1], expression: match[2] }] : [];
        });
    };

    // A declaration's doc comment lines -> { name, tags, color }.
    const parseDocComments = (docs) => {
        const nameLines = [];
        let tags = [];
        let color = null;
        docs.forEach(line => {
            const tagMatch = line.match(/^@tags:\s*(.*)$/i);
            const colorMatch = line.match(/^@color:\s*(#[0-9a-f]{6})\s*$/i);
            if (tagMatch) tags = normalizeTags(tagMatch[1]);
            else if (colorMatch) color = colorMatch[1];
            else nameLines.push(line);
        });
        return { name: nameLines.join(' '), tags, color };
    };

    // Why key can't be declared, or null. seenKeys: upper-cased keys declared so far.
    const bindingError = (key, seenKeys) => {
        if (/^I_\d+_(H|L)$/i.test(key)) return `"${key}" is reserved for an item price`;
        if (seenKeys.has(key.toUpperCase())) return `"${key}" is declared more than once (assign to it to change it)`;
        return null;
    };


    // --- Parsing code: finding top-level declarations ---------------------------------------------
    // One pass over the code, character by character, tracking just enough state to know where each
    // top-level const / let / var statement starts and ends, and which comment lines sit above it.

    // A statement carries on to the next line when its line ends, or the next line starts, with an operator.
    const ENDS_MID_STATEMENT = /[=+\-*/%&|^<>!?:,.([{]/;
    const STARTS_MID_STATEMENT = /[.?:+\-*/%&|^<>=!,)\]}]/;

    const continuesOnNextLine = (code, newline, lastCodeChar) => {
        if (ENDS_MID_STATEMENT.test(lastCodeChar)) return true;
        let next = newline + 1;
        while (/\s/.test(code[next] || '')) next++;
        if (code.startsWith('//', next) || code.startsWith('/*', next)) return false;
        return STARTS_MID_STATEMENT.test(code[next] || '');
    };

    const createDeclarationScan = () => ({
        declarations: [], // { text, docs, lineNo } per finished declaration
        errors: [],
        docs: [],         // comment lines collected for the next declaration
        open: null,       // the declaration being read: { start, docs, lineNo }
        depth: 0,         // bracket depth; only depth 0 is top level
        lineNo: 1,
        lineIsBlank: true,
        lineHasCode: false,
        lastCodeChar: '',
        atStatementStart: true,
    });

    // Whether the scan is at the start of a statement outside any block or open declaration.
    const atTopLevelStatementStart = (scan) => scan.atStatementStart && scan.depth === 0 && !scan.open;

    const closeDeclaration = (scan, code, end) => {
        if (scan.open) {
            const { start, docs, lineNo } = scan.open;
            scan.declarations.push({ text: code.slice(start, end), docs, lineNo });
        }
        scan.open = null;
    };

    const markCode = (scan, ch) => {
        scan.atStatementStart = false;
        scan.lineHasCode = true;
        scan.lastCodeChar = ch;
    };

    // A newline ends the open declaration unless the statement clearly carries on. A blank line
    // detaches the comments above it from the next declaration.
    const scanNewline = (scan, code, i) => {
        if (scan.depth === 0) {
            if (scan.open && !continuesOnNextLine(code, i, scan.lastCodeChar)) closeDeclaration(scan, code, i);
            if (scan.lineIsBlank && !scan.open) scan.docs = [];
            scan.atStatementStart = true;
        }
        scan.lineNo++;
        scan.lineIsBlank = true;
        scan.lineHasCode = false;
    };

    // // comment lines on their own line, directly above a top-level declaration, are its docs.
    // "// @group:" lines start a new section, so the comments above them aren't docs.
    const scanLineCommentDocs = (scan, text) => {
        if (scan.depth !== 0 || scan.open || scan.lineHasCode) return;
        if (/^\/\/\s*@group:/.test(text)) scan.docs = [];
        else scan.docs.push(text.replace(/^\/\/\s?/, '').trim());
    };

    const scanLiteralOrCommentToken = (scan, code, i, skipped) => {
        const text = code.slice(i, skipped.end);
        const isComment = code[i] === '/';
        if (skipped.unterminated) scan.errors.push(isComment ? 'Unterminated /* comment' : 'Unterminated string');

        if (isComment && text.startsWith('//')) {
            scanLineCommentDocs(scan, text);
        } else if (!isComment) {
            // A statement that starts with a string isn't a declaration; drop the docs.
            if (atTopLevelStatementStart(scan)) scan.docs = [];
            markCode(scan, code[i]);
        }
        scan.lineNo += text.split('\n').length - 1;
    };

    const scanCodeChar = (scan, code, i) => {
        const ch = code[i];
        if (atTopLevelStatementStart(scan)) {
            if (/^(?:const|let|var)\s/.test(code.slice(i, i + 6))) scan.open = { start: i, docs: scan.docs, lineNo: scan.lineNo };
            scan.docs = [];
        }
        markCode(scan, ch);

        if (OPENING_BRACKETS.includes(ch)) {
            scan.depth++;
        } else if (CLOSING_BRACKETS.includes(ch)) {
            scan.depth = Math.max(0, scan.depth - 1);
            // The end of a top-level block (if, for, function, ...) ends its statement.
            if (scan.depth === 0 && ch === '}') scan.atStatementStart = true;
        } else if (ch === ';' && scan.depth === 0) {
            closeDeclaration(scan, code, i);
            scan.atStatementStart = true;
        }
    };

    // { declarations: [{ text, docs, lineNo }], errors: string[] }
    const findTopLevelDeclarations = (code) => {
        const scan = createDeclarationScan();
        for (let i = 0; i < code.length; i++) {
            const ch = code[i];
            if (ch === '\n') {
                scanNewline(scan, code, i);
                continue;
            }
            if (/\s/.test(ch)) continue;
            scan.lineIsBlank = false;

            const skipped = scanLiteralOrComment(code, i);
            if (skipped) {
                scanLiteralOrCommentToken(scan, code, i, skipped);
                i = skipped.end - 1;
            } else {
                scanCodeChar(scan, code, i);
            }
        }
        closeDeclaration(scan, code, code.length);
        if (scan.depth > 0) scan.errors.push('Unclosed bracket');
        return { declarations: scan.declarations, errors: scan.errors };
    };


    // --- Parsing code -----------------------------------------------------------------------------

    // Returns { variables: [{ key, name, formula, tags, color }], errors: string[] }.
    // The code is any JavaScript; its variables are the top-level const / let / var declarations (not
    // ones inside a loop or block). A declaration ends at a top-level ";", or at the end of its line
    // unless the statement clearly carries on. `let a = 1, b = 2;` declares two variables, and so
    // does `const { a, b } = importScope('Other');`; array and nested destructuring work but aren't listed.
    const parseScopeCode = (code) => {
        const { declarations, errors } = findTopLevelDeclarations(code || '');
        const seenKeys = new Set();
        const variables = [];

        declarations.forEach(({ text, docs, lineNo }) => {
            const { name, tags, color } = parseDocComments(docs);
            declaredBindings(text).forEach(({ key, expression }) => {
                const error = bindingError(key, seenKeys);
                if (error) {
                    errors.push(`Line ${lineNo}: ${error}`);
                    return;
                }
                seenKeys.add(key.toUpperCase());
                variables.push({ key, name, formula: expressionToFormula(expression ?? ''), tags: [...tags], color });
            });
        });

        return { variables, errors };
    };


    // --- Public API -------------------------------------------------------------------------------

    return Object.freeze({
        parseScopeCode,
        generateScopeCode,
        generateImpliedCode,
        mergeParsedVariables,
        migrateLegacyItemRefs,
        autoVariableColors,
        formulaItemArg,
        unescapeQuoted,
    });
})();

// Classic scripts share one global scope, so the public API is unpacked here for the files that
// follow (the same way vue-globals.js unpacks Vue).
const {
    parseScopeCode,
    generateScopeCode,
    generateImpliedCode,
    mergeParsedVariables,
    migrateLegacyItemRefs,
    autoVariableColors,
    formulaItemArg,
    unescapeQuoted,
} = ScopeCode;
