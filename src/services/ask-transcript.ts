/**
 * The ask thread, on disk.
 *
 * `gm ask`'s REPL keeps its turns in a closure and replays them, because the
 * providers we call are one-shot. The picker's chat cannot: every question is
 * answered by a fresh detached worker that exits when it is done, so there is no
 * closure left to hold anything. **The transcript file IS the turn array**, and
 * `foldCompletedTurns` is what turns it back into one — `buildAskPrompt` never
 * learns the difference.
 *
 * An append-only JSONL *event* log, not a document, and three things force that:
 *
 * 1. **A question must land before its answer exists.** The echo of what you
 *    typed appears the instant you press enter, ~9–20s before there is an answer
 *    to pair it with. A turn record cannot be written until both halves exist.
 * 2. **Two writers.** `__ask-send` appends `meta`/`question`, the worker appends
 *    `chunk`/`end`. `O_APPEND` makes the offset update atomic, so ordering holds
 *    for whole records — and for nothing else.
 * 3. **The reader is unsynchronized.** The preview re-runs on every cursor move
 *    and takes no lock, so it must be able to parse a file that is being
 *    appended to right now.
 *
 * Which is why **gm must never truncate-and-rewrite a transcript**: a reader
 * would catch the file mid-rewrite and the pane would flash empty, or show the
 * previous answer. Appends are whole-line and ordered, so the only line a reader
 * can ever see torn is the last one — `parseTranscript` drops it and the next
 * refresh gets it. A dropped tail costs one repaint; a lock on the read path
 * would cost the whole format.
 */

import { spawn, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { AskProviderError } from "../core/errors.js";
import { askTranscriptDir, askTranscriptPath } from "../core/paths.js";
import type { AskEvent, AskTurn } from "../core/types.js";
import { ASK_TIMEOUT_MS } from "./ask.js";
import { isLockStale, LOCK_STALE_MS, type AutoSummarizeLock } from "./auto-summarize.js";
import { childEnv } from "./config.js";
import { runProviderCommand } from "./provider-process.js";

/**
 * How many prior turns a worker replays into the prompt.
 *
 * Every turn re-sends every earlier answer, so tokens grow quadratically and the
 * 300s timeout starts to bite exactly when the thread gets useful. A bare slice
 * of the most recent turns is the bound.
 *
 * Bounded at the fold, deliberately: `buildAskPrompt` is shared with bare
 * `gm ask`, which this design does not change.
 */
export const ASK_MAX_REPLAY_TURNS = 8;

/**
 * The in-flight heartbeat. The only timer in the design.
 *
 * The provider buffers — a 40-line request came back as one 111-byte write at
 * +3.32s — so nothing else fires for the whole think, and a pane that is silent
 * and static for 20s is indistinguishable from a wedged one. This is what makes
 * `thinking… 14s` tick. It exists only while a request is in flight; that is the
 * whole of the exception to "no idle polling".
 */
export const ASK_HEARTBEAT_MS = 1_000;

/**
 * Trailing-edge throttle on chunk-driven refreshes.
 *
 * Against `claude -p` this fires once, with the answer. It is throttled anyway
 * because `onChunk` is a tee: a provider that trickles would otherwise spawn one
 * preview process per chunk. fzf does not save us — measured on 0.74, 100
 * back-to-back `refresh-preview` POSTs ran a fast preview command 100 times. It
 * bounds concurrency, not spawn rate.
 */
export const REFRESH_INTERVAL_MS = 150;

/** How long a cancelled worker's group gets to die politely before SIGKILL. */
export const ASK_KILL_GRACE_MS = 250;

/**
 * A parsed transcript. `torn` is true when the final line failed to parse —
 * normal, not an error: the writer is appending as we read.
 */
export interface AskTranscript {
  events: AskEvent[];
  torn: boolean;
}

/** Same shape and same staleness predicate as the auto-summarize lock. */
export type AskLock = AutoSummarizeLock;

/** `<pid>-<rand8>`: the pid reaps, the random half keeps two pickers apart. */
export function newAskRunId(pid: number = process.pid): string {
  return `${pid}-${randomBytes(4).toString("hex")}`;
}

/** The transcript for a fresh run. Allocates a path and creates nothing. */
export function newAskTranscriptPath(): string {
  return askTranscriptPath(newAskRunId());
}

/** The run id a transcript path carries. Derived, so it is never stored twice. */
export function askRunIdOf(transcript: string): string {
  return basename(transcript, ".jsonl");
}

/**
 * Open a transcript for appending, creating it and its directory if needed.
 *
 * The fd is the caller's to close, and it is held for the life of the turn:
 * `openSync`/`writeSync` rather than a stream because `createWriteStream` can
 * defer its flush past the refresh POST, and with one paint per answer that is
 * not a frame of lag — it is the whole answer missing until something else
 * happens to repaint. **The bytes are on disk before the POST goes out.**
 */
export function openAskTranscript(transcript: string): number {
  mkdirSync(dirname(transcript), { recursive: true });
  return openSync(transcript, "a");
}

/** One record, one whole-line append. Synchronous — see `openAskTranscript`. */
export function appendAskEvent(fd: number, event: AskEvent): void {
  writeSync(fd, `${JSON.stringify(event)}\n`);
}

function isAskEvent(value: unknown): value is AskEvent {
  if (!value || typeof value !== "object") return false;
  const t = (value as { t?: unknown }).t;
  return t === "meta" || t === "question" || t === "chunk" || t === "end" || t === "aborted" || t === "error";
}

/**
 * Parse a transcript's text.
 *
 * Takes no lock and cannot fail. A half-written last line is the normal case,
 * not the error case — the reader is a preview re-running on a keystroke while
 * a worker appends a multi-KB answer. Whole-line appends mean only the last line
 * can ever be torn, so everything before it is still true.
 */
export function parseTranscript(text: string): AskTranscript {
  const lines = text.split("\n");
  const events: AskEvent[] = [];
  let torn = false;

  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Only the tail can be torn. A broken line anywhere else is a file we
      // don't understand, and skipping it beats guessing at it.
      if (index === lines.length - 1) torn = true;
      continue;
    }
    if (isAskEvent(parsed)) events.push(parsed);
  }

  return { events, torn };
}

