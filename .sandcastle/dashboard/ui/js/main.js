// The dashboard's controller: follows the server's event stream, renders
// every view, and turns clicks and keys into navigation or run controls.

import { fetchChanges, renderChangesTab } from './changes.js';
import { morph } from './dom.js';
import { FeedView } from './feed.js';
import { computeAlerts } from './health.js';
import { applyEvent, createState, isAgentActive } from './store.js';
import {
    agentDisplayName,
    renderAgentHeader,
    renderAlerts,
    renderConflicts,
    renderFeedFilters,
    renderGate,
    renderKpis,
    renderOverview,
    renderPhaseTrack,
    renderPlanTab,
    renderRoster,
    renderRunControls,
    renderRunLog,
    renderTabs,
    renderTimeline,
} from './views.js';

const RECONNECT_DELAY_MS = 2000;
const CHANGES_POLL_MS = 4000;
const TOAST_MS = 4000;

const element = (id) => document.getElementById(id);

const els = {
    phaseTrack: element('phase-track'),
    kpis: element('kpis'),
    runControls: element('run-controls'),
    roster: element('roster'),
    rosterCount: element('roster-count'),
    overview: element('stage-overview'),
    agentView: element('stage-agent'),
    agentHeader: element('agent-header'),
    tabs: element('agent-tabs'),
    feedFilters: element('feed-filters'),
    feed: element('feed'),
    jumpLatest: element('jump-latest'),
    tabPanels: {
        activity: element('tab-activity'),
        changes: element('tab-changes'),
        plan: element('tab-plan'),
    },
    gatePanel: element('gate-panel'),
    alerts: element('alerts'),
    alertCount: element('alert-count'),
    conflicts: element('conflicts'),
    runLog: element('run-log'),
    timeline: element('timeline'),
    toasts: element('toasts'),
    dialog: element('confirm-dialog'),
};

let state = createState();

const ui = {
    // The server's identity for the stream; a different one means a new run.
    streamRunId: null,
    connected: false,
    syncing: false,
    live: false,
    selectedAgentId: null,
    tab: 'activity',
    feedFilter: 'all',
    // Branches ticked in the merge gate, and which gate they belong to.
    gateSelection: new Set(),
    gateKey: null,
    // agentId -> { loading, error, data, files, fetchedAt }
    changes: new Map(),
    // agentId -> path shown in the Changes tab
    selectedFile: new Map(),
};

const feedView = new FeedView(els.feed, (following) => {
    els.jumpLatest.hidden = following;
});

// A replayed run is frozen at its last event; a live one moves with the clock.
const currentTime = () => {
    if (ui.live) {
        return Date.now();
    }
    return state.endedAt ?? state.lastEventAt ?? Date.now();
};

// --- Notifications -----------------------------------------------------------

const showToast = (message, level = 'info') => {
    const toast = document.createElement('div');
    toast.className = `toast toast-${level}`;
    toast.textContent = message;
    els.toasts.appendChild(toast);
    setTimeout(() => toast.remove(), TOAST_MS);
};

// Resolves true when the user confirms. Uses the page's own dialog rather
// than window.confirm so it matches the rest of the UI.
const confirmAction = ({ title, body, confirmLabel, danger = false }) => {
    const dialog = els.dialog;
    dialog.querySelector('.dialog-title').textContent = title;
    dialog.querySelector('.dialog-body').textContent = body;
    const confirmButton = dialog.querySelector('[value="confirm"]');
    confirmButton.textContent = confirmLabel;
    confirmButton.className = danger ? 'btn btn-danger' : 'btn btn-primary';

    // Escape closes the dialog without setting returnValue, so clear the one
    // left by the previous confirmation.
    dialog.returnValue = '';
    return new Promise((resolve) => {
        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
        dialog.showModal();
    });
};

const updateDocumentTitle = (alerts) => {
    if (state.gate) {
        document.title = '⏸ Approval needed · Sandcastle';
        return;
    }

    const urgent = alerts.filter((alert) => alert.level !== 'info').length;
    if (urgent > 0) {
        document.title = `(${urgent}) Sandcastle Mission Control`;
        return;
    }
    document.title = 'Sandcastle Mission Control';
};

// --- Merge gate selection ----------------------------------------------------

