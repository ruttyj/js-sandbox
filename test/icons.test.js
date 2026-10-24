import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers.js';

const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');

// Stands in for the wiki: "Missing.png" doesn't exist; anything else is a tiny PNG.
const fakeWiki = () => {
    const requestedUrls = [];
    const fetchImpl = async (url) => {
        requestedUrls.push(url);
        if (url.endsWith('/Missing.png')) {
            return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
        }
        return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
    };
    return { fetchImpl, requestedUrls };
};

let testApp;
let wiki;

beforeAll(async () => {
    wiki = fakeWiki();
    testApp = await createTestApp({ fetchImpl: wiki.fetchImpl });
});

afterAll(async () => {
    await testApp.destroy();
});

describe('item icons', () => {
    it('downloads an icon from the wiki once, then serves it from disk', async () => {
        const client = supertest(testApp.app);
        const first = await client.get('/icons/Abyssal%20whip.png').expect(200);
        expect(first.headers['content-type']).toBe('image/png');
        expect(first.headers['cache-control']).toContain('max-age=');
        expect(Buffer.compare(first.body, PNG_BYTES)).toBe(0);

        await client.get('/icons/Abyssal%20whip.png').expect(200);
        expect(wiki.requestedUrls).toEqual(['https://oldschool.runescape.wiki/images/Abyssal_whip.png']);
    });

    it("404s for an icon the wiki doesn't have, without asking again", async () => {
        const client = supertest(testApp.app);
        await client.get('/icons/Missing.png').expect(404);
        await client.get('/icons/Missing.png').expect(404);
        expect(wiki.requestedUrls.filter(url => url.endsWith('/Missing.png'))).toHaveLength(1);
    });

    it('refuses names that are not image file names', async () => {
        const client = supertest(testApp.app);
        await client.get('/icons/notes.txt').expect(400);
        await client.get('/icons/..%2F..%2Fetc%2Fpasswd.png').expect(400);
    });
});
