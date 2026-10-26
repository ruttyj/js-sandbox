// The supervisor sits between the orchestration loop and Sandcastle. It
// records everything each agent does as dashboard events, and gives the
// person watching the dashboard the controls a human supervisor of parallel
// agents needs:
//
//   - abort a single agent that has gone off the rails
//   - stop the run gracefully after the current iteration
//   - approve or reject each branch before it is merged (the merge gate)

import { join } from "node:path";
import type { AgentStreamEvent, LoggingOption } from "@ai-hero/sandcastle";
import type { AgentRole, DashboardEventBody, IssueRef, RunPhase } from "./events.ts";
import { normaliseStreamLine } from "./events.ts";
import { currentHeadSha, repoWebUrl } from "./git.ts";
import { LogTail } from "./logTail.ts";
import { EventStore } from "./store.ts";

export interface AgentMeta {
  // Unique within an iteration, e.g. "planner" or "issue-42".
  readonly key: string;
  readonly role: AgentRole;
  readonly title: string;
  readonly iteration: number;
  readonly model: string;
  readonly maxTurns: number;
  readonly issue?: IssueRef;
  readonly branch?: string;
}

// What runAgent hands to sandcastle.run: spread both into its options.
export interface Instrumentation {
  readonly logging: LoggingOption;
  readonly signal: AbortSignal;
}

// The parts of a Sandcastle RunResult the supervisor records.
interface RunOutcome {
  readonly commits: { sha: string }[];
  readonly branch: string;
}

export interface MergeCandidate {
  readonly branch: string;
  readonly issue: IssueRef;
}

interface PendingGate {
  readonly branches: string[];
  readonly resolve: (approved: string[]) => void;
}

// --- Helpers -----------------------------------------------------------------

