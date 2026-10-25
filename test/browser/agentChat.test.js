// The AI chat in the browser: its tools against real scope code and items, the diff and reply
// formatting, and the whole chat loop running through a real server with a scripted fake Claude
// and Gemini.
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_HEADER, createTestApp } from '../helpers.js';
import { openTab } from './syncHarness.js';

const GOOD_KEY = 'sk-ant-api03-good-key-0000000000wxyz';
const GEMINI_KEY = 'AIzaSyGoodGeminiKey00000000000000000gem1';

const waitFor = async (condition, timeoutMs = 5000) => {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('Timed out waiting.');
        }
        await new Promise(resolve => setTimeout(resolve, 20));
    }
};

// --- A fake Claude that replies from a script ------------------------------------------------

// Each call to stream() takes the next reply from replies (a function of the request, so it can
// look at the tool results it was sent). A reply of { error } fails that request with the error.
// requests records every request.
const scriptedAnthropic = () => {
    const requests = [];
    const replies = [];
    const createClient = () => ({
        beta: {
            messages: {
                stream: (request) => {
                    requests.push(structuredClone(request));
                    const reply = replies.shift()(request);
                    const message = {
                        id: `msg_${requests.length}`,
                        type: 'message',
                        role: 'assistant',
                        usage: { input_tokens: 100, output_tokens: 10 },
                        ...reply,
                    };
                    return {
                        async *[Symbol.asyncIterator]() {
                            if (reply.error) {
                                throw reply.error;
                            }
                        },
                        finalMessage: async () => message,
                    };
                },
            },
        },
    });
    return { createClient, requests, replies };
};

// A fake Gemini: each call takes the next list of chunks from replies.
const scriptedGemini = () => {
    const requests = [];
    const replies = [];
    const createClient = () => ({
        models: {
            generateContentStream: async (request) => {
                const { abortSignal, ...config } = request.config;
                requests.push(structuredClone({ ...request, config }));
                const chunks = replies.shift()(request);
                return (async function* () {
                    for (const chunk of chunks) {
                        yield chunk;
                    }
                })();
            },
        },
    });
    return { createClient, requests, replies };
};

const toolUse = (id, name, input) => ({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' });
const textReply = (text) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });

// The tool_result blocks in the last message of a request.
const lastToolResults = (request) => request.messages.at(-1).content.filter(block => block.type === 'tool_result');

// --- Setup ------------------------------------------------------------------------------------

let testApp;
let server;
let baseUrl;
let cookie;
const claude = scriptedAnthropic();
const gemini = scriptedGemini();

