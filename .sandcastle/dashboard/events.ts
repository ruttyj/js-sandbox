// Dashboard events: the journal the web UI is built from.
//
// Everything the dashboard shows is derived from this one append-only stream,
// so a live run and a replayed journal render exactly the same way. Agent
// events are normalised from Claude Code's raw stream-json output (one JSON
// object per stdout line), keeping only what a supervisor needs and clipping
// large payloads so the journal stays small.

// --- Event types -------------------------------------------------------------

export type AgentRole = "planner" | "implementer" | "merger";

// "review" only happens with the merge gate on.
export type RunPhase = "plan" | "execute" | "review" | "merge";

export interface IssueRef {
  readonly id: string;
  readonly title: string;
}

export type DashboardEventBody =
  | {
      kind: "run.start";
      runId: string;
      maxIterations: number;
      repoUrl?: string;
      mergeGate: boolean;
    }
  | { kind: "run.phase"; phase: RunPhase; iteration: number }
  | { kind: "run.plan"; iteration: number; issues: { id: string; title: string; branch: string }[] }
  | { kind: "run.log"; level: "info" | "warn" | "error"; message: string }
  | { kind: "run.settings"; mergeGate: boolean }
  | { kind: "run.stopRequested" }
  | { kind: "run.end"; error?: string }
  | { kind: "gate.open"; iteration: number; branches: { branch: string; issue: IssueRef }[] }
  | { kind: "gate.closed"; approved: string[]; rejected: string[] }
  | {
      kind: "agent.start";
      agentId: string;
      role: AgentRole;
      title: string;
      iteration: number;
      model: string;
      maxTurns: number;
      baseSha: string;
      issue?: IssueRef;
      branch?: string;
    }
  | { kind: "agent.branch"; agentId: string; branch: string }
  | { kind: "agent.status"; agentId: string; text: string }
  | { kind: "agent.turn"; agentId: string; turn: number }
  | { kind: "agent.session"; agentId: string; sessionId: string; model?: string }
  | { kind: "agent.text"; agentId: string; text: string }
  | { kind: "agent.thinking"; agentId: string; text: string }
  | { kind: "agent.tool"; agentId: string; toolId: string; name: string; input: unknown }
  | { kind: "agent.toolResult"; agentId: string; toolId: string; isError: boolean; output: string }
  | {
      kind: "agent.usage";
      agentId: string;
      messageId: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheCreate: number;
    }
  | {
      kind: "agent.result";
      agentId: string;
      costUsd?: number;
      turns?: number;
      durationMs?: number;
      isError: boolean;
    }
  | {
      kind: "agent.end";
      agentId: string;
      status: "done" | "failed" | "aborted";
      commits: string[];
      branch?: string;
      error?: string;
    };

// Every stored event carries a sequence number (for resuming a stream) and
// an ISO timestamp.
export type DashboardEvent = DashboardEventBody & { seq: number; time: string };

// The agent events a stream line can produce: the body without its agentId,
// which the caller adds.
type AgentEventKind =
  | "agent.session"
  | "agent.text"
  | "agent.thinking"
  | "agent.tool"
  | "agent.toolResult"
  | "agent.usage"
  | "agent.result";

type WithoutAgentId<T> = T extends unknown ? Omit<T, "agentId"> : never;

export type StreamEventBody = WithoutAgentId<Extract<DashboardEventBody, { kind: AgentEventKind }>>;

// --- Clipping ----------------------------------------------------------------

// Tool output beyond this is clipped. Test runs and file reads can be huge,
// and the head and tail are what a supervisor reads.
const MAX_TOOL_OUTPUT_CHARS = 8_000;

// Per string field in a tool's input. Large enough to keep a whole Edit or a
// typical Write, so the UI can show the change itself.
const MAX_TOOL_INPUT_FIELD_CHARS = 24_000;

// Inside the sandbox the repo is mounted here; paths are shown relative to it.
const SANDBOX_REPO_PREFIX = "/home/agent/workspace/";

