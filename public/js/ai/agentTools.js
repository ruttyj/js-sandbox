// The tools the chat's model (Claude or Gemini) calls, run here in the browser where the items,
// prices, code engine and the user's scopes are. The server declares them to the model
// (server/ai/tools.js): keep the names and inputs in step with it.
//
// Each tool returns a plain object, sent back to the model as JSON. A tool that fails returns
// { error } and is marked as an error, so the model can correct itself (a misspelt tag, an edit whose
// old_text isn't in the code, ...).
//
// propose_edit and create_scope change the user's data, so they wait for the user: the chat shows
// the change and the tool resolves once it's applied or rejected (see requestApproval).
//
// Uses globals from scripts loaded before it:
//   formula/itemQuery.js   createItemQuery
//   formula/scopeCode.js   parseScopeCode
//   formula/engine.js      exportedValues
//   ai/lineDiff.js         diffLines, collapseDiffContext, countDiffChanges

// --- Limits -------------------------------------------------------------------------------------
// Tool results go back into the model's context, so they're kept small: a value or list that would
// run to pages is cut short, and the result says so.

const AGENT_DEFAULT_ITEM_LIMIT = 10;
const AGENT_MAX_ITEM_LIMIT = 50;
const AGENT_MAX_TAGS_LISTED = 100;
const AGENT_MAX_VALUE_CHARS = 2000;
const AGENT_MAX_RESULT_CHARS = 30000;
const AGENT_MAX_TABLE_ROWS_SHOWN = 5;

class AgentToolError extends Error {}

// --- Reading values for the model ------------------------------------------------------------------

// JSON for any value code can produce: Maps and Sets as objects and arrays, functions by name.
const agentJsonReplacer = (key, value) => {
    if (value instanceof Map) {
        return Object.fromEntries(value);
    }
    if (value instanceof Set) {
        return [...value];
    }
    if (typeof value === 'function') {
        return `[function ${value.name || 'anonymous'}]`;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
        return String(value);
    }
    return value;
};

// A value as the model reads it: as plain JSON data when small, otherwise its JSON text cut short.
const summarizeAgentValue = (value) => {
    if (value === undefined) {
        return null;
    }

    let json;
    try {
        json = JSON.stringify(value, agentJsonReplacer);
    } catch (error) {
        return `[unreadable value: ${error.message}]`;
    }
    if (json.length <= AGENT_MAX_VALUE_CHARS) {
        return JSON.parse(json);
    }
    return `${json.slice(0, AGENT_MAX_VALUE_CHARS)}... [cut short: ${json.length} characters in all]`;
};

// A run's values (a Map) as an object of summarized values.
const summarizeAgentValues = (values) => {
    const summary = {};
    for (const [key, value] of values) {
        summary[key] = summarizeAgentValue(value);
    }
    return summary;
};

// Code with line numbers, so the model can relate an error's line to the code.
const numberAgentCodeLines = (code) => {
    return code.split('\n').map((line, index) => `${String(index + 1).padStart(4)}| ${line}`).join('\n');
};

// What a ui panel shows, briefly: enough for the model to tell whether the code drew what it meant to.
const summarizeAgentPanel = (panel) => {
    if (panel.kind === 'heading' || panel.kind === 'text') {
        return { kind: panel.kind, text: panel.text };
    }
    if (panel.kind === 'items') {
        return { kind: 'items', title: panel.title, items: panel.items.map(item => item.name) };
    }
    if (panel.kind === 'table') {
        return {
            kind: 'table',
            title: panel.title,
            columns: panel.columns.map(column => column.label),
            rowCount: panel.rows.length,
            firstRows: panel.rows.slice(0, AGENT_MAX_TABLE_ROWS_SHOWN).map(row => row.map(cellAsAgentText)),
        };
    }
    if (panel.kind === 'stats') {
        return { kind: 'stats', title: panel.title, entries: panel.entries.map(entry => `${entry.label}: ${entry.value}`) };
    }
    if (panel.kind === 'input') {
        return { kind: 'input', input: panel.input, label: panel.label, value: summarizeAgentValue(panel.value), error: panel.error };
    }
    return { kind: panel.kind };
};