const putJson = (url, body) => fetch(`${baseUrl}${url}`, {
    method: 'PUT',
    headers: { ...API_HEADER, cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

beforeAll(async () => {
    testApp = await createTestApp({ createAiClients: { anthropic: claude.createClient, gemini: gemini.createClient } });
    server = testApp.app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const signIn = await fetch(`${baseUrl}/auth/dev`, { redirect: 'manual' });
    cookie = signIn.headers.get('set-cookie').split(';')[0];
    await putJson('/api/ai/key/anthropic', { apiKey: GOOD_KEY });
    await putJson('/api/ai/key/gemini', { apiKey: GEMINI_KEY });
    // With both connected the default is Gemini's roomiest free model; these tests talk to Claude.
    await putJson('/api/ai/model', { model: 'claude-opus-5-5' });
});

afterAll(async () => {
    server.close();
    await testApp.destroy();
});

const ITEMS = {
    1515: { id: 1515, name: 'Yew logs', highPrice: 300, lowPrice: 280, members: false, limit: 25000 },
    1513: { id: 1513, name: 'Magic logs', highPrice: 1100, lowPrice: 1050, members: true, limit: 25000 },
    1511: { id: 1511, name: 'Logs', highPrice: 60, lowPrice: 50, members: false, limit: 25000 },
};

// A browser tab with the chat's dependencies built from the real scripts, except the parts of
// the app the tools only call into (which record what they were asked to do).
const openChatTab = () => {
    const tab = openTab(baseUrl, cookie, {
        exportNames: [
            'useEvaluation', 'useAgentChat', 'runAgentTool', 'diffLines', 'collapseDiffContext', 'formatChatHtml',
            'untaggedItemSource', 'itemNameKey',
        ],
    });
    const ref = (value) => ({ value });
    const items = ref(ITEMS);
    const itemsByName = ref(new Map(Object.values(ITEMS).map(item => [tab.itemNameKey(item.name), item])));
    const itemQuerySource = tab.untaggedItemSource(ITEMS);
    const store = {
        scopes: ref([{ id: 100, name: 'Logs', code: 'const yew = getOsrsItem(\'Yew logs\').highPrice;\nconst total = yew * 10;\n', itemTagKeys: [], itemColors: {}, variables: [] }]),
        globalsCode: ref('const tax = 0.02;\n'),
    };
    const evaluation = tab.useEvaluation({ store, items, itemsByName, itemQuerySource });
    const selectedScope = ref(store.scopes.value[0]);
    const tagDefs = ref(new Map([['logs', { key: 'logs', label: 'Logs', parent: 'woodcutting', system: true }]]));
    return { tab, store, evaluation, selectedScope, tagDefs, itemQuerySource };
};

// --- Diffs and reply formatting ---------------------------------------------------------------

describe('chat display helpers', () => {
    it('diffs lines, showing a changed line as removed then added', () => {
        const { tab } = openChatTab();
        const rows = tab.diffLines('a\nb\nc', 'a\nB\nc');
        expect(rows.map(row => `${row.type}:${row.text}`)).toEqual(['same:a', 'remove:b', 'add:B', 'same:c']);
    });

    it('collapses long unchanged runs into one skip row', () => {
        const { tab } = openChatTab();
        const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
        const after = before.replace('line 10', 'changed');
        const rows = tab.collapseDiffContext(tab.diffLines(before, after));
        expect(rows[0]).toEqual({ type: 'skip', count: 7 });
        expect(rows.filter(row => row.type === 'add').map(row => row.text)).toEqual(['changed']);
        expect(rows.at(-1)).toEqual({ type: 'skip', count: 6 });
    });

    it('formats replies as safe HTML', () => {
        const { tab } = openChatTab();
        const html = tab.formatChatHtml('**Profit**: `a - b` <img src=x onerror=alert(1)>\n```js\nconst x = "<b>";\n```');
        expect(html).toContain('<strong>Profit</strong>');
        expect(html).toContain('<code>a - b</code>');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).toContain('<pre class="chat-code"><code>const x = &quot;&lt;b&gt;&quot;;</code></pre>');
        expect(html).not.toContain('<img');
    });
});

// --- The tools ----------------------------------------------------------------------------------

describe('chat tools', () => {
    // A tool context over the tab, with approvals answered by decide.
    const toolContext = (chat, decide = () => ({ approved: true })) => {
        const asked = [];
        const context = {
            scopes: chat.store.scopes,
            selectedScope: chat.selectedScope,
            globalsCode: chat.store.globalsCode,
            tagDefs: chat.tagDefs,
            itemQuerySource: chat.itemQuerySource,
            evaluation: chat.evaluation,
            requestApproval: async (proposal) => {
                asked.push(proposal);
                return decide(proposal);
            },
            replaceScopeCode: (scope, code) => {
                scope.code = code;
            },
            replaceGlobalsCode: (code) => {
                chat.store.globalsCode.value = code;
            },
            createScopeWithCode: (name, code) => {
                const scope = { id: 200, name, code, itemTagKeys: [], itemColors: {}, variables: [] };
                chat.store.scopes.value.push(scope);
                return scope;
            },
        };
        return { context, asked };
    };

    const run = async (context, name, input) => {
        const result = await context.tab.runAgentTool(context.context, { id: 'toolu_1', name, input });
        return { ...result, parsed: JSON.parse(result.content) };
    };

    it('finds items by name, shortest names first', async () => {
        const chat = openChatTab();
        const { context } = toolContext(chat);
        const result = await run({ tab: chat.tab, context }, 'find_items', { name: 'logs' });
        expect(result.parsed.matchCount).toBe(3);
        expect(result.parsed.items.map(item => item.name)).toEqual(['Logs', 'Yew logs', 'Magic logs']);
        expect(result.parsed.items[1]).toMatchObject({ id: 1515, highPrice: 300, lowPrice: 280 });
    });

    it('lists scopes and tags, and reads code with its values', async () => {
        const chat = openChatTab();
        const { context } = toolContext(chat);
        const scopes = await run({ tab: chat.tab, context }, 'list_scopes', {});
        expect(scopes.parsed.scopes).toEqual([{ id: '100', name: 'Logs', error: null, publicVariables: ['yew', 'total'], selected: true }]);

        const tags = await run({ tab: chat.tab, context }, 'list_item_tags', { search: 'log' });
        expect(tags.parsed.tags).toEqual([{ key: 'logs', label: 'Logs', parent: 'woodcutting', own: false }]);

        const read = await run({ tab: chat.tab, context }, 'read_code', { target: 'scope', scope: 'logs' });
        expect(read.parsed.code).toContain('   2| const total = yew * 10;');
        expect(read.parsed.values).toEqual({ yew: 300, total: 3000 });
        expect(read.parsed.errors).toEqual([]);
    });

    it('test-runs code without saving it, reporting values and errors', async () => {
        const chat = openChatTab();
        const { context } = toolContext(chat);
        const ok = await run({ tab: chat.tab, context }, 'run_code', {
            target: 'scope',
            scope: 'logs',
            code: 'const magic = getOsrsItem(\'Magic logs\');\nconst afterTax = magic.highPrice * (1 - tax);\nui.table([magic], { title: \'Logs\', columns: [{ label: \'Item\', type: \'item\', value: m => m }] });',
        });
        expect(ok.parsed.ok).toBe(true);
        expect(ok.parsed.values.afterTax).toBe(1078);
        expect(ok.parsed.ui).toEqual([{ kind: 'table', title: 'Logs', columns: ['Item'], rowCount: 1, firstRows: [['Magic logs']] }]);

        const failed = await run({ tab: chat.tab, context }, 'run_code', { target: 'scope', scope: 'logs', code: 'const a = 1;\nconst b = missingName + 1;' });
        expect(failed.parsed.ok).toBe(false);
        expect(failed.parsed.errors[0]).toMatch(/missingName/);
        expect(chat.store.scopes.value[0].code).not.toContain('missingName');
    });

    it('applies an approved edit, and refuses one whose old_text is not in the code', async () => {
        const chat = openChatTab();
        const { context, asked } = toolContext(chat);
        const applied = await run({ tab: chat.tab, context }, 'propose_edit', {
            target: 'scope', scope: 'logs', summary: 'Sell 20 instead of 10.', edits: [{ old_text: 'yew * 10', new_text: 'yew * 20' }],
        });
        expect(applied.parsed).toEqual({ status: 'applied', errors: [] });
        expect(chat.store.scopes.value[0].code).toContain('yew * 20');
        expect(asked[0]).toMatchObject({ kind: 'edit', title: 'Logs', summary: 'Sell 20 instead of 10.' });
        expect(asked[0].diff).toMatchObject({ added: 1, removed: 1 });

        const missing = await run({ tab: chat.tab, context }, 'propose_edit', {
            target: 'scope', scope: 'logs', summary: 'x', edits: [{ old_text: 'not in the code', new_text: 'y' }],
        });
        expect(missing.is_error).toBe(true);
        expect(missing.parsed.error).toMatch(/is not in the code/);
        expect(asked).toHaveLength(1);
    });

    it('refuses a scope target with no scope, so it never lands on the wrong scope', async () => {
        const chat = openChatTab();
        const { context, asked } = toolContext(chat);
        const result = await run({ tab: chat.tab, context }, 'propose_edit', {
            target: 'scope', summary: 'Sell 20.', edits: [{ old_text: 'yew * 10', new_text: 'yew * 20' }],
        });
        expect(result.is_error).toBe(true);
        expect(result.parsed.error).toMatch(/scope/i);
        expect(asked).toHaveLength(0);
    });

    it('leaves the code alone when the user rejects, and passes on their reason', async () => {
        const chat = openChatTab();
        const { context } = toolContext(chat, () => ({ approved: false, reason: 'Keep 10.' }));
        const rejected = await run({ tab: chat.tab, context }, 'propose_edit', {
            target: 'globals', summary: 'Raise tax.', new_code: 'const tax = 0.05;\n',
        });
        expect(rejected.parsed).toEqual({ status: 'rejected', reason: 'Keep 10.' });
        expect(chat.store.globalsCode.value).toBe('const tax = 0.02;\n');
    });

    it('creates a scope once approved', async () => {
        const chat = openChatTab();
        const { context } = toolContext(chat);
        const created = await run({ tab: chat.tab, context }, 'create_scope', { name: 'Magic', code: 'const m = 1;', summary: 'A new scope.' });
        expect(created.parsed).toEqual({ status: 'created', id: '200', errors: [] });
        expect(chat.store.scopes.value.map(scope => scope.name)).toEqual(['Logs', 'Magic']);
    });

    it('reports an unknown tool as an error', async () => {
        const chat = openChatTab();
        const { context } = toolContext(chat);
        const result = await run({ tab: chat.tab, context }, 'delete_everything', {});
        expect(result.is_error).toBe(true);
    });
});

// --- The whole chat loop --------------------------------------------------------------------------

describe('the chat loop', () => {
    const openChat = (overrides = {}) => {
        const chat = openChatTab();
        const ref = (value) => ({ value });
        const toasts = [];
        const scopesApi = {
            selectedScope: chat.selectedScope,
            replaceScopeCode: (scope, code) => {
                scope.code = code;
            },
            createScopeWithCode: () => null,
        };
        const api = chat.tab.useAgentChat({
            store: chat.store,
            itemTagsApi: { tagDefs: chat.tagDefs, itemQuerySource: chat.itemQuerySource },
            evaluation: chat.evaluation,
            scopesApi,
            variablesApi: { replaceGlobalsCode: () => {} },
            aiAccountApi: {
                aiStatus: ref({ connected: true }),
                assistantName: ref('Claude'),
                openAiModal: () => {},
                markAiProviderDisconnected: () => {},
            },
            activeTab: ref('scopes'),
            showToast: (message, type) => toasts.push({ message, type }),
            showUndoToast: (message) => toasts.push({ message, type: 'undo' }),
            showConfirmModal: () => {},
            // Keep the transient-retry backoff to a single second so these tests stay quick.
            retryWaitSeconds: () => 1,
            ...overrides,
        });
        return { ...chat, api, toasts };
    };

    const listConversations = async () => {
        const response = await fetch(`${baseUrl}/api/ai/conversations`, { headers: { ...API_HEADER, cookie } });
        return response.json();
    };

    const readConversation = async (id) => {
        const response = await fetch(`${baseUrl}/api/ai/conversations/${id}`, { headers: { ...API_HEADER, cookie } });
        return response.json();
    };

    it('runs the tools Claude asks for, sends the results back, and shows the answer', async () => {
        const { api } = openChat();
        claude.replies.push(
            () => toolUse('toolu_a', 'find_items', { name: 'yew' }),
            (request) => {
                const [result] = lastToolResults(request);
                const found = JSON.parse(result.content).items[0];
                return textReply(`${found.name} sell for ${found.highPrice} gp.`);
            },
        );

        await api.sendChatMessage('What do yew logs sell for?');

        const firstRequest = claude.requests.at(-2);
        const userBlocks = firstRequest.messages[0].content;
        expect(userBlocks[0].text).toContain('<app_context>');
        expect(userBlocks[0].text).toContain('Scope on screen: "Logs" (id 100)');
        expect(userBlocks[1].text).toBe('What do yew logs sell for?');

        const entries = api.chatEntries.value;
        expect(entries.map(entry => entry.kind)).toEqual(['user', 'tool', 'assistant']);
        expect(entries[1]).toMatchObject({ label: 'Searched items for "yew"', state: 'done', detail: '1 found' });
        expect(entries[2].html).toBe('Yew logs sell for 300 gp.');
        expect(api.chatBusy.value).toBe(false);
        expect(api.chatCostUsd.value).toBeGreaterThan(0);
        expect(api.chatTitle.value).toBe('What do yew logs sell for?');
    });

    it('saves the chat, which can be opened again', async () => {
        const list = await (await fetch(`${baseUrl}/api/ai/conversations`, { headers: { ...API_HEADER, cookie } })).json();
        expect(list[0].title).toBe('What do yew logs sell for?');

        const { api } = openChat();
        await api.openSavedChat(list[0].id);
        expect(api.chatEntries.value.map(entry => entry.kind)).toEqual(['user', 'tool', 'assistant']);
    });

    it('waits for the user to apply a proposed change, then tells Claude it was applied', async () => {
        const { api, store, toasts } = openChat();
        claude.replies.push(
            () => toolUse('toolu_b', 'propose_edit', {
                target: 'scope', scope: '100', summary: 'Sell 20.', edits: [{ old_text: 'yew * 10', new_text: 'yew * 20' }],
            }),
            () => textReply('Done.'),
        );

        const sending = api.sendChatMessage('Make it 20 logs.');
        await waitFor(() => api.chatEntries.value.some(entry => entry.state === 'waiting'));
        expect(store.scopes.value[0].code).toContain('yew * 10');

        api.applyProposal('toolu_b');
        await sending;

        expect(store.scopes.value[0].code).toContain('yew * 20');
        const [result] = lastToolResults(claude.requests.at(-1));
        expect(JSON.parse(result.content)).toEqual({ status: 'applied', errors: [] });
        const proposal = api.chatEntries.value.find(entry => entry.kind === 'proposal');
        expect(proposal).toMatchObject({ state: 'applied', title: 'Logs' });
        expect(proposal.diff.added).toBe(1);
        expect(toasts.some(toast => toast.type === 'undo')).toBe(true);
    });

    it('applies a proposal to the scope it was made for, not the one now open', async () => {
        const { api, store, selectedScope } = openChat();
        // A second scope the user switches to while the change waits for approval.
        store.scopes.value.push({ id: 101, name: 'Herbs', code: 'const grimy = 1;\n', itemTagKeys: [], itemColors: {}, variables: [] });
        claude.replies.push(
            () => toolUse('toolu_s', 'propose_edit', {
                target: 'scope', scope: '100', summary: 'Sell 20.', edits: [{ old_text: 'yew * 10', new_text: 'yew * 20' }],
            }),
            () => textReply('Done.'),
        );

        const sending = api.sendChatMessage('Make it 20 logs.');
        await waitFor(() => api.chatEntries.value.some(entry => entry.state === 'waiting'));

        // Switch to the other scope while the proposal is still waiting.
        selectedScope.value = store.scopes.value[1];
        const proposal = api.chatEntries.value.find(entry => entry.kind === 'proposal');
        expect(proposal).toMatchObject({ title: 'Logs', viewingScope: 'Herbs' });

        api.applyProposal('toolu_s');
        await sending;

        // Only the scope the change was made for changed.
        expect(store.scopes.value[0].code).toContain('yew * 20');
        expect(store.scopes.value[1].code).toBe('const grimy = 1;\n');
    });

    it('turns down a waiting change when the chat is stopped, and answers it before the next message', async () => {
        const { api, store } = openChat();
        claude.replies.push(() => toolUse('toolu_c', 'propose_edit', { target: 'globals', summary: 'x', new_code: 'const tax = 1;' }));

        const sending = api.sendChatMessage('Change the tax.');
        await waitFor(() => api.chatEntries.value.some(entry => entry.state === 'waiting'));
        api.stopChat();
        await sending;
        expect(store.globalsCode.value).toBe('const tax = 0.02;\n');

        claude.replies.push(() => textReply('OK, leaving it.'));
        await api.sendChatMessage('Never mind.');
        const lastRequest = claude.requests.at(-1);
        const results = lastToolResults(lastRequest);
        expect(JSON.parse(results[0].content)).toEqual({ status: 'rejected', reason: 'The user stopped the chat.' });
        expect(lastRequest.messages.at(-1).content.at(-1).text).toBe('Never mind.');
    });

    it('starts a new chat while busy by stopping the old one, which is still saved', async () => {
        const { api } = openChat();
        claude.replies.push(() => toolUse('toolu_n', 'propose_edit', { target: 'globals', summary: 'x', new_code: 'const tax = 1;' }));

        api.sendChatMessage('Reset me mid-turn.');
        await waitFor(() => api.chatEntries.value.some(entry => entry.state === 'waiting'));
        await api.startNewChat();

        expect(api.chatBusy.value).toBe(false);
        expect(api.chatEntries.value).toEqual([]);
        expect(api.chatTitle.value).toBe('');

        const list = await (await fetch(`${baseUrl}/api/ai/conversations`, { headers: { ...API_HEADER, cookie } })).json();
        expect(list.some(chat => chat.title === 'Reset me mid-turn.')).toBe(true);
    });

    it('shows a declined request as a notice, and folds the next message into the unanswered one', async () => {
        const { api } = openChat();
        claude.replies.push(() => ({ content: [], stop_reason: 'refusal' }));
        await api.sendChatMessage('First try.');
        expect(api.chatNotice.value.text).toMatch(/declined/);

        claude.replies.push(() => textReply('Sure.'));
        await api.sendChatMessage('Second try.');
        const messages = claude.requests.at(-1).messages;
        expect(messages).toHaveLength(1);
        expect(messages[0].content.filter(block => !block.text.startsWith('<app_context>')).map(block => block.text))
            .toEqual(['First try.', 'Second try.']);
    });

    it('offers to retry a failed reply, and asks again without repeating the message', async () => {
        const { api } = openChat();
        claude.replies.push(() => ({ error: new Error('boom') }));
        await api.sendChatMessage('Are you there?');
        expect(api.chatNotice.value).toMatchObject({ text: 'Something went wrong on the server.', canRetry: true });

        claude.replies.push(() => textReply('Yes, sorry.'));
        await api.retryChat();

        expect(api.chatNotice.value).toBeNull();
        const messages = claude.requests.at(-1).messages;
        expect(messages).toHaveLength(1);
        expect(messages[0].content.at(-1).text).toBe('Are you there?');
        expect(api.chatEntries.value.map(entry => entry.kind)).toEqual(['user', 'assistant']);
        expect(api.chatEntries.value.at(-1).html).toBe('Yes, sorry.');
    });

    const overloadedError = () => ({
        error: Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, new Headers()),
    });

    it('retries a reply that fails once with an overloaded error, then shows the answer', async () => {
        const { api } = openChat();
        claude.replies.push(overloadedError, () => textReply('Here you go.'));

        const sending = api.sendChatMessage('Still there?');
        await waitFor(() => api.chatNotice.value?.waiting);
        expect(api.chatNotice.value.text).toMatch(/Connection lost\. Retrying in 1s….*\(1\/3\)/);
        await sending;

        expect(api.chatNotice.value).toBeNull();
        expect(api.chatEntries.value.at(-1)).toMatchObject({ kind: 'assistant', html: 'Here you go.' });
    });

    it('gives up after three retries of an always-failing reply, leaving a Retry notice', async () => {
        const { api } = openChat();
        const before = claude.requests.length;
        claude.replies.push(overloadedError, overloadedError, overloadedError, overloadedError);

        await api.sendChatMessage('Anyone home?');

        expect(api.chatNotice.value).toMatchObject({ canRetry: true });
        // The first attempt plus three retries: four requests reached the server.
        expect(claude.requests.length - before).toBe(4);
        expect(api.chatBusy.value).toBe(false);
    }, 10000);

    it('ends the turn when the chat is stopped during a retry wait', async () => {
        const { api } = openChat();
        claude.replies.push(overloadedError);

        const sending = api.sendChatMessage('You there?');
        await waitFor(() => api.chatNotice.value?.waiting);
        api.stopChat();
        await sending;

        expect(api.chatBusy.value).toBe(false);
        expect(api.chatNotice.value).toBeNull();
    });

    it('waits out a rate limit with a countdown, then carries on by itself', async () => {
        const { api } = openChat();
        const limited = Anthropic.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Slow down' } }, undefined, new Headers({ 'retry-after': '1' }));
        claude.replies.push(() => ({ error: limited }), () => textReply('Back again.'));

        const sending = api.sendChatMessage('Hello?');
        await waitFor(() => api.chatNotice.value?.waiting);
        expect(api.chatNotice.value.text).toMatch(/rate limit.*Retrying in 1s/);
        await sending;

        expect(api.chatNotice.value).toBeNull();
        expect(api.chatEntries.value.at(-1)).toMatchObject({ kind: 'assistant', html: 'Back again.' });
    });

    it('carries a chat over from Claude to Gemini, and keeps Gemini\'s own parts for later turns', async () => {
        await putJson('/api/ai/model', { model: 'claude-opus-5-5' });
        const { api } = openChat();
        claude.replies.push(() => toolUse('toolu_x', 'list_scopes', {}), () => textReply('You have one scope.'));
        await api.sendChatMessage('What scopes do I have?');

        await putJson('/api/ai/model', { model: 'gemini-3.8-flash' });
        gemini.replies.push(
            () => [{ candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'g1', name: 'find_items', args: { name: 'yew' } }, thoughtSignature: 'sig-g' }] }, finishReason: 'STOP' }] }],
            () => [{ candidates: [{ content: { role: 'model', parts: [{ text: 'Yew logs: 300 gp.' }] }, finishReason: 'STOP' }] }],
        );
        await api.sendChatMessage('And yew logs?');

        const [first, second] = gemini.requests.slice(-2);
        // Claude's turn reached Gemini as a function call with the stand-in signature.
        expect(first.contents[1]).toEqual({
            role: 'model',
            parts: [{ functionCall: { id: 'toolu_x', name: 'list_scopes', args: {} }, thoughtSignature: 'skip_thought_signature_validator' }],
        });
        expect(first.contents[2].parts[0].functionResponse).toMatchObject({ id: 'toolu_x', name: 'list_scopes' });
        expect(first.contents[3]).toEqual({ role: 'model', parts: [{ text: 'You have one scope.' }] });
        // Gemini's own turn went back exactly as it came, then the tool's result.
        expect(second.contents.at(-2)).toEqual({
            role: 'model',
            parts: [{ functionCall: { id: 'g1', name: 'find_items', args: { name: 'yew' } }, thoughtSignature: 'sig-g' }],
        });
        expect(second.contents.at(-1).parts[0].functionResponse).toMatchObject({ id: 'g1', name: 'find_items', response: { matchCount: 1 } });

        const entries = api.chatEntries.value;
        expect(entries.at(-1)).toMatchObject({ kind: 'assistant', html: 'Yew logs: 300 gp.' });
        expect(entries.filter(entry => entry.kind === 'tool').map(entry => entry.state)).toEqual(['done', 'done']);
        await putJson('/api/ai/model', { model: 'claude-opus-5-5' });
    });

    it('saves the chat before the turn ends, while it waits on a proposal', async () => {
        const { api } = openChat();
        claude.replies.push(
            () => toolUse('toolu_save', 'propose_edit', {
                target: 'scope', scope: 'logs', summary: 'Sell 20.', edits: [{ old_text: 'yew * 10', new_text: 'yew * 20' }],
            }),
            () => textReply('Done.'),
        );

        const sending = api.sendChatMessage('Save me before the end.');
        await waitFor(() => api.chatEntries.value.some(entry => entry.state === 'waiting'));

        // The turn is still blocked on the proposal, yet the chat is already in the saved list.
        const saved = (await listConversations()).find(chat => chat.title === 'Save me before the end.');
        expect(saved).toBeTruthy();
        const full = await readConversation(saved.id);
        const userText = full.messages[0].content
            .find(block => block.text && !block.text.startsWith('<app_context>')).text;
        expect(userText).toBe('Save me before the end.');

        api.applyProposal('toolu_save');
        await sending;
    });

    it('closes the Saved chats panel when a message is sent', async () => {
        const { api } = openChat();
        api.toggleChatHistory();
        expect(api.isChatHistoryOpen.value).toBe(true);

        claude.replies.push(() => textReply('Hi.'));
        await api.sendChatMessage('Hello with the list open.');

        expect(api.isChatHistoryOpen.value).toBe(false);
    });

    it('keeps a deleted chat deleted when it is removed mid-turn', async () => {
        const { api } = openChat({ showConfirmModal: (title, body, onConfirm) => onConfirm() });
        claude.replies.push(
            () => toolUse('toolu_del', 'propose_edit', { target: 'globals', summary: 'x', new_code: 'const tax = 1;' }),
            () => textReply('Done.'),
        );

        api.sendChatMessage('Delete me mid-turn.');
        await waitFor(() => api.chatEntries.value.some(entry => entry.state === 'waiting'));

        // Saved as it went, so the chat exists now; we delete it while the turn still runs.
        const saved = (await listConversations()).find(chat => chat.title === 'Delete me mid-turn.');
        expect(saved).toBeTruthy();

        await api.deleteSavedChat({ id: saved.id, title: 'Delete me mid-turn.' });

        expect(api.chatBusy.value).toBe(false);
        const after = await listConversations();
        expect(after.some(chat => chat.id === saved.id)).toBe(false);
    });
});
