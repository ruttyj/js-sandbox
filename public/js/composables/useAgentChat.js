// The AI chat drawer: the conversation, the loop that runs the model's tool calls, the changes
// waiting for the user's approval, and saved chats. The model is Claude or Gemini, whichever the
// user picked; the server makes both look the same from here.
//
// The conversation (chatMessages) is kept in the Anthropic API's message shape, with each reply
// marked with the provider that wrote it and, for Gemini, Gemini's own parts (see
// server/ai/transcript.js). It's sent back in full on every request, and each provider's replies
// must go back to it unchanged, so it only ever grows at the end. What the drawer shows
// (chatEntries) is derived from it.
//
// One message from the user can take several requests: when a reply asks for tools, they run here
// (see agentTools.js), their results are appended, and the conversation goes back to the model,
// until a reply needs no tools.

const CHAT_MAX_ROUNDS = 40;
// A rate limit asking for a longer wait than this (a daily limit, say) stops the chat instead.
const CHAT_MAX_RETRY_WAIT_SECONDS = 120;
const CHAT_MAX_RETRIES_IN_A_ROW = 5;
// How many times a transient failure (a dropped connection, a stall, an overloaded provider, a
// cut-off reply) is retried on its own before the Retry button is shown instead.
const CHAT_MAX_TRANSIENT_RETRIES = 3;
// Roughly how long to wait before each transient retry: exponential backoff, with jitter added so
// many clients recovering from the same outage don't all retry in lockstep.
const CHAT_TRANSIENT_RETRY_WAITS = [2, 4, 8];
// Failures worth retrying automatically after the reply started streaming (see chatClient.js).
const CHAT_TRANSIENT_REASONS = new Set(['stalled', 'cut-off', 'overloaded']);
const CHAT_TITLE_LENGTH = 60;
const CHAT_CONTEXT_TAG = '<app_context>';
const CHAT_TAB_LABELS = {
    market: 'Market Search',
    'item-tags': 'Item Tags',
    globals: 'Global Vars',
    scopes: 'Scopes',
    tags: 'Variable Tags',
    dashboard: 'Dashboard',
};
// What the model reads for a tool call that never ran, e.g. when the chat was stopped.
const CHAT_TOOL_NOT_RUN = 'This tool call did not run: the user stopped the chat, or the reply was cut off.';

// --- Building the conversation ------------------------------------------------------------------

