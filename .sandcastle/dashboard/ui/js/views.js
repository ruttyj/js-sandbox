// HTML for every part of the dashboard except the feed and the changes tab.
// Each function takes the state (and UI state where needed) and returns a
// string, which main.js morphs into place. Interactive elements carry
// data-action attributes, handled by one delegated listener in main.js.

import { renderTodos } from './feed.js';
import { CONTEXT_LIMIT, agentAlertLevel, findConflicts } from './health.js';
import {
    baseName,
    escapeHtml,
    formatClock,
    formatCost,
    formatDuration,
    formatTokens,
    truncate,
} from './format.js';
import { icon } from './icons.js';
import { isAgentActive, phaseName } from './store.js';
import { describeTool } from './tools.js';

// --- Shared pieces -----------------------------------------------------------

// A stable colour per agent, used for its dot on the timeline and the
// conflict radar.
const AGENT_HUES = [199, 265, 152, 32, 330, 48, 180, 290];

export const agentHue = (state, agentId) => {
    const index = state.agentOrder.indexOf(agentId);
    return AGENT_HUES[Math.max(0, index) % AGENT_HUES.length];
};

const ROLE_ICONS = { planner: 'compass', implementer: 'code', merger: 'gitMerge' };

const STATUS_LABELS = {
    setup: 'Setting up',
    working: 'Working',
    between: 'Next iteration',
    done: 'Done',
    failed: 'Failed',
    aborted: 'Aborted',
};

const roleBadge = (agent, size = 16) => {
    return `<span class="role-badge role-${agent.role}">${icon(ROLE_ICONS[agent.role] ?? 'activity', size)}</span>`;
};

const statusPill = (agent) => {
    let label = STATUS_LABELS[agent.status] ?? agent.status;
    if (agent.status === 'working' && agent.pendingTools === 0) {
        label = 'Thinking';
    }
    return `<span class="status-pill status-${agent.status}"><span class="status-dot"></span>${label}</span>`;
};

export const agentDisplayName = (agent) => {
    if (agent.issue) {
        return `#${agent.issue.id} ${agent.issue.title}`;
    }
    return agent.title;
};

const agentElapsed = (agent, now) => {
    return (agent.endedAt ?? now) - agent.startedAt;
};

const totalTokens = (usage) => {
    return usage.input + usage.output + usage.cacheRead + usage.cacheCreate;
};

const contextShare = (agent) => {
    return Math.min(1, agent.contextTokens / CONTEXT_LIMIT);
};

const contextLevel = (share) => {
    if (share >= 0.9) {
        return 'danger';
    }
    if (share >= 0.7) {
        return 'warn';
    }
    return 'ok';
};

const contextGauge = (agent) => {
    const share = contextShare(agent);
    const percent = Math.round(share * 100);
    const title = `Context: ${formatTokens(agent.contextTokens)} of ${formatTokens(CONTEXT_LIMIT)}`;
    return `<div class="gauge gauge-${contextLevel(share)}" title="${title}"><span style="width:${percent}%"></span></div>`;
};

const testsChip = (agent) => {
    // Planners only read issues; a test status would always be blank.
    if (agent.role === 'planner') {
        return '';
    }

    if (!agent.tests) {
        return `<span class="chip chip-muted" title="No test run seen yet">${icon('flask', 12)} –</span>`;
    }

    if (agent.tests.failed > 0) {
        return `<span class="chip chip-danger" title="Last test run">${icon('flask', 12)} ${agent.tests.failed} failing</span>`;
    }
    return `<span class="chip chip-success" title="Last test run">${icon('flask', 12)} ${agent.tests.passed} passing</span>`;
};

const commitCount = (agent) => {
    return agent.finalCommits?.length ?? agent.commits.length;
};

// Tool calls per bucket over the agent's last 10 minutes, as an SVG bar
// sparkline: how busy it has been, at a glance.
const SPARK_BUCKETS = 30;
const SPARK_WINDOW_MS = 10 * 60 * 1000;

