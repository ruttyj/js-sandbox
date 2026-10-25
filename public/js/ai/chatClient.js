// Asking the server for the model's next reply (POST /api/ai/chat) and reading it as it streams in.
// The server's events are described in server/ai/chatStream.js.
//
// Uses globals from scripts loaded before it:
//   api/apiClient.js   API_HEADERS, ApiError, readApiResponseBody

// How long streamChatReply waits for more bytes before treating the reply as stalled. The server
// sends a heartbeat comment every 15s, so a slow model stays well inside this.
const CHAT_IDLE_TIMEOUT_MS = 60_000;

// The turn failed after the reply started streaming. reason: 'no-key' when the provider's key needs
// connecting again; 'rate-limit' when it can be tried again after retryAfterSeconds; 'overloaded'
// when the provider returned a 5xx / overloaded error; 'stalled' when no bytes arrived for
// CHAT_IDLE_TIMEOUT_MS; 'cut-off' when the connection closed before the reply finished; otherwise
// undefined. The idle-timeout ('stalled') is thrown as a ChatReplyError, not an AbortError, so a
// user's Stop (an AbortError) can be told apart from a stall.
class ChatReplyError extends Error {
    constructor({ error, reason, provider, retryAfterSeconds }) {
        super(error);
        this.reason = reason;
        this.provider = provider;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

// Each complete "data: ..." event in buffer, and what's left over (the start of the next one).
const takeChatEvents = (buffer) => {
    const chunks = buffer.split('\n\n');
    const rest = chunks.pop();
    const events = [];
    for (const chunk of chunks) {
        if (chunk.startsWith('data: ')) {
            events.push(JSON.parse(chunk.slice('data: '.length)));
        }
    }
    return { events, rest };
};

/**
 * Streams the model's reply to the conversation so far.
 * @param {Object[]} messages  The conversation, in the API's shape.
 * @param {function(Object): void} onEvent  Called with each block / text / thinking event.
 * @param {AbortSignal} signal  Aborting stops the reply (the fetch rejects with an AbortError).
 * @returns {Promise<{ message: Object, costUsd: number }>}  The finished reply.
 * @throws {ApiError} When the server refused before streaming (e.g. 409 with no key connected).
 * @throws {ChatReplyError} When the turn failed while streaming.
 */
const streamChatReply = async (messages, onEvent, signal, idleTimeoutMs = CHAT_IDLE_TIMEOUT_MS) => {
    // The fetch is aborted either by the user's Stop (signal) or by the idle timeout. stalled
    // tells the two apart: on a stall we raise a retryable ChatReplyError; on a Stop the fetch's
    // own AbortError surfaces unchanged.
    const idleAbort = new AbortController();
    let stalled = false;
    let idleTimer = null;

    const onUserStop = () => idleAbort.abort();
    const startIdleTimer = () => {
        idleTimer = setTimeout(() => {
            stalled = true;
            idleAbort.abort();
        }, idleTimeoutMs);
    };
    const clearIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = null;
    };

    if (signal) {
        if (signal.aborted) {
            idleAbort.abort();
        } else {
            signal.addEventListener('abort', onUserStop);
        }
    }

    try {
        const response = await fetch('/api/ai/chat', {
            method: 'POST',
            headers: { ...API_HEADERS, 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ messages }),
            signal: idleAbort.signal,
        });
        if (!response.ok) {
            throw new ApiError(response.status, (await readApiResponseBody(response)) || {});
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            startIdleTimer();
            let result;
            try {
                result = await reader.read();
            } catch (error) {
                if (stalled) {
                    throw new ChatReplyError({ error: 'The reply stalled. Retrying.', reason: 'stalled' });
                }
                throw error;
            } finally {
                clearIdleTimer();
            }

            if (result.done) {
                break;
            }

            buffer += decoder.decode(result.value, { stream: true });
            const { events, rest } = takeChatEvents(buffer);
            buffer = rest;
            for (const event of events) {
                if (event.type === 'message') {
                    return { message: event.message, costUsd: event.costUsd };
                }
                if (event.type === 'error') {
                    throw new ChatReplyError(event);
                }
                onEvent(event);
            }
        }
        throw new ChatReplyError({ error: 'The reply was cut off before it finished. Try again.', reason: 'cut-off' });
    } finally {
        clearIdleTimer();
        if (signal) {
            signal.removeEventListener('abort', onUserStop);
        }
    }
};
