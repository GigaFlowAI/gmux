/**
 * The pane-border-label HUD: each pane's session headline, written into its tmux
 * pane title and shown on the pane border. The `gm watch` service repaints these
 * on a loop; `Alt-g` toggles the service.
 *
 * Labels live in a per-pane `@gm_label` option, NOT `#{pane_title}`: a running
 * agent sets its pane title via OSC escape sequences (a progress spinner), which
 * would clobber a title we wrote. A `@`-prefixed user option is ours alone.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { SessionRecord, SessionView, TmuxPane } from "../core/types.js";
import { inProgressIds } from "../services/auto-summarize.js";
import { prunePaneLinks } from "../services/pane-links.js";
import { listAllPanes, listPanes } from "../services/tmux.js";
import { resolvePanesLive } from "../services/tmux-resolve.js";
import { attachSummaries, loadCachedRecords } from "../services/views.js";
import {
  isWatchRunning,
  startWatch,
  stopWatch,
} from "../services/watch.js";

const run = promisify(execFile);

/**
 * Active pane emphasised, label centred. Forces its own foreground colour so it
 * doesn't inherit a themed, dimmed `pane-border-style` (which would leave every
 * inactive pane's label invisible).
 */
const PANE_BORDER_FORMAT =
  "#[align=centre]#[fg=colour252]#{?pane_active,#[reverse],} #{@gm_label} #[default]";

/**
 * The label for a pane: `project — headline`, `project — gm summaries loading…`
 * while a refresh is in flight, `○ project` when resolved but not yet summarised,
 * or empty for a pane with no resolvable agent. Not truncated — tmux clips it to
 * the pane's width at render.
 */
export function paneLabel(view: SessionView | null, refreshing = false): string {
  if (!view) return "";
  const project = view.record.project ?? view.record.harness;
  if (refreshing) return `${project} — gm summaries loading…`;
  if (!view.summary) return `○ ${project}`;
  return `${project} — ${view.summary.headline}`;
}

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await run("tmux", args);
  return stdout;
}

/**
 * Resolve a set of panes and write each one's `@gm_label`. Returns the resolved
 * session records, so the caller can feed exactly the on-screen sessions to the
 * summariser. No model calls here — labels render from the cache.
 */
export async function labelPanes(panes: readonly TmuxPane[]): Promise<SessionRecord[]> {
  const links = await prunePaneLinks(panes.map((p) => p.paneId));
  const records = await loadCachedRecords();
  const resolved = await resolvePanesLive(panes, records, links);

  const present = resolved
    .map((r) => r.record)
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const views = await attachSummaries(present);
  const bySession = new Map(views.map((v) => [v.record.sessionId, v]));
  const refreshing = await inProgressIds();

  for (const { pane, record } of resolved) {
    const view: SessionView | null = record
      ? bySession.get(record.sessionId) ?? { record, summary: null }
      : null;
    const isRefreshing = record ? refreshing.has(record.sessionId) : false;
    await tmux(["set-option", "-p", "-t", pane.paneId, "@gm_label", paneLabel(view, isRefreshing)]);
  }

  return present;
}

/** Label every pane in a window (or all windows when `windowId` is null). */
export async function paintLabels(windowId: string | null): Promise<SessionRecord[]> {
  const panes = windowId === null ? await listAllPanes() : await listPanes(windowId);
  return labelPanes(panes);
}

async function windowIds(): Promise<string[]> {
  const out = await tmux(["list-windows", "-a", "-F", "#{window_id}"]);
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Clear any per-window `pane-border-status` so the global option governs every window. */
async function clearWindowOverrides(): Promise<void> {
  for (const w of await windowIds()) {
    await tmux(["set-option", "-w", "-u", "-t", w, "pane-border-status"]);
  }
}

/** Show the label borders across all windows, driven purely by the global option. */
export async function enableBorder(): Promise<void> {
  await clearWindowOverrides();
  await tmux(["set-option", "-g", "pane-border-format", PANE_BORDER_FORMAT]);
  await tmux(["set-option", "-g", "pane-border-status", "top"]);
}

/**
 * Hide the label borders. Sets the global off, then clears any per-window
 * override (older versions set `pane-border-status` per window, which would
 * override the global and keep the border up) and wipes every pane's `@gm_label`,
 * so no headline lingers regardless of theme or leftover settings.
 */
export async function disableBorder(): Promise<void> {
  await tmux(["set-option", "-g", "pane-border-status", "off"]);
  try {
    await clearWindowOverrides();
    for (const pane of await listAllPanes()) {
      await tmux(["set-option", "-p", "-u", "-t", pane.paneId, "@gm_label"]);
    }
  } catch {
    // Best-effort cleanup; the global 'off' has already hidden the borders.
  }
}

/**
 * `Alt-g`: toggle the background label agent. On when off (enable the borders,
 * paint an immediate first frame for the current window, start the watcher); off
 * when on (stop the watcher, hide the borders). "On" is the service running, not
 * the border option — a theme may set the border for its own reasons.
 */
export async function toggleWatch(windowId: string): Promise<"on" | "off"> {
  if (await isWatchRunning()) {
    await stopWatch();
    await disableBorder();
    return "off";
  }
  await enableBorder();
  await paintLabels(windowId); // instant first paint, before the loop's first tick
  await startWatch();
  return "on";
}