const cellAsAgentText = (cell) => {
    if (Array.isArray(cell)) {
        return cell.map(cellAsAgentText).join(', ');
    }
    if (cell && typeof cell === 'object') {
        return cell.name;
    }
    return cell;
};

// The errors code has now: what doesn't parse, then what the run threw.
const agentCodeErrors = (code, runError) => {
    const errors = [...parseScopeCode(code).errors];
    if (runError) {
        errors.push(runError);
    }
    return errors;
};

// --- Finding what a tool is about ---------------------------------------------------------------

const scopeLabelForAgent = (scope) => `"${scope.name}" (id ${scope.id})`;

/**
 * The scope a tool input names (by id or name), or the selected one when it names none.
 * @throws {AgentToolError}
 */
const findAgentScope = (context, ref) => {
    const scopes = context.scopes.value;
    if (ref === undefined || ref === null || String(ref).trim() === '') {
        const selected = context.selectedScope.value;
        if (!selected) {
            throw new AgentToolError('No scope is selected. Pass scope (an id or name from list_scopes).');
        }
        return selected;
    }

    const wanted = String(ref).trim();
    const byId = scopes.find(scope => String(scope.id) === wanted);
    if (byId) {
        return byId;
    }
    const byName = scopes.find(scope => scope.name.trim().toLowerCase() === wanted.toLowerCase());
    if (byName) {
        return byName;
    }
    throw new AgentToolError(`There is no scope "${wanted}". list_scopes lists them.`);
};

const readAgentTarget = (input) => {
    if (input.target !== 'scope' && input.target !== 'globals') {
        throw new AgentToolError('target must be "scope" or "globals".');
    }
    return input.target;
};

const readAgentString = (input, field) => {
    if (typeof input[field] !== 'string') {
        throw new AgentToolError(`${field} must be a string.`);
    }
    return input[field];
};

// --- Looking things up --------------------------------------------------------------------------

const findItemsTool = (context, input) => {
    const limit = Math.min(Math.max(Number(input.limit) || AGENT_DEFAULT_ITEM_LIMIT, 1), AGENT_MAX_ITEM_LIMIT);
    let query = createItemQuery(context.itemQuerySource);
    if (Array.isArray(input.tags) && input.tags.length) {
        query = query.tagged(...input.tags);
    }
    if (typeof input.name === 'string' && input.name.trim()) {
        query = query.nameMatches(input.name.trim());
    }

    // Shortest names first, so "rune platebody" lists Rune platebody before Rune platebody (g).
    const matchCount = query.count();
    const items = query.sortBy(item => item.name.length).limit(limit).list().map(item => ({
        id: item.id,
        name: item.name,
        highPrice: item.highPrice,
        lowPrice: item.lowPrice,
        limit: item.limit,
        members: item.members,
        tags: item.tags,
    }));
    return { matchCount, shown: items.length, items };
};

const listItemTagsTool = (context, input) => {
    const search = typeof input.search === 'string' ? input.search.trim().toLowerCase() : '';
    const matching = [];
    for (const tag of context.tagDefs.value.values()) {
        const isMatch = !search || tag.key.includes(search) || tag.label.toLowerCase().includes(search);
        if (isMatch) {
            matching.push({ key: tag.key, label: tag.label, parent: tag.parent, own: !tag.system });
        }
    }
    return { matchCount: matching.length, tags: matching.slice(0, AGENT_MAX_TAGS_LISTED) };
};

const listScopesTool = (context) => {
    const scopes = context.scopes.value.map(scope => {
        const result = context.evaluation.getScopeResult(scope);
        return {
            id: String(scope.id),
            name: scope.name,
            error: result.error,
            publicVariables: [...exportedValues(result).keys()],
            selected: scope === context.selectedScope.value,
        };
    });
    return { scopes };
};

