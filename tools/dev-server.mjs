// Runs the server and restarts it whenever a file under server/ changes. Used by the dev
// container (docker-compose.override.yml):
//
//   node tools/dev-server.mjs
//
// `node --watch` would do this, but it waits for file-change events, and Docker Desktop doesn't
// pass those through for folders mounted from Windows. So this checks the files' modified times
// once a second instead, which also catches files added or deleted.

import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = join(projectRoot, 'server');
const POLL_MS = 1000;

// --- Spotting changes --------------------------------------------------------------------------

/**
 * Every file under a folder with its modified time, as one string, e.g.
 * "server/app.js:1729788000000|server/index.js:1729787000000". Comparing two of these tells
 * whether anything was edited, added or removed.
 */
const snapshotFolder = async (folder) => {
    const entries = await readdir(folder, { recursive: true, withFileTypes: true });
    const parts = [];
    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }
        const path = join(entry.parentPath, entry.name);
        const { mtimeMs } = await stat(path);
        parts.push(`${path}:${mtimeMs}`);
    }
    return parts.sort().join('|');
};

// --- Running the server ------------------------------------------------------------------------

const startServer = () => {
    return spawn(process.execPath, ['server/index.js'], { cwd: projectRoot, stdio: 'inherit' });
};

// Stops the server and resolves once it has exited, so the next one can take the port.
const stopServer = (child) => {
    return new Promise((resolve) => {
        if (child.exitCode !== null) {
            resolve();
            return;
        }
        child.once('exit', resolve);
        child.kill('SIGTERM');
    });
};

const run = async () => {
    let child = startServer();
    let lastSnapshot = await snapshotFolder(serverDir);

    const forwardSignal = async (signal) => {
        await stopServer(child);
        process.exit(signal === 'SIGINT' ? 130 : 0);
    };
    process.on('SIGTERM', forwardSignal);
    process.on('SIGINT', forwardSignal);

    for (;;) {
        await new Promise(resolve => setTimeout(resolve, POLL_MS));

        // A file can disappear between readdir and stat mid-save; the next poll sees it settled.
        const snapshot = await snapshotFolder(serverDir).catch(() => lastSnapshot);
        if (snapshot === lastSnapshot) {
            continue;
        }

        lastSnapshot = snapshot;
        console.log('[dev-server] server/ changed, restarting…');
        await stopServer(child);
        child = startServer();
    }
};

run();
