// What an agent's tool calls mean: a human description for the feed, and the
// signals the supervisor cares about (files edited, tests run, commits made).

import { baseName, truncate } from './format.js';

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

// Matches the commands agents use to run the suite, e.g. "npm test",
// "npx vitest run test/x.test.js", "npm run test -- --watch=false".
const TEST_COMMAND = /\b(npm (run )?test|npx vitest|vitest( run)?|npx jest|jest)\b/;

const relativePath = (path) => {
    return String(path ?? '').replace(/^\.\//, '');
};

const firstLine = (text) => {
    return String(text ?? '').split('\n')[0];
};

// { icon, verb, target, detail } for a tool call. `target` is the one-line
// summary shown in monospace; `detail` is optional extra context.
export const describeTool = (name, input) => {
    const args = input ?? {};

    switch (name) {
        case 'Bash':
            return { icon: 'terminal', verb: 'Run', target: firstLine(args.command), detail: args.description };
        case 'Read':
            return { icon: 'file', verb: 'Read', target: relativePath(args.file_path) };
        case 'Edit':
        case 'MultiEdit':
        case 'NotebookEdit':
            return { icon: 'edit', verb: 'Edit', target: relativePath(args.file_path ?? args.notebook_path) };
        case 'Write':
            return { icon: 'filePlus', verb: 'Write', target: relativePath(args.file_path) };
        case 'Grep': {
            let target = args.pattern ?? '';
            if (args.path) {
                target += `  in ${relativePath(args.path)}`;
            }
            return { icon: 'search', verb: 'Search', target };
        }
        case 'Glob':
            return { icon: 'search', verb: 'Find files', target: args.pattern ?? '' };
        case 'TodoWrite':
            return { icon: 'list', verb: 'Update plan', target: `${(args.todos ?? []).length} steps` };
        case 'Task':
        case 'Agent':
            return { icon: 'users', verb: 'Delegate', target: args.description ?? '' };
        case 'WebFetch':
            return { icon: 'globe', verb: 'Fetch', target: args.url ?? '' };
        case 'WebSearch':
            return { icon: 'globe', verb: 'Search web', target: args.query ?? '' };
        default:
            return { icon: 'activity', verb: name, target: truncate(JSON.stringify(args), 120) };
    }
};

// A short present-tense line for "what is it doing right now".
export const describeActivity = (name, input) => {
    const { verb, target, detail } = describeTool(name, input);

    if (name === 'Bash' && detail) {
        return detail;
    }
    if (EDIT_TOOLS.has(name) || name === 'Read') {
        return `${verb} ${baseName(target)}`;
    }
    return `${verb} ${truncate(target, 80)}`;
};

// The file a tool call changes, or undefined.
export const editedFile = (name, input) => {
    if (!EDIT_TOOLS.has(name)) {
        return undefined;
    }
    return relativePath(input?.file_path ?? input?.notebook_path) || undefined;
};

export const readFile = (name, input) => {
    if (name !== 'Read') {
        return undefined;
    }
    return relativePath(input?.file_path) || undefined;
};

export const isTestRun = (name, input) => {
    return name === 'Bash' && TEST_COMMAND.test(String(input?.command ?? ''));
};

// Reads vitest/jest summary lines such as
//   " Tests  2 failed | 83 passed (85)"  -> { passed: 83, failed: 2 }
//   "Tests:       85 passed, 85 total"   -> { passed: 85, failed: 0 }
// Returns undefined when the output has no summary (the agent filtered it
// away, say) and the command didn't fail either.
export const parseTestResult = (output, isError) => {
    const summary = /^\s*Tests:?\s+(.*)$/m.exec(output);

    if (summary) {
        const failed = Number(/(\d+) failed/.exec(summary[1])?.[1] ?? 0);
        const passed = Number(/(\d+) passed/.exec(summary[1])?.[1] ?? 0);
        return { passed, failed };
    }

    if (isError) {
        return { passed: 0, failed: 1 };
    }
    return undefined;
};

// Git prints "[agent/issue-4 c803670] RALPH: Fix issue #4 ..." after a commit.
const COMMIT_LINE = /\[([^\s\]]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)/;

// Agents often commit with -q and then check with `git log --oneline -1`,
// which prints "bf752d8 RALPH: Fix issue #3 ...".
const ONELINE_LOG = /^([0-9a-f]{7,40}) (.+)$/m;

export const parseCommit = (name, input, output) => {
    if (name !== 'Bash' || !/\bgit\b[^|;&]*\bcommit\b/.test(String(input?.command ?? ''))) {
        return undefined;
    }

    const match = COMMIT_LINE.exec(output);
    if (match) {
        return { sha: match[2], subject: match[3] };
    }

    const logMatch = ONELINE_LOG.exec(output);
    if (logMatch) {
        return { sha: logMatch[1], subject: logMatch[2] };
    }
    return undefined;
};

// Identifies a tool call by what it does, for spotting an agent repeating
// itself: the same command or the same edit, over and over.
export const toolSignature = (name, input) => {
    return `${name}:${truncate(JSON.stringify(input ?? {}), 400)}`;
};
