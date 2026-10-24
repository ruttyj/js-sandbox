// The Anthropic API key each user connects to use Claude in the app, encrypted (see
// server/ai/keyCipher.js). key_hint is the key's last few characters, so the settings can show
// which key is connected without decrypting it.

/** @param {import('knex').Knex} knex */
export const up = async (knex) => {
    await knex.schema.createTable('user_ai_settings', (table) => {
        table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.primary(['user_id']);
        table.text('api_key_encrypted').notNullable();
        table.string('key_hint').notNullable();
        table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
        table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    });
};

/** @param {import('knex').Knex} knex */
export const down = async (knex) => {
    await knex.schema.dropTable('user_ai_settings');
};
