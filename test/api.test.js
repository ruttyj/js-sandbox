import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScopeManager } from '../server/managers/ScopeManager.js';
import { UserManager } from '../server/managers/UserManager.js';
import { API_HEADER, createTestApp, scopeData, signedInAgent } from './helpers.js';

let testApp;
let agent;

beforeAll(async () => {
    testApp = await createTestApp();
    agent = await signedInAgent(testApp.app);
});

afterAll(async () => {
    await testApp.destroy();
});

const putScope = (id, body) => agent.put(`/api/scopes/${id}`).set(API_HEADER).send(body);

describe('signing in', () => {
    it('reports no user, and refuses data, when signed out', async () => {
        const client = supertest(testApp.app);
        const me = await client.get('/api/me').expect(200);
        expect(me.body.user).toBeNull();
        expect(me.body.providers).toEqual({ google: false, dev: true });

        await client.get('/api/state').expect(401);
    });

    it('signs in the development user', async () => {
        const me = await agent.get('/api/me').expect(200);
        expect(me.body.user).toMatchObject({ name: 'Dev User', email: 'dev@localhost' });
    });

    it('only returns to paths on this site after signing in', async () => {
        const client = supertest.agent(testApp.app);
        const local = await client.get('/auth/dev').query({ returnTo: '/?share=abc' }).expect(302);
        expect(local.headers.location).toBe('/?share=abc');

        for (const returnTo of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
            const response = await client.get('/auth/dev').query({ returnTo }).expect(302);
            expect(response.headers.location).toBe('/');
        }
    });

    it('signs out', async () => {
        const client = await signedInAgent(testApp.app);
        await client.post('/auth/logout').set(API_HEADER).expect(204);
        const me = await client.get('/api/me').expect(200);
        expect(me.body.user).toBeNull();
    });

    it('refuses writes without the API header', async () => {
        await agent.put('/api/scopes/1').send({ version: null, position: 0, data: scopeData() }).expect(403);
        await agent.post('/auth/logout').expect(403);
    });
});

describe('scopes', () => {
    it('creates, updates and loads a scope, bumping its version', async () => {
        const created = await putScope('100', { version: null, position: 0, data: scopeData() }).expect(200);
        expect(created.body).toEqual({ version: 1 });

        const updated = await putScope('100', { version: 1, position: 0, data: scopeData({ code: 'const profit = 200;' }) }).expect(200);
        expect(updated.body).toEqual({ version: 2 });

        const state = await agent.get('/api/state').expect(200);
        const scope = state.body.scopes.find(record => record.data.id === '100');
        expect(scope.version).toBe(2);
        expect(scope.data).toMatchObject({ ...scopeData({ code: 'const profit = 200;' }), id: '100', shareToken: null });
    });

    it('refuses a save based on a stale version, returning the current record', async () => {
        const response = await putScope('100', { version: 1, position: 0, data: scopeData({ name: 'Stale' }) }).expect(409);
        expect(response.body.current.version).toBe(2);
        expect(response.body.current.data.code).toBe('const profit = 200;');
    });

    it('refuses to create a record that already exists', async () => {
        const response = await putScope('100', { version: null, position: 0, data: scopeData() }).expect(409);
        expect(response.body.current.version).toBe(2);
    });

    it('refuses to save a record that was deleted elsewhere', async () => {
        const response = await putScope('missing', { version: 3, position: 0, data: scopeData() }).expect(409);
        expect(response.body.current).toBeNull();
    });

    it('validates the record', async () => {
        const response = await putScope('101', { version: null, position: 0, data: { name: '' } }).expect(400);
        expect(response.body.issues.length).toBeGreaterThan(0);
    });

    it('saves the order of the scopes', async () => {
        await putScope('200', { version: null, position: 1, data: scopeData({ name: 'Second' }) }).expect(200);
        await agent.put('/api/scopes/order').set(API_HEADER).send({ keys: ['200', '100'] }).expect(204);

        const state = await agent.get('/api/state').expect(200);
        expect(state.body.scopes.map(record => record.data.id)).toEqual(['200', '100']);
    });

    it('deletes with a version check, and treats deleting a missing scope as done', async () => {
        await agent.delete('/api/scopes/200').query({ version: 5 }).set(API_HEADER).expect(409);
        await agent.delete('/api/scopes/200').query({ version: 1 }).set(API_HEADER).expect(204);
        await agent.delete('/api/scopes/200').query({ version: 1 }).set(API_HEADER).expect(204);
    });

    it("keeps each user's scopes to themselves", async () => {
        const users = new UserManager(testApp.knex);
        const other = await users.upsertBySub({ sub: 'other-user', name: 'Other' });
        await new ScopeManager(testApp.knex).save(other.id, '100', { version: null, position: 0, data: scopeData({ name: 'Theirs' }) });

        const state = await agent.get('/api/state').expect(200);
        const names = state.body.scopes.map(record => record.data.name);
        expect(names).not.toContain('Theirs');
    });
});