// When a new gate opens, branches whose last test run passed (or that have
// no test run) start ticked; failing ones start unticked.
const syncGateSelection = () => {
    if (!state.gate) {
        ui.gateKey = null;
        return;
    }

    const key = `${state.gate.iteration}:${state.gate.branches.map((candidate) => candidate.branch).join(',')}`;
    if (key === ui.gateKey) {
        return;
    }

    ui.gateKey = key;
    ui.gateSelection = new Set();
    for (const candidate of state.gate.branches) {
        const agent = [...state.agents.values()].find((entry) => entry.branch === candidate.branch && entry.iteration === state.gate.iteration);
        const testsFailing = agent?.tests && agent.tests.failed > 0;
        if (!testsFailing) {
            ui.gateSelection.add(candidate.branch);
        }
    }
};

// --- Rendering ---------------------------------------------------------------

const renderAgentView = (agent, now) => {
    morph(els.agentHeader, renderAgentHeader(state, agent, ui, now));
    morph(els.tabs, renderTabs(agent, ui));

    for (const [tab, panel] of Object.entries(els.tabPanels)) {
        panel.hidden = tab !== ui.tab;
    }

    if (ui.tab === 'activity') {
        morph(els.feedFilters, renderFeedFilters(ui));
        els.feed.dataset.filter = ui.feedFilter;
        feedView.render(agent);
    } else if (ui.tab === 'changes') {
        const entry = ui.changes.get(agent.id);
        // Real time, not the run's clock: "updated 3s ago" is about the fetch,
        // which happens now even when replaying an old run.
        morph(els.tabPanels.changes, renderChangesTab(entry, ui.selectedFile.get(agent.id), state.repoUrl, Date.now()));
    } else {
        morph(els.tabPanels.plan, renderPlanTab(state, agent));
    }
};

const renderRail = (alerts, now) => {
    syncGateSelection();
    els.gatePanel.hidden = !state.gate;
    morph(els.gatePanel, renderGate(state, ui, now));

    morph(els.alerts, renderAlerts(state, alerts));
    els.alertCount.textContent = alerts.length === 0 ? '' : String(alerts.length);
    morph(els.conflicts, renderConflicts(state));
    morph(els.runLog, renderRunLog(state));
};

const render = () => {
    const now = currentTime();
    const alerts = computeAlerts(state, now);

    morph(els.phaseTrack, renderPhaseTrack(state));
    morph(els.kpis, renderKpis(state, now));
    morph(els.runControls, renderRunControls(state, ui));
    morph(els.roster, renderRoster(state, ui, alerts, now));
    els.rosterCount.textContent = String(state.agents.size);

    const agent = state.agents.get(ui.selectedAgentId);
    els.overview.hidden = Boolean(agent);
    els.agentView.hidden = !agent;
    if (agent) {
        renderAgentView(agent, now);
    } else {
        morph(els.overview, renderOverview(state, alerts, now));
    }

    renderRail(alerts, now);
    morph(els.timeline, renderTimeline(state, ui, now));
    updateDocumentTitle(alerts);
};

let renderQueued = false;

const scheduleRender = () => {
    if (renderQueued) {
        return;
    }
    renderQueued = true;
    requestAnimationFrame(() => {
        renderQueued = false;
        render();
    });
};

// --- Changes -----------------------------------------------------------------

const refreshChanges = async (agentId) => {
    const entry = ui.changes.get(agentId) ?? { loading: false, error: null, data: null, files: [], fetchedAt: null };
    if (entry.loading) {
        return;
    }

    entry.loading = true;
    ui.changes.set(agentId, entry);
    scheduleRender();

    try {
        const { data, files } = await fetchChanges(agentId);
        entry.data = data;
        entry.files = files;
        entry.error = null;
        entry.fetchedAt = Date.now();
    } catch (error) {
        entry.error = String(error.message ?? error);
    } finally {
        entry.loading = false;
        scheduleRender();
    }
};

// Keeps the open Changes tab current while its agent is still editing.
const pollChanges = () => {
    const agent = state.agents.get(ui.selectedAgentId);
    if (!agent || ui.tab !== 'changes' || document.hidden) {
        return;
    }

    if (isAgentActive(agent)) {
        void refreshChanges(agent.id);
    }
};

