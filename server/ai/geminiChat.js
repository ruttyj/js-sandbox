// One chat reply from Gemini, streamed, in the same shape as Claude's (see chatStream.js), so the
// browser doesn't need to know which provider answered.
//
// Gemini streams its reply as parts: text, and function calls (its tool calls). The parts are
// kept exactly as they came, thought signatures included, to send back on later turns (see
// transcript.js); the browser also gets them as text and tool_use blocks.
import { ApiError, GoogleGenAI } from '@google/genai';
import { HttpError } from '../errors.js';
import { toGeminiContents } from './transcript.js';
import { CHAT_TOOLS } from './tools.js';

const DEFAULT_RETRY_SECONDS = 30;
// Why Gemini stopped -> the Anthropic stop_reason the browser understands. Unlisted ones
// (STOP, ...) are a normal end.
const GEMINI_REFUSAL_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);

export const createGeminiClient = (apiKey) => new GoogleGenAI({ apiKey });

// --- Building the request -----------------------------------------------------------------------

// The chat's tools as Gemini function declarations. A tool without inputs has no schema.
const geminiFunctionDeclarations = () => {
    return CHAT_TOOLS.map(tool => {
        const declaration = { name: tool.name, description: tool.description };
        if (Object.keys(tool.input_schema.properties).length) {
            declaration.parametersJsonSchema = tool.input_schema;
        }
        return declaration;
    });
};

export const buildGeminiRequest = (model, systemPrompt, messages, signal) => ({
    model: model.id,
    contents: toGeminiContents(messages),
    config: {
        systemInstruction: systemPrompt,
        tools: [{ functionDeclarations: geminiFunctionDeclarations() }],
        abortSignal: signal,
    },
});

// --- Reading the reply --------------------------------------------------------------------------

// Tool calls need ids to pair with their results. Gemini usually sends one; this makes one when
// it doesn't, in the characters Claude's API accepts (the chat may switch to Claude later).
const toolCallId = (call, index) => {
    if (call.id && /^[A-Za-z0-9_-]+$/.test(call.id)) {
        return call.id;
    }
    return `gemini_${Date.now().toString(36)}_${index}`;
};

// Parts worth keeping: an empty text part only matters when it carries a signature.
const isMeaningfulPart = (part) => {
    if (part.text === '' && !part.thoughtSignature) {
        return false;
    }
    return true;
};

/**
 * Reads the streamed chunks, telling the browser about text and tool calls as they arrive.
 * @returns {{ parts: Object[], finishReason: string|null, blockReason: string|null, usage: Object }}
 */
const readGeminiStream = async (stream, onEvent) => {
    const parts = [];
    let finishReason = null;
    let blockReason = null;
    let usage = {};
    let blockIndex = -1;
    let currentBlockType = null;

    const startBlock = (blockType, name) => {
        blockIndex++;
        currentBlockType = blockType;
        onEvent({ type: 'block', index: blockIndex, blockType, name });
    };

    for await (const chunk of stream) {
        usage = chunk.usageMetadata || usage;
        blockReason = chunk.promptFeedback?.blockReason || blockReason;
        const candidate = chunk.candidates?.[0];
        finishReason = candidate?.finishReason || finishReason;

        for (const part of candidate?.content?.parts || []) {
            if (!isMeaningfulPart(part)) {
                continue;
            }
            parts.push(part);
            if (part.functionCall) {
                startBlock('tool_use', part.functionCall.name);
            } else if (part.text && !part.thought) {
                if (currentBlockType !== 'text') {
                    startBlock('text');
                }
                onEvent({ type: 'text', index: blockIndex, text: part.text });
            }
        }
    }
    return { parts, finishReason, blockReason, usage };
};

// The reply as the browser's text and tool_use blocks. Text Gemini split over several parts
// becomes one block, so it reads as one reply.
const neutralContent = (parts) => {
    const content = [];
    parts.forEach((part, index) => {
        if (part.functionCall) {
            content.push({
                type: 'tool_use',
                id: toolCallId(part.functionCall, index),
                name: part.functionCall.name,
                input: part.functionCall.args || {},
            });
            return;
        }
        if (!part.text || part.thought) {
            return;
        }
        const last = content.at(-1);
        if (last && last.type === 'text') {
            last.text += part.text;
        } else {
            content.push({ type: 'text', text: part.text });
        }
    });
    return content;
};