/**
 * Read a transcript. A missing file is the empty state, not an error — it is
 * how "no conversation yet" costs no flag and no branch.
 */
export async function readAskTranscript(transcript: string): Promise<AskTranscript> {
  try {
    return parseTranscript(await readFile(transcript, "utf8"));
  } catch {
    return { events: [], torn: false };
  }
}

/** The seq the next question takes. Questions are the only thing that allocates one. */
export function nextSeq(events: readonly AskEvent[]): number {
  let max = 0;
  for (const event of events) {
    if (event.t === "question" && event.seq > max) max = event.seq;
  }
  return max + 1;
}

/**
 * The turn being answered right now, if any — a question with no `end`,
 * `aborted` or `error` against it. What `__ask-cancel` aborts, and what the pane
 * renders as `thinking… Ns`.
 */
export function inFlightSeq(events: readonly AskEvent[]): number | null {
  const settled = new Set<number>();
  let latest: number | null = null;

  for (const event of events) {
    if (event.t === "question") latest = latest === null ? event.seq : Math.max(latest, event.seq);
    if (event.t === "end" || event.t === "aborted" || event.t === "error") settled.add(event.seq);
  }
  return latest !== null && !settled.has(latest) ? latest : null;
}

/**
 * The conversation so far, as `buildAskPrompt` wants it.
 *
 * Two rules carry the weight:
 *
 * - **Keyed by `seq`, never file order.** Chunks are contiguous in practice
 *   because the lock guarantees one writer, but folding by position would make
 *   this function's correctness depend on a lock in another module.
 * - **A turn enters history only with an `end` record.** In-flight, aborted and
 *   errored turns are excluded, so an aborted question is dropped from the
 *   model's view entirely (the human still sees it in the pane). A half-written
 *   answer promoted to history is shown to the model as its own completed
 *   statement of fact, and it will build on a sentence that stops mid-clause.
 *   "The answer so far" and "the conversation so far" are different things.
 */
export function foldCompletedTurns(
  events: readonly AskEvent[],
  options: { maxTurns?: number } = {},
): AskTurn[] {
  const questions = new Map<number, string>();
  const chunks = new Map<number, string[]>();
  const ended = new Set<number>();

  for (const event of events) {
    switch (event.t) {
      case "question":
        questions.set(event.seq, event.text);
        break;
      case "chunk": {
        const existing = chunks.get(event.seq);
        if (existing) existing.push(event.text);
        else chunks.set(event.seq, [event.text]);
        break;
      }
      case "end":
        ended.add(event.seq);
        break;
      default:
        break;
    }
  }

  const turns: AskTurn[] = [];
  for (const seq of [...ended].sort((a, b) => a - b)) {
    const question = questions.get(seq);
    const answer = (chunks.get(seq) ?? []).join("").trim();
    if (question === undefined || answer === "") continue;
    turns.push({ question, answer });
  }

  const maxTurns = options.maxTurns ?? ASK_MAX_REPLAY_TURNS;
  return maxTurns >= 0 && turns.length > maxTurns ? turns.slice(-maxTurns) : turns;
}

