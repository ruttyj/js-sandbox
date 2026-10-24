// One turn of the chat: sends the conversation to the user's chosen model (Claude or Gemini) with
// their key, and streams the reply to the browser as server-sent events. The browser runs the
// tool loop: when the reply asks for tools, it runs them and posts the conversation again with
// their results.
//
// Events sent (each a "data: <json>" line), the same for every provider:
//   { type: 'block', index, blockType, name? }  a content block starts (name: a tool_use's tool)
//   { type: 'text', index, text }               more of a text block
//   { type: 'thinking', index, text }           more of a progress note between tool calls
//   { type: 'message', message, costUsd }       the finished reply, for the browser to keep:
//       { role: 'assistant', provider, model, content, raw?, stop_reason } (see transcript.js)
//   { type: 'error', error, reason?, provider?, retryAfterSeconds? }
//       the turn failed. reason 'no-key': the provider's key needs connecting again;
//       'rate-limit': try again after retryAfterSeconds.
import { describeAnthropicError, streamAnthropicReply } from './anthropicChat.js';
import { describeGeminiError, streamGeminiReply } from './geminiChat.js';
import { estimateCostUsd } from './models.js';

const PROVIDERS = {
    anthropic: { streamReply: streamAnthropicReply, describeError: describeAnthropicError },
    gemini: { streamReply: streamGeminiReply, describeError: describeGeminiError },
};

export const startEventStream = (res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        // Stops reverse proxies from holding the events back until the reply is finished.
        'X-Accel-Buffering': 'no',
    });
};

export const sendEvent = (res, event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
};

const describeChatError = (provider, error) => {
    const described = provider.describeError(error);
    if (described) {
        return described;
    }
    console.error(error);
    return { error: 'Something went wrong on the server.' };
};

/**
 * Streams one reply to res and ends it.
 * @param {object} options
 * @param {string} options.apiKey  The key for the model's provider.
 * @param {import('./models.js').ChatModel} options.model
 * @param {string} options.systemPrompt
 * @param {Array} options.messages
 * @param {import('express').Response} options.res
 * @param {{ anthropic?: function, gemini?: function }} [options.createClients]  Client factories
 *     by provider; replaced in tests.
 */
export const streamChatTurn = async ({ apiKey, model, systemPrompt, messages, res, createClients = {} }) => {
    const provider = PROVIDERS[model.provider];
    const abort = new AbortController();
    // The browser stopped the reply (or went away): stop paying for tokens nobody will read.
    res.on('close', () => abort.abort());

    startEventStream(res);
    try {
        const { message, usage } = await provider.streamReply({
            apiKey,
            model,
            systemPrompt,
            messages,
            onEvent: (event) => sendEvent(res, event),
            signal: abort.signal,
            createClient: createClients[model.provider],
        });
        sendEvent(res, { type: 'message', message, costUsd: estimateCostUsd(model, usage) });
    } catch (error) {
        if (abort.signal.aborted) {
            return;
        }
        sendEvent(res, { type: 'error', ...describeChatError(provider, error) });
    } finally {
        res.end();
    }
};
