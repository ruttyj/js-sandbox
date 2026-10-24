// The code tabs' workbench layout: dragging the UI section between its docks, resizing the side
// panes, and the caret position the status bar shows. Module-level state, like editorSettings,
// so components and the page template share it without passing props around.
//
// Uses globals from scripts loaded before it:
//   composables/useEditorSettings.js  editorSettings (uiInSidebar)


// --- Docking the UI section -------------------------------------------------------------------
// The UI section (ScopeUiPanel) is dragged by its header onto a dock: 'top' (full width above the
// editor) or 'sidebar' (above Values). Docks are the elements marked data-ui-dock in index.html;
// while a drag is on, an empty dock shows a drop zone.

// How far the pointer moves before a press on the header becomes a drag, so a click stays a click.
const UI_DRAG_THRESHOLD = 5;

// active: a drag is on. x / y: the pointer, for the ghost. zone: the dock under it, or null.
const uiDockDrag = reactive({ active: false, x: 0, y: 0, zone: null });

// The dock under a point: 'top', 'sidebar' or null.
const uiDockZoneAt = (x, y) => {
    const element = document.elementFromPoint(x, y);
    const dock = element ? element.closest('[data-ui-dock]') : null;
    return dock ? dock.dataset.uiDock : null;
};

const moveUiDockDrag = (x, y) => {
    uiDockDrag.x = x;
    uiDockDrag.y = y;
    uiDockDrag.zone = uiDockZoneAt(x, y);
};

const beginUiDockDrag = (x, y) => {
    uiDockDrag.active = true;
    document.body.classList.add('is-dragging-ui');
    moveUiDockDrag(x, y);
};

// Docks the section where it was dropped; dropping it anywhere else leaves it where it was. A
// collapsed sidebar opens to show it.
const endUiDockDrag = () => {
    if (uiDockDrag.zone === 'top') {
        editorSettings.uiInSidebar = false;
    } else if (uiDockDrag.zone === 'sidebar') {
        editorSettings.uiInSidebar = true;
        expandPane('sidebar');
    }
    uiDockDrag.active = false;
    uiDockDrag.zone = null;
    document.body.classList.remove('is-dragging-ui');
};

// Follows a press on the UI section's header (a pointerdown event) until it's released. The
// header captures the pointer, so the drag keeps going over any element.
const trackUiPanelDrag = (event) => {
    const handle = event.currentTarget;
    const origin = { x: event.clientX, y: event.clientY };
    handle.setPointerCapture(event.pointerId);

    const onMove = (e) => {
        if (!uiDockDrag.active) {
            const distance = Math.hypot(e.clientX - origin.x, e.clientY - origin.y);
            if (distance < UI_DRAG_THRESHOLD) {
                return;
            }
            beginUiDockDrag(e.clientX, e.clientY);
        }
        moveUiDockDrag(e.clientX, e.clientY);
    };

    const onEnd = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onEnd);
        if (uiDockDrag.active) {
            endUiDockDrag();
        }
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
};


// --- Resizable, collapsible panes -------------------------------------------------------------
// The data explorer (left of the editor) and the sidebar (right of it) are resized by dragging
// the splitter beside them, and collapse to a thin rail that expands them again. Both are kept
// in this browser only: they suit a screen, not a user.

const PANE_WIDTHS_STORAGE_KEY = 'jsSandbox.paneWidths';
const COLLAPSED_PANES_STORAGE_KEY = 'jsSandbox.collapsedPanes';

// A collapsed pane's column: wide enough for its rail.
const COLLAPSED_PANE_WIDTH = 36;

// A stored JSON object, or {} when it's missing or unreadable (storage can be blocked, e.g. in a
// private window).
const readStoredObject = (key) => {
    try {
        const stored = JSON.parse(localStorage.getItem(key));
        return stored && typeof stored === 'object' ? stored : {};
    } catch {
        return {};
    }
};

const writeStoredObject = (key, value) => {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Not saved; the layout still applies until the page is reloaded.
    }
};

const PANE_LIMITS = {
    explorer: { initial: 400, min: 260, max: 720 },
    sidebar: { initial: 420, min: 280, max: 1000 },
};

const clampPaneWidth = (pane, width) => {
    const { min, max } = PANE_LIMITS[pane];
    return Math.round(Math.min(max, Math.max(min, width)));
};

// The saved widths, or the defaults for any that are missing or unreadable.
const readStoredPaneWidths = () => {
    const stored = readStoredObject(PANE_WIDTHS_STORAGE_KEY);
    const widths = {};
    for (const pane of Object.keys(PANE_LIMITS)) {
        const width = Number(stored[pane]);
        widths[pane] = Number.isFinite(width) ? clampPaneWidth(pane, width) : PANE_LIMITS[pane].initial;
    }
    return widths;
};

// Which panes are collapsed; any not saved are open.
const readStoredCollapsedPanes = () => {
    const stored = readStoredObject(COLLAPSED_PANES_STORAGE_KEY);
    const collapsed = {};
    for (const pane of Object.keys(PANE_LIMITS)) {
        collapsed[pane] = stored[pane] === true;
    }
    return collapsed;
};

const paneWidths = reactive(readStoredPaneWidths());
const paneCollapsed = reactive(readStoredCollapsedPanes());

const savePaneWidths = () => writeStoredObject(PANE_WIDTHS_STORAGE_KEY, paneWidths);

const togglePaneCollapsed = (pane) => {
    paneCollapsed[pane] = !paneCollapsed[pane];
    writeStoredObject(COLLAPSED_PANES_STORAGE_KEY, paneCollapsed);
};

const expandPane = (pane) => {
    if (paneCollapsed[pane]) {
        togglePaneCollapsed(pane);
    }
};

const paneColumnWidth = (pane) => {
    const width = paneCollapsed[pane] ? COLLAPSED_PANE_WIDTH : paneWidths[pane];
    return `${width}px`;
};

// The widths as CSS variables for the code tabs' grid.
const workbenchStyle = computed(() => ({
    '--explorer-w': paneColumnWidth('explorer'),
    '--side-w': paneColumnWidth('sidebar'),
}));

// Follows a press on a splitter (a pointerdown event) until it's released. The explorer is left
// of its splitter, so dragging right widens it; the sidebar is right of its splitter, so dragging
// left does.
const startPaneResize = (pane, event) => {
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = paneWidths[pane];
    const direction = pane === 'explorer' ? 1 : -1;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing-pane');

    const onMove = (e) => {
        paneWidths[pane] = clampPaneWidth(pane, startWidth + (e.clientX - startX) * direction);
    };

    const onEnd = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onEnd);
        document.body.classList.remove('is-resizing-pane');
        savePaneWidths();
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
};

// Double-clicking a splitter puts its pane back to the default width.
const resetPaneWidth = (pane) => {
    paneWidths[pane] = PANE_LIMITS[pane].initial;
    savePaneWidths();
};


// --- Status bar -------------------------------------------------------------------------------

// The focused code editor's caret, written by FormulaInput. active: an editor has focus; line and
// column are from 1; selected: how many characters are selected.
const editorStatus = reactive({ active: false, line: 1, column: 1, selected: 0 });
