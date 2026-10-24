// The AI providers a user can connect a key for, and the models the chat can use from each.
//
// Prices are US dollars per million tokens, used only to show an estimate of what a chat cost
// (the provider's bill is the real figure). Writing to Anthropic's prompt cache costs 1.25x the
// input price. Gemini models are used on Google's free tier, so they're estimated at $0; a key
// with billing turned on would be charged at Google's paid rates instead.

const CACHE_WRITE_MULTIPLIER = 1.25;

export const AI_PROVIDERS = {
    anthropic: { id: 'anthropic', label: 'Claude', company: 'Anthropic' },
    gemini: { id: 'gemini', label: 'Gemini', company: 'Google' },
};

export const AI_PROVIDER_IDS = Object.keys(AI_PROVIDERS);

/**
 * @typedef {Object} ChatModel
 * @property {string} id  The model ID sent to the provider.
 * @property {'anthropic'|'gemini'} provider
 * @property {string} label
 * @property {string} description  Shown in the model picker.
 * @property {boolean} freeTier  Used on the provider's free tier: estimated at $0.
 * @property {FreeLimits} [freeLimits]  Gemini: the free tier's limits for the model, shown in the
 *     picker. Each model has its own quota, so when one runs out the others still work.
 * @property {'low'|'medium'|'high'} [effort]  Anthropic: how hard it thinks; medium suits
 *     multi-step tool use.
 * @property {boolean} [serverFallback]  Anthropic: whether a request it declines can be re-run on
 *     another model by Anthropic (fallbacks: "default").
 * @property {boolean} [progressUpdates]  Anthropic: whether it can return its notes between tool
 *     calls as text (thinking display "updates").
 * @property {{ input: number, output: number, cacheRead: number }} price
 */

/**
 * A free tier's rate limits. Google publishes these only on AI Studio's Rate Limit page (no API
 * returns them for a key), so they're copied from there; last checked 2026-10-24. A chat sends
 * about 5K tokens per request before any conversation (system prompt and tool definitions), and
 * each tool round adds its results, so a small tokensPerMinute allows only a few requests a minute.
 * @typedef {Object} FreeLimits
 * @property {number} requestsPerMinute
 * @property {number} tokensPerMinute  Input tokens.
 * @property {number} requestsPerDay  Resets at midnight Pacific time.
 */

/** @type {ChatModel[]} The picker lists them by free requests per day (see PICKER_MODELS). */
export const CHAT_MODELS = [
    {
        id: 'claude-opus-5-5',
        provider: 'anthropic',
        label: 'Claude Opus 5.5',
        description: 'Most capable. Best for writing and fixing scope code.',
        freeTier: false,
        effort: 'medium',
        serverFallback: true,
        progressUpdates: true,
        price: { input: 4, output: 20, cacheRead: 0.2 },
    },
    {
        id: 'claude-sonnet-5-5',
        provider: 'anthropic',
        label: 'Claude Sonnet 5.5',
        description: 'Fast and capable, at half the price of Opus.',
        freeTier: false,
        effort: 'medium',
        serverFallback: true,
        progressUpdates: true,
        price: { input: 2, output: 10, cacheRead: 0.2 },
    },
    {
        id: 'claude-haiku-5-5',
        provider: 'anthropic',
        label: 'Claude Haiku 5.5',
        description: 'Cheapest and quickest Claude. Good for item lookups.',
        freeTier: false,
        effort: 'medium',
        serverFallback: false,
        progressUpdates: false,
        price: { input: 0.1, output: 0.5, cacheRead: 0.01 },
    },
    {
        id: 'gemini-3.8-flash',
        provider: 'gemini',
        label: 'Gemini 3.8 Flash',
        description: 'Free tier. The best free option, including for code changes.',
        freeTier: true,
        freeLimits: { requestsPerMinute: 5, tokensPerMinute: 250_000, requestsPerDay: 20 },
        price: { input: 0.75, output: 3.75, cacheRead: 0 },
    },
    {
        id: 'gemini-3.5-flash-lite',
        provider: 'gemini',
        label: 'Gemini 3.5 Flash-Lite',
        description: 'Free tier. Lighter and faster; suits quick item lookups.',
        freeTier: true,
        freeLimits: { requestsPerMinute: 15, tokensPerMinute: 250_000, requestsPerDay: 500 },
        price: { input: 0.3, output: 2.5, cacheRead: 0 },
    },
    {
        id: 'gemini-3.6-flash',
        provider: 'gemini',
        label: 'Gemini 3.6 Flash',
        description: "Free tier. A backup for when 3.8 Flash's free limit runs out.",
        freeTier: true,
        freeLimits: { requestsPerMinute: 5, tokensPerMinute: 250_000, requestsPerDay: 20 },
        price: { input: 0.75, output: 3.75, cacheRead: 0 },
    },
    {
        id: 'gemini-3.1-flash-lite',
        provider: 'gemini',
        label: 'Gemini 3.1 Flash-Lite',
        description: "Free tier. A backup for when 3.5 Flash-Lite's free limit runs out.",
        freeTier: true,
        freeLimits: { requestsPerMinute: 15, tokensPerMinute: 250_000, requestsPerDay: 500 },
        price: { input: 0.25, output: 1.5, cacheRead: 0 },
    },
    // Google's open models, served through the Gemini API with the same key. They're free only:
    // the API has no paid tier for them, hence the $0 prices.
    {
        id: 'gemma-4-31b-it',
        provider: 'gemini',
        label: 'Gemma 4 31B',
        description: 'Free, with plenty of requests a day, but 16K tokens a minute: long chats pause to wait.',
        freeTier: true,
        freeLimits: { requestsPerMinute: 30, tokensPerMinute: 16_000, requestsPerDay: 14_400 },
        price: { input: 0, output: 0, cacheRead: 0 },
    },
    {
        id: 'gemma-4-26b-a4b-it',
        provider: 'gemini',
        label: 'Gemma 4 26B',
        description: 'Free. Quicker and lighter than 31B, with its own daily limit.',
        freeTier: true,
        freeLimits: { requestsPerMinute: 30, tokensPerMinute: 16_000, requestsPerDay: 14_400 },
        price: { input: 0, output: 0, cacheRead: 0 },
    },
];