const sparkline = (agent, now) => {
    const end = agent.endedAt ?? now;
    const start = end - SPARK_WINDOW_MS;
    const bucketMs = SPARK_WINDOW_MS / SPARK_BUCKETS;
    const counts = new Array(SPARK_BUCKETS).fill(0);

    for (const marker of agent.markers) {
        if (marker.time < start || marker.time > end) {
            continue;
        }
        const bucket = Math.min(SPARK_BUCKETS - 1, Math.floor((marker.time - start) / bucketMs));
        counts[bucket] += 1;
    }

    const peak = Math.max(1, ...counts);
    const bars = [];
    for (const [index, count] of counts.entries()) {
        const height = Math.max(1, Math.round((count / peak) * 18));
        bars.push(`<rect x="${index * 4}" y="${20 - height}" width="3" height="${height}" rx="1"/>`);
    }
    return `<svg class="sparkline" viewBox="0 0 ${SPARK_BUCKETS * 4} 20" preserveAspectRatio="none">${bars.join('')}</svg>`;
};

const issueLink = (state, agent) => {
    if (!agent.issue || !state.repoUrl) {
        return '';
    }
    const url = `${state.repoUrl}/issues/${encodeURIComponent(agent.issue.id)}`;
    return `<a class="icon-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" title="Open issue on GitHub">${icon('external', 13)}</a>`;
};

// --- Header ------------------------------------------------------------------

const PHASE_STEPS = [
    { phase: 'plan', label: 'Plan', icon: 'compass' },
    { phase: 'execute', label: 'Implement', icon: 'code' },
    { phase: 'review', label: 'Review', icon: 'eye' },
    { phase: 'merge', label: 'Merge', icon: 'gitMerge' },
];

const phaseStepClass = (stepIndex, activeIndex, runEnded) => {
    if (runEnded || stepIndex < activeIndex) {
        return 'is-done';
    }
    if (stepIndex === activeIndex) {
        return 'is-active';
    }
    return '';
};

export const renderPhaseTrack = (state) => {
    // Review only happens with the gate on; it's shown when it is, or was.
    const showReview = state.mergeGate || state.phase === 'review';
    const steps = PHASE_STEPS.filter((step) => step.phase !== 'review' || showReview);
    const activeIndex = steps.findIndex((step) => step.phase === state.phase);
    const runEnded = state.endedAt !== null;

    const parts = [];
    for (const [index, step] of steps.entries()) {
        if (index > 0) {
            parts.push('<span class="phase-link"></span>');
        }
        const stepClass = phaseStepClass(index, activeIndex, runEnded);
        parts.push(`<span class="phase-step ${stepClass}">${icon(step.icon, 13)}${step.label}</span>`);
    }

    let iteration = 'Waiting to start';
    if (state.iteration > 0) {
        iteration = `Iteration <strong>${state.iteration}</strong> / ${state.maxIterations}`;
    }
    return `<div class="phase-iteration">${iteration}</div><div class="phase-steps">${parts.join('')}</div>`;
};

const kpi = (iconName, label, value, title = '') => {
    return `<div class="kpi" title="${escapeHtml(title)}"><span class="kpi-icon">${icon(iconName, 14)}</span>`
        + `<div><div class="kpi-value">${value}</div><div class="kpi-label">${label}</div></div></div>`;
};

export const renderKpis = (state, now) => {
    let activeAgents = 0;
    let tokens = 0;
    let cost = 0;
    let commits = 0;
    const usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    const filesEdited = new Set();

    for (const agent of state.agents.values()) {
        if (isAgentActive(agent)) {
            activeAgents += 1;
        }
        tokens += totalTokens(agent.usage);
        cost += agent.costUsd;
        commits += commitCount(agent);
        for (const field of Object.keys(usage)) {
            usage[field] += agent.usage[field];
        }
        for (const path of agent.filesEdited.keys()) {
            filesEdited.add(path);
        }
    }

    const elapsed = state.startedAt === null ? 0 : (state.endedAt ?? now) - state.startedAt;
    const tokenTitle = `Input ${formatTokens(usage.input)} · Output ${formatTokens(usage.output)} · `
        + `Cache read ${formatTokens(usage.cacheRead)} · Cache write ${formatTokens(usage.cacheCreate)}`;

    return [
        kpi('clock', 'Elapsed', formatDuration(elapsed)),
        kpi('users', 'Active agents', `${activeAgents}<span class="kpi-dim">/${state.agents.size}</span>`),
        kpi('cpu', 'Tokens', formatTokens(tokens), tokenTitle),
        kpi('dollar', 'Est. cost', formatCost(cost), 'Reported by Claude Code at the end of each agent iteration'),
        kpi('layers', 'Files edited', String(filesEdited.size)),
        kpi('gitCommit', 'Commits', String(commits)),
    ].join('');
};

