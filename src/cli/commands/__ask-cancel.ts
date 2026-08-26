/**
 * `gm __ask-cancel` — what esc does mid-answer.
 *
 * **It kills the process GROUP, and that is the whole point of this command.**
 * Measured, and it is where the prototype actually broke: `kill -TERM <worker>`
 * leaves the provider ORPHANED AND ALIVE — still running, still billing, still
 * writing into a transcript nobody is reading — while the picker cheerfully
 * flips back to browse mode. `kill -TERM -- -<worker>` reaps the tree, which is
 * why the worker is spawned `detached` and is therefore its own group leader.
 *
 * **The canceller writes the `aborted` record, not the worker.** A worker wedged
 * badly enough to need a SIGKILL is a worker that cannot write anything, and a
 * pane stuck on "answering" forever is a worse failure than the one we started
 * with. Whoever knows the kill happened owns the record.
 */

import type { Command } from "commander";

import {
  ASK_KILL_GRACE_MS,
  appendAskEvent,
  closeAskTranscript,
  inFlightSeq,
  openAskTranscript,
  readAskLock,
  readAskTranscript,
  releaseAskLock,
} from "../../services/ask-transcript.js";
import { isLockStale } from "../../services/auto-summarize.js";
import { refreshNotifier } from "./__ask-refresh.js";

/** The hidden command fzf's `esc` binding runs in ask mode. */
export const ASK_CANCEL_COMMAND = "__ask-cancel";

export interface AskCancelOptions {
  transcript: string;
  port?: string;
  now?: Date;
  /** Injected in tests, so no test signals a real process group. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  graceMs?: number;
}

export type AskCancelStatus = "cancelled" | "idle";

function groupKill(pid: number, signal: NodeJS.Signals): void {
  // Negative pid: the group, not the process. The worker is a group leader
  // because it was spawned detached; a plain pid here would orphan the provider.
  process.kill(-pid, signal);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stop whatever turn is in flight, if any.
 *
 * Never throws. esc is also how you leave ask mode, so a cancel with nothing to
 * cancel is the ordinary case and must be silent and cheap.
 */
export async function cancelAskTurn(options: AskCancelOptions): Promise<AskCancelStatus> {
  const notify = refreshNotifier(options.port);
  const now = options.now ?? new Date();
  const kill = options.kill ?? groupKill;

  const lock = await readAskLock(options.transcript);
  // A stale lock's pid is either dead or recycled into some innocent process —
  // liveness ANDed with age is what stops us signalling a stranger.
  const live = lock !== null && lock.pid > 0 && !isLockStale(lock, now);

  if (live && lock) {
    try {
      kill(lock.pid, "SIGTERM");
      await sleep(options.graceMs ?? ASK_KILL_GRACE_MS);
      if (alive(lock.pid)) kill(lock.pid, "SIGKILL");
    } catch {
      // ESRCH: it finished on its own between our read and our signal. The
      // `aborted` record below is still the honest thing to write — the user
      // pressed esc, and a race must not resurrect the answer in the pane.
    }
  }

  const { events } = await readAskTranscript(options.transcript);
  const seq = inFlightSeq(events);
  if (seq === null) {
    await releaseAskLock(options.transcript);
    notify();
    return "idle";
  }

  const fd = openAskTranscript(options.transcript);
  try {
    appendAskEvent(fd, { t: "aborted", seq, at: now.toISOString() });
  } finally {
    closeAskTranscript(fd);
  }
  await releaseAskLock(options.transcript);
  notify();
  return "cancelled";
}

export function registerAskCancel(program: Command): void {
  program
    .command(ASK_CANCEL_COMMAND, { hidden: true })
    .description("internal: cancel the in-flight answer (run by the picker's esc binding)")
    .requiredOption("--transcript <path>", "the picker's chat transcript")
    .option("--port <port>", "fzf's listen port, for the repaint")
    .action(async (options: AskCancelOptions) => {
      await cancelAskTurn(options);
    });
}
