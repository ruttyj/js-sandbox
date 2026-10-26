// An append-only event store, optionally mirrored to a JSONL journal so a run
// can be replayed in the dashboard after it has finished.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DashboardEvent, DashboardEventBody } from "./events.ts";

type Listener = (event: DashboardEvent) => void;

export class EventStore {
  readonly events: DashboardEvent[] = [];
  private readonly listeners = new Set<Listener>();

  // journalPath: where each event is appended as one JSON line, or undefined
  // to keep events in memory only (replay).
  constructor(private readonly journalPath?: string) {
    if (journalPath) {
      mkdirSync(dirname(journalPath), { recursive: true });
    }
  }

  append(body: DashboardEventBody): DashboardEvent {
    const event = { ...body, seq: this.events.length + 1, time: new Date().toISOString() } as DashboardEvent;
    this.events.push(event);

    if (this.journalPath) {
      appendFileSync(this.journalPath, JSON.stringify(event) + "\n");
    }

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken dashboard connection must never take down the run.
      }
    }
    return event;
  }

  // Returns a function that removes the listener.
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Loads a journal written by a previous run. Malformed lines (a run killed
  // mid-write) are skipped.
  static fromJournal(path: string): EventStore {
    const store = new EventStore();
    const lines = readFileSync(path, "utf8").split("\n");

    for (const line of lines) {
      if (line.trim() === "") {
        continue;
      }

      try {
        store.events.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    return store;
  }
}