// The tool_use ids made up in neutralContent are written into the kept parts too, so a later
// turn's tool results (which name these ids) pair with the right calls.
const partsWithToolIds = (parts, content) => {
    const ids = content.filter(block => block.type === 'tool_use').map(block => block.id);
    let next = 0;
    return parts.map(part => {
        if (!part.functionCall) {
            return part;
        }
        const id = ids[next++];
        return { ...part, functionCall: { ...part.functionCall, id } };
    });
};

const stopReason = (content, finishReason, blockReason) => {
    if (blockReason || GEMINI_REFUSAL_REASONS.has(finishReason)) {
        return 'refusal';
    }
    if (content.some(block => block.type === 'tool_use')) {
        return 'tool_use';
    }
    if (finishReason === 'MAX_TOKENS') {
        return 'max_tokens';
    }
    return 'end_turn';
};

class MalformedToolCallError extends Error {}

/**
 * @param {object} options  As streamAnthropicReply's.
 * @returns {Promise<{ message: Object, usage: Object }>} See chatStream.js.
 */
export const streamGeminiReply = async ({ apiKey, model, systemPrompt, messages, onEvent, signal, createClient = createGeminiClient }) => {
    const client = createClient(apiKey);
    const stream = await client.models.generateContentStream(buildGeminiRequest(model, systemPrompt, messages, signal));
    const { parts, finishReason, blockReason, usage } = await readGeminiStream(stream, onEvent);
    if (finishReason === 'MALFORMED_FUNCTION_CALL') {
        throw new MalformedToolCallError();
    }

    const content = neutralContent(parts);
    return {
        message: {
            role: 'assistant',
            provider: 'gemini',
            model: model.id,
            content,
            raw: { parts: partsWithToolIds(parts, content) },
            stop_reason: stopReason(content, finishReason, blockReason),
        },
        usage: {
            inputTokens: usage.promptTokenCount || 0,
            outputTokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
            cacheReadTokens: usage.cachedContentTokenCount || 0,
            cacheWriteTokens: 0,
        },
    };
};

// --- Errors -------------------------------------------------------------------------------------

// Google's message for a bad key, in a 400 like any other bad request.
const INVALID_KEY = /API_KEY_INVALID|API key not valid/;

// A 429's "retryDelay": "31s" (the details may be nested JSON text, so quotes can be escaped).
const RETRY_DELAY = /retryDelay\\*"\s*:\s*\\*"(\d+(?:\.\d+)?)s/;

const retryAfterSeconds = (error) => {
    const match = RETRY_DELAY.exec(error.message);
    if (match) {
        return Math.ceil(Number(match[1]));
    }
    return DEFAULT_RETRY_SECONDS;
};

// What to tell the user when a reply fails (see chatStream.js for the fields), or null for an
// error that isn't Gemini's.
export const describeGeminiError = (error) => {
    if (error instanceof MalformedToolCallError) {
        return { error: 'Gemini sent a tool call it got wrong. Try again, or pick another model.' };
    }
    if (!(error instanceof ApiError)) {
        return null;
    }
    if (INVALID_KEY.test(error.message) || error.status === 401 || error.status === 403) {
        return { error: 'Google rejected your Gemini API key. Connect a working key to keep chatting.', reason: 'no-key', provider: 'gemini' };
    }
    if (error.status === 429) {
        return { error: "Gemini's free limit was reached.", reason: 'rate-limit', retryAfterSeconds: retryAfterSeconds(error) };
    }
    if (error.status === 503 || error.status === 500) {
        return { error: 'Gemini is overloaded right now. Try again in a minute.' };
    }
    if (error.status === 400) {
        return { error: `Google refused the request: ${error.message}` };
    }
    return { error: `Google returned an error (HTTP ${error.status}). Try again shortly.` };
};

// --- Checking a key -----------------------------------------------------------------------------

// Asks for the default model's details: free, quick, and refused for a bad key.
const VERIFY_MODEL = 'gemini-3.8-flash';

/**
 * @throws {HttpError} Saying why, for the user to read.
 */
export const verifyGeminiKey = async (apiKey) => {
    try {
        await createGeminiClient(apiKey).models.get({ model: VERIFY_MODEL });
    } catch (error) {
        if (error instanceof ApiError && (INVALID_KEY.test(error.message) || error.status === 401 || error.status === 403)) {
            throw new HttpError(400, 'Google did not accept this Gemini API key.');
        }
        if (error instanceof ApiError) {
            throw new HttpError(502, `Google could not check the key right now (HTTP ${error.status}).`);
        }
        throw new HttpError(502, 'Could not reach Google to check the key. Try again shortly.');
    }
};
