/**
 * Auto-summarize: keep the top of `gm ls` written, without ever making you wait.
 *
 * A summary costs a model call (~8s). Ten of them, inline, would turn a 60ms
 * `gm ls` into a minute of staring at a cursor — so the foreground command never
 * runs one. Instead it decides *what* would need summarizing, hands that job to
 * a DETACHED child process, prints a one-line notice to stderr and exits. The
 * summaries land in the cache and appear on the next run.
 *
 * Three things this module exists to prevent:
 *
 * 1. **Blocking.** The child is spawned `detached` with `stdio: "ignore"` and
 *    unref'd, so it outlives its parent and the parent's event loop drains
 *    immediately. Nothing is awaited.
 *
 * 2. **A stampede.** Five `gm ls` in a row must not start five summarizers doing
 *    identical work. A lock file in the cache dir is created with O_EXCL before
 *    spawning; a lock whose owner is dead — or older than LOCK_STALE_MS — is
 *    taken over. A short cooldown stops us re-deciding on every invocation.
 *
 * 3. **A feedback loop.** The provider is `claude -p`, which itself writes a new
 *    Claude Code session to disk. If those were eligible targets, gigamanage
 *    would summarize its own summarizer forever. `automated` and `sidechain`
 *    sessions are therefore excluded from the target set — see
 *    `autoSummarizeCandidates`, which is where that guarantee lives.
 */

import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { cacheDir } from "../core/paths.js";
import type { SessionRecord, SummaryProvider } from "../core/types.js";
import { autoSummarizeAllowed, isChildProcess, readConfig } from "./config.js";
import {
  defaultSummaryProvider,
  readSummary,
  shouldRefresh,
  summarizeBatch,
  type SummarizeBatchResult,
} from "./summarize.js";
import { loadRecords } from "./views.js";

/**
 * How many recent sessions the background pass keeps summarized.
 *
 * This MUST be at least as large as `gm ls`'s default limit, or the bottom of
 * the default view is permanently `○` and the feature looks broken — which is
 * exactly what happened when this was 10 and `gm ls` showed 20.
 *
 * Override with `GIGAMANAGE_AUTO_SUMMARIZE=<n>`.
 */
export const AUTO_SUMMARIZE_LIMIT = 20;

/**
 * Hard ceiling on one background pass.
 *
 * `gm ls -n 500` should not fire 500 model calls. Anything beyond this is left
 * for the next run, and we say so rather than truncating silently.
 */
export const MAX_PER_PASS = 50;

/** A lock older than this belongs to a process that died without cleaning up. */
export const LOCK_STALE_MS = 10 * 60_000;

/** Don't re-decide on every invocation; `gm ls` in a loop should cost nothing. */
export const COOLDOWN_MS = 60_000;

/** The hidden CLI command the detached worker runs. It never auto-summarizes itself. */
export const AUTO_SUMMARIZE_COMMAND = "__auto-summarize";

export function lockPath(): string {
  return join(cacheDir(), "auto-summarize.lock");
}

export function statePath(): string {
  return join(cacheDir(), "auto-summarize.state.json");
}

/** The sessions the running worker is writing right now. Drives the `◐` marker. */
export function queuePath(): string {
  return join(cacheDir(), "auto-summarize.queue.json");
}

/** Where a failing background pass leaves its evidence. */
export function logPath(): string {
  return join(cacheDir(), "auto-summarize.log");
}

/**
 * Off via `GIGAMANAGE_AUTO_SUMMARIZE=0`.
 *
 * Background model calls spend tokens. A user who has not opted into that must
 * be able to say no once, in their shell profile, and be done with it.
 */
export function autoSummarizeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["GIGAMANAGE_AUTO_SUMMARIZE"];
  if (raw == null || raw.trim() === "") return true;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

/**
 * Every reason the background pass might be off, in one place.
 *
 * Three independent "no"s, and any of them is final:
 *
 * - the env var — a shell-profile opt-out
 * - the config — what the user answered in `gm setup`
 * - GIGAMANAGE_CHILD — we are a `gm` spawned by our own provider
 *
 * The last is the one that isn't obvious. `gm ask`'s provider may run `gm grep`,
 * whose postAction hook would start a summarize pass — a model call spawned by a
 * model call. The lock would absorb most of the damage; this makes it a
 * non-question.
 */
export async function autoSummarizeAllowedNow(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!autoSummarizeEnabled(env)) return false;
  if (isChildProcess(env)) return false;
  return autoSummarizeAllowed(await readConfig());
}

export interface AutoSummarizeLock {
  /** Pid of the worker. 0 when the lock is taken but the child is not spawned yet. */
  pid: number;
  startedAt: string;
}