/* ---------------------------------------------------------------- the lock */

/**
 * `transform` returns immediately, so nothing stops you pressing enter twice.
 *
 * Two workers interleaving chunks of different seqs is the one thing that makes
 * the fold ambiguous. With the lock the second enter appends nothing and
 * refreshes a pane that already says "still answering". A key that visibly does
 * nothing for a stated reason is fine; a key that silently corrupts the thread
 * is not.
 */
export function askLockPath(transcript: string): string {
  return `${transcript}.lock`;
}

/**
 * Where ctrl-o parks the browse query while ask mode owns fzf's query line.
 *
 * A sibling of the transcript rather than a state directory: it inherits the
 * `<pid>-<rand8>` uniqueness for free, so two concurrent pickers cannot collide,
 * and it falls into the cleanup and sweep paths that already exist with no new
 * concept to name.
 *
 * The picker spells this suffix a second time, because it may not import a
 * service and the path is baked into a shell binding. A drift between the two is
 * SILENT — esc restores an empty query and the browse filter is gone — so
 * tests/picker.test.ts pins them equal.
 */
export function askBrowseQueryPath(transcript: string): string {
  return `${transcript}.browseq`;
}

export async function readAskLock(transcript: string): Promise<AskLock | null> {
  try {
    const parsed = JSON.parse(await readFile(askLockPath(transcript), "utf8")) as AskLock;
    if (typeof parsed?.startedAt !== "string") return null;
    return { pid: Number(parsed.pid) || 0, startedAt: parsed.startedAt };
  } catch {
    return null; // No lock, or an unreadable one: treat as not held.
  }
}

async function createAskLockExclusive(transcript: string, lock: AskLock): Promise<boolean> {
  let handle;
  try {
    handle = await open(askLockPath(transcript), "wx");
  } catch {
    return false; // EEXIST: the other enter got there first.
  }
  try {
    await handle.writeFile(JSON.stringify(lock), "utf8");
    return true;
  } finally {
    await handle.close();
  }
}

/**
 * Take the turn lock, or report that a turn is already in flight.
 *
 * `pid: 0` until the worker exists — the same acquired-but-not-yet-spawned shape
 * `auto-summarize` uses, and the reason `isLockStale` ANDs liveness with age
 * rather than trusting a pid on its own. That AND is also the pid-reuse guard:
 * a recycled pid can only look alive, never young.
 */
export async function acquireAskLock(transcript: string, now: Date = new Date()): Promise<boolean> {
  mkdirSync(dirname(transcript), { recursive: true });
  const lock: AskLock = { pid: 0, startedAt: now.toISOString() };

  if (await createAskLockExclusive(transcript, lock)) return true;

  const existing = await readAskLock(transcript);
  if (existing && !isLockStale(existing, now)) return false;

  await rm(askLockPath(transcript), { force: true });
  return createAskLockExclusive(transcript, lock);
}

/** Record the worker that now owns the turn. `__ask-cancel` kills this pid's group. */
export async function writeAskLockPid(transcript: string, pid: number, now: Date = new Date()): Promise<void> {
  await writeFile(askLockPath(transcript), JSON.stringify({ pid, startedAt: now.toISOString() }), "utf8");
}

export async function releaseAskLock(transcript: string): Promise<void> {
  await rm(askLockPath(transcript), { force: true });
}

/* --------------------------------------------------------------- the sweep */

function processAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Every run with a file in the directory, however far its picker got.
 *
 * Keyed on the RUN, not on the transcript: `ctrl-o` writes `.browseq` before a
 * question exists, so a picker killed between `ctrl-o` and `enter` leaves a
 * `.browseq` with no `.jsonl` beside it. Keying the sweep on `.jsonl` — the file
 * that happens to be reaped first — made that one unreapable forever, and a
 * cache that only ever grows is the bug the sweep exists to prevent.
 */
