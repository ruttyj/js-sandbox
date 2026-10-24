// Who's signed in, and signing in and out. Signing in leaves the app for Google (or the
// development sign-in) and comes back to the page it started from.
const useSession = ({ showToast }) => {
    const currentUser = ref(null); // { id, email, name, avatarUrl }, or null when signed out
    const signInProviders = ref({ google: false, dev: false }); // which ways of signing in the server offers
    const sessionChecked = ref(false); // false until the server has said who's signed in
    const serverUnreachable = ref(false);

    const loadSession = async () => {
        try {
            const me = await apiRequest('GET', '/api/me');
            currentUser.value = me.user;
            signInProviders.value = me.providers;
        } catch (error) {
            console.error(error);
            serverUnreachable.value = true;
            showToast('Could not reach the server.', 'error');
        } finally {
            sessionChecked.value = true;
        }
    };

    // provider: 'google' | 'dev'.
    const signInUrl = (provider) => {
        const returnTo = window.location.pathname + window.location.search;
        return `/auth/${provider}?returnTo=${encodeURIComponent(returnTo)}`;
    };

    // beforeSignOut: saves anything still waiting, so it isn't lost with the session.
    const signOut = async (beforeSignOut) => {
        await beforeSignOut();
        try {
            await apiRequest('POST', '/auth/logout');
        } catch (error) {
            console.error(error);
            showToast('Signing out failed.', 'error');
            return;
        }
        window.location.assign('/');
    };

    // ?signin=failed: Google sent the user back without signing them in (e.g. they cancelled).
    const reportFailedSignIn = () => {
        const url = new URL(window.location);
        if (url.searchParams.get('signin') !== 'failed') {
            return;
        }
        showToast('Signing in did not complete.', 'error');
        url.searchParams.delete('signin');
        window.history.replaceState(null, '', url);
    };

    return { currentUser, signInProviders, sessionChecked, serverUnreachable, loadSession, signInUrl, signOut, reportFailedSignIn };
};
