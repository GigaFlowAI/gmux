/**
 * The narrow surface where gm shells out to `tmux`. The parsers are pure
 * (and tested); the two `run` wrappers are thin shells over documented tmux
 * flags, guarded at the edges by the `gm doctor` version check.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { TmuxPane } from "../core/types.js";

const run = promisify(execFile);

/**
 * Cap every tmux call on the daemon tick path. A wedged child (a hung tmux
 * server, a pane whose command blocks the socket) would otherwise stall the
 * tick forever — the daemon's try/catch handles rejections but not hangs.
 * `execFile`'s `timeout` kills the child and rejects, which the callers
 * already tolerate.
 */
const TMUX_TIMEOUT_MS = 5000;

/** Tab-separated so a cwd with spaces cannot be mis-split. */
export const PANE_FORMAT =
  "#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t" +
  "#{pane_current_path}\t#{pane_current_command}\t#{pane_pid}\t#{window_id}\t#{?pane_active,1,0}";

export function parsePaneLine(line: string): TmuxPane | null {
  const fields = line.split("\t");
  if (fields.length < 8) return null;
  const [paneId, left, top, width, height, cwd, command, pid] = fields;
  const nums = [left, top, width, height, pid].map((n) => Number(n));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const windowId = fields[8] && fields[8].length > 0 ? fields[8] : null;
  const active = fields[9] === "1";
  return {
    paneId: paneId!,
    left: nums[0]!,
    top: nums[1]!,
    width: nums[2]!,
    height: nums[3]!,
    cwd: cwd!,
    command: command!,
    pid: nums[4]!,
    windowId,
    active,
  };
}

export function parsePanes(output: string): TmuxPane[] {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map(parsePaneLine)
    .filter((pane): pane is TmuxPane => pane !== null);
}

export async function listPanes(windowId: string): Promise<TmuxPane[]> {
  const { stdout } = await run("tmux", ["list-panes", "-t", windowId, "-F", PANE_FORMAT], { timeout: TMUX_TIMEOUT_MS });
  return parsePanes(stdout);
}

/** Every pane in every window of the server. Throws if tmux isn't running. */
export async function listAllPanes(): Promise<TmuxPane[]> {
  const { stdout } = await run("tmux", ["list-panes", "-a", "-F", PANE_FORMAT], { timeout: TMUX_TIMEOUT_MS });
  return parsePanes(stdout);
}

export interface TmuxVersion {
  raw: string;
  major: number;
  minor: number;
}

export function parseTmuxVersion(raw: string): TmuxVersion | null {
  const match = raw.match(/(\d+)\.(\d+)/);
  if (!match) return null;
  return { raw: raw.trim(), major: Number(match[1]), minor: Number(match[2]) };
}

/** display-popup landed in tmux 3.2. */
export function supportsDisplayPopup(version: TmuxVersion | null): boolean {
  if (!version) return false;
  return version.major > 3 || (version.major === 3 && version.minor >= 2);
}

export async function tmuxVersion(): Promise<TmuxVersion | null> {
  try {
    const { stdout } = await run("tmux", ["-V"]);
    return parseTmuxVersion(stdout);
  } catch {
    return null;
  }
}

/** Single-quote a shell argument. `pipe-pane`'s command runs through the shell. */
const q = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/** Grab the visible buffer of a pane (last `lines` rows, default whole screen). */
export async function capturePane(paneId: string, lines?: number): Promise<string> {
  const args = ["capture-pane", "-p", "-t", paneId];
  if (lines !== undefined) args.push("-S", `-${lines}`);
  const { stdout } = await run("tmux", args, { timeout: TMUX_TIMEOUT_MS });
  return stdout;
}

/** Start streaming a pane's output to a log file (append). */
export async function startPipePane(paneId: string, logPath: string): Promise<void> {
  await run("tmux", ["pipe-pane", "-o", "-t", paneId, `cat >> ${q(logPath)}`], { timeout: TMUX_TIMEOUT_MS });
}

/** Stop streaming a pane (toggle pipe-pane off). */
export async function stopPipePane(paneId: string): Promise<void> {
  await run("tmux", ["pipe-pane", "-t", paneId], { timeout: TMUX_TIMEOUT_MS });
}

/** Type literal keys into a pane. `-l` = literal, no key-name interpretation. */
export async function sendKeys(paneId: string, keys: string): Promise<void> {
  await run("tmux", ["send-keys", "-t", paneId, "-l", keys], { timeout: TMUX_TIMEOUT_MS });
}

/** Set a per-pane option (e.g. `@gm_label`). */
export async function setPaneOption(paneId: string, name: string, value: string): Promise<void> {
  await run("tmux", ["set-option", "-p", "-t", paneId, name, value], { timeout: TMUX_TIMEOUT_MS });
}

/** Create a detached window (does not steal focus) and return its "@N" id. */
export async function newWindow(name: string): Promise<string> {
  const { stdout } = await run(
    "tmux",
    ["new-window", "-d", "-P", "-F", "#{window_id}", "-n", name],
    { timeout: TMUX_TIMEOUT_MS },
  );
  return stdout.trim();
}

/** Rename a window. `window` is a "@N" id. */
export async function renameWindow(windowId: string, name: string): Promise<void> {
  await run("tmux", ["rename-window", "-t", windowId, name], { timeout: TMUX_TIMEOUT_MS });
}

/**
 * Move `srcPane` ("%N") into `dst` — a window ("@N") or an existing pane ("%N").
 * The pane and its process move; nothing is killed. If the source window is left
 * empty, tmux closes that (now empty) window — the process already left with the pane.
 */
export async function joinPane(srcPane: string, dst: string): Promise<void> {
  await run("tmux", ["join-pane", "-s", srcPane, "-t", dst], { timeout: TMUX_TIMEOUT_MS });
}

/** Break `pane` ("%N") into its own detached window; return the new "@N" id. */
export async function breakPane(pane: string, name?: string): Promise<string> {
  const args = ["break-pane", "-d", "-s", pane, "-P", "-F", "#{window_id}"];
  if (name !== undefined) args.push("-n", name);
  const { stdout } = await run("tmux", args, { timeout: TMUX_TIMEOUT_MS });
  return stdout.trim();
}

/** Swap two panes in place ("%N" each). Processes stay put; only positions swap. */
export async function swapPane(a: string, b: string): Promise<void> {
  await run("tmux", ["swap-pane", "-s", a, "-t", b], { timeout: TMUX_TIMEOUT_MS });
}

/** Apply a named layout to a window. `layout` is one of the tmux preset names. */
export async function selectLayout(windowId: string, layout: string): Promise<void> {
  await run("tmux", ["select-layout", "-t", windowId, layout], { timeout: TMUX_TIMEOUT_MS });
}
