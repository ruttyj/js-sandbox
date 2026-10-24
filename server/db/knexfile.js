// For the knex CLI (npm run migrate, migrate:make, ...). The server runs migrations itself on start.
import { loadConfig } from '../config.js';
import { ensureDatabaseDir, knexConfig } from './knex.js';

const { databaseFile } = loadConfig();
ensureDatabaseDir(databaseFile);

export default knexConfig(databaseFile);
