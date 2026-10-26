// Supervision heuristics: the things a person watching several unattended
// agents should be told about without having to read every feed.
//
//   stalled        no output for a while (Sandcastle kills it at 10 minutes)
//   looping        the same tool call repeated: the classic doom loop
//   flailing       several tool errors in a row
//   red tests      the last test run failed
//   context        the context window is filling up, so quality will drop
//   turn budget    close to its iteration limit
//   conflict risk  two agents of one iteration editing the same file, which
//                  the planner was meant to rule out, so the merge will fight
//
// Everything is derived from state, so a replayed run shows the same alerts
// it would have shown live (with "now" being the end of the run).

import { formatDuration } from './format.js';
import { isAgentActive } from './store.js';

const STALL_WORKING_MS = 3 * 60 * 1000;
// Sandbox setup (npm ci onto a Windows bind mount) is slow and quiet.
const STALL_SETUP_MS = 8 * 60 * 1000;

const LOOP_REPEATS = 3;
const ERROR_STREAK = 3;

// Claude's standard context window. Past these shares, answers degrade and
// the agent is likely to be compacted or to lose track of the task.
export const CONTEXT_LIMIT = 200_000;
const CONTEXT_WARN = 0.7;
const CONTEXT_DANGER = 0.9;

const TURN_BUDGET_WARN = 0.8;

// --- Per-agent checks ----------------------------------------------------------

const checkStall = (agent, now, alerts) => {
    const quietFor = now - agent.lastActivityAt;
    const limit = agent.status === 'setup' ? STALL_SETUP_MS : STALL_WORKING_MS;
    if (quietFor < limit) {
        return;
    }

    alerts.push({
        level: 'warn',
        agentId: agent.id,
        title: 'No output',
        detail: `Silent for ${formatDuration(quietFor)} while "${agent.activity}"`,
    });
};

const mostRepeatedSignature = (signatures) => {
    const counts = new Map();
    let best = { signature: null, count: 0 };

    for (const signature of signatures) {
        const count = (counts.get(signature) ?? 0) + 1;
        counts.set(signature, count);
        if (count > best.count) {
            best = { signature, count };
        }
    }
    return best;
};

const checkLoop = (agent, alerts) => {
    const { signature, count } = mostRepeatedSignature(agent.recentSignatures);
    if (count < LOOP_REPEATS) {
        return;
    }

    const toolName = signature.split(':')[0];
    alerts.push({
        level: 'warn',
        agentId: agent.id,
        title: 'Repeating itself',
        detail: `Same ${toolName} call ${count}× in its last ${agent.recentSignatures.length} actions`,
    });
};

const checkErrors = (agent, alerts) => {
    if (agent.consecutiveErrors < ERROR_STREAK) {
        return;
    }

    alerts.push({
        level: 'warn',
        agentId: agent.id,
        title: 'Tool errors',
        detail: `${agent.consecutiveErrors} failed tool calls in a row`,
    });
};

const checkTests = (agent, alerts) => {
    if (!agent.tests || agent.tests.failed === 0) {
        return;
    }

    // Failing tests mid-run are expected with red-green-refactor; at the end
    // they mean the branch is broken.
    let level = 'info';
    if (!isAgentActive(agent)) {
        level = 'danger';
    }

    alerts.push({
        level,
        agentId: agent.id,
        title: 'Tests failing',
        detail: `${agent.tests.failed} failed, ${agent.tests.passed} passed in the last run`,
    });
};

const checkContext = (agent, alerts) => {
    const share = agent.contextTokens / CONTEXT_LIMIT;
    if (share < CONTEXT_WARN) {
        return;
    }

    alerts.push({
        level: share >= CONTEXT_DANGER ? 'danger' : 'warn',
        agentId: agent.id,
        title: 'Context filling up',
        detail: `${Math.round(share * 100)}% of the context window in use`,
    });
};