function askRunIds(entries: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const entry of entries) {
    const base = entry.replace(/\.(browseq|lock)$/, "");
    if (base.endsWith(".jsonl")) ids.add(basename(base, ".jsonl"));
  }
  return [...ids];
}

/** The newest mtime among a run's files, or null when none of them exist. */
async function newestMtime(paths: readonly string[]): Promise<number | null> {
  let newest: number | null = null;
  for (const path of paths) {
    try {
      const at = (await stat(path)).mtime.getTime();
      if (newest === null || at > newest) newest = at;
    } catch {
      // Not every member of a run exists — that is the normal case, not an error.
    }
  }
  return newest;
}

/**
 * Reap the files left behind by pickers that died without cleaning up.
 *
 * Normal exit is `pick.ts`'s `onClose`; this is the `kill -9` path. **A run
 * whose owning pid is alive is never removed** — that is another picker's live
 * thread, and deleting it would empty a pane someone is reading.
 *
 * The spec also says "or the mtime is older than LOCK_STALE_MS", on the grounds
 * that a live worker's file cannot be 10 minutes idle. That reasoning does not
 * survive the filename: the pid is the *picker's*, not the worker's, and a
 * picker left open for an hour after one question is entirely ordinary. So age
 * alone reaps only a run we cannot attribute to a pid at all.
 *
 * Never throws, and never able to fail the picker: an orphan is a few KB of
 * disposable cache, so the cost of not reaping is nil and the cost of a sweep
 * that throws is a picker that will not open.
 */
export async function sweepAskTranscripts(
  now: Date = new Date(),
  staleMs: number = LOCK_STALE_MS,
): Promise<string[]> {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(askTranscriptDir());
  } catch {
    return removed; // No directory: nobody has ever asked. Nothing to sweep.
  }

  for (const runId of askRunIds(entries)) {
    const transcript = askTranscriptPath(runId);
    const members = [transcript, askLockPath(transcript), askBrowseQueryPath(transcript)];
    try {
      const pid = Number.parseInt(runId.split("-")[0] ?? "", 10);
      if (Number.isFinite(pid) && processAlive(pid)) continue;
      if (!Number.isFinite(pid)) {
        const mtime = await newestMtime(members);
        if (mtime === null || now.getTime() - mtime <= staleMs) continue;
      }
      for (const member of members) await rm(member, { force: true });
      removed.push(transcript);
    } catch {
      // One unreadable entry must not cost the others their sweep.
    }
  }
  return removed;
}

/* --------------------------------------------------------- the worker spawn */

/**
 * How `__ask-send` forks the worker. Pure, so the decision is testable without
 * spawning anything — the same seam `maybeAutoSummarize`'s `spawnWorker` has.
 *
 * `detached` is not a nicety twice over: it lets the sender exit at once, and it
 * makes the worker a process-group leader, which is the only thing that lets
 * `__ask-cancel` reap the provider underneath it. `spawn` does not kill its
 * child on POSIX, so a worker that merely exits leaves `claude -p` running and
 * billing. (`setsid` does not exist on macOS — gm's own platform — so Node's
 * `detached: true` is the portable equivalent; it calls `setsid(2)`.)
 *
 * `childEnv()`, not `process.env`: the worker is a `gm` that is about to make a
 * model call, which is the definition of a child — its provider may shell back
 * into `gm grep`, and that nested `gm` must not start a summarize pass. The fzf
 * api key rides here by inheritance and nowhere else; it must never reach an
 * argv, where `ps` would hand it to any user on the box.
 */
export function askChildSpawnOptions(env: NodeJS.ProcessEnv = process.env): SpawnOptions {
  return {
    detached: true,
    stdio: "ignore",
    // Belt and braces on top of GIGAMANAGE_CHILD: the worker must never
    // summarize, or every answer would fork a summarize pass from inside fzf.
    env: { ...childEnv(env), GIGAMANAGE_AUTO_SUMMARIZE: "0" },
  };
}

/**
 * Re-enter this same CLI, detached, on a hidden command.
 *
 * `execArgv` is forwarded for the reason picker.ts already documents once: under
 * `npm run dev` the entry is `src/cli/main.ts` and `execArgv` carries tsx's
 * loader flags. Drop them and the command is `node src/cli/main.ts`, which Node
 * 20 cannot run — so in development every answer silently never arrives, with
 * `stdio: "ignore"` swallowing the evidence.
 */
