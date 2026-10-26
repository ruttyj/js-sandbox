// The dashboard's local web server.
//
//   GET  /                          the UI (static files in ./ui)
//   GET  /api/stream?run=&after=    every event as Server-Sent Events, then live ones
//   GET  /api/agents/:id/changes    the agent's diff and commits, read from git
//   POST /api/agents/:id/abort      kill one agent
//   POST /api/run/stop              stop after the current iteration
//   POST /api/run/settings          { mergeGate: boolean }
//   POST /api/gate                  { approved: string[] } branches to merge
//
// It listens on 127.0.0.1 only. The POST routes change what the agents do,
// so they also refuse cross-origin requests: any web page the user has open
// could otherwise post to localhost.

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { DashboardEvent } from "./events.ts";
import { getAgentChanges } from "./git.ts";
import type { EventStore } from "./store.ts";

const UI_DIR = fileURLToPath(new URL("./ui/", import.meta.url));

const HOST = "127.0.0.1";

// If the port is taken (say, by a second run), the next few are tried.
const PORT_ATTEMPTS = 10;

// Comment lines keep idle SSE connections from being dropped by the browser.
const HEARTBEAT_INTERVAL_MS = 15_000;

const MAX_BODY_BYTES = 64 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

// The run controls; absent when replaying a finished run's journal.
export interface DashboardControls {
  abortAgent(agentId: string): boolean;
  requestStop(): void;
  setMergeGate(enabled: boolean): void;
  resolveGate(approved: string[]): boolean;
}

interface ServerContext {
  readonly store: EventStore;
  readonly repoDir: string;
  readonly controls?: DashboardControls;
  readonly runId: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// --- Responses ---------------------------------------------------------------

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

const serveStatic = async (res: ServerResponse, urlPath: string): Promise<void> => {
  let relativePath = urlPath;
  if (relativePath === "/") {
    relativePath = "/index.html";
  }

  // normalize() collapses "..", and the prefix check rejects anything that
  // still escapes the UI folder.
  const filePath = normalize(join(UI_DIR, relativePath));
  if (!filePath.startsWith(normalize(UI_DIR + sep))) {
    throw new HttpError(404, "Not found");
  }

  let content: Buffer;
  try {
    content = await readFile(filePath);
  } catch {
    throw new HttpError(404, "Not found");
  }

  const contentType = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
  res.end(content);
};

// --- Event stream ------------------------------------------------------------

const writeSse = (res: ServerResponse, event: DashboardEvent): void => {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
};

// Sends the history, then follows the store. A client that reconnects passes
// the run it was showing and the last seq it saw; if that run is still the
// one being served, it only gets what it missed, otherwise everything.
const streamEvents = (context: ServerContext, req: IncomingMessage, res: ServerResponse, url: URL): void => {
  const isSameRun = url.searchParams.get("run") === context.runId;
  let after = 0;
  if (isSameRun) {
    after = Number(url.searchParams.get("after")) || 0;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ runId: context.runId, live: Boolean(context.controls) })}\n\n`);

  for (const event of context.store.events) {
    if (event.seq > after) {
      writeSse(res, event);
    }
  }
  res.write("event: synced\ndata: {}\n\n");

  const unsubscribe = context.store.subscribe((event) => writeSse(res, event));
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), HEARTBEAT_INTERVAL_MS);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
};

// --- Agent changes -----------------------------------------------------------

// The branch an agent works on and the commit it started from. A merger's
// branch is only known once its log header is read, so later events win.
const findAgentBranch = (events: DashboardEvent[], agentId: string): { branch?: string; baseSha?: string } => {
  let branch: string | undefined;
  let baseSha: string | undefined;

  for (const event of events) {
    if (!("agentId" in event) || event.agentId !== agentId) {
      continue;
    }

    if (event.kind === "agent.start") {
      branch = event.branch;
      baseSha = event.baseSha;
    } else if (event.kind === "agent.branch" || (event.kind === "agent.end" && event.branch)) {
      branch = event.branch;
    }
  }
  return { branch, baseSha };
};

const serveChanges = async (context: ServerContext, res: ServerResponse, agentId: string): Promise<void> => {
  const { branch, baseSha } = findAgentBranch(context.store.events, agentId);
  if (!branch || !baseSha) {
    sendJson(res, 200, { source: "none", patch: "", truncated: false, commits: [] });
    return;
  }

  sendJson(res, 200, await getAgentChanges(context.repoDir, branch, baseSha));
};

// --- Controls ----------------------------------------------------------------

const readJsonBody = async (req: IncomingMessage): Promise<any> => {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "Body too large");
    }
    chunks.push(chunk);
  }

  if (size === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body is not JSON");
  }
};

// Only the dashboard's own page may use the controls. Browsers always send
// Origin on a cross-site POST, and requiring a JSON content type forces a
// CORS preflight, which this server never approves.
const assertSameOrigin = (req: IncomingMessage): void => {
  const origin = req.headers.origin;
  const isOwnOrigin = origin === undefined || origin === `http://${req.headers.host}`;
  const isJson = (req.headers["content-type"] ?? "").startsWith("application/json");

  if (!isOwnOrigin || !isJson) {
    throw new HttpError(403, "Forbidden");
  }
};