// Keeps the first ~70% and the last ~30% of an over-long string, marking the
// gap, e.g. clip("abcdefghij", 6) -> "abcd\n… 4 chars omitted …\nij".
export const clip = (text: string, max: number): string => {
  if (text.length <= max) {
    return text;
  }

  const headLength = Math.floor(max * 0.7);
  const tailLength = max - headLength;
  const omitted = text.length - headLength - tailLength;
  return `${text.slice(0, headLength)}\n… ${omitted} chars omitted …\n${text.slice(-tailLength)}`;
};

const stripSandboxPrefix = (text: string): string => {
  return text.split(SANDBOX_REPO_PREFIX).join("");
};

// Clips every string in a tool input, recursing into arrays and objects
// (MultiEdit's edits, TodoWrite's todos).
const clipToolInput = (value: unknown): unknown => {
  if (typeof value === "string") {
    return clip(stripSandboxPrefix(value), MAX_TOOL_INPUT_FIELD_CHARS);
  }

  if (Array.isArray(value)) {
    return value.map(clipToolInput);
  }

  if (value !== null && typeof value === "object") {
    const clipped: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      clipped[key] = clipToolInput(field);
    }
    return clipped;
  }

  return value;
};

// A tool_result's content is either a string or a list of blocks; only the
// text blocks are kept (images can't be shown usefully in the feed).
const toolResultText = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const texts: string[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    } else if (block?.type === "image") {
      texts.push("[image]");
    }
  }
  return texts.join("\n");
};

// --- Stream-json normalisation -----------------------------------------------

const toNumber = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return 0;
};

const normaliseAssistant = (message: any): StreamEventBody[] => {
  const events: StreamEventBody[] = [];
  const content = Array.isArray(message?.content) ? message.content : [];

  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
      events.push({ kind: "agent.text", text: block.text });
    } else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim() !== "") {
      events.push({ kind: "agent.thinking", text: block.thinking });
    } else if (block?.type === "tool_use" && typeof block.name === "string") {
      events.push({
        kind: "agent.tool",
        toolId: String(block.id ?? ""),
        name: block.name,
        input: clipToolInput(block.input ?? {}),
      });
    }
  }

  // Claude Code writes one line per content block of a message, each
  // repeating the message's usage; the UI keeps the latest per messageId.
  const usage = message?.usage;
  if (usage && typeof message.id === "string") {
    events.push({
      kind: "agent.usage",
      messageId: message.id,
      input: toNumber(usage.input_tokens),
      output: toNumber(usage.output_tokens),
      cacheRead: toNumber(usage.cache_read_input_tokens),
      cacheCreate: toNumber(usage.cache_creation_input_tokens),
    });
  }

  return events;
};

const normaliseUser = (message: any): StreamEventBody[] => {
  const events: StreamEventBody[] = [];
  const content = Array.isArray(message?.content) ? message.content : [];

  for (const block of content) {
    if (block?.type !== "tool_result") {
      continue;
    }

    const output = stripSandboxPrefix(toolResultText(block.content));
    events.push({
      kind: "agent.toolResult",
      toolId: String(block.tool_use_id ?? ""),
      isError: block.is_error === true,
      output: clip(output, MAX_TOOL_OUTPUT_CHARS),
    });
  }

  return events;
};

// Turns one stdout line from `claude --output-format stream-json` into
// dashboard events. Lines that aren't JSON, or that the dashboard has no use
// for, produce nothing.
export const normaliseStreamLine = (line: string): StreamEventBody[] => {
  if (!line.startsWith("{")) {
    return [];
  }

  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }

  if (parsed.type === "system" && parsed.subtype === "init" && typeof parsed.session_id === "string") {
    return [{ kind: "agent.session", sessionId: parsed.session_id, model: parsed.model }];
  }

  if (parsed.type === "assistant") {
    return normaliseAssistant(parsed.message);
  }

  if (parsed.type === "user") {
    return normaliseUser(parsed.message);
  }

  if (parsed.type === "result") {
    return [
      {
        kind: "agent.result",
        costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : undefined,
        turns: typeof parsed.num_turns === "number" ? parsed.num_turns : undefined,
        durationMs: typeof parsed.duration_ms === "number" ? parsed.duration_ms : undefined,
        isError: parsed.is_error === true,
      },
    ];
  }

  return [];
};
