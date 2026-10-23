// Pure code evaluation, independent of Vue.
//
// A block of code (the globals' or a scope's) runs as one JavaScript program, top to bottom, so
// loops, counters and reassignment (let x = 1; x = 2;) work, and a name must be declared before
// it's used. It runs in strict mode against a scope that holds:
//   getOsrsItem('Name')  -> { id, name, highPrice, lowPrice, spread, members, limit, ... } of any GE
//                           item (name is case-insensitive; see toCodeItem in itemRefs.js)
//   getOsrsItem(id)      -> the same, by item ID (a number, or a string of digits)
//   queryOsrsItems()     -> a query builder over every GE item (see itemQuery.js)
//   queryOsrsItemRecipes(), queryOsrsItemLinks(type)
//                        -> query builders over recipes and the links between items (itemGraph.js)
//   ui.table(...), ui.items(...), ...
//                        -> panels for the UI section beside the editor (uiLibrary.js)
//   I_<id>_H / I_<id>_L  -> legacy refs to an item's high / low price, still evaluated
//   global variable keys -> their values, read-only (a scope's own declarations override them)
//   MIN, MAX, SUM, ...   -> the library in functions.js
// The program's top-level declarations are its variables (see parseScopeCode); each one's value
// is what it holds when the program finishes. RS shorthand like "10k" is expanded first.
//
// Uses globals from scripts loaded before it:
//   utils/format.js        convertRunescapeNumbers
//   formula/sourceScan.js  scanLiteralOrComment, matchParen
//   formula/functions.js   FORMULA_FUNCTIONS, isFormulaFunction
//   formula/itemRefs.js    ITEM_LOOKUP_FN, isItemIdArg, findItem, toCodeItem
//   formula/itemQuery.js   ITEM_QUERY_FN, createItemQuery, untaggedItemSource
//   formula/itemGraph.js   RECIPE_QUERY_FN, LINK_QUERY_FN, createItemRecipeQuery, createItemLinkQuery
//   formula/uiLibrary.js   UI_LIBRARY_FN, createUiLibrary
//
// Sections: shared types -> loop guards -> error lines -> the code's environment -> result
// values -> running a program -> reading a run's result -> public API.
//
// Everything is private to the FormulaEngine closure except the names in its returned object
// (see "Public API" at the bottom), which are also exposed as globals for the other scripts.

