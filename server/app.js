// Builds the Express app: security headers, sessions and sign-in, the API, item icons, and the
// browser app itself (public/) as static files.
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { buildSystemPrompt } from './ai/systemPrompt.js';
import { createPassport } from './auth/passport.js';
import { KnexSessionStore } from './auth/KnexSessionStore.js';
import { createAiController } from './controllers/aiController.js';
import { createAuthController } from './controllers/authController.js';
import { createIconController } from './controllers/iconController.js';
import { createCollectionController, createDocumentController, createStateController } from './controllers/recordControllers.js';
import { createShareController } from './controllers/shareController.js';
import { createManagers } from './managers/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createApiRoutes } from './routes/apiRoutes.js';
import { createAuthRoutes } from './routes/authRoutes.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Scopes' code and item tags' item lists can be large; this is well above any real save.
const JSON_BODY_LIMIT = '5mb';

// What the page may load. The app is Vue's in-browser build from unpkg, which compiles the
// templates at runtime, and it runs scope code with new Function: both need 'unsafe-eval'. Prices
// come straight from the OSRS wiki's API; Google profile pictures from googleusercontent.com.
const contentSecurityPolicy = (config) => ({
    directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://unpkg.com', "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https://secure.runescape.com', 'https://*.googleusercontent.com'],
        connectSrc: ["'self'", 'https://prices.runescape.wiki'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        // Over plain http (local development) this would rewrite every request to https.
        upgradeInsecureRequests: config.secureCookies ? [] : null,
    },
});

const createControllers = (managers, { config, passport, createAiClients }) => ({
    auth: createAuthController({ config, users: managers.users, passport }),
    state: createStateController(managers),
    scopes: createCollectionController(managers.scopes),
    itemTags: createCollectionController(managers.itemTags),
    variableTags: createCollectionController(managers.variableTags),
    globals: createDocumentController(managers.globals),
    settings: createDocumentController(managers.settings),
    shares: createShareController(managers),
    icons: createIconController(managers),
    ai: createAiController(managers, { systemPrompt: buildSystemPrompt(config.publicDir), createAiClients }),
});

const createSessionMiddleware = ({ knex, config }) => {
    const store = new KnexSessionStore({ knex, ttlMs: SESSION_TTL_MS });
    const middleware = session({
        name: config.sessionCookieName,
        secret: config.sessionSecret,
        store,
        resave: false,
        saveUninitialized: false,
        // Each request pushes the expiry back, so only 30 days without a visit signs you out.
        rolling: true,
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: config.secureCookies,
            maxAge: SESSION_TTL_MS,
        },
    });
    return { middleware, store };
};

/**
 * @param {object} options
 * @param {import('knex').Knex} options.knex  Already migrated.
 * @param {ReturnType<import('./config.js').loadConfig>} options.config
 * @param {typeof fetch} [options.fetchImpl]  Replaced in tests so icons aren't downloaded.
 * @param {function(string, string): Promise<void>} [options.verifyApiKey]  Replaced in tests so
 *     API keys aren't checked with their provider.
 * @param {{ anthropic?: function, gemini?: function }} [options.createAiClients]  Replaced in
 *     tests so the chat doesn't call Anthropic or Google.
 * @returns {{ app: import('express').Express, close: function(): void }}
 */
export const createApp = ({ knex, config, fetchImpl, verifyApiKey, createAiClients }) => {
    const managers = createManagers({ knex, config, fetchImpl, verifyApiKey });
    const passport = createPassport({ config, users: managers.users });
    const controllers = createControllers(managers, { config, passport, createAiClients });
    const sessions = createSessionMiddleware({ knex, config });

    const app = express();
    app.set('trust proxy', config.trustProxy);
    app.disable('x-powered-by');

    app.use(helmet({ contentSecurityPolicy: contentSecurityPolicy(config) }));
    app.use(express.json({ limit: JSON_BODY_LIMIT }));
    app.use(sessions.middleware);
    app.use(passport.session());

    app.use('/auth', createAuthRoutes(controllers));
    app.use('/api', createApiRoutes(controllers));
    app.get('/icons/:name', controllers.icons.get);
    app.use(express.static(config.publicDir));

    app.use(notFoundHandler);
    app.use(errorHandler);

    return { app, close: () => sessions.store.close() };
};
