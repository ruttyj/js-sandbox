// One chat reply from Claude, streamed. See chatStream.js for how replies reach the browser.
import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from '../errors.js';
import { toAnthropicMessages } from './transcript.js';
import { CHAT_TOOLS } from './tools.js';

const MAX_OUTPUT_TOKENS = 64_000;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const PROGRESS_UPDATES_BETA = 'thinking-display-updates-2026-08-18';
const DEFAULT_RETRY_SECONDS = 30;
// A chat reply shouldn't take longer than this; without it the SDK waits its 10-minute default
// before giving up on a stalled request.
const CHAT_TIMEOUT_MS = 5 * 60_000;

export const createAnthropicClient = (apiKey, options = {}) => new Anthropic({ apiKey, ...options });

// --- Building the request -----------------------------------------------------------------------

/**
 * @param {import('./models.js').ChatModel} model
 * @param {string} systemPrompt
 * @param {Array} messages  The conversation, as the browser keeps it.
 */
export const buildAnthropicRequest = (model, systemPrompt, messages) => {
    const betas = [];
    const request = {
        model: model.id,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPrompt,
        tools: CHAT_TOOLS,
        messages: toAnthropicMessages(messages),
        // Caches everything up to the newest message, so each turn only pays full price for
        // what's new since the last one.
        cache_control: { type: 'ephemeral' },
        thinking: { type: 'adaptive' },
        output_config: { effort: model.effort },
    };

    if (model.progressUpdates) {
        // The model's short notes between tool calls come back as text, so the chat isn't
        // silent through a long run of lookups and test runs.
        request.thinking.display = 'updates';
        betas.push(PROGRESS_UPDATES_BETA);
    }
    if (model.serverFallback) {
        // A request the model's safety checks decline is re-run on another model by Anthropic.
        request.fallbacks = 'default';
        betas.push(FALLBACK_BETA);
    }
    request.betas = betas;
    return request;
};

// --- Streaming the reply ------------------------------------------------------------------------

// The stream events the browser needs, in its own smaller shape; null for the rest.
const toBrowserEvent = (event) => {
    if (event.type === 'content_block_start') {
        const block = event.content_block;
        return { type: 'block', index: event.index, blockType: block.type, name: block.name };
    }
    if (event.type !== 'content_block_delta') {
        return null;
    }
    if (event.delta.type === 'text_delta') {
        return { type: 'text', index: event.index, text: event.delta.text };
    }
    if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
        return { type: 'thinking', index: event.index, text: event.delta.thinking };
    }
    return null;
};

/**
 * @param {object} options
 * @param {string} options.apiKey
 * @param {import('./models.js').ChatModel} options.model
 * @param {string} options.systemPrompt
 * @param {Array} options.messages
 * @param {function(Object): void} options.onEvent  Gets each browser event as it streams.
 * @param {AbortSignal} options.signal
 * @param {function(string): Anthropic} [options.createClient]  Replaced in tests.
 * @returns {Promise<{ message: Object, usage: Object }>} See chatStream.js.
 */
export const streamAnthropicReply = async ({ apiKey, model, systemPrompt, messages, onEvent, signal, createClient = createAnthropicClient }) => {
    const client = createClient(apiKey);
    const stream = client.beta.messages.stream(buildAnthropicRequest(model, systemPrompt, messages), { signal, timeout: CHAT_TIMEOUT_MS });
    for await (const event of stream) {
        const browserEvent = toBrowserEvent(event);
        if (browserEvent) {
            onEvent(browserEvent);
        }
    }

    const final = await stream.finalMessage();
    const usage = final.usage || {};
    return {
        message: {
            role: 'assistant',
            provider: 'anthropic',
            model: model.id,
            content: final.content,
            stop_reason: final.stop_reason,
        },
        usage: {
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            cacheReadTokens: usage.cache_read_input_tokens || 0,
            cacheWriteTokens: usage.cache_creation_input_tokens || 0,
        },
    };
};

// --- Errors -------------------------------------------------------------------------------------

const OVERLOADED_STATUS = 529;

const retryAfterSeconds = (error) => {
    const seconds = Number(error.headers?.get?.('retry-after'));
    if (Number.isFinite(seconds) && seconds > 0) {
        return seconds;
    }
    return DEFAULT_RETRY_SECONDS;
};

// What to tell the user when a reply fails (see chatStream.js for the fields), or null for an
// error that isn't Anthropic's. Most specific first: in this SDK, APIConnectionError is itself
// an APIError.
export const describeAnthropicError = (error) => {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        return { error: 'Anthropic rejected your API key. Connect a working key to keep chatting.', reason: 'no-key', provider: 'anthropic' };
    }
    if (error instanceof Anthropic.RateLimitError) {
        return { error: 'Your Anthropic account hit its rate limit.', reason: 'rate-limit', retryAfterSeconds: retryAfterSeconds(error) };
    }
    // Checking a key (listing models) works without credits, so an account with none only finds
    // out here. Claude.ai's own "extra usage" credits don't count: API credits are separate.
    if (error instanceof Anthropic.BadRequestError && /credit balance is too low/i.test(error.message)) {
        return { error: 'Your Anthropic API account has no credits left. Add API credits at console.anthropic.com, Settings > Billing, in the organization this key belongs to (Claude.ai subscription credits don\'t cover the API).' };
    }
    if (error instanceof Anthropic.BadRequestError) {
        return { error: `Anthropic refused the request: ${error.message}` };
    }
    if (error instanceof Anthropic.APIConnectionError) {
        return { error: 'Could not reach Anthropic. Check the connection and try again.' };
    }
    if (error instanceof Anthropic.APIError && error.status === OVERLOADED_STATUS) {
        // reason 'overloaded': the browser retries these on its own, with backoff.
        return { error: 'Claude is overloaded right now. Try again in a minute.', reason: 'overloaded' };
    }
    if (error instanceof Anthropic.APIError && error.status >= 500) {
        return { error: `Anthropic returned an error (HTTP ${error.status}). Try again shortly.`, reason: 'overloaded' };
    }
    if (error instanceof Anthropic.APIError) {
        return { error: `Anthropic returned an error (HTTP ${error.status}). Try again shortly.` };
    }
    return null;
};

// --- Checking a key -----------------------------------------------------------------------------

// Checking a key is one quick call made while the user waits, so it fails fast rather than
// retrying for minutes.
const VERIFY_TIMEOUT_MS = 15_000;

/**
 * Checks that Anthropic accepts the key, with the cheapest call there is (listing one model).
 * @throws {HttpError} Saying why, for the user to read.
 */
export const verifyAnthropicKey = async (apiKey) => {
    const client = createAnthropicClient(apiKey, { maxRetries: 1, timeout: VERIFY_TIMEOUT_MS });
    try {
        await client.models.list({ limit: 1 });
    } catch (error) {
        if (error instanceof Anthropic.AuthenticationError) {
            throw new HttpError(400, 'Anthropic did not accept this API key.');
        }
        if (error instanceof Anthropic.PermissionDeniedError) {
            throw new HttpError(400, 'This API key is not allowed to use the Claude API.');
        }
        if (error instanceof Anthropic.APIConnectionError) {
            throw new HttpError(502, 'Could not reach Anthropic to check the key. Try again shortly.');
        }
        if (error instanceof Anthropic.APIError) {
            throw new HttpError(502, `Anthropic could not check the key right now (HTTP ${error.status}).`);
        }
        throw error;
    }
};
