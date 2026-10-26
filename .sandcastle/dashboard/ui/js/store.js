// Builds the dashboard's state from the event stream (see ../../events.ts).
// applyEvent mutates the state in place; views read from it on each render.
//
// Each agent keeps a `feed` of items for its activity stream. Items are
// appended, and a tool item is updated in place when its result arrives;
// every change bumps the item's `rev` so the feed view knows to redraw it.

import { truncate } from './format.js';
import {
    describeActivity,
    editedFile,
    isTestRun,
    parseCommit,
    parseTestResult,
    readFile,
    toolSignature,
} from './tools.js';

// How many recent tool calls are kept for loop detection.
const RECENT_SIGNATURES = 12;

const ITERATION_STATUS = /^Iteration (\d+)\/(\d+)$/;
const FAILED_STATUS = /timed out|failed|error/i;

export const createState = () => {
    return {
        runId: null,
        live: false,
        startedAt: null,
        endedAt: null,
        error: null,
        maxIterations: 0,
        repoUrl: null,
        mergeGate: false,
        stopRequested: false,
        phase: null,
        iteration: 0,
        // { phase, iteration, startedAt, endedAt } in order.
        phases: [],
        // iteration -> planned issues
        plans: {},
        // The open merge gate: { iteration, branches: [{ branch, issue }] }.
        gate: null,
        agents: new Map(),
        agentOrder: [],
        // Run-level log: { time, level, text, agentId? }
        log: [],
        lastSeq: 0,
        lastEventAt: null,
    };
};

const createAgent = (event, time) => {
    return {
        id: event.agentId,
        role: event.role,
        title: event.title,
        iteration: event.iteration,
        model: event.model,
        maxTurns: event.maxTurns,
        baseSha: event.baseSha,
        issue: event.issue ?? null,
        branch: event.branch ?? null,
        // setup | working | between | done | failed | aborted
        status: 'setup',
        activity: 'Starting sandbox',
        startedAt: time,
        endedAt: null,
        lastActivityAt: time,
        turn: 0,
        sessionId: null,
        feed: [],
        nextKey: 1,
        feedRev: 0,
        toolItems: new Map(),
        pendingTools: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
        messageUsage: new Map(),
        contextTokens: 0,
        costUsd: 0,
        // path -> number of edits
        filesEdited: new Map(),
        filesRead: new Set(),
        todos: [],
        // The latest test run: { passed, failed, time }
        tests: null,
        testRuns: 0,
        // Commits seen in the agent's own git output, then the final list
        // Sandcastle reports when the run ends.
        commits: [],
        finalCommits: null,
        toolCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        recentSignatures: [],
        // Points of interest for the timeline: { time, type }
        markers: [],
        error: null,
    };
};

// --- Feed and log ------------------------------------------------------------

// level: info | warn | error | phase
const addLog = (state, time, level, text, agentId) => {
    state.log.push({ time, level, text, agentId });
};

const pushFeedItem = (agent, item) => {
    const feedItem = { ...item, key: agent.nextKey, rev: 0 };
    agent.nextKey += 1;
    agent.feed.push(feedItem);
    agent.feedRev += 1;
    return feedItem;
};

const touchFeedItem = (agent, item) => {
    item.rev += 1;
    agent.feedRev += 1;
};

// --- Agent events ------------------------------------------------------------

const handleStatus = (agent, text, time) => {
    const iterationMatch = ITERATION_STATUS.exec(text);
    if (iterationMatch) {
        agent.turn = Number(iterationMatch[1]);
        pushFeedItem(agent, { type: 'turn', turn: agent.turn, maxTurns: Number(iterationMatch[2]), time });
        return;
    }

    if (text === 'Agent started') {
        agent.status = 'working';
        agent.activity = 'Thinking…';
    } else if (text === 'Agent stopped') {
        agent.status = 'between';
        agent.activity = 'Wrapping up the turn';
    } else if (agent.status !== 'working') {
        agent.status = 'setup';
        agent.activity = text;
    }

    pushFeedItem(agent, { type: 'status', text, isError: FAILED_STATUS.test(text), time });
};

