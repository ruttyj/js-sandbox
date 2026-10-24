// The chat's conversation, as the browser keeps it, turned into each provider's request format.
//
// The browser's shape is the Anthropic API's (it's a good neutral vocabulary): user messages hold
// text and tool_result blocks; assistant messages hold text and tool_use blocks. Each assistant
// message also says which provider wrote it:
//   { role: 'assistant', provider: 'anthropic', content: [...] }
//       content is Claude's reply exactly as it came, thinking blocks included.
//   { role: 'assistant', provider: 'gemini', content: [text, tool_use...], raw: { parts } }
//       raw.parts is Gemini's reply exactly as it came, with its thought signatures.
// A message saved before providers existed has no provider: it's Claude's.
//
// Both APIs need their own model's replies sent back unchanged, so a reply goes back as it came
// to the provider that wrote it, and as plain text and tool calls to the other one. That's what
// lets a chat switch between Claude and Gemini.

// Gemini needs a thought signature on the first tool call of each of its own turns. Tool calls
// another model made have none, and this value is Google's documented stand-in for them.
const GEMINI_FOREIGN_SIGNATURE = 'skip_thought_signature_validator';

const contentBlocks = (content) => {
    if (typeof content === 'string') {
        return [{ type: 'text', text: content }];
    }
    return content;
};

const providerOf = (message) => message.provider || 'anthropic';

// --- To Anthropic -------------------------------------------------------------------------------

// Another provider's reply, as Claude can read it: its text and tool calls.
const portableAssistantBlocks = (message) => {
    const blocks = [];
    for (const block of contentBlocks(message.content)) {
        if (block.type === 'text' && block.text) {
            blocks.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
            blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input || {} });
        }
    }
    return blocks;
};

/**
 * @param {Object[]} messages  The browser's conversation.
 * @returns {Object[]} Anthropic messages ({ role, content } only: the API refuses other fields).
 */
export const toAnthropicMessages = (messages) => {
    return messages.map(message => {
        if (message.role === 'user' || providerOf(message) === 'anthropic') {
            return { role: message.role, content: message.content };
        }
        return { role: 'assistant', content: portableAssistantBlocks(message) };
    });
};

// --- To Gemini ----------------------------------------------------------------------------------

// Every tool call's name by its id, since Gemini's tool results name the tool they answer.
const toolNamesById = (messages) => {
    const names = new Map();
    for (const message of messages) {
        if (message.role !== 'assistant') {
            continue;
        }
        for (const block of contentBlocks(message.content)) {
            if (block.type === 'tool_use') {
                names.set(block.id, block.name);
            }
        }
    }
    return names;
};

// A tool result's content as the object Gemini wants. The app's tools return JSON objects;
// anything else is wrapped.
const toolResultObject = (block) => {
    const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
    try {
        const parsed = JSON.parse(text);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
        return { output: parsed };
    } catch (error) {
        return { output: text };
    }
};

const userParts = (message, namesById) => {
    const parts = [];
    for (const block of contentBlocks(message.content)) {
        if (block.type === 'text') {
            parts.push({ text: block.text });
        } else if (block.type === 'tool_result') {
            parts.push({
                functionResponse: {
                    id: block.tool_use_id,
                    name: namesById.get(block.tool_use_id) || 'unknown_tool',
                    response: toolResultObject(block),
                },
            });
        }
    }
    return parts;
};

// Another provider's reply as Gemini model parts, with the stand-in signature on its first tool
// call. Its hidden reasoning stays behind.
const foreignModelParts = (message) => {
    const parts = [];
    let signed = false;
    for (const block of portableAssistantBlocks(message)) {
        if (block.type === 'text') {
            parts.push({ text: block.text });
            continue;
        }
        const part = { functionCall: { id: block.id, name: block.name, args: block.input } };
        if (!signed) {
            part.thoughtSignature = GEMINI_FOREIGN_SIGNATURE;
            signed = true;
        }
        parts.push(part);
    }
    return parts;
};

const modelParts = (message) => {
    if (providerOf(message) === 'gemini' && Array.isArray(message.raw?.parts)) {
        return message.raw.parts;
    }
    return foreignModelParts(message);
};

/**
 * @param {Object[]} messages  The browser's conversation.
 * @returns {Object[]} Gemini contents: [{ role: 'user' | 'model', parts }].
 */
export const toGeminiContents = (messages) => {
    const namesById = toolNamesById(messages);
    const contents = [];
    for (const message of messages) {
        const isUser = message.role === 'user';
        const parts = isUser ? userParts(message, namesById) : modelParts(message);
        // A turn with nothing Gemini can read (a Claude reply that was only reasoning) would be
        // refused as empty, and dropping it would leave two user turns in a row.
        if (!parts.length) {
            parts.push({ text: isUser ? '(no message)' : '(no reply)' });
        }
        contents.push({ role: isUser ? 'user' : 'model', parts });
    }
    return contents;
};