const newChatId = () => `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Seconds to wait before the (zero-based) transient retry attempt: the backoff step, plus up to a
// second of jitter. Injectable into useAgentChat so tests can shorten it.
const chatRetryWaitSeconds = (attempt) => {
    const base = CHAT_TRANSIENT_RETRY_WAITS[attempt] ?? CHAT_TRANSIENT_RETRY_WAITS.at(-1);
    return base + Math.random();
};

// A reply failure worth retrying on its own, as a { retry, error } outcome, or null for anything
// else (a bad key, a refusal, a 4xx, or a user Stop). A network error reaches here as a TypeError.
const transientFailure = (error) => {
    if (error instanceof TypeError) {
        return { retry: true, error: 'Could not reach the server.' };
    }
    if (error instanceof ChatReplyError && CHAT_TRANSIENT_REASONS.has(error.reason)) {
        return { retry: true, error: error.message };
    }
    return null;
};

// A message's content as a list of blocks (the API allows a plain string too).
const chatContentBlocks = (content) => {
    if (typeof content === 'string') {
        return [{ type: 'text', text: content }];
    }
    return content;
};

// What the user is looking at, sent with each of their messages so "this scope" means something.
const chatContextText = ({ activeTab, selectedScope }) => {
    const lines = [CHAT_CONTEXT_TAG, `Tab: ${CHAT_TAB_LABELS[activeTab] || activeTab}`];
    if (activeTab === 'scopes' && selectedScope) {
        lines.push(`Scope on screen: "${selectedScope.name}" (id ${selectedScope.id})`);
    } else if (selectedScope) {
        lines.push(`Last scope opened: "${selectedScope.name}" (id ${selectedScope.id})`);
    }
    lines.push('</app_context>');
    return lines.join('\n');
};

// tool_result blocks for the last reply's tool calls that never got one (a stopped chat, or a
// conversation saved mid-way): the API needs every tool call answered before the next message.
const unansweredToolResults = (messages) => {
    const last = messages.at(-1);
    if (!last || last.role !== 'assistant') {
        return [];
    }
    return chatContentBlocks(last.content)
        .filter(block => block.type === 'tool_use')
        .map(block => ({ type: 'tool_result', tool_use_id: block.id, content: CHAT_TOOL_NOT_RUN, is_error: true }));
};

// A new chat's title: the start of its first message.
const chatTitleFrom = (text) => {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    if (oneLine.length <= CHAT_TITLE_LENGTH) {
        return oneLine || 'New chat';
    }
    return `${oneLine.slice(0, CHAT_TITLE_LENGTH - 1)}…`;
};

// --- What the drawer shows ----------------------------------------------------------------------

const parseToolResultContent = (block) => {
    try {
        return JSON.parse(block.content);
    } catch (error) {
        return { text: block.content };
    }
};

// A tool call as one line: "Searched items for "yew" tagged logs".
const describeChatToolCall = (name, input) => {
    if (name === 'find_items') {
        let text = 'Searched items';
        if (input.name) {
            text += ` for "${input.name}"`;
        }
        if (input.tags?.length) {
            text += ` tagged ${input.tags.join(', ')}`;
        }
        return text;
    }
    if (name === 'list_item_tags') {
        return input.search ? `Looked up item tags matching "${input.search}"` : 'Looked up item tags';
    }
    if (name === 'list_scopes') {
        return 'Listed your scopes';
    }
    if (name === 'read_code') {
        return input.target === 'globals' ? 'Read the globals' : `Read scope ${input.scope || 'on screen'}`;
    }
    if (name === 'run_code') {
        return 'Test-ran code';
    }
    return name;
};

// The outcome of a tool call, briefly: "12 found", "2 errors", ...
const describeChatToolResult = (name, result, isError) => {
    if (isError) {
        return result.error || result.text || 'Failed';
    }
    if (name === 'find_items' || name === 'list_item_tags') {
        return `${result.matchCount} found`;
    }
    if (name === 'list_scopes') {
        return `${result.scopes.length} scopes`;
    }
    if (name === 'run_code' || name === 'read_code') {
        const count = result.errors.length;
        if (!count) {
            return 'no errors';
        }
        return count === 1 ? '1 error' : `${count} errors`;
    }
    return 'Done';
};

// The name of the scope the user is viewing, when it differs from the one a change was made for.
// Null when the change is for the globals, a new scope, or the scope that's already open.
const viewingScopeNote = (proposal, selectedScope) => {
    if (!proposal?.scopeId || !selectedScope) {
        return null;
    }
    if (String(selectedScope.id) === proposal.scopeId) {
        return null;
    }
    return selectedScope.name;
};

// A propose_edit / create_scope call, with its outcome once it has one.
const proposalEntry = (block, resultBlock, ctx) => {
    const waiting = ctx.approvals[block.id];
    const shown = waiting?.proposal || ctx.proposals[block.id] || null;
    const entry = {
        kind: 'proposal',
        key: block.id,
        id: block.id,
        isCreate: block.name === 'create_scope',
        title: shown?.title || block.input.name || (block.input.target === 'globals' ? 'Globals' : block.input.scope || 'Scope'),
        summary: block.input.summary || '',
        diff: shown?.diff || null,
        state: 'pending',
        detail: '',
        // The scope the user is looking at now, shown only when it isn't the one this change is for,
        // so "apply" to a change made for another scope isn't mistaken for the open one.
        viewingScope: viewingScopeNote(shown, ctx.selectedScope),
    };

    if (waiting) {
        entry.state = 'waiting';
        return entry;
    }
    if (!resultBlock) {
        entry.state = ctx.busy ? 'pending' : 'not run';
        return entry;
    }

    const result = parseToolResultContent(resultBlock);
    if (resultBlock.is_error) {
        entry.state = 'failed';
        entry.detail = result.error || result.text || '';
    } else {
        entry.state = result.status;
        entry.detail = result.reason || (result.errors?.length ? `Runs with errors: ${result.errors[0]}` : '');
    }
    return entry;
};

const toolEntry = (block, resultBlock, ctx) => {
    const entry = {
        kind: 'tool',
        key: block.id,
        label: describeChatToolCall(block.name, block.input || {}),
        state: 'running',
        detail: '',
        raw: '',
    };
    if (!resultBlock) {
        entry.state = ctx.busy ? 'running' : 'not run';
        return entry;
    }

    const result = parseToolResultContent(resultBlock);
    entry.state = resultBlock.is_error ? 'error' : 'done';
    entry.detail = describeChatToolResult(block.name, result, resultBlock.is_error);
    entry.raw = resultBlock.content;
    return entry;
};

// The drawer entries for one assistant block (streamed or finished).
const pushAssistantBlockEntries = (entries, block, key, resultsById, ctx) => {
    if (block.type === 'text' && block.text) {
        entries.push({ kind: 'assistant', key, html: formatChatHtml(block.text) });
    } else if (block.type === 'thinking' && block.thinking) {
        // With display "updates", a thinking block with text is a short progress note.
        entries.push({ kind: 'note', key, text: block.thinking });
    } else if (block.type === 'tool_use' && (block.name === 'propose_edit' || block.name === 'create_scope')) {
        entries.push(proposalEntry(block, resultsById.get(block.id), ctx));
    } else if (block.type === 'tool_use') {
        entries.push(toolEntry(block, resultsById.get(block.id), ctx));
    }
};

const pushUserMessageEntries = (entries, message, messageIndex) => {
    chatContentBlocks(message.content).forEach((block, blockIndex) => {
        const isContext = block.type === 'text' && block.text.startsWith(CHAT_CONTEXT_TAG);
        if (block.type === 'text' && !isContext) {
            entries.push({ kind: 'user', key: `${messageIndex}-${blockIndex}`, text: block.text });
        }
    });
};

/**
 * Everything the drawer lists, in order.
 * @param {Object} ctx  { messages, live, approvals, proposals, busy }
 */
const buildChatEntries = (ctx) => {
    const resultsById = new Map();
    for (const message of ctx.messages) {
        if (message.role !== 'user') {
            continue;
        }
        for (const block of chatContentBlocks(message.content)) {
            if (block.type === 'tool_result') {
                resultsById.set(block.tool_use_id, block);
            }
        }
    }

    const entries = [];
    ctx.messages.forEach((message, messageIndex) => {
        if (message.role === 'user') {
            pushUserMessageEntries(entries, message, messageIndex);
            return;
        }
        chatContentBlocks(message.content).forEach((block, blockIndex) => {
            pushAssistantBlockEntries(entries, block, `${messageIndex}-${blockIndex}`, resultsById, ctx);
        });
    });

    // The reply streaming in now. Its tool calls have no id until it's finished.
    for (const block of ctx.live?.blocks || []) {
        const liveBlock = { type: block.type, text: block.text, thinking: block.text, name: block.name, input: {}, id: `live-${block.index}` };
        pushAssistantBlockEntries(entries, liveBlock, `live-${block.index}`, resultsById, ctx);
    }
    return entries;
};

// --- Text the drawer template shows -------------------------------------------------------------

// Suggestions on an empty chat; clicking one sends it.
const CHAT_EXAMPLES = [
    'What are the 5 most expensive herbs right now?',
    'Explain what the scope on screen calculates.',
    'Add a table of tree seed prices to this scope.',
];

const CHAT_PROPOSAL_STATES = {
    pending: 'Preparing the change…',
    applied: 'Applied.',
    created: 'Created.',
    rejected: 'Rejected.',
    'not applied': 'Not applied.',
    'not run': 'Not applied (the chat stopped first).',
    failed: 'Could not be prepared.',
};

const chatToolStatusText = (entry) => {
    if (entry.state === 'running') {
        return 'running…';
    }
    return entry.detail || entry.state;
};

const chatProposalStateText = (entry) => {
    const text = CHAT_PROPOSAL_STATES[entry.state] || entry.state;
    if (!entry.detail) {
        return text;
    }
    return `${text} ${entry.detail}`;
};

const chatDiffSign = (row) => {
    if (row.type === 'add') {
        return '+';
    }
    if (row.type === 'remove') {
        return '-';
    }
    return ' ';
};

const chatDiffLineNumber = (row) => {
    if (row.type === 'skip') {
        return '';
    }
    return row.newLine ?? row.oldLine;
};

const chatDiffText = (row) => {
    if (row.type === 'skip') {
        return `… ${row.count} unchanged line${row.count === 1 ? '' : 's'}`;
    }
    return row.text;
};

// "$0.0042": cents alone hide what a short chat cost.
const formatChatCost = (dollars) => {
    if (dollars < 0.01) {
        return `$${dollars.toFixed(4)}`;
    }
    return `$${dollars.toFixed(2)}`;
};

// SQLite's CURRENT_TIMESTAMP looks like "2026-10-24 12:00:00" and is UTC without saying so.
const SQLITE_TIMESTAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;

const parseChatTimestamp = (timestamp) => {
    const text = String(timestamp);
    if (SQLITE_TIMESTAMP.test(text)) {
        return new Date(`${text.replace(' ', 'T')}Z`);
    }
    return new Date(text);
};

// A saved chat's date: the time today, otherwise the date.
const formatChatDate = (timestamp) => {
    const date = parseChatTimestamp(timestamp);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    if (date.toDateString() === new Date().toDateString()) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString();
};

// Why a save failed, as the toast says it: the server's reason, and for a rejected body the first
// field it rejected ("messages.3.content: ...").
const describeSaveError = (error) => {
    if (error instanceof TypeError) {
        return 'could not reach the server.';
    }
    const issue = error.body?.issues?.[0];
    if (issue) {
        return `${error.message} ${issue.path}: ${issue.message}`;
    }
    return error.message;
};

// Asks the browser to confirm leaving or refreshing while a chat turn runs (streaming, running
// tools or waiting on an approval), because unloading the page cuts the agent off mid-task.
const warnBeforeLeavingBusyChat = (chatBusy) => {
    window.addEventListener('beforeunload', (event) => {
        if (chatBusy.value) {
            event.preventDefault();
            event.returnValue = '';
        }
    });
};

// --- The composable -----------------------------------------------------------------------------

/**
 * @param {Object} options
 * @param {Object} options.store  useTrackerStore
 * @param {Object} options.itemTagsApi  useItemTags
 * @param {Object} options.evaluation  useEvaluation
 * @param {Object} options.scopesApi  useScopes
 * @param {Object} options.variablesApi  useVariables
 * @param {Object} options.aiAccountApi  useAiAccount
 * @param {Ref<string>} options.activeTab
 * @param {function} options.showToast
 * @param {function} options.showUndoToast
 * @param {function} options.showConfirmModal
 * @param {function(number): number} [options.retryWaitSeconds]  Seconds before the Nth transient
 *     retry; shortened in tests.
 */
const useAgentChat = ({ store, itemTagsApi, evaluation, scopesApi, variablesApi, aiAccountApi, activeTab, showToast, showUndoToast, showConfirmModal, retryWaitSeconds = chatRetryWaitSeconds }) => {
    const { assistantName } = aiAccountApi;
    const isChatOpen = ref(false);
    const chatInput = ref('');
    const chatInputRef = ref(null);
    const chatScrollRef = ref(null);
    const chatBusy = ref(false);
    warnBeforeLeavingBusyChat(chatBusy);
    // { text, needsKey, canRetry?, waiting? } after a turn failed or was declined. canRetry: the
    // reply failed, so asking again (retryChat) may work; a declined or cut-off reply needs a
    // new message instead.
    const chatNotice = ref(null);

    const chatId = ref(newChatId());
    const chatTitle = ref('');
    const chatMessages = ref([]);
    const chatCostUsd = ref(0);
    const chatLive = ref(null); // { blocks: [{ index, type, name, text }] } while a reply streams

    // Changes waiting for the user, by tool call id: { proposal, resolve }. Once decided, the
    // proposal moves to chatProposals so its diff stays visible (for this session; a saved chat
    // shows only the outcome).
    const chatApprovals = ref({});
    const chatProposals = ref({});
    const chatRejectReasons = ref({});

    const isChatHistoryOpen = ref(false);
    const chatHistory = ref([]);

    let abortController = null;
    let stopRequested = false;
    let cancelRetryWait = null; // ends a rate-limit wait early (when the chat is stopped)
    // The chat loop while it runs, so a new chat can wait for a stopped one to finish: the loop
    // saves the chat as it ends, under the chat id at that moment.
    let runningChatLoop = null;

    const chatEntries = computed(() => buildChatEntries({
        messages: chatMessages.value,
        live: chatLive.value,
        approvals: chatApprovals.value,
        proposals: chatProposals.value,
        busy: chatBusy.value,
        selectedScope: scopesApi.selectedScope.value,
    }));

    const scrollChatToEnd = () => {
        nextTick(() => {
            const el = chatScrollRef.value;
            if (el) {
                el.scrollTop = el.scrollHeight;
            }
        });
    };

    // --- What the tools work on ---

    const requestApproval = (proposal) => {
        scrollChatToEnd();
        return new Promise((resolve) => {
            chatApprovals.value = { ...chatApprovals.value, [proposal.id]: { proposal, resolve } };
        });
    };

    const toolContext = {
        scopes: store.scopes,
        selectedScope: scopesApi.selectedScope,
        globalsCode: store.globalsCode,
        tagDefs: itemTagsApi.tagDefs,
        itemQuerySource: itemTagsApi.itemQuerySource,
        evaluation,
        requestApproval,
        replaceScopeCode: (scope, code) => {
            const previous = scope.code;
            scopesApi.replaceScopeCode(scope, code);
            showUndoToast(`Applied ${assistantName.value}'s change to "${scope.name}".`, () => scopesApi.replaceScopeCode(scope, previous));
        },
        replaceGlobalsCode: (code) => {
            const previous = store.globalsCode.value;
            variablesApi.replaceGlobalsCode(code);
            showUndoToast(`Applied ${assistantName.value}'s change to the globals.`, () => variablesApi.replaceGlobalsCode(previous));
        },
        createScopeWithCode: (name, code) => {
            const scope = scopesApi.createScopeWithCode(name, code);
            activeTab.value = 'scopes';
            showToast(`Scope "${name}" created.`, 'success');
            return scope;
        },
    };

    const decideProposal = (id, decision) => {
        const waiting = chatApprovals.value[id];
        if (!waiting) {
            return;
        }
        const { [id]: decided, ...stillWaiting } = chatApprovals.value;
        chatApprovals.value = stillWaiting;
        chatProposals.value = { ...chatProposals.value, [id]: decided.proposal };
        waiting.resolve(decision);
    };

    const applyProposal = (id) => decideProposal(id, { approved: true });

    const rejectProposal = (id) => {
        const reason = (chatRejectReasons.value[id] || '').trim();
        decideProposal(id, { approved: false, reason });
    };

    // --- Talking to the model ---

    // Adds blocks for the user to the conversation: to the last message when it's already the
    // user's (a reply that was stopped or declined left it unanswered), else as a new message.
    const appendUserContent = (blocks) => {
        const last = chatMessages.value.at(-1);
        if (last && last.role === 'user') {
            last.content = [...chatContentBlocks(last.content), ...blocks];
            return;
        }
        chatMessages.value.push({ role: 'user', content: blocks });
    };

    const onReplyEvent = (event) => {
        const live = chatLive.value;
        if (event.type === 'block') {
            live.blocks.push({ index: event.index, type: event.blockType, name: event.name, text: '' });
        } else {
            const block = live.blocks.find(candidate => candidate.index === event.index);
            if (block) {
                block.text += event.text;
            }
        }
        scrollChatToEnd();
    };

    const showReplyError = (error) => {
        const needsKey = error.reason === 'no-key' || error.body?.reason === 'no-key';
        const provider = error.provider || error.body?.provider;
        if (needsKey && provider) {
            aiAccountApi.markAiProviderDisconnected(provider);
        }
        let text = error.message;
        if (error instanceof TypeError) {
            text = 'Could not reach the server.';
        }
        chatNotice.value = { text, needsKey, canRetry: true };
    };

    /**
     * One attempt at the model's next reply.
     * @returns {Promise<{ message: Object } | { retryAfterSeconds: number, error: string } | { retry: true, error: string } | null>}
     *     The reply; a rate limit to wait out; a transient failure to retry on its own; or null
     *     when it failed for good, was stopped or declined.
     */
    const requestReply = async () => {
        abortController = new AbortController();
        chatLive.value = { blocks: [] };
        try {
            const reply = await streamChatReply(chatMessages.value, onReplyEvent, abortController.signal);
            chatCostUsd.value += reply.costUsd || 0;
            if (reply.message.stop_reason === 'refusal') {
                chatNotice.value = { text: `${assistantName.value} declined to answer that. Try asking another way.`, needsKey: false };
                return null;
            }
            return { message: reply.message };
        } catch (error) {
            if (error.name === 'AbortError') {
                return null;
            }
            if (error instanceof ChatReplyError && error.reason === 'rate-limit') {
                return { retryAfterSeconds: error.retryAfterSeconds, error: error.message };
            }
            const transient = transientFailure(error);
            if (transient) {
                return transient;
            }
            showReplyError(error);
            return null;
        } finally {
            chatLive.value = null;
            abortController = null;
        }
    };

    // Counts down a wait in the notice, one second at a time. textFor(secondsLeft) is the notice
    // text to show. Resolves true when the wait is up, false when the chat was stopped first (via
    // cancelRetryWait, which Stop calls).
    const countdownNotice = (seconds, textFor) => {
        return new Promise((resolve) => {
            let left = seconds;
            const showLeft = () => {
                chatNotice.value = { text: textFor(left), needsKey: false, waiting: true };
            };
            const finish = (retry) => {
                clearInterval(timer);
                cancelRetryWait = null;
                chatNotice.value = null;
                resolve(retry);
            };
            const timer = setInterval(() => {
                left--;
                if (left <= 0) {
                    finish(true);
                    return;
                }
                showLeft();
            }, 1000);
            cancelRetryWait = () => finish(false);
            showLeft();
            scrollChatToEnd();
        });
    };

    // Counts down a rate-limit wait. Resolves true when it's time to retry, false when stopped.
    const waitOutRateLimit = (seconds, reason) => {
        return countdownNotice(seconds, (left) => `${reason} Retrying in ${left}s…`);
    };

    // Counts down the backoff before a transient retry, e.g. "Connection lost. Retrying in 4s…
    // (2/3)". Resolves true when it's time to retry, false when stopped.
    const waitBeforeTransientRetry = (seconds, attempt) => {
        return countdownNotice(seconds, (left) => `Connection lost. Retrying in ${left}s… (${attempt}/${CHAT_MAX_TRANSIENT_RETRIES})`);
    };

    // The model's next reply, waiting out rate limits (common on Gemini's free tier) and retrying
    // transient failures (a dropped connection, a stall, an overloaded provider, a cut-off reply)
    // with backoff. Null when it failed for good, was stopped or declined, or a limit needs too
    // long a wait. Rate-limit and transient retries are counted separately: a long chat that hits
    // the free tier's limit shouldn't use up its transient budget, or the other way round.
    const requestReplyWithRetries = async () => {
        let rateLimitWaits = 0;
        let transientWaits = 0;
        while (true) {
            const outcome = await requestReply();
            if (!outcome || outcome.message) {
                return outcome?.message || null;
            }

            if (outcome.retry) {
                if (transientWaits >= CHAT_MAX_TRANSIENT_RETRIES) {
                    chatNotice.value = { text: outcome.error, needsKey: false, canRetry: true };
                    return null;
                }
                transientWaits++;
                const seconds = Math.ceil(retryWaitSeconds(transientWaits - 1));
                const retry = await waitBeforeTransientRetry(seconds, transientWaits);
                if (!retry || stopRequested) {
                    return null;
                }
                continue;
            }

            const tooLong = outcome.retryAfterSeconds > CHAT_MAX_RETRY_WAIT_SECONDS;
            if (tooLong || rateLimitWaits >= CHAT_MAX_RETRIES_IN_A_ROW) {
                chatNotice.value = { text: `${outcome.error} Try again later, or pick another model.`, needsKey: false, canRetry: true };
                return null;
            }
            rateLimitWaits++;
            const retry = await waitOutRateLimit(Math.ceil(outcome.retryAfterSeconds), outcome.error);
            if (!retry || stopRequested) {
                return null;
            }
        }
    };

    // A reply as the conversation keeps it: which provider wrote it, and Gemini's own parts.
    const keptReply = (reply) => {
        const message = { role: 'assistant', provider: reply.provider, model: reply.model, content: reply.content };
        if (reply.raw) {
            message.raw = reply.raw;
        }
        return message;
    };

    // Requests replies, running their tools, until one needs no tools (or the chat is stopped).
    const runChatLoop = async () => {
        chatBusy.value = true;
        stopRequested = false;
        try {
            for (let round = 0; round < CHAT_MAX_ROUNDS; round++) {
                const reply = await requestReplyWithRetries();
                if (!reply) {
                    return;
                }
                chatMessages.value.push(keptReply(reply));
                scrollChatToEnd();

                const toolUses = reply.content.filter(block => block.type === 'tool_use');
                if (reply.stop_reason !== 'tool_use' || !toolUses.length) {
                    if (reply.stop_reason === 'max_tokens') {
                        chatNotice.value = { text: `The reply hit its length limit. Ask ${assistantName.value} to continue.`, needsKey: false };
                    }
                    return;
                }

                const results = await Promise.all(toolUses.map(toolUse => runAgentTool(toolContext, toolUse)));
                chatMessages.value.push({ role: 'user', content: results });
                if (stopRequested) {
                    return;
                }
            }
            chatNotice.value = { text: `${assistantName.value} used tools ${CHAT_MAX_ROUNDS} times in a row, so the chat paused. Say "continue" to let it carry on.`, needsKey: false };
        } finally {
            chatBusy.value = false;
            scrollChatToEnd();
            await saveChat();
        }
    };

    const startChatLoop = async () => {
        runningChatLoop = runChatLoop();
        await runningChatLoop;
        runningChatLoop = null;
    };

    const sendChatMessage = async (text = chatInput.value) => {
        const trimmed = text.trim();
        if (!trimmed || chatBusy.value) {
            return;
        }
        if (!chatMessages.value.length) {
            chatTitle.value = chatTitleFrom(trimmed);
        }

        chatInput.value = '';
        chatNotice.value = null;
        const context = chatContextText({ activeTab: activeTab.value, selectedScope: scopesApi.selectedScope.value });
        appendUserContent([
            ...unansweredToolResults(chatMessages.value),
            { type: 'text', text: context },
            { type: 'text', text: trimmed },
        ]);
        scrollChatToEnd();
        await startChatLoop();
    };

    // Asks again for the reply that failed. A failed reply leaves the conversation ending with the
    // user's message (or the tool results it was answering), so running the loop again picks up
    // where it stopped without repeating anything.
    const retryChat = async () => {
        const lastMessage = chatMessages.value.at(-1);
        const isAwaitingReply = lastMessage?.role === 'user';
        if (chatBusy.value || !isAwaitingReply) {
            return;
        }

        chatNotice.value = null;
        await startChatLoop();
    };

    // Stops the reply streaming (or a rate-limit wait) now, and turns down any change waiting for
    // approval.
    const stopChat = () => {
        stopRequested = true;
        abortController?.abort();
        cancelRetryWait?.();
        for (const id of Object.keys(chatApprovals.value)) {
            decideProposal(id, { approved: false, reason: 'The user stopped the chat.' });
        }
    };

    // Enter sends; Shift+Enter is a new line.
    const onChatInputKeydown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendChatMessage();
        }
    };

    // --- Saved chats ---

    const saveChat = async () => {
        if (!chatMessages.value.length) {
            return;
        }
        try {
            await apiRequest('PUT', `/api/ai/conversations/${chatId.value}`, {
                title: chatTitle.value || 'New chat',
                messages: chatMessages.value,
                costUsd: chatCostUsd.value,
            });
        } catch (error) {
            console.error(error, error.body);
            showToast(`Could not save this chat: ${describeSaveError(error)}`, 'error');
        }
    };

    const loadChatHistory = async () => {
        try {
            chatHistory.value = await apiRequest('GET', '/api/ai/conversations');
        } catch (error) {
            console.error(error);
            showToast('Could not load your saved chats.', 'error');
        }
    };

    const toggleChatHistory = () => {
        isChatHistoryOpen.value = !isChatHistoryOpen.value;
        if (isChatHistoryOpen.value) {
            loadChatHistory();
        }
    };

    const resetChat = () => {
        chatId.value = newChatId();
        chatTitle.value = '';
        chatMessages.value = [];
        chatCostUsd.value = 0;
        chatProposals.value = {};
        chatRejectReasons.value = {};
        chatNotice.value = null;
    };

    // Starts a fresh chat; the current one stays in Saved chats. When the assistant is still
    // working, it's stopped first, and the chat is reset only once that turn has ended and saved.
    const startNewChat = async () => {
        if (chatBusy.value) {
            stopChat();
            await runningChatLoop;
        }
        resetChat();
        isChatHistoryOpen.value = false;
        nextTick(() => chatInputRef.value?.focus());
    };

    const openSavedChat = async (id) => {
        if (chatBusy.value) {
            return;
        }
        try {
            const saved = await apiRequest('GET', `/api/ai/conversations/${id}`);
            resetChat();
            chatId.value = saved.id;
            chatTitle.value = saved.title;
            chatMessages.value = saved.messages;
            chatCostUsd.value = saved.costUsd;
            isChatHistoryOpen.value = false;
            scrollChatToEnd();
        } catch (error) {
            console.error(error);
            showToast(error.message || 'Could not open that chat.', 'error');
        }
    };

    const deleteSavedChat = (chat) => {
        showConfirmModal('Delete Chat', `Delete the chat "<strong>${escapeChatHtml(chat.title)}</strong>"?`, async () => {
            try {
                await apiRequest('DELETE', `/api/ai/conversations/${chat.id}`);
            } catch (error) {
                console.error(error);
                showToast('Could not delete that chat.', 'error');
                return;
            }
            chatHistory.value = chatHistory.value.filter(candidate => candidate.id !== chat.id);
            if (chat.id === chatId.value && !chatBusy.value) {
                resetChat();
            }
        });
    };

    // --- Opening the drawer ---

    // The header's AI button: the chat once a key is connected, else the connect dialog.
    const onAiButtonClick = () => {
        if (!aiAccountApi.aiStatus.value.connected) {
            aiAccountApi.openAiModal();
            return;
        }
        isChatOpen.value = !isChatOpen.value;
        if (isChatOpen.value) {
            nextTick(() => chatInputRef.value?.focus());
            scrollChatToEnd();
        }
    };

    const closeChat = () => {
        isChatOpen.value = false;
    };

    // On wide screens the page makes room for the drawer instead of sitting under it (styles.css).
    watch(isChatOpen, (open) => {
        document.body.classList.toggle('chat-open', open);
    });

    // "Fix with Claude/Gemini" on a code error toast: asks about the code on screen in a fresh message.
    const askAssistantToFix = (label, errors) => {
        isChatOpen.value = true;
        if (chatBusy.value) {
            showToast(`${assistantName.value} is still busy with the last message.`, 'info');
            return;
        }
        const list = errors.map(error => `- ${error}`).join('\n');
        sendChatMessage(`The code in ${label} has ${errors.length === 1 ? 'this error' : 'these errors'}:\n${list}\nPlease find the cause and fix it.`);
    };

    return {
        isChatOpen, chatInput, chatInputRef, chatScrollRef, chatBusy, chatNotice, chatTitle, chatCostUsd,
        chatEntries, chatRejectReasons, isChatHistoryOpen, chatHistory,
        sendChatMessage, retryChat, stopChat, onChatInputKeydown, applyProposal, rejectProposal,
        toggleChatHistory, startNewChat, openSavedChat, deleteSavedChat,
        onAiButtonClick, closeChat, askAssistantToFix,
        chatExamples: CHAT_EXAMPLES, chatToolStatusText, chatProposalStateText, chatDiffSign, chatDiffLineNumber, chatDiffText,
        formatChatCost, formatChatDate,
    };
};