describe('tags, globals and settings', () => {
    it('saves item tags and variable tags', async () => {
        await agent.put('/api/item-tags/herbs').set(API_HEADER)
            .send({ version: null, position: 0, data: { label: 'Herbs', parent: null, items: [199, 201] } }).expect(200);
        await agent.put('/api/variable-tags/PROFIT').set(API_HEADER)
            .send({ version: null, position: 0, data: { label: 'Profit' } }).expect(200);

        const state = await agent.get('/api/state').expect(200);
        expect(state.body.itemTags[0].data).toEqual({ key: 'herbs', label: 'Herbs', parent: null, items: [199, 201] });
        expect(state.body.variableTags[0].data).toEqual({ key: 'PROFIT', label: 'Profit' });
    });

    it('reads unsaved globals as version 0, then versions each save', async () => {
        const initial = await agent.get('/api/globals').expect(200);
        expect(initial.body).toEqual({ version: 0, data: { code: '', variables: [] } });

        const data = { code: 'const tax = 0.02;', variables: [{ key: 'tax' }] };
        await agent.put('/api/globals').set(API_HEADER).send({ version: 0, data }).expect(200, { version: 1 });
        const conflict = await agent.put('/api/globals').set(API_HEADER).send({ version: 0, data }).expect(409);
        expect(conflict.body.current.version).toBe(1);
    });

    it('saves settings', async () => {
        const data = { editorSettings: { lineNumbers: true }, dashboardFilter: ['PROFIT'] };
        await agent.put('/api/settings').set(API_HEADER).send({ version: 0, data }).expect(200);

        const state = await agent.get('/api/state').expect(200);
        expect(state.body.settings).toEqual({ version: 1, data });
    });
});

describe('sharing', () => {
    let token;

    it('makes a link to a scope, reused when shared again', async () => {
        const first = await agent.post('/api/scopes/100/share').set(API_HEADER).expect(200);
        token = first.body.shareToken;
        expect(token).toMatch(/^[A-Za-z0-9_-]{16,}$/);

        const second = await agent.post('/api/scopes/100/share').set(API_HEADER).expect(200);
        expect(second.body.shareToken).toBe(token);
    });

    it('404s when sharing a scope the user does not have', async () => {
        await agent.post('/api/scopes/nope/share').set(API_HEADER).expect(404);
    });

    it("shows the scope and its owner's globals and tags to anyone, without the token", async () => {
        const view = await supertest(testApp.app).get(`/api/shared/${token}`).expect(200);
        expect(view.body.scope).toMatchObject({ id: '100', shareToken: null });
        expect(view.body.globals.code).toBe('const tax = 0.02;');
        expect(view.body.itemTags.map(tag => tag.key)).toEqual(['herbs']);
        expect(view.body.variableTags.map(tag => tag.key)).toEqual(['PROFIT']);
    });

    it('copies the scope for a signed-in viewer only', async () => {
        await supertest(testApp.app).post(`/api/shared/${token}/copy`).set(API_HEADER).expect(401);

        const copy = await agent.post(`/api/shared/${token}/copy`).set(API_HEADER).expect(201);
        expect(copy.body.version).toBe(1);
        expect(copy.body.data.name).toBe('Herb runs (copy)');
        expect(copy.body.data.id).not.toBe('100');
        expect(copy.body.data.shareToken).toBeNull();
    });

    it('stops working once unshared', async () => {
        await agent.delete('/api/scopes/100/share').set(API_HEADER).expect(204);
        await supertest(testApp.app).get(`/api/shared/${token}`).expect(404);
    });
});

describe('static files', () => {
    it('serves the browser app with a content security policy', async () => {
        const response = await supertest(testApp.app).get('/').expect(200);
        expect(response.text).toContain('<div id="app"');
        expect(response.headers['content-security-policy']).toContain("script-src 'self' https://unpkg.com");
    });
});