const handleTool = (agent, event, time) => {
    const item = pushFeedItem(agent, {
        type: 'tool',
        toolId: event.toolId,
        name: event.name,
        input: event.input,
        isTest: isTestRun(event.name, event.input),
        result: null,
        time,
    });
    agent.toolItems.set(event.toolId, item);
    agent.pendingTools += 1;
    agent.toolCount += 1;
    agent.status = 'working';
    agent.activity = describeActivity(event.name, event.input);

    // Re-running the tests between edits is how red-green-refactor works, so
    // test runs don't count towards looping.
    if (!item.isTest) {
        agent.recentSignatures.push(toolSignature(event.name, event.input));
        if (agent.recentSignatures.length > RECENT_SIGNATURES) {
            agent.recentSignatures.shift();
        }
    }

    const edited = editedFile(event.name, event.input);
    if (edited) {
        agent.filesEdited.set(edited, (agent.filesEdited.get(edited) ?? 0) + 1);
        agent.markers.push({ time, type: 'edit' });
    } else {
        agent.markers.push({ time, type: 'tool' });
    }

    const read = readFile(event.name, event.input);
    if (read) {
        agent.filesRead.add(read);
    }

    if (event.name === 'TodoWrite' && Array.isArray(event.input?.todos)) {
        agent.todos = event.input.todos;
    }
};

const recordTestResult = (agent, item, time) => {
    const result = parseTestResult(item.result.output, item.result.isError);
    if (!result) {
        return;
    }

    item.tests = result;
    agent.tests = { ...result, time };
    agent.testRuns += 1;

    if (result.failed > 0) {
        agent.markers.push({ time, type: 'testFail' });
    } else {
        agent.markers.push({ time, type: 'testPass' });
    }
};

const recordCommit = (agent, item, time) => {
    const commit = parseCommit(item.name, item.input, item.result.output);
    if (!commit || item.result.isError) {
        return;
    }

    item.commit = commit;
    agent.commits.push({ ...commit, time });
    agent.markers.push({ time, type: 'commit' });
};

const handleToolResult = (agent, event, time) => {
    const item = agent.toolItems.get(event.toolId);
    if (!item) {
        return;
    }

    item.result = { isError: event.isError, output: event.output, time };
    agent.pendingTools = Math.max(0, agent.pendingTools - 1);
    if (agent.pendingTools === 0 && agent.status === 'working') {
        agent.activity = 'Thinking…';
    }

    if (event.isError) {
        agent.errorCount += 1;
        agent.consecutiveErrors += 1;
        agent.markers.push({ time, type: 'error' });
    } else {
        agent.consecutiveErrors = 0;
    }

    if (item.isTest) {
        recordTestResult(agent, item, time);
    }
    recordCommit(agent, item, time);
    touchFeedItem(agent, item);
};

// Claude reports usage per message, repeated on every content block of it,
// so the latest figure per message replaces the earlier one in the totals.
const handleUsage = (agent, event) => {
    const previous = agent.messageUsage.get(event.messageId);
    const fields = ['input', 'output', 'cacheRead', 'cacheCreate'];

    for (const field of fields) {
        agent.usage[field] += event[field] - (previous?.[field] ?? 0);
    }
    agent.messageUsage.set(event.messageId, event);

    // Everything the model read for this message: the size of its context.
    agent.contextTokens = event.input + event.cacheRead + event.cacheCreate;
};

const handleAgentEnd = (state, agent, event, time) => {
    agent.status = event.status;
    agent.endedAt = time;
    agent.pendingTools = 0;
    agent.finalCommits = event.commits;
    agent.error = event.error ?? null;
    if (event.branch) {
        agent.branch = event.branch;
    }

    if (event.status === 'done') {
        agent.activity = `Finished · ${event.commits.length} commit(s)`;
    } else if (event.status === 'aborted') {
        agent.activity = 'Aborted';
    } else {
        agent.activity = truncate(`Failed: ${event.error ?? 'unknown error'}`, 140);
    }

    pushFeedItem(agent, { type: 'end', status: event.status, error: event.error, commits: event.commits, time });
    addLog(state, time, event.status === 'failed' ? 'error' : 'info', `${agent.title}: ${agent.activity}`, agent.id);
};