// The code a target holds now, and how its last run went.
const readAgentCodeState = (context, target, scopeRef) => {
    if (target === 'globals') {
        return { label: 'the globals', code: context.globalsCode.value, result: context.evaluation.globalsResult.value };
    }
    const scope = findAgentScope(context, scopeRef);
    return { label: `scope ${scopeLabelForAgent(scope)}`, scope, code: scope.code, result: context.evaluation.getScopeResult(scope) };
};

const readCodeTool = (context, input) => {
    const state = readAgentCodeState(context, readAgentTarget(input), input.scope);
    return {
        of: state.label,
        code: numberAgentCodeLines(state.code),
        errors: agentCodeErrors(state.code, state.result.error),
        values: summarizeAgentValues(state.result.values),
        publicVariables: state.result.exports ? [...state.result.exports] : 'all (no top-level return)',
    };
};

const runCodeTool = (context, input) => {
    const code = readAgentString(input, 'code');
    const target = readAgentTarget(input);
    let scope = null;
    if (target === 'scope' && input.scope) {
        scope = findAgentScope(context, input.scope);
    }

    const result = context.evaluation.runDraft(code, { asGlobals: target === 'globals', scope });
    return {
        ok: agentCodeErrors(code, result.error).length === 0,
        errors: agentCodeErrors(code, result.error),
        values: summarizeAgentValues(result.values),
        ui: result.ui.map(summarizeAgentPanel),
    };
};

// --- Changing code (with the user's approval) ---------------------------------------------------

// Each old_text must be in the code exactly once, so an edit can't land in the wrong place.
const applyAgentEdits = (code, edits) => {
    let edited = code;
    edits.forEach((edit, index) => {
        if (typeof edit?.old_text !== 'string' || typeof edit?.new_text !== 'string' || edit.old_text === '') {
            throw new AgentToolError(`edits[${index}] needs a non-empty old_text and a new_text.`);
        }
        const occurrences = edited.split(edit.old_text).length - 1;
        if (occurrences !== 1) {
            const where = occurrences === 0 ? 'is not in the code' : `appears ${occurrences} times`;
            throw new AgentToolError(`edits[${index}].old_text ${where}. Copy it exactly from read_code, with enough around it to be unique.`);
        }
        edited = edited.replace(edit.old_text, () => edit.new_text);
    });
    return edited;
};

// The code an edit proposal leads to, from either edits or new_code.
const proposedAgentCode = (code, input) => {
    const hasEdits = Array.isArray(input.edits) && input.edits.length > 0;
    const hasNewCode = typeof input.new_code === 'string';
    if (hasEdits === hasNewCode) {
        throw new AgentToolError('Give either edits or new_code (one of them, not both).');
    }
    if (hasEdits) {
        return applyAgentEdits(code, input.edits);
    }
    return input.new_code;
};

const buildAgentDiff = (oldCode, newCode) => {
    const rows = diffLines(oldCode, newCode);
    return { rows: collapseDiffContext(rows), ...countDiffChanges(rows) };
};

// Writes code to the scope or the globals through the app's own editing path (so it's saved
// and can be undone), then reports how it runs.
const writeAgentCode = (context, target, scope, code) => {
    if (target === 'globals') {
        context.replaceGlobalsCode(code);
        return agentCodeErrors(code, context.evaluation.globalsResult.value.error);
    }
    context.replaceScopeCode(scope, code);
    return agentCodeErrors(code, context.evaluation.getScopeResult(scope).error);
};

