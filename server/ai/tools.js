// The tools the chat's model can call. They all run in the browser (public/js/ai/agentTools.js),
// which has the item list, the prices, the code engine and the user's scopes; the server only
// declares them. Keep the names and inputs here in step with agentTools.js.

const SCOPE_INPUT = {
    type: 'string',
    description: "The scope's id or name. Leave it out for the scope the user is looking at.",
};

const TARGET_INPUT = {
    type: 'string',
    enum: ['scope', 'globals'],
    description: "Which code: a scope's, or the globals'.",
};

export const CHAT_TOOLS = [
    {
        name: 'find_items',
        description: 'Searches GE items by name and/or tags, with their current prices. Use it to get exact item names before writing them into code, or to answer quick price questions. For anything more involved (sorting, maths, recipes) use run_code.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Text the item name contains (case-insensitive).' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Tag keys the item must all have.' },
                limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many to return (default 10).' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'list_item_tags',
        description: 'Lists item tag keys (for queryOsrsItems().tagged(...)) with their labels and parents. There are hundreds, so pass search to narrow them down.',
        input_schema: {
            type: 'object',
            properties: {
                search: { type: 'string', description: 'Text the tag key or label contains.' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'list_scopes',
        description: "Lists the user's scopes: id, name, whether the code currently has an error, and its public variables.",
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'read_code',
        description: "Reads a scope's or the globals' code, with line numbers, its current errors and its variables' values.",
        input_schema: {
            type: 'object',
            properties: { target: TARGET_INPUT, scope: SCOPE_INPUT },
            required: ['target'],
            additionalProperties: false,
        },
    },
    {
        name: 'run_code',
        description: "Runs code against live prices without saving anything, as if it were the given scope's code (with the globals and other scopes importable) or the globals' code. Returns each top-level variable's value, the errors if it failed (with their lines), and a summary of the ui panels it drew. To see a value, assign it to a top-level variable. Use it to test code before proposing it, and to look things up.",
        input_schema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'The whole program to run.' },
                target: TARGET_INPUT,
                scope: SCOPE_INPUT,
            },
            required: ['code', 'target'],
            additionalProperties: false,
        },
    },
    {
        name: 'propose_edit',
        description: "Proposes a change to a scope's or the globals' code. The user sees it as a diff and applies or rejects it; the result says which (and why, if they gave a reason) and, once applied, how the code runs. Give either edits (each old_text must appear exactly once in the current code) or new_code (the whole new code), not both. Test the result with run_code first.",
        input_schema: {
            type: 'object',
            properties: {
                target: TARGET_INPUT,
                scope: SCOPE_INPUT,
                summary: { type: 'string', description: 'One sentence the user reads: what this change does.' },
                edits: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            old_text: { type: 'string', description: 'Text to replace, copied exactly from the code.' },
                            new_text: { type: 'string', description: 'What replaces it.' },
                        },
                        required: ['old_text', 'new_text'],
                        additionalProperties: false,
                    },
                },
                new_code: { type: 'string', description: 'The complete new code.' },
            },
            required: ['target', 'summary'],
            additionalProperties: false,
        },
    },
    {
        name: 'create_scope',
        description: 'Proposes a new scope with the given name and code. The user decides whether to create it. Test the code with run_code first.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: "The new scope's name." },
                code: { type: 'string' },
                summary: { type: 'string', description: 'One sentence the user reads: what the scope is for.' },
            },
            required: ['name', 'code', 'summary'],
            additionalProperties: false,
        },
    },
];
