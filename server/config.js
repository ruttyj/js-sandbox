// Settings read from the environment (see .env.example for what each one does).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readBoolean = (value, fallback) => {
    if (value === undefined || value === '') {
        return fallback;
    }
    return value === 'true' || value === '1';
};

// A config object built from env (process.env by default). Tests pass their own env.
export const loadConfig = (env = process.env) => {
    const isProduction = env.NODE_ENV === 'production';
    const baseUrl = (env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const dataDir = path.resolve(projectRoot, env.DATA_DIR || 'storage');

    const sessionSecret = env.SESSION_SECRET || '';
    if (isProduction && sessionSecret.length < 32) {
        throw new Error('SESSION_SECRET must be set to at least 32 characters in production.');
    }

    // Production without it leaves the Claude features off; set too short, it's refused.
    const aiKeySecret = env.AI_KEY_SECRET || '';
    if (isProduction && aiKeySecret !== '' && aiKeySecret.length < 32) {
        throw new Error('AI_KEY_SECRET must be at least 32 characters in production.');
    }

    return {
        isProduction,
        port: Number(env.PORT) || 3000,
        baseUrl,
        // Cookies are only sent over https when the site is served over https.
        secureCookies: baseUrl.startsWith('https://'),
        // How many reverse proxies (Traefik) sit in front of the app, so req.ip and req.secure
        // come from X-Forwarded-* rather than the proxy's own connection.
        trustProxy: Number(env.TRUST_PROXY ?? (isProduction ? 1 : 0)),
        dataDir,
        databaseFile: path.join(dataDir, 'ge-tracker.sqlite'),
        iconDir: path.join(dataDir, 'icons'),
        publicDir: path.join(projectRoot, 'public'),
        sessionSecret: sessionSecret || 'dev-only-session-secret-change-me',
        sessionCookieName: 'ge.sid',
        google: {
            clientId: env.GOOGLE_CLIENT_ID || '',
            clientSecret: env.GOOGLE_CLIENT_SECRET || '',
        },
        // "Sign in as dev user" without Google. Never available in production.
        devLogin: !isProduction && readBoolean(env.DEV_LOGIN, false),
        // Encrypts the Anthropic API keys users connect. '' turns the Claude features off.
        aiKeySecret: aiKeySecret || (isProduction ? '' : 'dev-only-ai-key-secret-change-me'),
    };
};