const applyAgentEvent = (state, agent, event, time) => {
    agent.lastActivityAt = time;

    switch (event.kind) {
        case 'agent.branch':
            agent.branch = event.branch;
            break;
        case 'agent.status':
            handleStatus(agent, event.text, time);
            break;
        case 'agent.turn':
            agent.turn = event.turn;
            break;
        case 'agent.session':
            agent.sessionId = event.sessionId;
            break;
        case 'agent.text':
            pushFeedItem(agent, { type: 'text', text: event.text, time });
            agent.activity = truncate(event.text.trim().split('\n')[0], 140);
            break;
        case 'agent.thinking':
            pushFeedItem(agent, { type: 'thinking', text: event.text, time });
            agent.activity = 'Thinking…';
            break;
        case 'agent.tool':
            handleTool(agent, event, time);
            break;
        case 'agent.toolResult':
            handleToolResult(agent, event, time);
            break;
        case 'agent.usage':
            handleUsage(agent, event);
            break;
        case 'agent.result':
            agent.costUsd += event.costUsd ?? 0;
            break;
        case 'agent.end':
            handleAgentEnd(state, agent, event, time);
            break;
    }
};

// --- Run events --------------------------------------------------------------

const closeCurrentPhase = (state, time) => {
    const current = state.phases[state.phases.length - 1];
    if (current && current.endedAt === null) {
        current.endedAt = time;
    }
};

const PHASE_NAMES = { plan: 'Planning', execute: 'Implementing', review: 'Awaiting review', merge: 'Merging' };

export const phaseName = (phase) => {
    return PHASE_NAMES[phase] ?? 'Starting';
};

const applyRunEvent = (state, event, time) => {
    switch (event.kind) {
        case 'run.start':
            state.runId = event.runId;
            state.startedAt = time;
            state.maxIterations = event.maxIterations;
            state.repoUrl = event.repoUrl ?? null;
            state.mergeGate = event.mergeGate;
            addLog(state, time, 'info', `Run ${event.runId} started`);
            break;
        case 'run.phase':
            closeCurrentPhase(state, time);
            state.phase = event.phase;
            state.iteration = event.iteration;
            state.phases.push({ phase: event.phase, iteration: event.iteration, startedAt: time, endedAt: null });
            addLog(state, time, 'phase', `Iteration ${event.iteration} · ${phaseName(event.phase)}`);
            break;
        case 'run.plan':
            state.plans[event.iteration] = event.issues;
            break;
        case 'run.log':
            addLog(state, time, event.level, event.message);
            break;
        case 'run.settings':
            state.mergeGate = event.mergeGate;
            addLog(state, time, 'info', `Merge gate turned ${event.mergeGate ? 'on' : 'off'}`);
            break;
        case 'run.stopRequested':
            state.stopRequested = true;
            addLog(state, time, 'warn', 'Stop requested: the run ends after this iteration');
            break;
        case 'run.end':
            closeCurrentPhase(state, time);
            state.endedAt = time;
            state.error = event.error ?? null;
            addLog(state, time, event.error ? 'error' : 'info', event.error ? `Run failed: ${event.error}` : 'Run finished');
            break;
        case 'gate.open':
            state.gate = { iteration: event.iteration, branches: event.branches, openedAt: time };
            addLog(state, time, 'warn', `${event.branches.length} branch(es) waiting for your approval`);
            break;
        case 'gate.closed':
            state.gate = null;
            addLog(state, time, 'info', `Approved ${event.approved.length}, rejected ${event.rejected.length}`);
            break;
    }
};

// --- Entry point -------------------------------------------------------------

export const applyEvent = (state, event) => {
    const time = Date.parse(event.time);
    state.lastSeq = event.seq;
    state.lastEventAt = time;

    if (event.kind === 'agent.start') {
        const agent = createAgent(event, time);
        state.agents.set(agent.id, agent);
        state.agentOrder.push(agent.id);
        addLog(state, time, 'info', `${agent.title} started`, agent.id);
        return;
    }

    if (event.kind.startsWith('agent.')) {
        const agent = state.agents.get(event.agentId);
        if (agent) {
            applyAgentEvent(state, agent, event, time);
        }
        return;
    }

    applyRunEvent(state, event, time);
};

export const isAgentActive = (agent) => {
    return agent.status === 'setup' || agent.status === 'working' || agent.status === 'between';
};