const connectionPill = (ui, state) => {
    if (!ui.connected) {
        return '<span class="conn conn-down"><span class="status-dot"></span>Reconnecting</span>';
    }
    if (!ui.live) {
        return '<span class="conn conn-replay"><span class="status-dot"></span>Replay</span>';
    }
    if (state.endedAt !== null) {
        return '<span class="conn conn-ended"><span class="status-dot"></span>Finished</span>';
    }
    return '<span class="conn conn-live"><span class="status-dot"></span>Live</span>';
};

export const renderRunControls = (state, ui) => {
    const canControl = ui.live && state.endedAt === null;
    const disabled = canControl ? '' : ' disabled';
    const gateChecked = state.mergeGate ? ' checked' : '';

    let stopLabel = 'Stop after iteration';
    if (state.stopRequested) {
        stopLabel = 'Stopping…';
    }
    const stopDisabled = canControl && !state.stopRequested ? '' : ' disabled';

    return `<label class="switch" title="Pause before each merge so you can approve or reject every branch">`
        + `<input type="checkbox" data-action="toggle-gate"${gateChecked}${disabled}><span class="switch-track"></span>`
        + `<span class="switch-label">${icon('shield', 13)} Merge gate</span></label>`
        + `<button class="btn btn-ghost" data-action="stop-run"${stopDisabled}>${icon('square', 13)} ${stopLabel}</button>`
        + connectionPill(ui, state);
};

// --- Roster ------------------------------------------------------------------

const rosterCard = (state, agent, ui, alerts, now) => {
    const selected = ui.selectedAgentId === agent.id ? ' is-selected' : '';
    const alertLevel = agentAlertLevel(alerts, agent.id);
    const alertClass = alertLevel ? ` alert-${alertLevel}` : '';
    const branch = agent.branch ? ` · ${escapeHtml(agent.branch)}` : '';

    return `<button class="agent-card status-${agent.status}${alertClass}${selected}" data-action="select-agent" data-agent="${escapeHtml(agent.id)}" data-key="${escapeHtml(agent.id)}">`
        + '<div class="agent-card-top">'
        + roleBadge(agent)
        + '<div class="agent-card-title">'
        + `<div class="agent-name" title="${escapeHtml(agentDisplayName(agent))}">${escapeHtml(agentDisplayName(agent))}</div>`
        + `<div class="agent-sub">${escapeHtml(agent.role)}${branch}</div>`
        + '</div>'
        + statusPill(agent)
        + '</div>'
        + `<div class="agent-activity">${escapeHtml(agent.activity)}</div>`
        + '<div class="agent-card-meta">'
        + `<span>${icon('clock', 12)} ${formatDuration(agentElapsed(agent, now))}</span>`
        + `<span>${icon('cpu', 12)} ${formatTokens(totalTokens(agent.usage))}</span>`
        + `<span>${icon('edit', 12)} ${agent.filesEdited.size}</span>`
        + testsChip(agent)
        + '</div>'
        + sparkline(agent, now)
        + contextGauge(agent)
        + '</button>';
};

// Agents grouped by iteration, newest iteration first.
const groupByIteration = (state) => {
    const groups = new Map();
    for (const agentId of state.agentOrder) {
        const agent = state.agents.get(agentId);
        if (!groups.has(agent.iteration)) {
            groups.set(agent.iteration, []);
        }
        groups.get(agent.iteration).push(agent);
    }
    return [...groups.entries()].sort((a, b) => b[0] - a[0]);
};

