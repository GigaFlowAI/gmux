/**
 * The `gm daemon run` PID lockfile — extracted to its own leaf module (no
 * dependents within `cli/`) so `cli/tmux-label.ts` can detect a live daemon
 * without importing `cli/commands/daemon.ts` (which itself imports
 * `cli/tmux-label.ts` for `enableBorder`, and a cycle between the two is
 * fragile to depend on even where it happens to work).
 *
 * Same shape (`{ pid, startedAt }`) and staleness rule as
 * `services/auto-summarize.ts`'s lock: owner dead, or too old. It lives under
 * `daemonDir()` rather than `cacheDir()` directly because it is gm-specific
 * ephemeral state, not shared with the rest of gm.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { daemonDir } from "../core/paths.js";

/** A lock older than this belongs to a process that died without cleaning up. */
export const DAEMON_LOCK_STALE_MS = 10 * 60_000;

export interface DaemonLock {
  pid: number;
  startedAt: string;
}

export function daemonLockPath(): string {
  return join(daemonDir(), "daemon.lock");
}

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

/** A lock is stale when its owner is gone, or when it is simply too old. */
export function isDaemonLockStale(
  lock: DaemonLock,
  now: Date = new Date(),
  staleMs: number = DAEMON_LOCK_STALE_MS,
): boolean {
  const started = Date.parse(lock.startedAt);
  if (Number.isNaN(started)) return true;
  if (now.getTime() - started > staleMs) return true;
  return !processAlive(lock.pid);
}

/** Corrupt or missing lock reads as "not running" — never throws. */
export async function readDaemonLock(): Promise<DaemonLock | null> {
  try {
    const parsed = JSON.parse(await readFile(daemonLockPath(), "utf8")) as DaemonLock;
    if (typeof parsed?.startedAt !== "string") return null;
    const pid = Number(parsed.pid);
    if (!Number.isFinite(pid)) return null;
    return { pid, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

async function writeDaemonLock(lock: DaemonLock): Promise<void> {
  await mkdir(daemonDir(), { recursive: true });
  await writeFile(daemonLockPath(), JSON.stringify(lock), "utf8");
}

export async function releaseDaemonLock(): Promise<void> {
  await rm(daemonLockPath(), { force: true });
}

/**
 * Take the lock for this process, refusing if a live one already exists.
 *
 * Returns false — never throws — when another daemon is already running, so
 * callers can print a clear message and exit rather than crash.
 */
export async function acquireDaemonLock(now: Date = new Date()): Promise<boolean> {
  const existing = await readDaemonLock();
  if (existing && !isDaemonLockStale(existing, now)) return false;
  await writeDaemonLock({ pid: process.pid, startedAt: now.toISOString() });
  return true;
}
