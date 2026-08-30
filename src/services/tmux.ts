/**
 * The narrow surface where gigamanage shells out to `tmux`. The parsers are pure
 * (and tested); the two `run` wrappers are thin shells over documented tmux
 * flags, guarded at the edges by the `gm doctor` version check.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { TmuxPane } from "../core/types.js";

const run = promisify(execFile);

/** Tab-separated so a cwd with spaces cannot be mis-split. */
export const PANE_FORMAT =
  "#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_pid}";

export function parsePaneLine(line: string): TmuxPane | null {
  const parts = line.split("\t");
  if (parts.length < 8) return null;
  const [paneId, left, top, width, height, cwd, command, pid] = parts;
  const nums = [left, top, width, height, pid].map((n) => Number(n));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return {
    paneId: paneId!,
    left: nums[0]!,
    top: nums[1]!,
    width: nums[2]!,
    height: nums[3]!,
    cwd: cwd!,
    command: command!,
    pid: nums[4]!,
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
  const { stdout } = await run("tmux", ["list-panes", "-t", windowId, "-F", PANE_FORMAT]);
  return parsePanes(stdout);
}

/** Every pane in every window of the server. Throws if tmux isn't running. */
export async function listAllPanes(): Promise<TmuxPane[]> {
  const { stdout } = await run("tmux", ["list-panes", "-a", "-F", PANE_FORMAT]);
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
