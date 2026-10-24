// Starts the server: brings the database up to date, then listens.
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createKnex, runMigrations } from './db/knex.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const logMigrations = ({ applied }) => {
    if (applied.length) {
        console.log(`Applied migrations: ${applied.join(', ')}`);
        return;
    }
    console.log('Database is up to date.');
};

// Docker stops the container with SIGTERM: finish the requests in progress, then close the database.
const shutDownOn = (signal, { server, knex, close }) => {
    process.on(signal, () => {
        console.log(`${signal} received, shutting down.`);
        setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
        server.close(async () => {
            close();
            await knex.destroy();
            process.exit(0);
        });
    });
};

const start = async () => {
    const config = loadConfig();
    const knex = createKnex(config.databaseFile);
    logMigrations(await runMigrations(knex));

    const { app, close } = createApp({ knex, config });
    const server = app.listen(config.port, () => {
        console.log(`GE Tracker listening on port ${config.port} (${config.baseUrl}).`);
        if (config.devLogin) {
            console.log('Development sign-in is enabled (DEV_LOGIN=true).');
        }
    });

    shutDownOn('SIGTERM', { server, knex, close });
    shutDownOn('SIGINT', { server, knex, close });
};

start().catch((error) => {
    console.error(error);
    process.exit(1);
});
