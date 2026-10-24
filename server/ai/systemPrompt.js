// The chat's system prompt: what the app is, how to work in it, and the reference for everything
// scope code can call. The reference is read from the browser app's own source when the server
// starts (the header comments of the formula files, and the function docs in functions.js), so it
// stays in step with the code without a second copy to maintain.
//
// It's built once and never changes while the server runs, so Anthropic's prompt cache can reuse
// it across every request (anything per request goes in the messages instead).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// The files whose header comment documents something scope code can use, in reading order.
const DOCUMENTED_FILES = [
    'formula/engine.js',
    'formula/scopeCode.js',
    'formula/itemRefs.js',
    'formula/itemQuery.js',
    'formula/itemGraph.js',
    'formula/uiLibrary.js',
];

// Header paragraphs that are about the source files rather than about writing code: they'd only
// distract the model. Matched against a paragraph's first line.
const INTERNAL_PARAGRAPH_STARTS = [
    'Uses globals from',
    'Sections:',
    'Everything is private',
    'To add a function',
    'Panel shapes',
];

const INTRODUCTION = `You are the AI assistant built into GE Tracker: a web app for Old School RuneScape (OSRS) players to track Grand Exchange (GE) prices and compute values like profit margins with small JavaScript programs.

# The app

- Scopes: each scope is a named block of code the user writes. Its top-level declarations are its variables, and their values are shown beside the editor. A scope can also draw panels (tables, item lists, stats, form inputs) with the ui library. "The sandbox" or "my code" means a scope's code.
- Globals: one block of code whose public variables every scope can read without declaring them.
- Item tags: labels on GE items (built-in ones from the OSRS wiki, plus the user's own), used to search items with queryOsrsItems().tagged(...).
- Prices come from the OSRS wiki's real-time prices API. highPrice is the latest instant-buy price and lowPrice the latest instant-sell price, both in gp.

Each user message starts with an <app_context> block saying which tab and scope the user is looking at. When the user says "this scope" or "my code" they mean that scope.

# How to work

- Use your tools rather than guessing. Item names must match the game exactly, so look them up (find_items) before writing them into code. Check a tag exists (list_item_tags) before using it.
- To change code: read it first (read_code), write the new version, test it with run_code until it runs without errors and the values look right, then call propose_edit. The user sees your change as a diff and decides whether to apply it; nothing changes until they do. Only call propose_edit once per change, with the tested code.
- Prefer small, targeted edits over rewriting a whole scope, and keep the user's style, names and comments. Never remove code the user didn't ask you to change.
- To answer a question about items or prices, run_code is often the quickest way: it runs any snippet against live prices and returns its top-level variables, for example \`const top = queryOsrsItems().tagged('herb').sortBy('highPrice', 'desc').limit(5).list().map(i => ({ name: i.name, high: i.highPrice }));\`.
- Keep replies short and concrete. Show prices with thousands separators or OSRS shorthand (1.2M). When you changed code, say in a sentence or two what you changed.
- If a request is ambiguous in a way that changes what you'd write, ask one short question instead of guessing.

# Writing scope code

Scope code is plain JavaScript (strict mode) with the extra names listed in the reference below. There are no imports, no DOM, no fetch and no timers. RuneScape shorthand like 10k, 1.5m and 2b is allowed in numbers. Loops that run longer than a fraction of a second are stopped with an error.

What getOsrsItem and queryOsrsItems give back for an item: { id, name, highPrice, lowPrice, spread, members, limit, highalch, lowalch, value, examine, icon, tags }. limit is the GE buy limit per 4 hours (or null); highalch and lowalch are alchemy values; tags are the item's own tag keys.

A top-level \`return { A, B }\` makes only those keys public: other scopes and the dashboard see them, and the rest are private. Without a return, every declaration is public.

# Reference

The rest of this prompt is the reference for everything scope code can call, taken from the app's source.`;

// --- Reading the docs from the source ---------------------------------------------------------

// The comment lines at the top of a file, without their "// " prefix, up to the first line of code.
const readHeaderComment = (source) => {
    const lines = [];
    for (const line of source.split(/\r?\n/)) {
        if (!line.startsWith('//')) {
            break;
        }
        lines.push(line.replace(/^\/\/ ?/, ''));
    }
    return lines.join('\n');
};

// The header without the paragraphs about the source files themselves.
const withoutInternalParagraphs = (header) => {
    const paragraphs = header.split(/\n\s*\n/);
    const kept = paragraphs.filter(paragraph => {
        const firstLine = paragraph.trimStart();
        return !INTERNAL_PARAGRAPH_STARTS.some(start => firstLine.startsWith(start));
    });
    return kept.join('\n\n').trim();
};

const readFileDocs = (jsDir, file) => {
    const source = fs.readFileSync(path.join(jsDir, file), 'utf8');
    const docs = withoutInternalParagraphs(readHeaderComment(source));
    return `## ${path.basename(file)}\n\n${docs}`;
};

// FORMULA_FUNCTION_REFERENCE from functions.js. It's a browser script with no imports, so it runs
// as it is in an empty context.
const loadFunctionReference = (jsDir) => {
    const source = fs.readFileSync(path.join(jsDir, 'formula/functions.js'), 'utf8');
    const context = vm.createContext({});
    vm.runInContext(`${source}\n;globalThis.__reference = FORMULA_FUNCTION_REFERENCE;`, context);
    return context.__reference;
};

const describeFunction = (fn) => {
    const lines = [`- ${fn.signature}: ${fn.description}`];
    for (const param of fn.params) {
        lines.push(`    - ${param.name}: ${param.description}`);
    }
    if (fn.returns) {
        lines.push(`    - returns: ${fn.returns}`);
    }
    return lines.join('\n');
};

// Math's functions are listed by name only: the model knows them, and their docs are long.
const formatFunctionReference = (groups) => {
    const sections = ['## Functions (call them without declaring them)'];
    for (const group of groups) {
        if (group.title === 'Math') {
            const names = group.functions.map(fn => fn.name).join(', ');
            sections.push(`### Math\n\nEvery JavaScript Math function in upper case: ${names}.`);
            continue;
        }
        sections.push(`### ${group.title}\n\n${group.functions.map(describeFunction).join('\n')}`);
    }
    return sections.join('\n\n');
};

/**
 * @param {string} publicDir  config.publicDir
 * @returns {string}
 */
export const buildSystemPrompt = (publicDir) => {
    const jsDir = path.join(publicDir, 'js');
    const fileDocs = DOCUMENTED_FILES.map(file => readFileDocs(jsDir, file));
    const functionDocs = formatFunctionReference(loadFunctionReference(jsDir));
    return [INTRODUCTION, ...fileDocs, functionDocs].join('\n\n');
};
