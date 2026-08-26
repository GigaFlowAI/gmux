import type { Command } from "commander";

import type { SessionView } from "../../core/types.js";
import type { ResolvedPane } from "../../services/tmux-resolve.js";
import type { OverlayCell } from "../overlay.js";
import { legacySurfaceError } from "./attach.js";

/** A question broadcast to every pane, and the per-session answers as they land. */
export interface AskBroadcast {
  question: string;
  answers: Map<string, string>;
}

/**
 * Pair each resolved pane with its summary view and the in-flight refresh set —
 * and, when a question has been broadcast, this pane's own answer (or the
 * `asking…` state until it lands). Pure, so the pairing is tested without a terminal.
 */
export function buildCells(
  resolved: readonly ResolvedPane[],
  views: readonly SessionView[],
  refreshingIds: ReadonlySet<string>,
  ask?: AskBroadcast | null,
): OverlayCell[] {
  const bySession = new Map(views.map((v) => [v.record.sessionId, v]));
  return resolved.map(({ pane, record }) => {
    const cell: OverlayCell = {
      pane,
      view: record ? bySession.get(record.sessionId) ?? { record, summary: null } : null,
      refreshing: record ? refreshingIds.has(record.sessionId) : false,
    };
    if (ask && record) {
      cell.answer = ask.answers.get(record.sessionId) ?? null;
      cell.asking = cell.answer == null;
    }
    return cell;
  });
}

/**
 * The keys that dismiss the overlay.
 *
 * ctrl-g (`\x07`) is here so the same key that opens the popup also closes it —
 * a toggle, which is what a peek key should feel like. Since the ask box landed
 * every other key types into it, so a close key has to be spelled out; without
 * ctrl-g listed it would fall through and be swallowed as un-printable input.
 * Esc, ctrl-c and ctrl-d are the long-standing exits, kept exactly.
 */
export function isCloseKey(s: string): boolean {
  return s === "\x1b" || s === "\x03" || s === "\x04" || s === "\x07";
}

/**
 * Hidden alias for one release. The tmux popup is gone; ctrl+g opens the
 * sidebar inside `gmux attach`.
 */
export function registerOverlay(program: Command): void {
  program
    .command("overlay [window]", { hidden: true })
    .description("removed — use gmux attach")
    .action(() => {
      throw legacySurfaceError("gmux overlay");
    });
}
