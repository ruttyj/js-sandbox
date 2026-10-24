// A user can connect a key for more than one AI provider (Claude and Gemini), so keys move from
// user_ai_settings (one per user) into user_ai_keys (one per user and provider). Keys already
// connected were all Anthropic keys. user_ai_settings keeps the picked model.

/** @param {import('knex').Knex} knex */
export const up = async (knex) => {
    await knex.schema.createTable('user_ai_keys', (table) => {
        table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.string('provider').notNullable(); // 'anthropic' | 'gemini'
        table.primary(['user_id', 'provider']);
        table.text('api_key_encrypted').notNullable(); // see server/ai/keyCipher.js
        table.string('key_hint').notNullable(); // the key's last few characters
        table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
        table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    });

    const existing = await knex('user_ai_settings').select('user_id', 'api_key_encrypted', 'key_hint');
    if (existing.length) {
        await knex('user_ai_keys').insert(existing.map(row => ({ ...row, provider: 'anthropic' })));
    }

    await knex.schema.alterTable('user_ai_settings', (table) => {
        table.dropColumn('api_key_encrypted');
        table.dropColumn('key_hint');
    });
};

/** @param {import('knex').Knex} knex */
export const down = async (knex) => {
    await knex.schema.alterTable('user_ai_settings', (table) => {
        table.text('api_key_encrypted');
        table.string('key_hint');
    });

    const anthropicKeys = await knex('user_ai_keys').where({ provider: 'anthropic' });
    for (const key of anthropicKeys) {
        await knex('user_ai_settings')
            .insert({ user_id: key.user_id, api_key_encrypted: key.api_key_encrypted, key_hint: key.key_hint })
            .onConflict('user_id')
            .merge(['api_key_encrypted', 'key_hint']);
    }
    // Rows without a key (only a picked model) couldn't exist before this migration.
    await knex('user_ai_settings').whereNull('api_key_encrypted').delete();
    await knex.schema.dropTable('user_ai_keys');
};
