// Saved Claude chats, so a user can go back to one later or on another device. Each save replaces
// the whole conversation: only the browser that's chatting writes it, so there's no version check.
import { NotFoundError } from '../errors.js';
import { parseJsonColumn, toJsonColumn } from './jsonColumns.js';

const TABLE = 'ai_conversations';
// The list shows the most recent ones; older chats stay saved but aren't listed.
const LIST_LIMIT = 100;

const toSummary = (row) => ({
    id: row.id,
    title: row.title,
    costUsd: row.cost_usd,
    updatedAt: row.updated_at,
});

export class AiConversationManager {
    constructor(knex) {
        this.knex = knex;
    }

    // [{ id, title, costUsd, updatedAt }], most recently changed first.
    async list(userId) {
        const rows = await this.knex(TABLE)
            .select('id', 'title', 'cost_usd', 'updated_at')
            .where({ user_id: userId })
            .orderBy('updated_at', 'desc')
            .limit(LIST_LIMIT);
        return rows.map(toSummary);
    }

    async get(userId, id) {
        const row = await this.knex(TABLE).where({ user_id: userId, id }).first();
        if (!row) {
            throw new NotFoundError('That conversation no longer exists.');
        }
        return { ...toSummary(row), messages: parseJsonColumn(row.messages, []) };
    }

    // data: { title, messages, costUsd }
    async save(userId, id, { title, messages, costUsd }) {
        const columns = { title, messages: toJsonColumn(messages), cost_usd: costUsd };
        await this.knex(TABLE)
            .insert({ ...columns, user_id: userId, id })
            .onConflict(['user_id', 'id'])
            .merge({ ...columns, updated_at: this.knex.fn.now() });
    }

    async remove(userId, id) {
        await this.knex(TABLE).where({ user_id: userId, id }).delete();
    }
}