// --- Navigation --------------------------------------------------------------

const writeHash = () => {
    const params = new URLSearchParams();
    if (ui.selectedAgentId) {
        params.set('agent', ui.selectedAgentId);
        params.set('tab', ui.tab);
    }
    history.replaceState(null, '', params.toString() ? `#${params}` : location.pathname);
};

const readHash = () => {
    const params = new URLSearchParams(location.hash.slice(1));
    ui.selectedAgentId = params.get('agent');
    ui.tab = params.get('tab') ?? 'activity';
};

const selectTab = (tab) => {
    ui.tab = tab;
    writeHash();

    if (tab === 'changes' && ui.selectedAgentId) {
        void refreshChanges(ui.selectedAgentId);
    }
    scheduleRender();
};

const selectAgent = (agentId, tab = ui.tab) => {
    ui.selectedAgentId = agentId;
    selectTab(tab);
};

const showOverview = () => {
    ui.selectedAgentId = null;
    writeHash();
    scheduleRender();
};

// Agents in roster order: newest iteration first, then start order.
const rosterOrder = () => {
    const agents = state.agentOrder.map((agentId) => state.agents.get(agentId));
    agents.sort((a, b) => b.iteration - a.iteration);
    return agents.map((agent) => agent.id);
};

const stepAgent = (direction) => {
    const order = rosterOrder();
    if (order.length === 0) {
        return;
    }

    const index = order.indexOf(ui.selectedAgentId);
    const next = (index + direction + order.length) % order.length;
    selectAgent(order[index === -1 ? 0 : next]);
};

// --- Run controls ------------------------------------------------------------

const post = async (path, body = {}) => {
    const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(result.error ?? `HTTP ${response.status}`);
    }
    return result;
};

const runControl = async (path, body, successMessage) => {
    try {
        await post(path, body);
        if (successMessage) {
            showToast(successMessage, 'success');
        }
    } catch (error) {
        showToast(`Failed: ${error.message}`, 'danger');
    }
};

const abortAgent = async (agentId) => {
    const agent = state.agents.get(agentId);
    const confirmed = await confirmAction({
        title: 'Abort this agent?',
        body: `"${agentDisplayName(agent)}" will be stopped immediately. Its worktree and any commits are kept; uncommitted edits stay in the worktree.`,
        confirmLabel: 'Abort agent',
        danger: true,
    });

    if (confirmed) {
        await runControl(`/api/agents/${encodeURIComponent(agentId)}/abort`, {}, 'Abort sent');
    }
};

const stopRun = async () => {
    const confirmed = await confirmAction({
        title: 'Stop after this iteration?',
        body: 'Agents that are running finish their work and the merge still happens, but no new iteration starts.',
        confirmLabel: 'Stop after iteration',
    });

    if (confirmed) {
        await runControl('/api/run/stop', {}, 'The run will stop after this iteration');
    }
};

const toggleGate = async (enabled) => {
    let message = 'Merge gate off: branches merge automatically';
    if (enabled) {
        message = 'Merge gate on: you approve each branch before merging';
    }
    await runControl('/api/run/settings', { mergeGate: enabled }, message);
};

const approveGate = async () => {
    const approved = state.gate.branches
        .map((candidate) => candidate.branch)
        .filter((branch) => ui.gateSelection.has(branch));
    const rejected = state.gate.branches.length - approved.length;

    const confirmed = await confirmAction({
        title: `Merge ${approved.length} branch(es)?`,
        body: rejected > 0
            ? `${rejected} unticked branch(es) are rejected: they stay unmerged and their issues stay open.`
            : 'The merger agent merges every branch and runs the tests.',
        confirmLabel: 'Merge',
    });

    if (confirmed) {
        await runControl('/api/gate', { approved }, 'Sent to the merger');
    }
};

const rejectGate = async () => {
    const confirmed = await confirmAction({
        title: 'Reject every branch?',
        body: 'Nothing is merged this iteration. The issues stay open and are planned again.',
        confirmLabel: 'Reject all',
        danger: true,
    });

    if (confirmed) {
        await runControl('/api/gate', { approved: [] }, 'All branches rejected');
    }
};

// --- Event delegation --------------------------------------------------------