function processAlive(pid: number): boolean {
  if (pid <= 0) return true; // Acquired-but-not-yet-spawned: trust the timestamp.
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lock is stale when its owner is gone, or when it is simply too old. */
export function isLockStale(
  lock: AutoSummarizeLock,
  now: Date = new Date(),
  staleMs: number = LOCK_STALE_MS,
): boolean {
  const started = Date.parse(lock.startedAt);
  if (Number.isNaN(started)) return true;
  if (now.getTime() - started > staleMs) return true;
  return !processAlive(lock.pid);
}

export async function readLock(): Promise<AutoSummarizeLock | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath(), "utf8")) as AutoSummarizeLock;
    if (typeof parsed?.startedAt !== "string") return null;
    return { pid: Number(parsed.pid) || 0, startedAt: parsed.startedAt };
  } catch {
    return null; // No lock, or an unreadable one: treat as not held.
  }
}

async function writeLock(lock: AutoSummarizeLock): Promise<void> {
  await writeFile(lockPath(), JSON.stringify(lock), "utf8");
}

async function createLockExclusive(lock: AutoSummarizeLock): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockPath(), "wx");
  } catch {
    return false; // EEXIST: someone else got there first.
  }
  try {
    await handle.writeFile(JSON.stringify(lock), "utf8");
    return true;
  } finally {
    await handle.close();
  }
}

/**
 * Take the lock, or report that someone else holds it.
 *
 * The create is O_EXCL, so two `gm` processes racing cannot both win. A stale
 * lock is removed and re-created rather than overwritten, so the takeover is
 * itself a race whose loser backs off instead of double-spawning.
 */
export async function acquireLock(now: Date = new Date()): Promise<boolean> {
  await mkdir(cacheDir(), { recursive: true });
  const lock: AutoSummarizeLock = { pid: 0, startedAt: now.toISOString() };

  if (await createLockExclusive(lock)) return true;

  const existing = await readLock();
  if (existing && !isLockStale(existing, now)) return false;

  await rm(lockPath(), { force: true });
  return createLockExclusive(lock);
}

export async function releaseLock(): Promise<void> {
  await rm(lockPath(), { force: true });
}

/** Record that we just decided; suppresses the next COOLDOWN_MS worth of checks. */
export async function noteCheck(now: Date = new Date()): Promise<void> {
  await mkdir(cacheDir(), { recursive: true });
  await writeFile(statePath(), JSON.stringify({ lastCheckAt: now.toISOString() }), "utf8");
}

export async function inCooldown(now: Date = new Date(), cooldownMs = COOLDOWN_MS): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(statePath(), "utf8")) as { lastCheckAt?: string };
    const last = Date.parse(parsed.lastCheckAt ?? "");
    if (Number.isNaN(last)) return false;
    return now.getTime() - last < cooldownMs;
  } catch {
    return false;
  }
}

export interface AutoSummarizeQueue {
  ids: string[];
  startedAt: string;
}

/** Publish what the worker is about to write, so the list can mark those rows `◐`. */
export async function writeQueue(ids: readonly string[], now: Date = new Date()): Promise<void> {
  await mkdir(cacheDir(), { recursive: true });
  const queue: AutoSummarizeQueue = { ids: [...ids], startedAt: now.toISOString() };
  await writeFile(queuePath(), JSON.stringify(queue), "utf8");
}

export async function readQueue(): Promise<AutoSummarizeQueue | null> {
  try {
    const parsed = JSON.parse(await readFile(queuePath(), "utf8")) as AutoSummarizeQueue;
    return Array.isArray(parsed?.ids) ? parsed : null;
  } catch {
    return null;
  }
}

export async function clearQueue(): Promise<void> {
  await rm(queuePath(), { force: true });
}

/**
 * Sessions being summarized *right now*, for the `◐` marker.
 *
 * Guarded by the lock: a queue left behind by a crashed worker would otherwise
 * mark rows as in-progress forever. No live lock, no in-progress rows.
 */
export async function inProgressIds(now: Date = new Date()): Promise<Set<string>> {
  const lock = await readLock();
  if (!lock || isLockStale(lock, now)) return new Set();
  const queue = await readQueue();
  return new Set(queue?.ids ?? []);
}

/**
 * The sessions the background pass is allowed to touch.
 *
 * THE FEEDBACK-LOOP GUARD. `claude -p` — our own summary provider — writes a
 * Claude Code session for every summary it produces, flagged `isAutomated`.
 * Summarizing those would generate more of them, forever, at real token cost.
 * Sidechains are excluded for the same reason plus a better one: nobody resumes
 * a subagent transcript.
 *
 * Pure. This is the function the anti-loop test pins.
 */