// e.g. 2026-10-25T19:30:12.345Z -> "20261025-193012"
const timestampId = (date: Date): string => {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

// --- Supervisor --------------------------------------------------------------

export class Supervisor {
  readonly store: EventStore;
  readonly runId: string;
  readonly journalPath: string;
  private readonly abortControllers = new Map<string, AbortController>();
  private pendingGate: PendingGate | undefined;
  private mergeGateEnabled: boolean;
  private stopWasRequested = false;

  private constructor(
    private readonly repoDir: string,
    options: { mergeGate: boolean },
  ) {
    this.runId = timestampId(new Date());
    this.journalPath = join(repoDir, ".sandcastle", "logs", "dashboard", `${this.runId}.jsonl`);
    this.store = new EventStore(this.journalPath);
    this.mergeGateEnabled = options.mergeGate;
  }

  static async start(options: { repoDir: string; maxIterations: number; mergeGate: boolean }): Promise<Supervisor> {
    const supervisor = new Supervisor(options.repoDir, options);
    supervisor.store.append({
      kind: "run.start",
      runId: supervisor.runId,
      maxIterations: options.maxIterations,
      repoUrl: await repoWebUrl(options.repoDir),
      mergeGate: options.mergeGate,
    });
    return supervisor;
  }

  get stopRequested(): boolean {
    return this.stopWasRequested;
  }

  // --- Run-level events -------------------------------------------------------

  setPhase(phase: RunPhase, iteration: number): void {
    this.store.append({ kind: "run.phase", phase, iteration });
  }

  recordPlan(iteration: number, issues: { id: string; title: string; branch: string }[]): void {
    this.store.append({ kind: "run.plan", iteration, issues });
  }

  log(level: "info" | "warn" | "error", message: string): void {
    this.store.append({ kind: "run.log", level, message });
  }

  endRun(error?: unknown): void {
    if (error === undefined) {
      this.store.append({ kind: "run.end" });
      return;
    }
    this.store.append({ kind: "run.end", error: errorMessage(error) });
  }

  // --- Agents -----------------------------------------------------------------

  // Runs one agent with its stream recorded and an abort switch attached.
  // `launch` receives the logging and signal options to pass to
  // sandcastle.run, and its result (or failure) is passed through unchanged.
  async runAgent<Result extends RunOutcome>(
    meta: AgentMeta,
    launch: (instrumentation: Instrumentation) => Promise<Result>,
  ): Promise<Result> {
    const agentId = `i${meta.iteration}-${meta.key}`;
    const logPath = join(this.repoDir, ".sandcastle", "logs", this.runId, `${agentId}.log`);
    const controller = new AbortController();
    this.abortControllers.set(agentId, controller);

    this.store.append({
      kind: "agent.start",
      agentId,
      role: meta.role,
      title: meta.title,
      iteration: meta.iteration,
      model: meta.model,
      maxTurns: meta.maxTurns,
      baseSha: await currentHeadSha(this.repoDir),
      issue: meta.issue,
      branch: meta.branch,
    });

    const logTail = new LogTail(logPath, {
      onStatus: (text) => this.store.append({ kind: "agent.status", agentId, text }),
      onBranch: (branch) => this.store.append({ kind: "agent.branch", agentId, branch }),
    });
    const logging: LoggingOption = {
      type: "file",
      path: logPath,
      onAgentStreamEvent: createStreamRecorder(this.store, agentId),
    };

    try {
      const result = await launch({ logging, signal: controller.signal });
      this.store.append({
        kind: "agent.end",
        agentId,
        status: "done",
        commits: result.commits.map((commit) => commit.sha),
        branch: result.branch,
      });
      return result;
    } catch (error) {
      const status = controller.signal.aborted ? "aborted" : "failed";
      this.store.append({ kind: "agent.end", agentId, status, commits: [], error: errorMessage(error) });
      throw error;
    } finally {
      logTail.stop();
      this.abortControllers.delete(agentId);
    }
  }

  // Returns false when the agent isn't running (already finished, or unknown).
  abortAgent(agentId: string): boolean {
    const controller = this.abortControllers.get(agentId);
    if (!controller) {
      return false;
    }

    this.log("warn", `Aborting ${agentId} from the dashboard.`);
    controller.abort(new Error("Aborted from the dashboard"));
    return true;
  }

  // --- Supervision controls ---------------------------------------------------

  requestStop(): void {
    if (this.stopWasRequested) {
      return;
    }

    this.stopWasRequested = true;
    this.store.append({ kind: "run.stopRequested" });
  }

  setMergeGate(enabled: boolean): void {
    this.mergeGateEnabled = enabled;
    this.store.append({ kind: "run.settings", mergeGate: enabled });

    // Turning the gate off while it's waiting lets everything through.
    if (!enabled && this.pendingGate) {
      this.resolveGate(this.pendingGate.branches);
    }
  }

  // Resolves with the branches to merge. With the gate off that's all of
  // them; with it on, it waits until the dashboard approves a subset.
  async reviewBeforeMerge(iteration: number, candidates: MergeCandidate[]): Promise<string[]> {
    const branches = candidates.map((candidate) => candidate.branch);
    if (!this.mergeGateEnabled) {
      return branches;
    }

    this.setPhase("review", iteration);
    this.store.append({ kind: "gate.open", iteration, branches: [...candidates] });
    return new Promise((resolve) => {
      this.pendingGate = { branches, resolve };
    });
  }

  // Returns false when no gate is waiting.
  resolveGate(approved: string[]): boolean {
    const gate = this.pendingGate;
    if (!gate) {
      return false;
    }

    const approvedBranches = gate.branches.filter((branch) => approved.includes(branch));
    const rejectedBranches = gate.branches.filter((branch) => !approved.includes(branch));
    this.pendingGate = undefined;
    this.store.append({ kind: "gate.closed", approved: approvedBranches, rejected: rejectedBranches });
    gate.resolve(approvedBranches);
    return true;
  }
}

// --- Stream recording --------------------------------------------------------

// Builds the onAgentStreamEvent callback for one agent. Only the raw lines
// are used: they carry everything the typed text/toolCall events do, plus
// edits, tool results and token usage.
const createStreamRecorder = (store: EventStore, agentId: string) => {
  let currentTurn = 0;

  return (event: AgentStreamEvent): void => {
    if (event.type !== "raw") {
      return;
    }

    // Each Sandcastle iteration is a fresh agent process: a "turn" here.
    if (event.iteration !== currentTurn) {
      currentTurn = event.iteration;
      store.append({ kind: "agent.turn", agentId, turn: currentTurn });
    }

    for (const body of normaliseStreamLine(event.line)) {
      store.append({ ...body, agentId } as DashboardEventBody);
    }
  };
};