export function spawnAskWorker(args: readonly string[]): number | undefined {
  const entry = process.argv[1];
  if (!entry) return undefined;

  const child = spawn(process.execPath, [...process.execArgv, entry, ...args], askChildSpawnOptions());
  child.unref();
  return child.pid;
}

/* ------------------------------------------------------------ one live turn */

/** Throttle state. `lastAt` is null before the first refresh; `final` bypasses the interval. */
export interface RefreshState {
  lastAt: number | null;
  pending: boolean;
  final: boolean;
}

/** The throttle policy, as a function of state, so it is testable without a socket. */
export function shouldRefresh(state: RefreshState, now: number): boolean {
  if (state.final) return true;
  if (!state.pending) return false;
  if (state.lastAt === null) return true;
  return now - state.lastAt >= REFRESH_INTERVAL_MS;
}

export interface StreamAnswerOptions {
  /** The provider's argv. The fake-binary seam: tests pass a `node -e` here. */
  argv: readonly string[];
  prompt: string;
  /** Open for append, owned by the caller, closed by the caller. */
  transcriptFd: number;
  seq: number;
  /** Injected, so the write-then-notify order is testable without a port. */
  notify: () => void;
  signal: AbortSignal;
  timeoutMs?: number;
}

/**
 * Run one turn: call the provider, append what it says, tell fzf to repaint.
 *
 * **Write, then notify.** Notify-then-write renders the previous chunk, forever
 * one behind — and with a provider that buffers, "one behind" means an empty
 * pane until something else repaints it.
 *
 * **No `env` is passed to `runProviderCommand`, and that is load-bearing.** It
 * defaults to `childEnv()`, which is what stops the provider's `gm grep` from
 * starting a summarize pass. A well-meant `env: { ...process.env, FZF_PORT }`
 * here would silently drop `GIGAMANAGE_CHILD` and reopen the loop — which is why
 * the port travels on the worker's argv instead, where the trap cannot be set.
 *
 * **The canceller owns the `aborted` record, not us.** On abort we write nothing
 * and return: a wedged worker must not be able to leave the pane stuck on
 * "answering", and only the process that knows the kill happened can be sure.
 */
export async function streamAnswer(options: StreamAnswerOptions): Promise<void> {
  const { transcriptFd: fd, seq, notify, signal } = options;
  const state: RefreshState = { lastAt: null, pending: false, final: false };
  let trailing: NodeJS.Timeout | null = null;

  const flush = (): void => {
    state.pending = false;
    state.lastAt = Date.now();
    notify();
  };

  const onChunk = (text: string): void => {
    appendAskEvent(fd, { t: "chunk", seq, text });
    state.pending = true;
    if (shouldRefresh(state, Date.now())) {
      flush();
      return;
    }
    // Trailing edge: the last chunk of a burst must still land, and the final
    // refresh below covers the case where the burst ends the turn.
    if (!trailing) {
      trailing = setTimeout(() => {
        trailing = null;
        if (state.pending) flush();
      }, REFRESH_INTERVAL_MS);
    }
  };

  try {
    const output = await runProviderCommand(options.argv, options.prompt, {
      timeoutMs: options.timeoutMs ?? ASK_TIMEOUT_MS,
      onChunk,
      signal,
    });
    if (signal.aborted) return;
    // The resolved string is every byte `onChunk` was handed, in order, so the
    // chunks on disk are already the whole answer — this only judges it.
    if (output.trim() === "") throw new Error("reply was empty");
    appendAskEvent(fd, { t: "end", seq, at: new Date().toISOString() });
  } catch (error) {
    if (signal.aborted) return;
    // fzf owns the terminal, so this error cannot be printed at anyone. It goes
    // where the answer would have gone, carrying its fix — non-negotiable #5
    // does not stop applying because the surface is a pane.
    const failed = new AskProviderError(options.argv.join(" "), (error as Error).message);
    appendAskEvent(fd, {
      t: "error",
      seq,
      at: new Date().toISOString(),
      message: failed.fix ? `${failed.message}\n${failed.fix}` : failed.message,
    });
  } finally {
    if (trailing) clearTimeout(trailing);
    if (!signal.aborted) {
      // One final unthrottled refresh, so the answer cannot be stranded behind
      // the throttle or the cancelled heartbeat.
      state.final = true;
      if (shouldRefresh(state, Date.now())) flush();
    }
  }
}

/** Close a transcript fd. Always from a `finally` — the fd lives for the turn. */
export function closeAskTranscript(fd: number): void {
  closeSync(fd);
}