export function autoSummarizeCandidates(
  records: readonly SessionRecord[],
  limit: number = AUTO_SUMMARIZE_LIMIT,
): SessionRecord[] {
  return [...records]
    .filter((record) => !record.isAutomated && !record.isSidechain)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

/**
 * Of the recent, eligible sessions, the ones whose summary is missing or stale.
 *
 * Reads the summary cache but calls no model, so tests exercise it for real.
 */
export async function selectAutoSummarizeTargets(
  records: readonly SessionRecord[],
  limit: number = AUTO_SUMMARIZE_LIMIT,
): Promise<SessionRecord[]> {
  const candidates = autoSummarizeCandidates(records, limit);
  const needed = await Promise.all(
    candidates.map(async (record) => shouldRefresh(await readSummary(record), record)),
  );
  return candidates.filter((_, index) => needed[index] === true);
}

export type AutoSummarizeStatus =
  | "spawned"
  | "disabled"
  | "no-provider"
  | "locked"
  | "cooling-down"
  | "nothing-to-do"
  | "spawn-failed";

export interface AutoSummarizeOutcome {
  status: AutoSummarizeStatus;
  /** How many sessions the worker was asked to write. */
  targets: number;
  /** Their ids — the caller renders these as `◐` on this very run. */
  targetIds: string[];
}

export interface MaybeAutoSummarizeOptions {
  /**
   * The sessions the command just displayed.
   *
   * Passing these is what makes `gm ls -n 50` summarize all fifty: the window
   * follows what you actually looked at, rather than a fixed top-N that leaves
   * the bottom of your screen permanently un-summarized.
   */
  records?: readonly SessionRecord[];
  /** False when `--no-auto-summarize` was passed. */
  enabled?: boolean;
  /**
   * Skip the cooldown — and only the cooldown.
   *
   * Set when the user explicitly asked for a refresh (ctrl-r in the picker).
   * The cooldown guards against *incidental* re-decisions, like `gm ls` in a
   * loop; a keypress is not incidental, and a key that silently does nothing
   * for its first minute reads as broken.
   *
   * The lock still applies, so hammering the key cannot start two workers, and
   * `GIGAMANAGE_AUTO_SUMMARIZE=0` still wins: force overrides our own
   * optimisation, never the user's opt-out.
   */
  force?: boolean;
  now?: Date;
  /** Injected in tests. Never a real model. */
  provider?: SummaryProvider;
  /** Injected in tests, so no test ever spawns anything. Returns the child pid. */
  spawnWorker?: () => number | undefined;
  /** Where the notice goes. STDERR — stdout must stay clean for `--json` and pipes. */
  notify?: (message: string) => void;
}

/**
 * Decide whether to kick off a background summarize pass, and if so, do it.
 *
 * Never throws and never blocks on a model: every failure path is a silent skip.
 * A read command must not die because `claude` is missing or a cache file is odd.
 */
export async function maybeAutoSummarize(
  options: MaybeAutoSummarizeOptions = {},
): Promise<AutoSummarizeOutcome> {
  try {
    return await decide(options);
  } catch {
    return { status: "spawn-failed", targets: 0, targetIds: [] };
  }
}

async function decide(options: MaybeAutoSummarizeOptions): Promise<AutoSummarizeOutcome> {
  const now = options.now ?? new Date();
  const none = (status: AutoSummarizeStatus): AutoSummarizeOutcome => ({
    status,
    targets: 0,
    targetIds: [],
  });

  if (options.enabled === false || !(await autoSummarizeAllowedNow())) return none("disabled");

  // Cheapest checks first: two small file reads keep a repeated `gm ls` free.
  if (options.force !== true && (await inCooldown(now))) return none("cooling-down");
  const held = await readLock();
  if (held && !isLockStale(held, now)) return none("locked");

  // A missing model is not an error — it just means no summaries today. Nor is
  // a null provider: that is `gm setup`'s "none" being honored.
  const provider = options.provider ?? (await defaultSummaryProvider());
  if (!provider || !(await provider.isAvailable())) return none("no-provider");

  // The window follows what was displayed. With nothing passed (e.g. `gm show`),
  // fall back to the default recent window.
  const records = options.records ?? (await loadRecords({ limit: AUTO_SUMMARIZE_LIMIT }));
  const limit = Math.max(AUTO_SUMMARIZE_LIMIT, records.length);
  const all = await selectAutoSummarizeTargets(records, limit);
  if (all.length === 0) {
    await noteCheck(now);
    return none("nothing-to-do");
  }

  // Bounded, and never silently: a dropped tail gets picked up next run.
  const targets = all.slice(0, MAX_PER_PASS);
  const deferred = all.length - targets.length;

  if (!(await acquireLock(now))) return none("locked");
  await noteCheck(now);
  await writeQueue(targets.map((r) => r.sessionId), now);

  let pid: number | undefined;
  try {
    pid = (options.spawnWorker ?? spawnWorker)();
  } catch {
    pid = undefined;
  }
  if (pid === undefined) {
    await releaseLock();
    await clearQueue();
    return none("spawn-failed");
  }
  await writeLock({ pid, startedAt: now.toISOString() });

  const plural = targets.length === 1 ? "" : "s";
  const tail = deferred > 0 ? ` (${deferred} more will follow on the next run)` : "";
  options.notify?.(
    `summarizing ${targets.length} session${plural} in the background${tail} — marked \u25d0 below`,
  );
  return { status: "spawned", targets: targets.length, targetIds: targets.map((r) => r.sessionId) };
}

/**
 * Re-run this same CLI, detached, on the hidden worker command.
 *
 * `detached` + `stdio: "ignore"` + `unref()` is the combination that lets the
 * parent exit at once: detached gives the child its own process group so it
 * survives the shell reaping the foreground job, ignoring stdio stops it holding
 * the terminal (or a pipe) open, and unref drops it from the parent's event loop.
 *
 * `execArgv` is forwarded so this works under `tsx` (`npm run dev`) as well as
 * from the built `dist/cli/main.js`.
 */
function spawnWorker(): number | undefined {
  const entry = process.argv[1];
  if (!entry) return undefined;

  const child = spawn(process.execPath, [...process.execArgv, entry, AUTO_SUMMARIZE_COMMAND], {
    detached: true,
    stdio: "ignore",
    // Belt and braces: the worker must never auto-summarize, or it would spawn a
    // grandchild for every summary it writes.
    env: { ...process.env, GIGAMANAGE_AUTO_SUMMARIZE: "0" },
  });
  child.unref();
  return child.pid;
}

/**
 * The worker body. Runs in the detached child, holding the lock its parent took.
 *
 * Re-selects its own targets rather than trusting a list handed down an argv: by
 * the time it starts, the parent's view of the store is already stale.
 */
export async function runAutoSummarize(provider: SummaryProvider): Promise<SummarizeBatchResult> {
  try {
    // Work the queue its parent published, so `gm ls -n 50` really does get all
    // fifty — not just whatever the default window happens to be.
    const queue = await readQueue();
    const wanted = new Set(queue?.ids ?? []);

    // Look up the queued ids across the WHOLE store, with no limit.
    //
    // Do not "load the N most recent and filter" — the queue holds human
    // sessions, while the most recent N of everything is mostly subagent
    // transcripts, so the filter matches nothing and the pass silently writes
    // zero summaries. (It did exactly that, once.)
    const records = await loadRecords(
      wanted.size > 0 ? { includeSidechains: true, includeAutomated: true } : { limit: AUTO_SUMMARIZE_LIMIT },
    );

    const targets =
      wanted.size > 0
        ? // Re-filter through the guard: a queued id can never smuggle an
          // automated session past the feedback-loop check.
          autoSummarizeCandidates(
            records.filter((r) => wanted.has(r.sessionId)),
            wanted.size,
          )
        : await selectAutoSummarizeTargets(records);

    if (targets.length === 0) return { generated: 0, skipped: 0, failed: [] };

    const result = await summarizeBatch(targets, provider);
    if (result.failed.length > 0) await logFailures(result);
    return result;
  } catch (error) {
    await logLine(`pass failed: ${(error as Error).message}`);
    return { generated: 0, skipped: 0, failed: [] };
  } finally {
    await clearQueue();
    await releaseLock();
  }
}

/**
 * Leave evidence when a background pass fails.
 *
 * The worker's stdio is `ignore`d, so without this a broken provider is utterly
 * silent: summaries just never appear and there is nothing to look at. `gm doctor`
 * surfaces the last line of this file.
 */
async function logLine(message: string): Promise<void> {
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(logPath(), `${new Date().toISOString()}  ${message}\n`, { flag: "a" });
  } catch {
    // Logging must never be the thing that breaks the worker.
  }
}

async function logFailures(result: SummarizeBatchResult): Promise<void> {
  for (const failure of result.failed.slice(0, 5)) {
    await logLine(`${failure.sessionId.slice(0, 8)}: ${failure.reason}`);
  }
}

/** The most recent background failure, if any — surfaced by `gm doctor`. */
export async function lastAutoSummarizeError(): Promise<string | null> {
  try {
    const lines = (await readFile(logPath(), "utf8")).trim().split("\n").filter(Boolean);
    return lines.at(-1) ?? null;
  } catch {
    return null;
  }
}