export const renderRoster = (state, ui, alerts, now) => {
    if (state.agents.size === 0) {
        return `<div class="empty">${icon('users', 22)}<div>No agents yet</div><small>They appear here as the planner hands out work.</small></div>`;
    }

    const parts = [];
    for (const [iteration, agents] of groupByIteration(state)) {
        parts.push(`<div class="roster-group" data-key="group-${iteration}">Iteration ${iteration}</div>`);
        for (const agent of agents) {
            parts.push(rosterCard(state, agent, ui, alerts, now));
        }
    }
    return parts.join('');
};

// --- Overview ----------------------------------------------------------------

// One line per recent feed item for the overview tiles.
const miniFeedLine = (item) => {
    if (item.type === 'tool') {
        const { icon: iconName, verb, target } = describeTool(item.name, item.input);
        const stateClass = item.result?.isError ? ' is-error' : '';
        return `<div class="mini-line${stateClass}">${icon(iconName, 12)}<span class="mini-verb">${escapeHtml(verb)}</span><span class="mini-target">${escapeHtml(truncate(target, 90))}</span></div>`;
    }

    if (item.type === 'text') {
        return `<div class="mini-line mini-text">${icon('message', 12)}<span>${escapeHtml(truncate(item.text.trim().split('\n')[0], 120))}</span></div>`;
    }

    if (item.type === 'status' || item.type === 'turn') {
        const text = item.type === 'turn' ? `Iteration ${item.turn}` : item.text;
        return `<div class="mini-line mini-status">${icon('activity', 12)}<span>${escapeHtml(text)}</span></div>`;
    }
    return '';
};

const MINI_FEED_LINES = 6;

const recentFeedLines = (agent) => {
    const lines = [];
    for (let index = agent.feed.length - 1; index >= 0 && lines.length < MINI_FEED_LINES; index--) {
        const line = miniFeedLine(agent.feed[index]);
        if (line) {
            lines.unshift(line);
        }
    }
    return lines.join('');
};

const topEditedFiles = (agent, count) => {
    const entries = [...agent.filesEdited.entries()].sort((a, b) => b[1] - a[1]);
    const chips = [];
    for (const [path, edits] of entries.slice(0, count)) {
        chips.push(`<span class="file-chip" title="${escapeHtml(path)} · ${edits} edit(s)">${escapeHtml(baseName(path))}</span>`);
    }

    const more = entries.length - count;
    if (more > 0) {
        chips.push(`<span class="file-chip file-chip-more">+${more}</span>`);
    }
    return chips.join('');
};

const overviewTile = (state, agent, alerts, now) => {
    const alertLevel = agentAlertLevel(alerts, agent.id);
    const alertClass = alertLevel ? ` alert-${alertLevel}` : '';
    const activeClass = isAgentActive(agent) ? ' is-active' : '';

    return `<article class="tile status-${agent.status}${alertClass}${activeClass}" data-key="${escapeHtml(agent.id)}">`
        + `<header class="tile-head" data-action="select-agent" data-agent="${escapeHtml(agent.id)}">`
        + roleBadge(agent, 18)
        + `<div class="tile-title"><div class="agent-name">${escapeHtml(agentDisplayName(agent))}</div>`
        + `<div class="agent-sub">${escapeHtml(agent.branch ?? agent.role)} · ${escapeHtml(agent.model)}</div></div>`
        + statusPill(agent)
        + '</header>'
        + `<div class="tile-activity"><span class="tile-caret">›</span>${escapeHtml(agent.activity)}</div>`
        + `<div class="mini-feed" data-action="select-agent" data-agent="${escapeHtml(agent.id)}">${recentFeedLines(agent) || '<div class="mini-line mini-status">Waiting for output…</div>'}</div>`
        + `<div class="tile-files">${topEditedFiles(agent, 5)}</div>`
        + '<footer class="tile-stats">'
        + `<span title="Elapsed">${icon('clock', 12)} ${formatDuration(agentElapsed(agent, now))}</span>`
        + `<span title="Iteration">${icon('refresh', 12)} ${agent.turn || '–'}/${agent.maxTurns}</span>`
        + `<span title="Tokens">${icon('cpu', 12)} ${formatTokens(totalTokens(agent.usage))}</span>`
        + `<span title="Estimated cost">${icon('dollar', 12)} ${formatCost(agent.costUsd)}</span>`
        + `<span title="Commits">${icon('gitCommit', 12)} ${commitCount(agent)}</span>`
        + testsChip(agent)
        + '</footer>'
        + contextGauge(agent)
        + '</article>';
};