const FormulaEngine = (() => {

    // --- Shared types -----------------------------------------------------------------------------

    /**
     * What runScopeCode needs besides the code itself. Every field is optional.
     * @typedef {Object} RunContext
     * @property {Object<string, Item>} [items] Items by id, for getOsrsItem(id) and legacy
     *     I_<id>_H / I_<id>_L refs.
     * @property {Map<string, Item>} [itemsByName] Items by itemNameKey(name), for getOsrsItem.
     * @property {Map<string, *>} [globals] Global variable values the code can read.
     * @property {(function(string): Object<string, *>)|null} [importScope] Another scope's public
     *     values by name, for importScope('Name'). Omitted for the globals, which can't import scopes.
     * @property {ItemQuerySource|null} [itemQuerySource] What queryOsrsItems() searches, with item
     *     tags. Defaults to the items alone, without tags.
     */

    /**
     * The result of runScopeCode.
     * @typedef {Object} RunResult
     * @property {Map<string, *>} values Each key's final value; an "#ERROR: ..." string for keys
     *     the run never reached.
     * @property {string|null} error The run's error message, or null if it finished.
     * @property {Set<string>|null} exports The keys of a top-level `return { ... }`, or null when
     *     there was none (every declaration is then public).
     * @property {UiPanel[]} ui The panels the code's ui calls made, in call order (see
     *     uiLibrary.js). If the run threw, the ones made before it did.
     */

    /**
     * A piece of text to insert, at an index into the original text.
     * @typedef {[number, string]} Insertion
     */


    // --- Loop guards ------------------------------------------------------------------------------
    // A guard call is put in front of every while / for loop condition (do...while included), so a
    // loop that never ends throws instead of freezing the page. for...in / for...of are left alone.
    // Only text within a line is inserted, so line numbers in errors still match the code.

    const LOOP_GUARD = '__ge.tick()';
    const LOOP_TIME_LIMIT_MS = 300;
    const IDENTIFIER = /[A-Za-z_$][\w$]*/y;

    /**
     * Every `while` / `for` keyword outside strings and comments.
     * @param {string} code
     * @returns {{ keyword: 'while'|'for', end: number }[]} end: the index just past the keyword.
     */
    const findLoopKeywords = (code) => {
        const found = [];

        for (let i = 0; i < code.length; i++) {
            const skipped = scanLiteralOrComment(code, i);
            if (skipped) {
                i = skipped.end - 1;
                continue;
            }

            IDENTIFIER.lastIndex = i;
            const match = IDENTIFIER.exec(code);
            if (!match) {
                continue;
            }

            const word = match[0];
            const isLoopKeyword = word === 'while' || word === 'for';
            const isProperty = code[i - 1] === '.'; // obj.while is a property, not a keyword
            if (isLoopKeyword && !isProperty) {
                found.push({ keyword: word, end: i + word.length });
            }

            // Skip the rest of the identifier, so the `while` in `awhile` isn't matched.
            i += word.length - 1;
        }

        return found;
    };

    /**
     * Finds the "(" that follows from, skipping whitespace.
     * @param {string} code
     * @param {number} from
     * @returns {number} Its index, or -1 if the next non-space character isn't a "(".
     */
    const openParenAfter = (code, from) => {
        let i = from;
        while (i < code.length && /\s/.test(code[i])) {
            i++;
        }

        if (code[i] === '(') {
            return i;
        }
        return -1;
    };

    /**
     * The insertions that guard one loop's condition. The condition is wrapped in parentheses so
     * `a || b` becomes `tick() && (a || b)`, not `tick() && a || b`.
     *   while (cond)          -> while (tick() && (cond))
     *   for (init; cond; inc) -> for (init; tick() && (cond); inc)
     *   for (init;; inc)      -> for (init; tick(); inc)
     * @param {string} code
     * @param {'while'|'for'} keyword
     * @param {number} open Index of the "(" after the keyword.
     * @returns {Insertion[]} Empty for for...in / for...of and for unclosed parentheses.
     */
    const loopGuardInserts = (code, keyword, open) => {
        const { close, semicolons } = matchParen(code, open);
        if (close === -1) {
            return []; // unclosed, so the code won't run anyway
        }

        if (keyword === 'while') {
            return [
                [open + 1, `${LOOP_GUARD} && (`],
                [close, ')'],
            ];
        }

        // for (init; cond; inc) has exactly two top-level semicolons; for...in / for...of have none.
        if (semicolons.length !== 2) {
            return [];
        }

        const [conditionStart, conditionEnd] = semicolons;
        const condition = code.slice(conditionStart + 1, conditionEnd);
        if (condition.trim() === '') {
            return [[conditionStart + 1, ` ${LOOP_GUARD}`]];
        }
        return [
            [conditionStart + 1, ` ${LOOP_GUARD} && (`],
            [conditionEnd, ')'],
        ];
    };

    /**
     * Applies insertions, all given as indices into the original text. Inserting from the end
     * backwards keeps the earlier indices valid.
     * @param {string} text
     * @param {Insertion[]} inserts
     * @returns {string}
     */
    const applyInsertions = (text, inserts) => {
        const lastFirst = [...inserts].sort((a, b) => b[0] - a[0]);

        let result = text;
        for (const [index, insert] of lastFirst) {
            result = result.slice(0, index) + insert + result.slice(index);
        }
        return result;
    };

    /**
     * Puts the loop guard in front of every while / for loop condition in code.
     * @param {string} code
     * @returns {string}
     */
    const guardLoops = (code) => {
        const inserts = [];

        for (const { keyword, end } of findLoopKeywords(code)) {
            const open = openParenAfter(code, end);
            if (open !== -1) {
                inserts.push(...loopGuardInserts(code, keyword, open));
            }
        }

        return applyInsertions(code, inserts);
    };


    // --- Error line numbers -----------------------------------------------------------------------
    // The generated function is named in stack traces (via sourceURL), so an error can point at the
    // line of the user's code it was thrown from.

    const CODE_SOURCE_URL = 'ge-tracker-code';
    const SOURCE_LINE = new RegExp(`${CODE_SOURCE_URL}:(\\d+):\\d+`);

    /**
     * Reported line - code line, measured on first use; null if this browser doesn't report one.
     * @type {number|null|undefined}
     */
    let sourceLineOffset;

    /**
     * The line number the stack trace gives for the generated function.
     * @param {*} error
     * @returns {number|null} null when the stack doesn't mention the generated function.
     */
    const reportedLine = (error) => {
        const stack = (error && error.stack) || '';
        const match = SOURCE_LINE.exec(stack);
        if (!match) {
            return null;
        }
        return Number(match[1]);
    };

    /**
     * Measures sourceLineOffset. Browsers number the lines of a new Function differently (some
     * count the wrapper they add), so this uses an Error created on line 2 of a function shaped
     * like the real program (whose code also starts on its second line). An Error records its
     * stack when it's created, so it doesn't need to be thrown.
     * @returns {number|null} null when the browser doesn't report line numbers.
     */
    const measureSourceLineOffset = () => {
        const probe = new Function(`\nreturn new Error();\n//# sourceURL=${CODE_SOURCE_URL}`)();
        const line = reportedLine(probe);
        if (line === null) {
            return null;
        }
        return line - 1;
    };

    /**
     * The line of the user's code an error was thrown from.
     * @param {*} error
     * @returns {number|null} null when the browser doesn't say.
     */
    const errorLine = (error) => {
        if (sourceLineOffset === undefined) {
            sourceLineOffset = measureSourceLineOffset();
        }

        const line = reportedLine(error);
        if (line === null || sourceLineOffset === null) {
            return null;
        }
        return line - sourceLineOffset;
    };

    /**
     * An error thrown by the code, as a message: "Line 3: x is not defined", or just the message
     * when the line is unknown.
     * @param {*} error Anything the code threw, not only an Error.
     * @returns {string}
     */
    const formatRunError = (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const line = errorLine(error);
        if (!line) {
            return message;
        }
        return `Line ${line}: ${message}`;
    };


    // --- The code's environment -------------------------------------------------------------------
    // The names the code can use without declaring them.

    /** A legacy item ref, I_<id>_H or I_<id>_L: captures the id and H / L. */
    const ITEM_REF_NAME = /^I_(\d+)_(H|L)$/;

    /** importScope('Name') in a scope's code: another scope's public values (see useEvaluation). */
    const SCOPE_IMPORT_FN = 'importScope';

    /**
     * Everything the scope proxy can supply.
     * @typedef {Object} Env
     * @property {Object<string, Item>} items Items by id.
     * @property {Map<string, *>} globals
     * @property {(function(string): Object<string, *>)|null} importScope null for the globals' own
     *     code, which can't import scopes.
     * @property {function(string|number): Object} getOsrsItem
     * @property {function(): Object} queryOsrsItems
     * @property {function(): Object} queryOsrsItemRecipes
     * @property {function(string): Object} queryOsrsItemLinks
     * @property {Object} ui This run's ui object (see createUiLibrary).
     */

    /**
     * The error for a getOsrsItem argument that matches no item.
     * @param {string|number} nameOrId
     * @returns {Error}
     */
    const unknownItemError = (nameOrId) => {
        if (isItemIdArg(nameOrId)) {
            return new Error(`Unknown item ID ${String(nameOrId).trim()}`);
        }
        return new Error(`Unknown item "${nameOrId}"`);
    };

    /**
     * Creates getOsrsItem('Name') / getOsrsItem(id), an O(1) lookup by name or item ID.
     * @param {Object<string, Item>} itemsById
     * @param {Map<string, Item>} itemsByName Items by itemNameKey(name).
     * @param {ItemQuerySource} querySource Where the item's tags come from.
     * @returns {function(string|number): Object} The item as toCodeItem builds it (itemRefs.js).
     *     Throws for an unknown item, except before the item list has loaded.
     */
    const createItemLookup = (itemsById, itemsByName, querySource) => {
        return (nameOrId) => {
            const item = findItem(nameOrId, itemsById, itemsByName);
            if (item) {
                return toCodeItem(item, querySource.tagsOf(item.id));
            }

            // Before the item list has loaded, every item reads as 0 rather than an error.
            if (itemsByName.size === 0) {
                return toCodeItem({ id: null, name: String(nameOrId) }, []);
            }

            throw unknownItemError(nameOrId);
        };
    };

    /**
     * The value of a legacy I_<id>_H / I_<id>_L ref.
     * @param {Object<string, Item>} items Items by id.
     * @param {string} id
     * @param {'H'|'L'} type
     * @returns {number} The item's high / low price, or 0 for an unknown item.
     */
    const legacyItemPrice = (items, id, type) => {
        const item = items[id];
        if (!item) {
            return 0;
        }

        const price = type === 'H' ? item.highPrice : item.lowPrice;
        return price || 0;
    };

    /**
     * @param {Env} env
     * @param {string} name
     * @returns {boolean} Whether name is importScope and this code is allowed to import scopes.
     */
    const isScopeImport = (env, name) => {
        return name === SCOPE_IMPORT_FN && Boolean(env.importScope);
    };

    /**
     * @param {Env} env
     * @param {string} name
     * @returns {boolean} Whether env supplies name.
     */
    const envProvides = (env, name) => {
        return isFormulaFunction(name)
            || ITEM_REF_NAME.test(name)
            || env.globals.has(name)
            || name === ITEM_LOOKUP_FN
            || name === ITEM_QUERY_FN
            || name === RECIPE_QUERY_FN
            || name === LINK_QUERY_FN
            || name === UI_LIBRARY_FN
            || isScopeImport(env, name);
    };

    /**
     * The value of a name env supplies. Precedence: FORMULA_FUNCTIONS, then legacy item refs, then
     * globals (so a global named getOsrsItem or importScope wins over the built-in).
     * @param {Env} env
     * @param {string} name
     * @returns {*} undefined when env doesn't supply name.
     */
    const envResolve = (env, name) => {
        if (isFormulaFunction(name)) {
            return FORMULA_FUNCTIONS[name];
        }

        const itemRef = ITEM_REF_NAME.exec(name);
        if (itemRef) {
            const [, id, type] = itemRef;
            return legacyItemPrice(env.items, id, type);
        }

        if (env.globals.has(name)) {
            return env.globals.get(name);
        }
        if (name === ITEM_LOOKUP_FN) {
            return env.getOsrsItem;
        }
        if (name === ITEM_QUERY_FN) {
            return env.queryOsrsItems;
        }
        if (name === RECIPE_QUERY_FN) {
            return env.queryOsrsItemRecipes;
        }
        if (name === LINK_QUERY_FN) {
            return env.queryOsrsItemLinks;
        }
        if (name === UI_LIBRARY_FN) {
            return env.ui;
        }
        if (isScopeImport(env, name)) {
            return env.importScope;
        }

        // Only reachable when the code reads the scope object directly (__scope.x), not through `with`.
        return undefined;
    };

    /**
     * Creates the object the program runs `with`. `with` only consults it for names it claims
     * (`has`); everything else (Math, JSON, ...) falls through to the real global scope, and the
     * code's own declarations shadow it. It's read-only: assigning to one of its names throws.
     * Non-string names are symbols such as Symbol.unscopables, which `with` reads; they're never ours.
     * @param {Required<RunContext>} context
     * @param {Object} ui This run's ui object (see createUiLibrary).
     * @returns {Proxy}
     */
    const createScopeProxy = ({ items, itemsByName, globals, importScope, itemQuerySource }, ui) => {
        const querySource = itemQuerySource || untaggedItemSource(items);
        const graphContext = { itemsById: items, itemsByName, source: querySource };
        const env = {
            items,
            globals,
            importScope,
            getOsrsItem: createItemLookup(items, itemsByName, querySource),
            queryOsrsItems: () => createItemQuery(querySource),
            queryOsrsItemRecipes: () => createItemRecipeQuery(graphContext),
            queryOsrsItemLinks: (type) => createItemLinkQuery(graphContext, type),
            ui,
        };

        return new Proxy({}, {
            has: (_, name) => {
                if (typeof name !== 'string') {
                    return false;
                }
                return envProvides(env, name);
            },
            get: (_, name) => {
                if (typeof name !== 'string') {
                    return undefined;
                }
                return envResolve(env, name);
            },
            set: (_, name) => {
                throw new TypeError(`"${String(name)}" is read-only here; declare your own with let to change it`);
            },
        });
    };


    // --- Result values ----------------------------------------------------------------------------

    /**
     * Whether a value from a run is an error ("#ERROR: ..."), as RunResult.values holds them.
     * @param {*} value
     * @returns {boolean}
     */
    const isErrorValue = (value) => {
        return typeof value === 'string' && value.startsWith('#ERROR');
    };

    /**
     * Rounds fractions to 2 decimal places for display.
     * @param {*} result
     * @returns {*} The rounded number; whole numbers and non-numbers are returned as they are.
     */
    const roundResult = (result) => {
        if (typeof result !== 'number' || Number.isInteger(result)) {
            return result;
        }
        return parseFloat(result.toFixed(2));
    };


    // --- Running a program ------------------------------------------------------------------------

    /**
     * The `__ge` object the program talks to.
     * @typedef {Object} Runtime
     * @property {Object<string, function(): *>} read Each key's reader, returning its current
     *     value. Filled in by the program itself (see buildProgram).
     * @property {function(): true} tick The loop guard: throws once the run has taken longer than
     *     LOOP_TIME_LIMIT_MS.
     */

    /**
     * Creates the runtime for one run; its time limit starts now.
     * @returns {Runtime}
     */
    const createRuntime = () => {
        const deadline = performance.now() + LOOP_TIME_LIMIT_MS;
        let ticks = 0;

        const tick = () => {
            ticks++;

            // Reading the clock is slow, so it's only checked every 1000 ticks.
            const isClockCheck = ticks % 1000 === 0;
            if (isClockCheck && performance.now() > deadline) {
                throw new Error(`Stopped after ${LOOP_TIME_LIMIT_MS}ms: does a loop never end?`);
            }

            // true, so the guard can sit in front of a loop condition: tick() && (cond)
            return true;
        };

        return {
            read: {},
            tick,
        };
    };

    /**
     * The source of the function that runs the code. It's a sloppy-mode outer function, so `with`
     * is allowed, around a strict inner function holding the code (so its var declarations are
     * found before the proxy, and assigning an undeclared name throws).
     * Before the code runs, __ge.read gets a reader closure per key; closures see let/const
     * bindings declared later, so after the run each one returns its variable's final value (or
     * throws if the run never reached its declaration). The code starts on the second line (see
     * errorLine).
     * @param {string} code
     * @param {string[]} keys The code's top-level declarations.
     * @returns {string} A function body taking (__scope, __ge).
     */
    const buildProgram = (code, keys) => {
        const readers = keys.map(key => `${JSON.stringify(key)}: () => ${key}`).join(', ');
        const userCode = guardLoops(convertRunescapeNumbers(code || ''));

        const header = `with (__scope) { return (function () { 'use strict'; __ge.read = { ${readers} };\n`;
        const footer = `\n})(); }\n//# sourceURL=${CODE_SOURCE_URL}`;
        return header + userCode + footer;
    };

    /**
     * Runs a program built by buildProgram.
     * @param {string} program
     * @param {Proxy} scope From createScopeProxy.
     * @param {Runtime} runtime
     * @returns {{ returned: *, error: string|null }} returned: what the code's top-level return gave;
     *     error: the message if it threw (or didn't compile), otherwise null.
     */
    const executeProgram = (program, scope, runtime) => {
        try {
            const run = new Function('__scope', '__ge', program);
            const returned = run(scope, runtime);
            return { returned, error: null };
        } catch (e) {
            return { returned: undefined, error: formatRunError(e) };
        }
    };

    /**
     * One key's final value, read through its reader.
     * @param {(function(): *)|undefined} read
     * @param {string|null} runError The run's error message, or null.
     * @returns {*} The rounded value, or an "#ERROR: ..." string if it can't be read.
     */
    const readFinalValue = (read, runError) => {
        // No reader: the program failed before it could set them up (e.g. a syntax error).
        if (!read) {
            return `#ERROR: ${runError}`;
        }

        try {
            return roundResult(read());
        } catch (e) {
            // The run never reached this declaration: it threw, or returned before it.
            return `#ERROR: ${runError || e.message}`;
        }
    };

    /**
     * Each key's final value. If the run threw, declarations it already ran keep their value and
     * the ones it never reached read as the error.
     * @param {string[]} keys
     * @param {Object<string, function(): *>} readers Runtime.read after the run.
     * @param {string|null} runError
     * @returns {Map<string, *>}
     */
    const readDeclaredValues = (keys, readers, runError) => {
        const values = new Map();
        for (const key of keys) {
            values.set(key, readFinalValue(readers[key], runError));
        }
        return values;
    };

    /**
     * Whether value is a plain `{ ... }` literal, the only return that counts as public keys (not
     * an array, number, Map, ...).
     * @param {*} value
     * @returns {boolean}
     */
    const isObjectLiteral = (value) => {
        if (value === null || typeof value !== 'object') {
            return false;
        }
        return Object.getPrototypeOf(value) === Object.prototype;
    };

    /**
     * Runs a block of code and reads back its variables.
     * A top-level `return { A, B, Total: A + B }` makes its keys the public ones (exports) and the
     * rest private; returned values are added to (or replace) the declared values. Without one,
     * exports is null and every declaration is public.
     * @param {string} code
     * @param {string[]} keys Its top-level declarations, to read back (see parseScopeCode).
     * @param {RunContext} context
     * @returns {RunResult}
     */
    const runScopeCode = (code, keys, context) => {
        const { items = {}, itemsByName = new Map(), globals = new Map(), importScope = null, itemQuerySource = null } = context;

        // A fresh ui object per run, so each run (an imported scope's included) shows only its own panels.
        const ui = createUiLibrary({ itemsById: items, itemsByName });
        const scope = createScopeProxy({ items, itemsByName, globals, importScope, itemQuerySource }, ui.api);
        const runtime = createRuntime();
        const { returned, error } = executeProgram(buildProgram(code, keys), scope, runtime);

        const values = readDeclaredValues(keys, runtime.read, error);
        if (!isObjectLiteral(returned)) {
            return { values, error, exports: null, ui: ui.panels };
        }

        const exports = new Set(Object.keys(returned));
        for (const key of exports) {
            values.set(key, roundResult(returned[key]));
        }
        return { values, error, exports, ui: ui.panels };
    };


    // --- Reading a run's result -------------------------------------------------------------------

    /**
     * Whether a run's key is public (see runScopeCode).
     * @param {RunResult} result
     * @param {string} key
     * @returns {boolean}
     */
    const isExported = (result, key) => {
        if (!result.exports) {
            return true;
        }
        return result.exports.has(key);
    };

    /**
     * Keys a run returned without declaring them, e.g. Total in `return { Total: A + B }`.
     * @param {RunResult} result
     * @param {{ key: string }[]} [variables] The declared variables.
     * @returns {string[]}
     */
    const returnedOnlyKeys = (result, variables) => {
        if (!result.exports) {
            return [];
        }

        const declared = new Set((variables || []).map(v => v.key));
        return [...result.exports].filter(key => !declared.has(key));
    };

    /**
     * The public values of a run, e.g. the globals a scope can see.
     * @param {RunResult} result
     * @returns {Map<string, *>} result.values itself when every key is public, otherwise a new Map.
     */
    const exportedValues = (result) => {
        if (!result.exports) {
            return result.values;
        }

        const publicEntries = [...result.values].filter(([key]) => result.exports.has(key));
        return new Map(publicEntries);
    };


    // --- Public API -------------------------------------------------------------------------------

    return Object.freeze({
        // Running code and reading its result
        runScopeCode,
        isExported,
        exportedValues,
        returnedOnlyKeys,
        isErrorValue,

        // A name the code's environment supplies (scopeCode.js treats it as known)
        SCOPE_IMPORT_FN,
    });
})();

// Classic scripts share one global scope, so the public API is unpacked here for the files that
// follow (the same way vue-globals.js unpacks Vue).
const {
    runScopeCode,
    isExported,
    exportedValues,
    returnedOnlyKeys,
    isErrorValue,
    SCOPE_IMPORT_FN,
} = FormulaEngine;
