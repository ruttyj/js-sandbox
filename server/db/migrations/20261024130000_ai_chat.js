// The Claude chat: which model each user picked, and their saved conversations.
//
// A conversation's messages are kept exactly as they went to and came back from Anthropic
// (including the model's signed thinking blocks), as JSON text, so it can be picked up again
// later. The server never reads inside them.

/** @param {import('knex').Knex} knex */
export const up = async (knex) => {
    await knex.schema.alterTable('user_ai_settings', (table) => {
        table.string('model'); // null: the default model
    });

    // id is the browser's own id for the conversation, unique per user.
    await knex.schema.createTable('ai_conversations', (table) => {
        table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.string('id').notNullable();
        table.primary(['user_id', 'id']);
        table.string('title').notNullable();
        table.text('messages').notNullable().defaultTo('[]');
        table.double('cost_usd').notNullable().defaultTo(0); // an estimate, summed over its replies
        table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
        table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
        table.index(['user_id', 'updated_at']);
    });
};

/** @param {import('knex').Knex} knex */
export const down = async (knex) => {
    await knex.schema.dropTable('ai_conversations');
    await knex.schema.alterTable('user_ai_settings', (table) => {
        table.dropColumn('model');
    });
};