const proposeEditTool = async (context, input, toolUseId) => {
    const target = readAgentTarget(input);
    const before = readAgentCodeState(context, target, input.scope);
    const newCode = proposedAgentCode(before.code, input);
    if (newCode === before.code) {
        throw new AgentToolError('That leaves the code exactly as it is.');
    }

    const decision = await context.requestApproval({
        id: toolUseId,
        kind: 'edit',
        title: target === 'globals' ? 'Globals' : before.scope.name,
        summary: String(input.summary || ''),
        diff: buildAgentDiff(before.code, newCode),
    });
    if (!decision.approved) {
        return { status: 'rejected', reason: decision.reason || null };
    }

    // The user may have edited the code while deciding. Edits can still go on top of their
    // changes; a whole new_code would wipe them out, so that's refused.
    const current = readAgentCodeState(context, target, before.scope ? String(before.scope.id) : null);
    let codeToWrite = newCode;
    if (current.code !== before.code) {
        if (!Array.isArray(input.edits)) {
            return { status: 'not applied', reason: 'The user changed the code while this was waiting. Read it again and propose the change again.' };
        }
        codeToWrite = applyAgentEdits(current.code, input.edits);
    }

    const errors = writeAgentCode(context, target, before.scope, codeToWrite);
    return { status: 'applied', errors };
};

const createScopeTool = async (context, input, toolUseId) => {
    const name = readAgentString(input, 'name').trim();
    const code = readAgentString(input, 'code');
    if (!name) {
        throw new AgentToolError('name must not be empty.');
    }

    const decision = await context.requestApproval({
        id: toolUseId,
        kind: 'create',
        title: name,
        summary: String(input.summary || ''),
        diff: buildAgentDiff('', code),
    });
    if (!decision.approved) {
        return { status: 'rejected', reason: decision.reason || null };
    }

    const scope = context.createScopeWithCode(name, code);
    return { status: 'created', id: String(scope.id), errors: agentCodeErrors(code, context.evaluation.getScopeResult(scope).error) };
};

// --- Running a tool -----------------------------------------------------------------------------

const AGENT_TOOLS = {
    find_items: findItemsTool,
    list_item_tags: listItemTagsTool,
    list_scopes: listScopesTool,
    read_code: readCodeTool,
    run_code: runCodeTool,
    propose_edit: proposeEditTool,
    create_scope: createScopeTool,
};

// The result as the text the model gets, cut short if it's huge.
const agentResultText = (result) => {
    const text = JSON.stringify(result, agentJsonReplacer);
    if (text.length <= AGENT_MAX_RESULT_CHARS) {
        return text;
    }
    return `${text.slice(0, AGENT_MAX_RESULT_CHARS)}... [cut short: the result was ${text.length} characters]`;
};

/**
 * @typedef {Object} AgentToolContext
 * @property {Ref<Object[]>} scopes
 * @property {Ref<Object|undefined>} selectedScope
 * @property {Ref<string>} globalsCode
 * @property {Ref<Map>} tagDefs
 * @property {Object} itemQuerySource
 * @property {Object} evaluation  From useEvaluation: getScopeResult, globalsResult, runDraft.
 * @property {function(Object): Promise<{ approved: boolean, reason?: string }>} requestApproval
 * @property {function(Object, string): void} replaceScopeCode
 * @property {function(string): void} replaceGlobalsCode
 * @property {function(string, string): Object} createScopeWithCode  Returns the new scope.
 */

/**
 * Runs one tool call from the model.
 * @param {AgentToolContext} context
 * @param {{ id: string, name: string, input: Object }} toolUse  A tool_use block.
 * @returns {Promise<{ type: 'tool_result', tool_use_id: string, content: string, is_error?: boolean }>}
 */
const runAgentTool = async (context, toolUse) => {
    const tool = AGENT_TOOLS[toolUse.name];
    try {
        if (!tool) {
            throw new AgentToolError(`There is no tool called ${toolUse.name}.`);
        }
        const result = await tool(context, toolUse.input || {}, toolUse.id);
        return { type: 'tool_result', tool_use_id: toolUse.id, content: agentResultText(result) };
    } catch (error) {
        // Not only AgentToolErrors: a query throws for an unknown tag, for example. Either way
        // the model reads the message and can try something else.
        return { type: 'tool_result', tool_use_id: toolUse.id, content: agentResultText({ error: error.message }), is_error: true };
    }
};