const checkTurnBudget = (agent, alerts) => {
    if (agent.maxTurns <= 1 || agent.turn < agent.maxTurns * TURN_BUDGET_WARN) {
        return;
    }

    alerts.push({
        level: 'warn',
        agentId: agent.id,
        title: 'Iteration budget',
        detail: `On iteration ${agent.turn} of ${agent.maxTurns}`,
    });
};

const checkOutcome = (agent, alerts) => {
    if (agent.status === 'failed') {
        alerts.push({ level: 'danger', agentId: agent.id, title: 'Agent failed', detail: agent.error ?? 'Unknown error' });
        return;
    }

    if (agent.status === 'aborted') {
        alerts.push({ level: 'info', agentId: agent.id, title: 'Aborted', detail: 'Stopped from the dashboard' });
        return;
    }

    const madeNoCommits = agent.status === 'done' && agent.role === 'implementer' && (agent.finalCommits ?? []).length === 0;
    if (madeNoCommits) {
        alerts.push({ level: 'warn', agentId: agent.id, title: 'No commits', detail: 'Finished without committing anything to merge' });
    }
};

// --- Cross-agent checks ------------------------------------------------------

// Files edited by more than one implementer within the same iteration:
// [{ path, iteration, agentIds }], most-contested first.
export const findConflicts = (state) => {
    const editorsByFile = new Map();

    for (const agent of state.agents.values()) {
        if (agent.role !== 'implementer') {
            continue;
        }

        for (const path of agent.filesEdited.keys()) {
            const key = `${agent.iteration}:${path}`;
            if (!editorsByFile.has(key)) {
                editorsByFile.set(key, { path, iteration: agent.iteration, agentIds: [] });
            }
            editorsByFile.get(key).agentIds.push(agent.id);
        }
    }

    const conflicts = [];
    for (const entry of editorsByFile.values()) {
        if (entry.agentIds.length > 1) {
            conflicts.push(entry);
        }
    }
    conflicts.sort((a, b) => b.agentIds.length - a.agentIds.length);
    return conflicts;
};

// --- Entry point -------------------------------------------------------------

const LEVEL_ORDER = { danger: 0, warn: 1, info: 2 };

// All current alerts, most severe first:
// [{ level: danger | warn | info, agentId?, title, detail }]
export const computeAlerts = (state, now) => {
    const alerts = [];

    if (state.gate) {
        alerts.push({ level: 'warn', title: 'Merge gate open', detail: 'Branches are waiting for your approval' });
    }

    if (state.error) {
        alerts.push({ level: 'danger', title: 'Run failed', detail: state.error });
    }

    for (const agent of state.agents.values()) {
        if (isAgentActive(agent)) {
            checkStall(agent, now, alerts);
            checkLoop(agent, alerts);
            checkErrors(agent, alerts);
            checkContext(agent, alerts);
            checkTurnBudget(agent, alerts);
        } else {
            checkOutcome(agent, alerts);
        }
        checkTests(agent, alerts);
    }

    // The files themselves are listed in the conflict radar, so one alert is
    // enough to point at it.
    const conflicts = findConflicts(state);
    if (conflicts.length > 0) {
        let detail = `${conflicts[0].path} is edited by ${conflicts[0].agentIds.length} agents`;
        if (conflicts.length > 1) {
            detail = `${conflicts.length} files are edited by more than one agent: see the conflict radar`;
        }
        alerts.push({ level: 'warn', title: 'Merge conflict risk', detail });
    }

    alerts.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
    return alerts;
};

// Worst alert level for one agent, for colouring its roster card.
export const agentAlertLevel = (alerts, agentId) => {
    let worst = null;
    for (const alert of alerts) {
        if (alert.agentId !== agentId) {
            continue;
        }
        if (worst === null || LEVEL_ORDER[alert.level] < LEVEL_ORDER[worst]) {
            worst = alert.level;
        }
    }
    return worst;
};
