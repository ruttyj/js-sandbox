// Signing in and out. After signing in, the user goes back to the page they started from (e.g. a
// shared scope's link), kept in the session as returnTo while they're at Google.
import { promisify } from 'node:util';
import { isGoogleConfigured } from '../auth/passport.js';
import { NotFoundError } from '../errors.js';

const DEV_USER = { sub: 'dev:local', email: 'dev@localhost', name: 'Dev User' };

// Only paths on this site, so the sign-in can't be used to send someone to another site:
// "/?share=abc" is kept; "https://evil.example", "//evil.example" and "/\evil.example" become "/".
const safeReturnPath = (value) => {
    const isLocalPath = typeof value === 'string'
        && value.startsWith('/')
        && !value.startsWith('//')
        && !value.startsWith('/\\')
        && value.length <= 1000;
    if (!isLocalPath) {
        return '/';
    }
    return value;
};

// Where to go after signing in, taken out of the session.
const takeReturnPath = (req) => {
    const returnTo = safeReturnPath(req.session.returnTo);
    delete req.session.returnTo;
    return returnTo;
};

export const createAuthController = ({ config, users, passport }) => ({
    // The signed-in user (or null) and which ways of signing in are available.
    me: (req, res) => {
        res.json({
            user: req.user || null,
            providers: { google: isGoogleConfigured(config), dev: config.devLogin },
        });
    },

    startGoogle: (req, res, next) => {
        if (!isGoogleConfigured(config)) {
            throw new NotFoundError('Google sign-in is not configured on this server.');
        }
        req.session.returnTo = safeReturnPath(req.query.returnTo);
        passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
    },

    // keepSessionInfo: signing in starts a fresh session (so a session id from before sign-in
    // can't be reused); this carries returnTo over into it.
    googleCallback: (req, res, next) => {
        const authenticate = passport.authenticate('google', {
            failureRedirect: '/?signin=failed',
            keepSessionInfo: true,
        });
        authenticate(req, res, next);
    },

    finishSignIn: (req, res) => {
        res.redirect(takeReturnPath(req));
    },

    devSignIn: async (req, res) => {
        if (!config.devLogin) {
            throw new NotFoundError();
        }
        req.session.returnTo = safeReturnPath(req.query.returnTo);

        const user = await users.upsertBySub(DEV_USER);
        await promisify(req.login.bind(req))(user, { keepSessionInfo: true });
        res.redirect(takeReturnPath(req));
    },

    signOut: async (req, res) => {
        await promisify(req.logout.bind(req))();
        await promisify(req.session.destroy.bind(req.session))();
        res.clearCookie(config.sessionCookieName);
        res.status(204).end();
    },
});
