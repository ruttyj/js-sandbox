// Entry point for main.ts: starts the supervisor and, unless disabled, the
// dashboard server.
//
// Environment:
//   SANDCASTLE_DASHBOARD=0         record the journal but serve no dashboard
//   SANDCASTLE_DASHBOARD_PORT=n    first port to try (default 4317)
//   SANDCASTLE_DASHBOARD_OPEN=0    don't open a browser tab
//   SANDCASTLE_MERGE_GATE=1        start with the merge gate on (also
//                                  switchable from the dashboard)

import { execFile } from "node:child_process";
import { startDashboardServer, type DashboardServer } from "./server.ts";
import { Supervisor } from "./supervisor.ts";

export { Supervisor } from "./supervisor.ts";

const DEFAULT_PORT = 4317;

export const openInBrowser = (url: string): void => {
  const onError = () => {
    console.log(`Open ${url} in your browser.`);
  };

  if (process.platform === "win32") {
    execFile("cmd", ["/c", "start", "", url], onError);
  } else if (process.platform === "darwin") {
    execFile("open", [url], onError);
  } else {
    execFile("xdg-open", [url], onError);
  }
};

export interface Supervision {
  readonly supervisor: Supervisor;
  // Undefined when the dashboard is disabled.
  readonly server?: DashboardServer;
}

export const startSupervision = async (options: { repoDir: string; maxIterations: number }): Promise<Supervision> => {
  const supervisor = await Supervisor.start({
    ...options,
    mergeGate: process.env.SANDCASTLE_MERGE_GATE === "1",
  });

  if (process.env.SANDCASTLE_DASHBOARD === "0") {
    return { supervisor };
  }

  const server = await startDashboardServer({
    store: supervisor.store,
    repoDir: options.repoDir,
    runId: supervisor.runId,
    port: Number(process.env.SANDCASTLE_DASHBOARD_PORT) || DEFAULT_PORT,
    controls: supervisor,
  });
  console.log(`Dashboard: ${server.url}`);

  if (process.env.SANDCASTLE_DASHBOARD_OPEN !== "0") {
    openInBrowser(server.url);
  }
  return { supervisor, server };
};
