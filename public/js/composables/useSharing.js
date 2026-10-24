// Sharing a scope read-only by link (see server/managers/ShareManager.js). The link opens the app
// with ?share=<token>: it shows that scope (with its owner's globals and tags) and saves nothing.
// A signed-in viewer can copy the scope into their own scopes.
const SHARE_URL_PARAM = 'share';

// The share token in the page's URL, or null when this isn't a shared link.
const sharedTokenFromUrl = () => new URLSearchParams(window.location.search).get(SHARE_URL_PARAM);

const shareLinkFor = (token) => `${window.location.origin}/?${SHARE_URL_PARAM}=${encodeURIComponent(token)}`;

const scopeSharePath = (scope) => `/api/scopes/${encodeURIComponent(String(scope.id))}/share`;

const useSharing = ({ selectedScope, flushPendingSaves, showToast, showConfirmModal, showInputModal }) => {
    const sharedViewToken = sharedTokenFromUrl();
    const isSharedView = sharedViewToken !== null;

    // Copies the link, or shows it to copy by hand where the clipboard isn't available (it needs
    // https or localhost).
    const offerShareLink = async (token) => {
        const link = shareLinkFor(token);
        try {
            await navigator.clipboard.writeText(link);
            showToast('Share link copied. Anyone with the link can view this scope.', 'success');
        } catch (error) {
            showInputModal('Share link', link, () => {});
        }
    };

    // Turns the link on the first time; afterwards copies the existing link.
    const shareSelectedScope = async () => {
        const scope = selectedScope.value;
        if (!scope) {
            return;
        }

        if (!scope.shareToken) {
            try {
                // The server can only share a scope it has, so a new one is saved first.
                await flushPendingSaves();
                const result = await apiRequest('POST', scopeSharePath(scope));
                scope.shareToken = result.shareToken;
            } catch (error) {
                showToast('Sharing failed.', 'error');
                return;
            }
        }
        await offerShareLink(scope.shareToken);
    };

    const unshareSelectedScope = () => {
        const scope = selectedScope.value;
        if (!scope?.shareToken) {
            return;
        }
        showConfirmModal(
            'Stop Sharing',
            `Turn off the link to "<strong>${scope.name}</strong>"? Anyone who has it won't be able to open it any more.`,
            async () => {
                try {
                    await apiRequest('DELETE', scopeSharePath(scope));
                    scope.shareToken = null;
                    showToast('The share link no longer works.', 'success');
                } catch (error) {
                    showToast('Turning off the link failed.', 'error');
                }
            }
        );
    };

    // Copies the shared scope into the viewer's scopes and opens it there.
    const copySharedScope = async () => {
        try {
            const record = await apiRequest('POST', `/api/shared/${encodeURIComponent(sharedViewToken)}/copy`);
            window.location.assign(`/?tab=scopes&scope=${encodeURIComponent(record.data.id)}`);
        } catch (error) {
            showToast('Copying the scope failed.', 'error');
        }
    };

    return { sharedViewToken, isSharedView, shareSelectedScope, unshareSelectedScope, copySharedScope };
};