const requireControls = (context: ServerContext): DashboardControls => {
  if (!context.controls) {
    throw new HttpError(409, "This is a replay; the run is not live.");
  }
  return context.controls;
};

const handleControl = async (context: ServerContext, req: IncomingMessage, res: ServerResponse, path: string) => {
  assertSameOrigin(req);
  const controls = requireControls(context);
  const body = await readJsonBody(req);

  const abortMatch = /^\/api\/agents\/([\w.-]+)\/abort$/.exec(path);
  if (abortMatch) {
    sendJson(res, 200, { ok: controls.abortAgent(abortMatch[1]!) });
    return;
  }

  if (path === "/api/run/stop") {
    controls.requestStop();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === "/api/run/settings" && typeof body.mergeGate === "boolean") {
    controls.setMergeGate(body.mergeGate);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === "/api/gate" && Array.isArray(body.approved)) {
    const approved = body.approved.filter((branch: unknown) => typeof branch === "string");
    sendJson(res, 200, { ok: controls.resolveGate(approved) });
    return;
  }

  throw new HttpError(404, "Not found");
};

// --- Routing -----------------------------------------------------------------

// Guards against DNS rebinding: a hostile site whose domain resolves to
// 127.0.0.1 would otherwise be "same origin" and could read agents' code.
const assertLocalHost = (req: IncomingMessage): void => {
  const hostname = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (hostname !== HOST && hostname !== "localhost") {
    throw new HttpError(403, "Forbidden");
  }
};

const route = async (context: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> => {
  assertLocalHost(req);
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const path = url.pathname;

  if (req.method === "POST") {
    await handleControl(context, req, res, path);
    return;
  }

  if (req.method !== "GET") {
    throw new HttpError(405, "Method not allowed");
  }

  if (path === "/api/stream") {
    streamEvents(context, req, res, url);
    return;
  }

  const changesMatch = /^\/api\/agents\/([\w.-]+)\/changes$/.exec(path);
  if (changesMatch) {
    await serveChanges(context, res, changesMatch[1]!);
    return;
  }

  await serveStatic(res, path);
};

const handleRequest = async (context: ServerContext, req: IncomingMessage, res: ServerResponse) => {
  try {
    await route(context, req, res);
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }

    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message });
      return;
    }
    sendJson(res, 500, { error: String(error) });
  }
};

// --- Startup -----------------------------------------------------------------

const listen = (server: Server, port: number): Promise<void> => {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
};

const listenOnFreePort = async (server: Server, firstPort: number): Promise<number> => {
  for (let port = firstPort; port < firstPort + PORT_ATTEMPTS; port++) {
    try {
      await listen(server, port);
      return port;
    } catch (error: any) {
      if (error?.code !== "EADDRINUSE") {
        throw error;
      }
    }
  }
  throw new Error(`No free port for the dashboard between ${firstPort} and ${firstPort + PORT_ATTEMPTS - 1}.`);
};

export interface DashboardServer {
  readonly url: string;
  close(): void;
}

export const startDashboardServer = async (options: {
  store: EventStore;
  repoDir: string;
  runId: string;
  port: number;
  controls?: DashboardControls;
}): Promise<DashboardServer> => {
  const context: ServerContext = options;
  const server = createServer((req, res) => {
    void handleRequest(context, req, res);
  });

  const port = await listenOnFreePort(server, options.port);
  return {
    url: `http://${HOST}:${port}/`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
};