const renderPlan = (state) => {
    const issues = state.plans[state.iteration];
    if (!issues || issues.length === 0) {
        return '';
    }

    const rows = issues.map((issue) => `<li><span class="plan-id">#${escapeHtml(issue.id)}</span>${escapeHtml(issue.title)}<code>${escapeHtml(issue.branch)}</code></li>`);
    return `<section class="plan-card"><h3>${icon('compass', 14)} Plan for iteration ${state.iteration}</h3><ul>${rows.join('')}</ul></section>`;
};

export const renderOverview = (state, alerts, now) => {
    const groups = groupByIteration(state);
    if (groups.length === 0) {
        const waiting = state.runId ? 'Waiting for the first agent…' : 'Connecting to Sandcastle…';
        return `<div class="empty empty-stage">${icon('castle', 40)}<div>${waiting}</div></div>`;
    }

    const [latestIteration, latestAgents] = groups[0];
    const tiles = latestAgents.map((agent) => overviewTile(state, agent, alerts, now));
    const parts = [
        renderPlan(state),
        `<h2 class="stage-title" data-key="title-${latestIteration}">Iteration ${latestIteration}</h2>`,
        `<div class="tile-grid" data-key="grid-${latestIteration}">${tiles.join('')}</div>`,
    ];

    for (const [iteration, agents] of groups.slice(1)) {
        const earlierTiles = agents.map((agent) => overviewTile(state, agent, alerts, now));
        parts.push(`<h2 class="stage-title is-past" data-key="title-${iteration}">Iteration ${iteration}</h2>`);
        parts.push(`<div class="tile-grid is-past" data-key="grid-${iteration}">${earlierTiles.join('')}</div>`);
    }
    return parts.join('');
};

// --- Agent detail header -----------------------------------------------------

const stat = (label, value, title = '') => {
    return `<div class="stat" title="${escapeHtml(title)}"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`;
};

export const renderAgentHeader = (state, agent, ui, now) => {
    const canAbort = ui.live && isAgentActive(agent);
    const abortButton = canAbort
        ? `<button class="btn btn-danger" data-action="abort-agent" data-agent="${escapeHtml(agent.id)}">${icon('square', 13)} Abort agent</button>`
        : '';
    const branchChip = agent.branch ? `<span class="chip">${icon('gitBranch', 12)} ${escapeHtml(agent.branch)}</span>` : '';
    const share = contextShare(agent);
    const usageTitle = `Input ${formatTokens(agent.usage.input)} · Output ${formatTokens(agent.usage.output)} · `
        + `Cache read ${formatTokens(agent.usage.cacheRead)} · Cache write ${formatTokens(agent.usage.cacheCreate)}`;

    return '<div class="agent-header-top">'
        + `<button class="btn btn-ghost btn-icon" data-action="show-overview" title="Back to overview (Esc)">${icon('grid', 15)}</button>`
        + roleBadge(agent, 20)
        + '<div class="agent-header-title">'
        + `<h1>${escapeHtml(agentDisplayName(agent))} ${issueLink(state, agent)}</h1>`
        + `<div class="agent-header-chips">${statusPill(agent)}${branchChip}<span class="chip">${icon('cpu', 12)} ${escapeHtml(agent.model)}</span><span class="chip chip-muted">${escapeHtml(agent.id)}</span></div>`
        + '</div>'
        + `<div class="agent-header-actions">${abortButton}</div>`
        + '</div>'
        + `<div class="agent-now"><span class="agent-now-label">Now</span>${escapeHtml(agent.activity)}</div>`
        + '<div class="stat-row">'
        + stat('Elapsed', formatDuration(agentElapsed(agent, now)))
        + stat('Iteration', `${agent.turn || '–'}<span class="kpi-dim">/${agent.maxTurns}</span>`)
        + stat('Tokens', formatTokens(totalTokens(agent.usage)), usageTitle)
        + stat('Context', `${Math.round(share * 100)}%`, `${formatTokens(agent.contextTokens)} of ${formatTokens(CONTEXT_LIMIT)}`)
        + stat('Est. cost', formatCost(agent.costUsd))
        + stat('Tool calls', `${agent.toolCount}<span class="kpi-dim"> · ${agent.errorCount} err</span>`)
        + stat('Files edited', String(agent.filesEdited.size))
        + stat('Commits', String(commitCount(agent)))
        + '</div>'
        + contextGauge(agent);
};

