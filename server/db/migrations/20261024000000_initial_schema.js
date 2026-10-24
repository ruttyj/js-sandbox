// Users, their sessions, and the data the app used to keep in localStorage.
//
// Each record a user edits (a scope, an item tag, a variable tag, their globals and their
// settings) is one row with a `version` that goes up on every save. A save names the version it
// was based on, so a tab working from stale data gets a conflict instead of overwriting newer
// changes. Nested parts of a record that the server never queries (a scope's variables, an item
// tag's items, ...) are JSON text columns.

const addTimestamps = (table, knex) => {
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
};

const addUserForeignKey = (table) => {
    table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
};

export const up = async (knex) => {
    await knex.schema.createTable('users', (table) => {
        table.increments('id');
        table.string('google_sub').notNullable().unique(); // Google's stable account id
        table.string('email');
        table.string('name');
        table.string('avatar_url');
        addTimestamps(table, knex);
    });

    await knex.schema.createTable('sessions', (table) => {
        table.string('sid').primary();
        table.text('sess').notNullable();
        table.bigInteger('expires_at').notNullable().index(); // ms since epoch
    });

    await knex.schema.createTable('user_settings', (table) => {
        addUserForeignKey(table);
        table.primary(['user_id']);
        table.text('editor_settings').notNullable().defaultTo('{}');
        table.text('dashboard_filter').notNullable().defaultTo('[]');
        table.integer('version').notNullable();
        addTimestamps(table, knex);
    });

    await knex.schema.createTable('globals', (table) => {
        addUserForeignKey(table);
        table.primary(['user_id']);
        table.text('code').notNullable().defaultTo('');
        table.text('variables').notNullable().defaultTo('[]');
        table.integer('version').notNullable();
        addTimestamps(table, knex);
    });

    // id is the client's own scope id (a timestamp when the scope was made), unique per user.
    await knex.schema.createTable('scopes', (table) => {
        addUserForeignKey(table);
        table.string('id').notNullable();
        table.primary(['user_id', 'id']);
        table.string('name').notNullable();
        table.text('code').notNullable().defaultTo('');
        table.integer('position').notNullable().defaultTo(0);
        table.text('variables').notNullable().defaultTo('[]');
        table.text('item_tag_keys').notNullable().defaultTo('[]');
        table.text('item_colors').notNullable().defaultTo('{}');
        table.double('color_seed');
        table.string('share_token').unique(); // set while the scope is shared read-only by link
        table.integer('version').notNullable();
        addTimestamps(table, knex);
    });

    await knex.schema.createTable('item_tags', (table) => {
        addUserForeignKey(table);
        table.string('key').notNullable();
        table.primary(['user_id', 'key']);
        table.string('label').notNullable();
        table.string('parent');
        table.text('items').notNullable().defaultTo('[]');
        table.integer('position').notNullable().defaultTo(0);
        table.integer('version').notNullable();
        addTimestamps(table, knex);
    });

    await knex.schema.createTable('variable_tags', (table) => {
        addUserForeignKey(table);
        table.string('key').notNullable();
        table.primary(['user_id', 'key']);
        table.string('label').notNullable();
        table.integer('position').notNullable().defaultTo(0);
        table.integer('version').notNullable();
        addTimestamps(table, knex);
    });
};

export const down = async (knex) => {
    await knex.schema.dropTable('variable_tags');
    await knex.schema.dropTable('item_tags');
    await knex.schema.dropTable('scopes');
    await knex.schema.dropTable('globals');
    await knex.schema.dropTable('user_settings');
    await knex.schema.dropTable('sessions');
    await knex.schema.dropTable('users');
};