const handleClick = (event) => {
    const target = event.target.closest('[data-action]');
    if (!target || target.matches('input')) {
        return;
    }

    const { action, agent: agentId } = target.dataset;
    switch (action) {
        case 'select-agent':
            selectAgent(agentId);
            break;
        case 'show-overview':
            showOverview();
            break;
        case 'select-tab':
            selectTab(target.dataset.tab);
            break;
        case 'filter-feed':
            ui.feedFilter = target.dataset.filter;
            scheduleRender();
            break;
        case 'abort-agent':
            void abortAgent(agentId);
            break;
        case 'stop-run':
            void stopRun();
            break;
        case 'gate-approve':
            void approveGate();
            break;
        case 'gate-reject-all':
            void rejectGate();
            break;
        case 'review-branch':
            selectAgent(agentId, 'changes');
            break;
        case 'refresh-changes':
            void refreshChanges(ui.selectedAgentId);
            break;
        case 'select-file':
            ui.selectedFile.set(ui.selectedAgentId, target.dataset.path);
            scheduleRender();
            break;
    }
};

const handleChange = (event) => {
    const target = event.target;
    if (target.dataset.action === 'toggle-gate') {
        void toggleGate(target.checked);
    } else if (target.dataset.action === 'gate-select') {
        if (target.checked) {
            ui.gateSelection.add(target.dataset.branch);
        } else {
            ui.gateSelection.delete(target.dataset.branch);
        }
        scheduleRender();
    }
};

const SHORTCUT_TABS = { 1: 'activity', 2: 'changes', 3: 'plan' };

const handleKey = (event) => {
    const typing = event.target.closest('input, textarea, select');
    if (typing || event.ctrlKey || event.metaKey || event.altKey || els.dialog.open) {
        return;
    }

    if (event.key === 'Escape') {
        showOverview();
    } else if (event.key === 'j') {
        stepAgent(1);
    } else if (event.key === 'k') {
        stepAgent(-1);
    } else if (SHORTCUT_TABS[event.key] && ui.selectedAgentId) {
        selectTab(SHORTCUT_TABS[event.key]);
    }
};

// --- Event stream ------------------------------------------------------------

const handleHello = (message) => {
    const hello = JSON.parse(message.data);

    // A different stream id means the server restarted with a new run (or
    // a new replay): everything shown so far belongs to the old one.
    if (hello.runId !== ui.streamRunId) {
        state = createState();
        ui.streamRunId = hello.runId;
        ui.changes.clear();
        feedView.reset(null);
    }

    ui.live = hello.live;
    ui.connected = true;
    ui.syncing = true;
};

const connect = () => {
    const params = new URLSearchParams({ run: ui.streamRunId ?? '', after: String(state.lastSeq) });
    const source = new EventSource(`/api/stream?${params}`);

    source.addEventListener('hello', handleHello);
    source.addEventListener('synced', () => {
        ui.syncing = false;
        scheduleRender();
    });
    source.onmessage = (message) => {
        applyEvent(state, JSON.parse(message.data));
        // During the initial catch-up, render once at the end instead.
        if (!ui.syncing) {
            scheduleRender();
        }
    };
    // EventSource would retry with the URL it was opened with; reopening
    // instead sends the latest seq so nothing is replayed twice.
    source.onerror = () => {
        source.close();
        ui.connected = false;
        scheduleRender();
        setTimeout(connect, RECONNECT_DELAY_MS);
    };
};

// --- Startup -----------------------------------------------------------------

els.jumpLatest.addEventListener('click', () => feedView.scrollToLatest());
document.addEventListener('click', handleClick);
document.addEventListener('change', handleChange);
document.addEventListener('keydown', handleKey);
// Following a link or reloading lands straight on a tab, which needs the
// same loading a click on it would do.
const applyHash = () => {
    readHash();
    if (ui.tab === 'changes' && ui.selectedAgentId) {
        void refreshChanges(ui.selectedAgentId);
    }
    scheduleRender();
};

window.addEventListener('hashchange', applyHash);

applyHash();
connect();
// Clocks, durations and stall checks advance even when no events arrive.
setInterval(scheduleRender, 1000);
setInterval(pollChanges, CHANGES_POLL_MS);

// Exposed for debugging from the browser console.
window.sandcastle = {
    get state() {
        return state;
    },
    ui,
};