const TABS = [
    { id: 'activity', label: 'Activity', icon: 'activity', key: '1' },
    { id: 'changes', label: 'Changes', icon: 'gitBranch', key: '2' },
    { id: 'plan', label: 'Plan & files', icon: 'list', key: '3' },
];

export const renderTabs = (agent, ui) => {
    const counts = {
        activity: agent.toolCount,
        changes: agent.filesEdited.size,
        plan: agent.todos.length,
    };

    const parts = [];
    for (const tab of TABS) {
        const active = ui.tab === tab.id ? ' is-active' : '';
        parts.push(`<button class="tab${active}" data-action="select-tab" data-tab="${tab.id}" title="Shortcut: ${tab.key}">${icon(tab.icon, 14)}${tab.label}<span class="tab-count">${counts[tab.id]}</span></button>`);
    }
    return parts.join('');
};

const FEED_FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'message', label: 'Messages' },
    { id: 'edit', label: 'Edits' },
    { id: 'command', label: 'Commands' },
    { id: 'read', label: 'Reads' },
    { id: 'error', label: 'Errors' },
];

export const renderFeedFilters = (ui) => {
    const parts = [];
    for (const filter of FEED_FILTERS) {
        const active = ui.feedFilter === filter.id ? ' is-active' : '';
        parts.push(`<button class="filter${active}" data-action="filter-feed" data-filter="${filter.id}">${filter.label}</button>`);
    }
    return parts.join('');
};

// --- Plan & files tab --------------------------------------------------------

const renderTodoPanel = (agent) => {
    if (agent.todos.length === 0) {
        return '<div class="empty-inline">The agent hasn\'t written a plan (TodoWrite) yet.</div>';
    }

    const done = agent.todos.filter((todo) => todo.status === 'completed').length;
    const percent = Math.round((done / agent.todos.length) * 100);
    return `<div class="todo-progress"><span>${done} of ${agent.todos.length} done</span><div class="gauge gauge-ok"><span style="width:${percent}%"></span></div></div>`
        + renderTodos(agent.todos, 'todo-list-large');
};

const renderFileList = (paths, emptyText) => {
    if (paths.length === 0) {
        return `<div class="empty-inline">${emptyText}</div>`;
    }

    const rows = paths.map(([path, detail]) => `<li><span class="file-path">${escapeHtml(path)}</span><span class="file-detail">${escapeHtml(detail)}</span></li>`);
    return `<ul class="file-list">${rows.join('')}</ul>`;
};

export const renderPlanTab = (state, agent) => {
    const edited = [...agent.filesEdited.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([path, edits]) => [path, `${edits} edit${edits === 1 ? '' : 's'}`]);
    const read = [...agent.filesRead].sort().map((path) => [path, agent.filesEdited.has(path) ? 'also edited' : '']);

    return '<div class="plan-grid">'
        + `<section class="card"><h3>${icon('list', 14)} Agent's plan</h3>${renderTodoPanel(agent)}</section>`
        + `<section class="card"><h3>${icon('edit', 14)} Files edited</h3>${renderFileList(edited, 'No edits yet.')}</section>`
        + `<section class="card"><h3>${icon('file', 14)} Files read</h3>${renderFileList(read, 'Nothing read yet.')}</section>`
        + '</div>';
};

// --- Supervisor rail ---------------------------------------------------------

const ALERT_ICONS = { danger: 'alert', warn: 'alert', info: 'eye' };