export const CHAT_MODEL_IDS = CHAT_MODELS.map(model => model.id);

/**
 * Orders models with the most free requests per day first. Models without a known limit (all of
 * Claude's) count as -1, so they keep CHAT_MODELS' order after the free ones.
 * @param {ChatModel} a
 * @param {ChatModel} b
 * @returns {number}
 */
const byFreeRequestsPerDay = (a, b) => {
    const aLimit = a.freeLimits?.requestsPerDay ?? -1;
    const bLimit = b.freeLimits?.requestsPerDay ?? -1;
    return bLimit - aLimit;
};

// The order the picker lists the models in, which is also the order the default is chosen from:
// the free model with the most requests per day comes first.
const PICKER_MODELS = [...CHAT_MODELS].sort(byFreeRequestsPerDay);

/**
 * The model to chat with: the one picked when its provider is connected, otherwise the first
 * model in the picker's order whose provider is connected, otherwise null.
 * @param {string|null} pickedId
 * @param {Set<string>} connectedProviders
 * @returns {ChatModel|null}
 */
export const chooseChatModel = (pickedId, connectedProviders) => {
    const picked = CHAT_MODELS.find(model => model.id === pickedId);
    if (picked && connectedProviders.has(picked.provider)) {
        return picked;
    }
    return PICKER_MODELS.find(model => connectedProviders.has(model.provider)) || null;
};

// The models as the browser's picker shows them, in PICKER_MODELS' order.
export const publicChatModels = (connectedProviders) => {
    return PICKER_MODELS.map(model => ({
        id: model.id,
        provider: model.provider,
        label: model.label,
        description: model.description,
        freeTier: model.freeTier,
        freeLimits: model.freeLimits ?? null,
        available: connectedProviders.has(model.provider),
    }));
};

/**
 * An estimate of what one reply cost.
 * @param {ChatModel} model
 * @param {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }} usage
 * @returns {number} US dollars.
 */
export const estimateCostUsd = (model, usage) => {
    if (model.freeTier) {
        return 0;
    }

    const { input, output, cacheRead } = model.price;
    const dollars = usage.inputTokens * input
        + usage.cacheWriteTokens * input * CACHE_WRITE_MULTIPLIER
        + usage.cacheReadTokens * cacheRead
        + usage.outputTokens * output;
    return dollars / 1_000_000;
};
