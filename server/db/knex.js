// The Knex connection to the SQLite database, and running its migrations.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import knexFactory from 'knex';

const DB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(DB_DIR, 'migrations');

// The Knex config for a database file (or ':memory:' in tests).
export const knexConfig = (filename) => ({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: {
        // SQLite leaves foreign keys (and so ON DELETE CASCADE) off unless each connection turns
        // them on. WAL lets reads carry on while a write is in progress.
        afterCreate: (connection, done) => {
            connection.pragma('foreign_keys = ON');
            connection.pragma('journal_mode = WAL');
            done();
        },
    },
    migrations: {
        directory: MIGRATIONS_DIR,
        loadExtensions: ['.js'],
        // knex's own template is CommonJS, which this ES-module package can't load.
        stub: path.join(DB_DIR, 'migration.stub'),
    },
});

// SQLite creates the database file, but not the folder it goes in.
export const ensureDatabaseDir = (filename) => {
    if (filename !== ':memory:') {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
    }
};

export const createKnex = (filename) => {
    ensureDatabaseDir(filename);
    return knexFactory(knexConfig(filename));
};

export const runMigrations = async (knex) => {
    const [batch, applied] = await knex.migrate.latest();
    return { batch, applied };
};