export const renderAlerts = (state, alerts) => {
    if (alerts.length === 0) {
        return `<div class="all-clear">${icon('shield', 18)}<div><strong>All clear</strong><small>No stalls, loops, failures or conflicts.</small></div></div>`;
    }

    const rows = [];
    for (const [index, alert] of alerts.entries()) {
        const agent = alert.agentId ? state.agents.get(alert.agentId) : null;
        const agentChip = agent ? `<span class="alert-agent">${escapeHtml(truncate(agentDisplayName(agent), 34))}</span>` : '';
        const action = agent ? ` data-action="select-agent" data-agent="${escapeHtml(agent.id)}"` : '';
        rows.push(`<div class="alert alert-${alert.level}"${action} data-key="alert-${index}-${escapeHtml(alert.title)}">`
            + `<span class="alert-icon">${icon(ALERT_ICONS[alert.level], 14)}</span>`
            + `<div class="alert-body"><div class="alert-title">${escapeHtml(alert.title)}${agentChip}</div><div class="alert-detail">${escapeHtml(alert.detail)}</div></div>`
            + '</div>');
    }
    return rows.join('');
};

export const renderConflicts = (state) => {
    const conflicts = findConflicts(state);
    if (conflicts.length === 0) {
        return '<div class="empty-inline">No file is being edited by more than one agent.</div>';
    }

    const rows = [];
    for (const conflict of conflicts) {
        const dots = conflict.agentIds.map((agentId) => {
            const agent = state.agents.get(agentId);
            return `<span class="agent-dot" style="--hue:${agentHue(state, agentId)}" title="${escapeHtml(agentDisplayName(agent))}"></span>`;
        });
        rows.push(`<div class="conflict"><span class="conflict-path" title="${escapeHtml(conflict.path)}">${escapeHtml(conflict.path)}</span><span class="conflict-agents">${dots.join('')}</span></div>`);
    }
    return rows.join('');
};

const gateRow = (state, candidate, ui) => {
    const agent = [...state.agents.values()].find((entry) => entry.branch === candidate.branch && entry.iteration === state.gate.iteration);
    const checked = ui.gateSelection.has(candidate.branch) ? ' checked' : '';
    const disabled = ui.live ? '' : ' disabled';

    let stats = '';
    let review = '';
    if (agent) {
        stats = `<span>${agent.filesEdited.size} files</span><span>${commitCount(agent)} commits</span>${testsChip(agent)}`;
        review = `<button class="btn btn-ghost btn-small" data-action="review-branch" data-agent="${escapeHtml(agent.id)}">${icon('eye', 12)} Review diff</button>`;
    }

    return `<div class="gate-row" data-key="${escapeHtml(candidate.branch)}">`
        + `<label class="gate-check"><input type="checkbox" data-action="gate-select" data-branch="${escapeHtml(candidate.branch)}"${checked}${disabled}>`
        + `<span><strong>#${escapeHtml(candidate.issue.id)}</strong> ${escapeHtml(candidate.issue.title)}</span></label>`
        + `<div class="gate-meta"><code>${escapeHtml(candidate.branch)}</code>${stats}</div>`
        + review
        + '</div>';
};

export const renderGate = (state, ui, now) => {
    if (!state.gate) {
        return '';
    }

    const rows = state.gate.branches.map((candidate) => gateRow(state, candidate, ui));
    const disabled = ui.live ? '' : ' disabled';
    const selectedCount = state.gate.branches.filter((candidate) => ui.gateSelection.has(candidate.branch)).length;

    return `<div class="panel-head gate-head">${icon('shield', 14)} Merge gate · iteration ${state.gate.iteration}<span class="panel-head-dim">waiting ${formatDuration(now - state.gate.openedAt)}</span></div>`
        + '<p class="gate-intro">Review each branch, then choose what the merger agent merges. Rejected branches stay unmerged and their issues stay open, so they are planned again.</p>'
        + rows.join('')
        + '<div class="gate-actions">'
        + `<button class="btn btn-primary" data-action="gate-approve"${disabled}>${icon('gitMerge', 13)} Merge selected (${selectedCount})</button>`
        + `<button class="btn btn-ghost" data-action="gate-reject-all"${disabled}>${icon('x', 13)} Reject all</button>`
        + '</div>';
};

