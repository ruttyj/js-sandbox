// Parallel Planner — three-phase orchestration loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):    An opus agent analyzes open issues, builds a dependency
//                      graph, and outputs a <plan> JSON listing unblocked issues
//                      with their target branch names.
//   Phase 2 (Execute): N sonnet agents run in parallel via Promise.allSettled,
//                      each working a single issue on its own branch.
//   Phase 3 (Merge):   A sonnet agent merges all branches that produced commits.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// Every agent runs through the supervisor (./dashboard), which records what
// it does and serves a live dashboard (the URL is printed at startup). From
// there agents can be aborted, the run stopped after the current iteration,
// and branches approved one by one before the merge phase (the merge gate).
// See dashboard/index.ts for the environment variables that configure it, and
// `npm run sandcastle:dashboard` to replay a finished run.
//
// Usage:
//   npx tsx .sandcastle/main.ts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.ts" }

import { execFileSync } from "node:child_process";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";
import { startSupervision, type Supervisor } from "./dashboard/index.ts";

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. We use Zod here, but any Standard
// Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev.
const planSchema = z.object({
  issues: z.array(
    z.object({ id: z.string(), title: z.string(), branch: z.string() }),
  ),
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 4;

// Opus throughout: planning benefits from deeper dependency reasoning, and
// implementation and conflict resolution from the stronger model too.
const PLANNER_MODEL = "claude-opus-5-5";
const IMPLEMENTER_MODEL = "claude-opus-5-5";
const MERGER_MODEL = "claude-opus-5-5";

// Give each implementer plenty of room to implement and iterate on tests.
const IMPLEMENTER_MAX_ITERATIONS = 100;

// Hooks run inside the sandbox before the agent starts each iteration.
// node_modules isn't copied in from the host: the host is Windows, where
// Sandcastle's copy (it shells out to `cp`) fails, and its native binaries
// (better-sqlite3) wouldn't run on Linux anyway. So install from scratch.
//
// Only give these hooks to runs that get their own worktree. A run with the
// default "head" branch strategy bind-mounts the real project directory, so
// npm ci there would wipe the host's Windows node_modules.
//
// Worktrees are checked out by Windows git, which converts the repo's LF
// endings to CRLF. Linux git doesn't convert them back on commit unless told
// to, so without autocrlf=input every file an agent touches is committed with
// CRLF and shows as fully rewritten. --global keeps it in the container.
//
// npm ci writes node_modules through the bind mount onto the Windows (and
// Dropbox) worktree, which is slow, and parallel agents install at once, so it
// needs far longer than the 60s default hook timeout.
const NPM_CI_TIMEOUT_MS = 15 * 60 * 1000;

const hooks = {
  sandbox: {
    onSandboxReady: [
      { command: "git config --global core.autocrlf input" },
      { command: "npm ci", timeoutMs: NPM_CI_TIMEOUT_MS },
    ],
  },
};

// ---------------------------------------------------------------------------
// Reporting
//
// Progress goes to the console as before, and to the dashboard's run log.
// ---------------------------------------------------------------------------

const report = (supervisor: Supervisor, message: string) => {
  console.log(message);
  supervisor.log("info", message.trim());
};

const reportError = (supervisor: Supervisor, message: string) => {
  console.error(`  ✗ ${message}`);
  supervisor.log("error", message);
};

// ---------------------------------------------------------------------------
// Closing finished issues
//
// Done here on the host rather than by the merge agent: the sandbox's
// GH_TOKEN may only be able to read issues, and an issue left open is planned
// and implemented all over again in the next iteration.
// ---------------------------------------------------------------------------

// Whether branch's commits are all in the current branch, i.e. the merge
// agent actually merged it.
const isMergedIntoHead = (branch: string) => {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", branch, "HEAD"]);
    return true;
  } catch {
    return false;
  }
};

// Uses the host's own gh login. GH_TOKEN is dropped in case it's the sandbox's
// read-only token.
const closeIssue = (id: string) => {
  const { GH_TOKEN, ...env } = process.env;
  execFileSync("gh", ["issue", "close", id, "--comment", "Completed by Sandcastle"], { env, stdio: "inherit" });
};

const closeMergedIssues = (issues: { id: string; branch: string }[], supervisor: Supervisor) => {
  for (const issue of issues) {
    if (!isMergedIntoHead(issue.branch)) {
      reportError(supervisor, `${issue.branch} wasn't merged; leaving issue ${issue.id} open.`);
      continue;
    }

    try {
      closeIssue(issue.id);
      supervisor.log("info", `Closed issue #${issue.id}.`);
    } catch (error) {
      reportError(supervisor, `Could not close issue ${issue.id}: ${error}`);
    }
  }
};

// ---------------------------------------------------------------------------
// Phase 1: Plan
//
// The planning agent reads the open issue list, builds a dependency graph,
// and selects the issues that can be worked in parallel right now (i.e., no
// blocking dependencies on other open issues).
//
// It outputs a <plan> JSON block — Output.object parses and validates it.
// ---------------------------------------------------------------------------

type PlannedIssue = z.infer<typeof planSchema>["issues"][number];

const planIssues = async (supervisor: Supervisor, iteration: number): Promise<PlannedIssue[]> => {
  supervisor.setPhase("plan", iteration);

  const plan = await supervisor.runAgent(
    { key: "planner", role: "planner", title: "Plan the next issues", iteration, model: PLANNER_MODEL, maxTurns: 1 },
    (instrumentation) =>
      // No hooks: the planner only reads issues, and it runs against the real
      // project directory (see the note on hooks above).
      sandcastle.run({
        ...instrumentation,
        sandbox: docker(),
        name: "planner",
        // One iteration is enough: the planner just needs to read and reason,
        // not write code. (Structured output requires maxIterations: 1.)
        maxIterations: 1,
        agent: sandcastle.claudeCode(PLANNER_MODEL),
        promptFile: "./.sandcastle/plan-prompt.md",
        // Extract and validate the <plan> JSON into a typed object. Throws
        // StructuredOutputError if the tag is missing, the JSON is malformed,
        // or validation fails — which aborts the loop.
        output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
      }),
  );

  supervisor.recordPlan(iteration, plan.output.issues);
  return plan.output.issues;
};

// ---------------------------------------------------------------------------
// Phase 2: Execute
//
// Spawn one agent per issue, all running concurrently. Each agent works on
// its own branch so there are no conflicts during execution — merging
// happens in Phase 3.
//
// Promise.allSettled means one failing (or aborted) agent doesn't cancel the
// others.
// ---------------------------------------------------------------------------

const implementIssue = (supervisor: Supervisor, iteration: number, issue: PlannedIssue) => {
  return supervisor.runAgent(
    {
      key: `issue-${issue.id}`,
      role: "implementer",
      title: issue.title,
      iteration,
      model: IMPLEMENTER_MODEL,
      maxTurns: IMPLEMENTER_MAX_ITERATIONS,
      issue: { id: issue.id, title: issue.title },
      branch: issue.branch,
    },
    (instrumentation) =>
      sandcastle.run({
        ...instrumentation,
        hooks,
        sandbox: docker(),
        // Each agent starts on its own branch via branchStrategy on run().
        branchStrategy: { type: "branch", branch: issue.branch },
        name: "implementer",
        maxIterations: IMPLEMENTER_MAX_ITERATIONS,
        agent: sandcastle.claudeCode(IMPLEMENTER_MODEL),
        promptFile: "./.sandcastle/implement-prompt.md",
        // Prompt arguments substitute {{TASK_ID}}, {{ISSUE_TITLE}},
        // and {{BRANCH}} placeholders in implement-prompt.md before the
        // agent sees the prompt.
        promptArgs: {
          TASK_ID: issue.id,
          ISSUE_TITLE: issue.title,
          BRANCH: issue.branch,
        },
      }),
  );
};

// Returns the issues whose agents produced commits. An agent that ran
// successfully but made no commits has nothing to merge.
const implementIssues = async (
  supervisor: Supervisor,
  iteration: number,
  issues: PlannedIssue[],
): Promise<PlannedIssue[]> => {
  supervisor.setPhase("execute", iteration);
  const settled = await Promise.allSettled(issues.map((issue) => implementIssue(supervisor, iteration, issue)));

  const completedIssues: PlannedIssue[] = [];
  for (const [i, outcome] of settled.entries()) {
    const issue = issues[i]!;

    // Log any agents that threw (network error, sandbox crash, abort, etc.).
    if (outcome.status === "rejected") {
      reportError(supervisor, `${issue.id} (${issue.branch}) failed: ${outcome.reason}`);
      continue;
    }

    if (outcome.value.commits.length > 0) {
      completedIssues.push(issue);
    }
  }
  return completedIssues;
};

// ---------------------------------------------------------------------------
// Phase 3: Merge
//
// One agent merges all completed branches into the current branch, resolving
// any conflicts and running tests to confirm everything still works.
//
// The {{BRANCHES}} and {{ISSUES}} prompt arguments are lists that the agent
// uses to know which branches to merge and what they fix. The issues are
// closed afterwards on the host (closeMergedIssues).
// ---------------------------------------------------------------------------

const mergeIssues = async (supervisor: Supervisor, iteration: number, issues: PlannedIssue[]) => {
  supervisor.setPhase("merge", iteration);

  await supervisor.runAgent(
    { key: "merger", role: "merger", title: "Merge completed branches", iteration, model: MERGER_MODEL, maxTurns: 1 },
    (instrumentation) =>
      sandcastle.run({
        ...instrumentation,
        hooks,
        sandbox: docker(),
        // Merge in a worktree so the npm ci hook can't touch the host's
        // node_modules; the result is merged back into the current branch.
        branchStrategy: { type: "merge-to-head" },
        name: "merger",
        maxIterations: 1,
        agent: sandcastle.claudeCode(MERGER_MODEL),
        promptFile: "./.sandcastle/merge-prompt.md",
        promptArgs: {
          // A markdown list of branch names, one per line.
          BRANCHES: issues.map((issue) => `- ${issue.branch}`).join("\n"),
          // A markdown list of issue IDs and titles, one per line.
          ISSUES: issues.map((issue) => `- ${issue.id}: ${issue.title}`).join("\n"),
        },
      }),
  );
};

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

// With the merge gate on, waits for the dashboard to approve branches and
// returns the approved issues; otherwise returns them all. A rejected
// branch's issue stays open, so it is planned again next iteration.
const approveIssues = async (supervisor: Supervisor, iteration: number, issues: PlannedIssue[]) => {
  const candidates = issues.map((issue) => ({ branch: issue.branch, issue: { id: issue.id, title: issue.title } }));
  const approvedBranches = await supervisor.reviewBeforeMerge(iteration, candidates);
  return issues.filter((issue) => approvedBranches.includes(issue.branch));
};

const runIteration = async (supervisor: Supervisor, iteration: number): Promise<"continue" | "finished"> => {
  const issues = await planIssues(supervisor, iteration);

  if (issues.length === 0) {
    // No unblocked work — either everything is done or everything is blocked.
    report(supervisor, "No unblocked issues to work on. Exiting.");
    return "finished";
  }

  report(supervisor, `Planning complete. ${issues.length} issue(s) to work in parallel:`);
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  const completedIssues = await implementIssues(supervisor, iteration, issues);
  report(supervisor, `\nExecution complete. ${completedIssues.length} branch(es) with commits:`);
  for (const issue of completedIssues) {
    console.log(`  ${issue.branch}`);
  }

  if (completedIssues.length === 0) {
    // All agents ran but none made commits — nothing to merge this cycle.
    report(supervisor, "No commits produced. Nothing to merge.");
    return "continue";
  }

  const approvedIssues = await approveIssues(supervisor, iteration, completedIssues);
  if (approvedIssues.length === 0) {
    report(supervisor, "No branches approved. Nothing to merge.");
    return "continue";
  }

  await mergeIssues(supervisor, iteration, approvedIssues);
  report(supervisor, "\nBranches merged.");
  closeMergedIssues(approvedIssues, supervisor);
  return "continue";
};

const runLoop = async (supervisor: Supervisor) => {
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    if (supervisor.stopRequested) {
      report(supervisor, "\nStopped from the dashboard.");
      return;
    }

    console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);
    const outcome = await runIteration(supervisor, iteration);
    if (outcome === "finished") {
      return;
    }
  }
};

const { supervisor, server } = await startSupervision({ repoDir: process.cwd(), maxIterations: MAX_ITERATIONS });

try {
  await runLoop(supervisor);
  supervisor.endRun();
  console.log("\nAll done.");
} catch (error) {
  supervisor.endRun(error);

  // Without a dashboard, fail as before. With one, keep it up so the failure
  // can be looked into there.
  if (!server) {
    throw error;
  }
  console.error(error);
  process.exitCode = 1;
}

// The open server keeps the process alive until Ctrl+C.
if (server) {
  console.log(`\nThe dashboard stays open for review at ${server.url} — press Ctrl+C to exit.`);
}
