// The shapes the API accepts. Records are checked as far as the server relies on them (types and
// sizes); nested parts the browser derives, like a scope's variables, only have to be arrays of
// objects, since their exact shape belongs to the frontend.
import { z } from 'zod';
import { AI_PROVIDER_IDS, CHAT_MODEL_IDS } from '../ai/models.js';

const MAX_CODE_LENGTH = 1_000_000;
const MAX_LIST_LENGTH = 50_000;

const label = z.string().min(1).max(200);
const looseObjects = z.array(z.record(z.string(), z.unknown())).max(MAX_LIST_LENGTH);

// A record key in a URL: a scope id, or an item/variable tag key.
export const keyParams = z.object({ key: z.string().min(1).max(200) });

export const shareTokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });

// ?version= on a delete.
export const versionQuery = z.object({ version: z.coerce.number().int().min(1) });

export const reorderBody = z.object({ keys: z.array(z.string().min(1).max(200)).max(MAX_LIST_LENGTH) });

export const scopeData = z.object({
    name: label,
    code: z.string().max(MAX_CODE_LENGTH),
    variables: looseObjects,
    itemTagKeys: z.array(z.string().max(200)).max(MAX_LIST_LENGTH),
    itemColors: z.record(z.string(), z.string().max(50)),
    colorSeed: z.number().optional(),
});

export const itemTagData = z.object({
    label,
    parent: z.string().max(200).nullable().optional(),
    items: z.array(z.union([z.number(), z.string().max(50)])).max(MAX_LIST_LENGTH),
});

export const variableTagData = z.object({ label });

export const globalsData = z.object({
    code: z.string().max(MAX_CODE_LENGTH),
    variables: looseObjects,
});

export const settingsData = z.object({
    editorSettings: z.record(z.string(), z.boolean()),
    dashboardFilter: z.array(z.string().max(200)).max(1000),
});

export const aiProviderParams = z.object({ provider: z.enum(AI_PROVIDER_IDS) });

// PUT /api/ai/key/:provider bodies. Anthropic's keys look like "sk-ant-api03-..."; checking the
// prefix catches a key pasted into the wrong box before asking the provider about it. Google's
// keys have changed format over time, so only their characters are checked.
export const aiKeyBodies = {
    anthropic: z.object({
        apiKey: z.string().trim().regex(/^sk-ant-[A-Za-z0-9_-]{16,300}$/, 'Not an Anthropic API key (they start with "sk-ant-").'),
    }),
    gemini: z.object({
        apiKey: z.string().trim().regex(/^(?!sk-ant-)[A-Za-z0-9._-]{20,300}$/, 'Not a Gemini API key (get one at aistudio.google.com).'),
    }),
};

export const aiModelBody = z.object({ model: z.enum(CHAT_MODEL_IDS) });

// A chat message as the Anthropic API takes it. Only the outline is checked here: the browser
// sends back Claude's replies exactly as they came (thinking blocks included), and Anthropic
// checks the rest.
const MAX_CHAT_MESSAGES = 2000;
// An assistant message also says which provider wrote it, and a Gemini reply carries Gemini's
// own parts to send back on later turns (see server/ai/transcript.js).
const chatMessage = z.object({
    role: z.enum(['user', 'assistant']),
    content: z.union([
        z.string().max(MAX_CODE_LENGTH),
        z.array(z.looseObject({ type: z.string().max(100) })).max(500),
    ]),
    provider: z.enum(AI_PROVIDER_IDS).optional(),
    model: z.string().max(100).optional(),
    raw: z.looseObject({ parts: z.array(z.looseObject({})).max(500) }).optional(),
});
const chatMessages = z.array(chatMessage).max(MAX_CHAT_MESSAGES);

export const chatBody = z.object({ messages: chatMessages.min(1) });

// A saved chat's id is the browser's own, e.g. "c-1761300000000-k3j2".
export const conversationParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

export const conversationSaveBody = z.object({
    title: label,
    messages: chatMessages,
    costUsd: z.number().min(0),
});

// PUT body for a record in a collection. version is null for a record never saved before.
export const collectionSaveBody = (dataSchema) => z.object({
    version: z.number().int().min(1).nullable(),
    position: z.number().int().min(0),
    data: dataSchema,
});

// PUT body for a one-per-user record. version is 0 when it was never saved.
export const documentSaveBody = (dataSchema) => z.object({
    version: z.number().int().min(0),
    data: dataSchema,
});
