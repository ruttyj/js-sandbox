// Opens the dashboard on a finished run's journal, read-only.
//
// Usage:
//   npm run sandcastle:dashboard              the most recent run
//   npm run sandcastle:dashboard -- <file>    a specific journal

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { openInBrowser } from "./index.ts";
import { startDashboardServer } from "./server.ts";
import { EventStore } from "./store.ts";

const JOURNAL_DIR = join(process.cwd(), ".sandcastle", "logs", "dashboard");

// Journals are named by run start time, so the last in sort order is newest.
const latestJournal = (): string | undefined => {
  let files: string[];
  try {
    files = readdirSync(JOURNAL_DIR).filter((file) => file.endsWith(".jsonl"));
  } catch {
    return undefined;
  }

  const newest = files.sort().at(-1);
  if (!newest) {
    return undefined;
  }
  return join(JOURNAL_DIR, newest);
};

const journalPath = process.argv[2] ? resolve(process.argv[2]) : latestJournal();
if (!journalPath) {
  console.error(`No journals found in ${JOURNAL_DIR}. Run \`npm run sandcastle\` first.`);
  process.exit(1);
}

const store = EventStore.fromJournal(journalPath);
const server = await startDashboardServer({
  store,
  repoDir: process.cwd(),
  // Each replay is its own "run" to the browser, so a stale tab reloads it all.
  runId: `replay-${Date.now()}`,
  port: Number(process.env.SANDCASTLE_DASHBOARD_PORT) || 4317,
});

console.log(`Replaying ${journalPath} (${store.events.length} events)`);
console.log(`Dashboard: ${server.url}  (Ctrl+C to exit)`);
if (process.env.SANDCASTLE_DASHBOARD_OPEN !== "0") {
  openInBrowser(server.url);
}
