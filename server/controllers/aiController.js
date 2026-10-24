// /api/ai/*: the user's own AI provider keys and model choice, the chat itself, and saved chats.
import { streamChatTurn } from '../ai/chatStream.js';

/**
 * @param {object} managers
 * @param {object} options
 * @param {string} options.systemPrompt  See buildSystemPrompt.
 * @param {{ anthropic?: function, gemini?: function }} [options.createAiClients]  Replaced in
 *     tests so no request leaves.
 */
export const createAiController = ({ aiKeys, aiConversations }, { systemPrompt, createAiClients }) => ({
    status: async (req, res) => {
        res.json(await aiKeys.status(req.user.id));
    },

    saveKey: async (req, res) => {
        res.json(await aiKeys.save(req.user.id, req.valid.params.provider, req.valid.body.apiKey));
    },

    removeKey: async (req, res) => {
        res.json(await aiKeys.remove(req.user.id, req.valid.params.provider));
    },

    setModel: async (req, res) => {
        res.json(await aiKeys.setModel(req.user.id, req.valid.body.model));
    },

    // Settings are read (and a missing key refused with a plain JSON 409) before the event stream
    // starts; after that, failures arrive as error events.
    chat: async (req, res) => {
        const { apiKey, model } = await aiKeys.chatSettingsFor(req.user.id);
        await streamChatTurn({
            apiKey,
            model,
            systemPrompt,
            messages: req.valid.body.messages,
            res,
            createClients: createAiClients,
        });
    },

    listConversations: async (req, res) => {
        res.json(await aiConversations.list(req.user.id));
    },

    getConversation: async (req, res) => {
        res.json(await aiConversations.get(req.user.id, req.valid.params.id));
    },

    saveConversation: async (req, res) => {
        await aiConversations.save(req.user.id, req.valid.params.id, req.valid.body);
        res.status(204).end();
    },

    removeConversation: async (req, res) => {
        await aiConversations.remove(req.user.id, req.valid.params.id);
        res.status(204).end();
    },
});
