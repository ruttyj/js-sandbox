// Follows a Sandcastle run's log file for lifecycle status: sandbox setup,
// hooks such as `npm ci`, commit collection. These only go to the log, not to
// the agent stream callback, and setup alone can take minutes, so without
// them an agent would look frozen.

import { closeSync, openSync, readSync, statSync } from "node:fs";

const POLL_INTERVAL_MS = 1000;

// The header Sandcastle writes at the start of every run. Skipped, except
// "  Branch: x", which is the only place a merger's branch is reported.
const HEADER_LINE = /^(--- Run started|Sandcastle Run$|  (Agent|Sandbox|Max iterations): )/;
const BRANCH_LINE = /^  Branch: (.+)$/;

export interface LogTailCallbacks {
  onStatus(text: string): void;
  onBranch(branch: string): void;
}

const fileSize = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

// Reads the bytes between `offset` and `end` as text.
const readFrom = (path: string, offset: number, end: number): string => {
  const buffer = Buffer.alloc(end - offset);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, offset);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
};

export class LogTail {
  private offset: number;
  private partialLine = "";
  // Between "Agent started" and "Agent stopped" the log holds the agent's own
  // text, which already reaches the dashboard through the stream callback.
  private insideAgentOutput = false;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly path: string,
    private readonly callbacks: LogTailCallbacks,
  ) {
    // Start from the current end: an existing log holds earlier runs.
    this.offset = fileSize(path);
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    this.poll();
  }

  private poll(): void {
    const size = fileSize(this.path);
    if (size <= this.offset) {
      return;
    }

    const text = this.partialLine + readFrom(this.path, this.offset, size);
    this.offset = size;

    const lines = text.split(/\r?\n/);
    this.partialLine = lines.pop() ?? "";
    for (const line of lines) {
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    if (line === "Agent started") {
      this.insideAgentOutput = true;
      this.callbacks.onStatus(line);
      return;
    }

    // The agent's last text chunk may not end in a newline, so the marker can
    // share a line with it.
    if (line.endsWith("Agent stopped")) {
      this.insideAgentOutput = false;
      this.callbacks.onStatus("Agent stopped");
      return;
    }

    if (this.insideAgentOutput || line.trim() === "") {
      return;
    }

    const branchMatch = BRANCH_LINE.exec(line);
    if (branchMatch) {
      this.callbacks.onBranch(branchMatch[1]!.trim());
      return;
    }

    if (HEADER_LINE.test(line)) {
      return;
    }

    this.callbacks.onStatus(line.trim());
  }
}
