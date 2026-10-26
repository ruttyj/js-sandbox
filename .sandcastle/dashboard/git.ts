// What an agent has done to the code, read straight from git on the host.
//
// While an agent runs, its branch is checked out in a worktree under
// .sandcastle/worktrees/, bind-mounted into its sandbox, so diffing that
// worktree shows its edits live, before they are committed. Once the
// worktree is gone (the run ended) the branch itself is diffed instead.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Diffs beyond this are cut off; the UI says so. Keeps the browser responsive
// when an agent touches a generated file.
const MAX_PATCH_BYTES = 2 * 1024 * 1024;

// New files the agent hasn't committed or staged yet are diffed one by one.
const MAX_UNTRACKED_FILES = 60;

export interface CommitInfo {
  readonly sha: string;
  readonly subject: string;
  readonly author: string;
  readonly date: string;
}

export interface AgentChanges {
  // worktree: live, including uncommitted edits. branch: committed work only.
  // none: nothing to diff (no branch, or it no longer exists).
  readonly source: "worktree" | "branch" | "none";
  readonly patch: string;
  readonly truncated: boolean;
  readonly commits: CommitInfo[];
}

const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: MAX_PATCH_BYTES * 2 });
  return stdout;
};

// `git diff --no-index` exits 1 when the files differ, which is the normal
// case here, so its output is read from the error too.
const gitAllowingDiffExit = async (cwd: string, args: string[]): Promise<string> => {
  try {
    return await git(cwd, args);
  } catch (error: any) {
    if (error?.code === 1 && typeof error.stdout === "string") {
      return error.stdout;
    }
    throw error;
  }
};

// --- Locating the agent's work -----------------------------------------------

// The path of the worktree that has `branch` checked out, if any. Parses
// `git worktree list --porcelain`, whose entries look like:
//   worktree C:/repo/.sandcastle/worktrees/agent-issue-4
//   HEAD 1a2b3c...
//   branch refs/heads/agent/issue-4
export const findWorktree = async (repoDir: string, branch: string): Promise<string | undefined> => {
  const output = await git(repoDir, ["worktree", "list", "--porcelain"]);
  let currentPath: string | undefined;

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line === `branch refs/heads/${branch}`) {
      return currentPath;
    }
  }
  return undefined;
};

const branchExists = async (repoDir: string, branch: string): Promise<boolean> => {
  try {
    await git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
};

// Where the agent's work started: the fork point between the branch it was
// given and the commit the run started from. Falls back to that commit when
// there's no common history.
const findBase = async (cwd: string, baseSha: string, tip: string): Promise<string> => {
  try {
    return (await git(cwd, ["merge-base", baseSha, tip])).trim();
  } catch {
    return baseSha;
  }
};

// --- Reading changes ---------------------------------------------------------

const DIFF_FLAGS = ["diff", "--no-color", "--no-ext-diff", "--find-renames", "--ignore-cr-at-eol"];

const listCommits = async (cwd: string, base: string, tip: string): Promise<CommitInfo[]> => {
  const output = await git(cwd, ["log", "--format=%H%x1f%s%x1f%an%x1f%aI", `${base}..${tip}`]);
  const commits: CommitInfo[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }

    const [sha = "", subject = "", author = "", date = ""] = line.split("\x1f");
    commits.push({ sha, subject, author, date });
  }
  return commits;
};

// Patches for files the agent created but hasn't committed. Plain `git diff`
// leaves them out, and staging them to include them would touch the agent's
// index.
const untrackedFilesPatch = async (worktree: string): Promise<string> => {
  const output = await git(worktree, ["ls-files", "--others", "--exclude-standard"]);
  const files = output.split(/\r?\n/).filter((file) => file.trim() !== "");
  const patches: string[] = [];

  for (const file of files.slice(0, MAX_UNTRACKED_FILES)) {
    patches.push(await gitAllowingDiffExit(worktree, [...DIFF_FLAGS, "--no-index", "--", "/dev/null", file]));
  }
  return patches.join("");
};

const capPatch = (patch: string): { patch: string; truncated: boolean } => {
  if (patch.length <= MAX_PATCH_BYTES) {
    return { patch, truncated: false };
  }
  return { patch: patch.slice(0, MAX_PATCH_BYTES), truncated: true };
};

const worktreeChanges = async (worktree: string, baseSha: string): Promise<AgentChanges> => {
  const base = await findBase(worktree, baseSha, "HEAD");
  const trackedPatch = await git(worktree, [...DIFF_FLAGS, base]);
  const newFilesPatch = await untrackedFilesPatch(worktree);
  const commits = await listCommits(worktree, base, "HEAD");

  return { source: "worktree", ...capPatch(trackedPatch + newFilesPatch), commits };
};

const branchChanges = async (repoDir: string, branch: string, baseSha: string): Promise<AgentChanges> => {
  const base = await findBase(repoDir, baseSha, branch);
  const patch = await git(repoDir, [...DIFF_FLAGS, base, branch]);
  const commits = await listCommits(repoDir, base, branch);

  return { source: "branch", ...capPatch(patch), commits };
};

// Everything the agent on `branch` has changed since `baseSha`.
export const getAgentChanges = async (repoDir: string, branch: string, baseSha: string): Promise<AgentChanges> => {
  const worktree = await findWorktree(repoDir, branch);
  if (worktree) {
    return worktreeChanges(worktree, baseSha);
  }

  if (await branchExists(repoDir, branch)) {
    return branchChanges(repoDir, branch, baseSha);
  }

  return { source: "none", patch: "", truncated: false, commits: [] };
};

export const currentHeadSha = async (repoDir: string): Promise<string> => {
  return (await git(repoDir, ["rev-parse", "HEAD"])).trim();
};

// The GitHub web URL for the repo, used to link issues and commits, e.g.
// "git@github.com:me/repo.git" -> "https://github.com/me/repo".
export const repoWebUrl = async (repoDir: string): Promise<string | undefined> => {
  let remote: string;
  try {
    remote = (await git(repoDir, ["remote", "get-url", "origin"])).trim();
  } catch {
    return undefined;
  }

  const match = /github\.com[:/](.+?)(\.git)?$/.exec(remote);
  if (!match) {
    return undefined;
  }
  return `https://github.com/${match[1]}`;
};
