// A fresh app over its own temporary database for each test file, and a signed-in client.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { createKnex, runMigrations } from '../server/db/knex.js';

export const API_HEADER = { 'X-Requested-With': 'ge-tracker' };

// fetchImpl: stands in for fetch when the server downloads icons.
// verifyApiKey: stands in for checking API keys with their provider (by default, accepts any).
// createAiClients: { anthropic, gemini } stand-ins for the clients the chat uses.
// env: extra environment settings.
export const createTestApp = async ({ fetchImpl, verifyApiKey = async () => {}, createAiClients, env = {} } = {}) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-tracker-test-'));
    const config = loadConfig({ DATA_DIR: dataDir, DEV_LOGIN: 'true', ...env });
    const knex = createKnex(config.databaseFile);
    await runMigrations(knex);
    const { app, close } = createApp({ knex, config, fetchImpl, verifyApiKey, createAiClients });

    const destroy = async () => {
        close();
        await knex.destroy();
        fs.rmSync(dataDir, { recursive: true, force: true });
    };
    return { app, knex, config, destroy };
};

// A client that keeps cookies, signed in as the development user.
export const signedInAgent = async (app) => {
    const agent = supertest.agent(app);
    await agent.get('/auth/dev').expect(302);
    return agent;
};

export const scopeData = (overrides = {}) => ({
    name: 'Herb runs',
    code: 'const profit = 100;',
    variables: [{ key: 'profit', name: 'Profit', color: '#ff0000', tags: [] }],
    itemTagKeys: [],
    itemColors: {},
    colorSeed: 42,
    ...overrides,
});