const LOG_LIMIT = 200;

export const renderRunLog = (state) => {
    const entries = state.log.slice(-LOG_LIMIT).reverse();
    const rows = [];

    for (const entry of entries) {
        const action = entry.agentId ? ` data-action="select-agent" data-agent="${escapeHtml(entry.agentId)}"` : '';
        rows.push(`<div class="log-row log-${entry.level}"${action}><time>${formatClock(entry.time)}</time><span>${escapeHtml(entry.text)}</span></div>`);
    }
    return rows.join('');
};

// --- Timeline ----------------------------------------------------------------

const MARKER_CLASSES = { tool: 'mk-tool', edit: 'mk-edit', commit: 'mk-commit', testFail: 'mk-fail', testPass: 'mk-pass', error: 'mk-error' };

const PHASE_CLASSES = { plan: 'ph-plan', execute: 'ph-execute', review: 'ph-review', merge: 'ph-merge' };

// Positions are percentages of the run so far, so the SVG stretches to any
// width without re-measuring.
const toPercent = (time, start, span) => {
    return Math.round(((time - start) / span) * 100_000) / 1000;
};

const timelinePhases = (state, start, span, now) => {
    const rects = [];
    for (const phase of state.phases) {
        const x = toPercent(phase.startedAt, start, span);
        const width = Math.max(0.2, toPercent(phase.endedAt ?? now, start, span) - x);
        rects.push(`<rect class="${PHASE_CLASSES[phase.phase]}" x="${x}%" y="0" width="${width}%" height="6" rx="2"><title>Iteration ${phase.iteration} · ${phaseName(phase.phase)}</title></rect>`);
    }
    return `<svg class="tl-phases" width="100%" height="6">${rects.join('')}</svg>`;
};

const timelineLane = (state, agent, start, span, now, ui) => {
    const x = toPercent(agent.startedAt, start, span);
    const width = Math.max(0.3, toPercent(agent.endedAt ?? now, start, span) - x);
    const marks = [];

    for (const marker of agent.markers) {
        const markerClass = MARKER_CLASSES[marker.type] ?? 'mk-tool';
        marks.push(`<rect class="${markerClass}" x="${toPercent(marker.time, start, span)}%" y="3" width="2" height="12"/>`);
    }

    const selected = ui.selectedAgentId === agent.id ? ' is-selected' : '';
    return `<div class="tl-lane${selected}" data-action="select-agent" data-agent="${escapeHtml(agent.id)}" data-key="${escapeHtml(agent.id)}">`
        + `<div class="tl-label"><span class="agent-dot" style="--hue:${agentHue(state, agent.id)}"></span>${escapeHtml(truncate(agentDisplayName(agent), 30))}</div>`
        + `<svg class="tl-track" width="100%" height="18"><rect class="tl-bar status-${agent.status}" x="${x}%" y="2" width="${width}%" height="14" rx="4" style="--hue:${agentHue(state, agent.id)}"/>${marks.join('')}</svg>`
        + '</div>';
};

export const renderTimeline = (state, ui, now) => {
    if (state.startedAt === null) {
        return '';
    }

    const start = state.startedAt;
    const end = state.endedAt ?? now;
    const span = Math.max(1000, end - start);
    const lanes = state.agentOrder.map((agentId) => timelineLane(state, state.agents.get(agentId), start, span, now, ui));

    return '<div class="tl-head">'
        + `<span class="panel-title">${icon('activity', 13)} Timeline</span>`
        + '<span class="tl-legend"><i class="mk-edit"></i>edit<i class="mk-tool"></i>tool<i class="mk-commit"></i>commit<i class="mk-pass"></i>tests pass<i class="mk-fail"></i>tests fail<i class="mk-error"></i>error</span>'
        + `<span class="tl-span">${formatDuration(span)}</span>`
        + '</div>'
        + `<div class="tl-row"><div class="tl-label tl-label-dim">Phases</div>${timelinePhases(state, start, span, now)}</div>`
        + lanes.join('');
};
