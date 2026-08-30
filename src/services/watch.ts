/**
 * The lifecycle of gigamanage's background agent — the `gm watch` service that
 * keeps pane labels and summaries current.
 *
 * A single global instance, tracked by a PID file, in the same spirit as the
 * auto-summarize lock: starting when one is already alive is a no-op; a stale PID
 * (dead owner) is reclaimed. The loop itself lives in `cli` (it paints labels, a
 * cli concern); this module owns only the start/stop/liveness plumbing so the
 * layer rule holds.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { cacheDir } from "../core/paths.js";

/** The hidden CLI command the detached worker runs. */
export const WATCH_WORKER_COMMAND = "__watch";

/** How often the watch loop repaints labels and re-checks divergence. */
export const WATCH_INTERVAL_MS = Number(process.env.GIGAMANAGE_WATCH_INTERVAL_MS) || 3000;

export function watchPidPath(): string {
  return join(cacheDir(), "watch.pid");
}

export interface WatchPid {
  pid: number;
  startedAt: string;
}

export async function readWatchPid(): Promise<WatchPid | null> {
  try {
    const parsed = JSON.parse(await readFile(watchPidPath(), "utf8")) as WatchPid;
    return typeof parsed?.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Is this recorded watcher actually running? */
export function isWatchAlive(record: WatchPid | null): boolean {
  return record !== null && processAlive(record.pid);
}

export async function writeWatchPid(pid: number, now: Date = new Date()): Promise<void> {
  await mkdir(cacheDir(), { recursive: true });
  await writeFile(watchPidPath(), JSON.stringify({ pid, startedAt: now.toISOString() }), "utf8");
}

export async function clearWatchPid(): Promise<void> {
  await rm(watchPidPath(), { force: true });
}

/**
 * Re-run this same CLI, detached, on the hidden watch worker command. Detached +
 * ignored stdio + unref lets the toggle return at once while the loop lives on.
 * `execArgv` is forwarded so it works under `tsx` as well as the built entry.
 */
export function spawnWatchWorker(): number | undefined {
  const entry = process.argv[1];
  if (!entry) return undefined;
  const child = spawn(process.execPath, [...process.execArgv, entry, WATCH_WORKER_COMMAND], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid;
}

export type StartWatchResult = "started" | "already-running" | "failed";

/** Start the watcher if one isn't already alive. Idempotent. */
export async function startWatch(
  now: Date = new Date(),
  spawnWorker: () => number | undefined = spawnWatchWorker,
): Promise<StartWatchResult> {
  if (isWatchAlive(await readWatchPid())) return "already-running";
  await clearWatchPid(); // reclaim a stale record
  const pid = spawnWorker();
  if (pid === undefined) return "failed";
  await writeWatchPid(pid, now);
  return "started";
}

/** Stop the watcher. Returns whether a live one was signalled. */
export async function stopWatch(): Promise<boolean> {
  const record = await readWatchPid();
  await clearWatchPid(); // the loop also watches for this and exits
  if (isWatchAlive(record)) {
    try {
      process.kill(record!.pid, "SIGTERM");
    } catch {
      // Already gone between the liveness check and the signal.
    }
    return true;
  }
  return false;
}

export async function isWatchRunning(): Promise<boolean> {
  return isWatchAlive(await readWatchPid());
}
