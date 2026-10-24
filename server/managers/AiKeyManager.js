// The AI provider keys each user connects (Anthropic for Claude, Google for Gemini) so the app can
// call those models for them, billed to (or on the free tier of) their own account. Keys are
// checked with the provider before they're kept, stored encrypted, and never sent back to the
// browser: it only learns which providers are connected and how each key ends. user_ai_settings
// holds which model the user picked for the chat.
import { AI_PROVIDER_IDS, chooseChatModel, publicChatModels } from '../ai/models.js';
import { HttpError } from '../errors.js';

const KEYS_TABLE = 'user_ai_keys';
const SETTINGS_TABLE = 'user_ai_settings';
const HINT_LENGTH = 4;

const notAvailableError = () => new HttpError(404, 'AI chat is not set up on this server.');

export class AiKeyManager {
    /**
     * @param {import('knex').Knex} knex
     * @param {object} options
     * @param {{ encrypt: function(string): string, decrypt: function(string): string } | null} options.cipher
     *   null when the server has no AI_KEY_SECRET: the feature is off.
     * @param {function(string, string): Promise<void>} options.verifyKey  (provider, apiKey);
     *   throws an HttpError for a key the provider refuses.
     */
    constructor(knex, { cipher, verifyKey }) {
        this.knex = knex;
        this.cipher = cipher;
        this.verifyKey = verifyKey;
    }

    get isAvailable() {
        return this.cipher !== null;
    }

    async keyRows(userId) {
        return this.knex(KEYS_TABLE).where({ user_id: userId });
    }

    async pickedModelId(userId) {
        const settings = await this.knex(SETTINGS_TABLE).where({ user_id: userId }).first();
        return settings?.model ?? null;
    }

    /**
     * What the browser may know:
     *   { available, connected, providers: { anthropic: { connected, keyHint }, gemini: ... },
     *     model, models }
     * connected: whether any provider is. model: the id of the model the chat will use (null with
     * no provider connected). models: every model, each saying whether its provider is connected.
     */
    async status(userId) {
        if (!this.isAvailable) {
            return { available: false, connected: false, providers: {}, model: null, models: [] };
        }

        const rows = await this.keyRows(userId);
        const connected = new Set(rows.map(row => row.provider));
        const providers = {};
        for (const provider of AI_PROVIDER_IDS) {
            const row = rows.find(candidate => candidate.provider === provider);
            providers[provider] = { connected: Boolean(row), keyHint: row?.key_hint ?? null };
        }

        const model = chooseChatModel(await this.pickedModelId(userId), connected);
        return {
            available: true,
            connected: connected.size > 0,
            providers,
            model: model?.id ?? null,
            models: publicChatModels(connected),
        };
    }

    // Checks the key with its provider, then keeps it (replacing that provider's previous key).
    async save(userId, provider, apiKey) {
        if (!this.isAvailable) {
            throw notAvailableError();
        }
        await this.verifyKey(provider, apiKey);

        const columns = {
            api_key_encrypted: this.cipher.encrypt(apiKey),
            key_hint: apiKey.slice(-HINT_LENGTH),
        };
        await this.knex(KEYS_TABLE)
            .insert({ ...columns, user_id: userId, provider })
            .onConflict(['user_id', 'provider'])
            .merge({ ...columns, updated_at: this.knex.fn.now() });

        return this.status(userId);
    }

    async remove(userId, provider) {
        await this.knex(KEYS_TABLE).where({ user_id: userId, provider }).delete();
        return this.status(userId);
    }

    // modelId has been checked against CHAT_MODEL_IDS.
    async setModel(userId, modelId) {
        if (!this.isAvailable) {
            throw notAvailableError();
        }
        await this.knex(SETTINGS_TABLE)
            .insert({ user_id: userId, model: modelId })
            .onConflict('user_id')
            .merge({ model: modelId, updated_at: this.knex.fn.now() });
        return this.status(userId);
    }

    /**
     * What the chat needs: the model to use and its provider's decrypted key.
     * @returns {Promise<{ apiKey: string, model: import('../ai/models.js').ChatModel }>}
     * @throws {HttpError} 409 when no provider is connected, or the key can't be decrypted
     *   (AI_KEY_SECRET changed since it was saved), so the browser asks for a key.
     */
    async chatSettingsFor(userId) {
        if (!this.isAvailable) {
            throw notAvailableError();
        }

        const rows = await this.keyRows(userId);
        const model = chooseChatModel(await this.pickedModelId(userId), new Set(rows.map(row => row.provider)));
        if (!model) {
            throw new HttpError(409, 'Connect a Claude or Gemini API key to use the chat.', { reason: 'no-key' });
        }

        const row = rows.find(candidate => candidate.provider === model.provider);
        try {
            return { apiKey: this.cipher.decrypt(row.api_key_encrypted), model };
        } catch (error) {
            console.error(`Could not decrypt the ${model.provider} key of user ${userId}:`, error.message);
            throw new HttpError(409, 'Your saved API key can no longer be read. Connect it again.', { reason: 'no-key', provider: model.provider });
        }
    }
}
