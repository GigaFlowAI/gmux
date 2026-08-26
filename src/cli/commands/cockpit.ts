import { basename } from "node:path";

import type { Command } from "commander";

import type { WorkspaceSnapshot } from "../../core/gmux-types.js";
import type { SessionRecord } from "../../core/types.js";
import { renderCockpit, type RenderCockpitOptions } from "../gmux-render.js";
import { legacySurfaceError } from "./attach.js";

const CLEAR = "\x1b[2J\x1b[H";

/**
 * Mux apply needs mux pane ids (`p_…`). Tmux daemon snapshots use `%N` / `@N`
 * and must stay preview-only — never send those ids to MuxClient.
 */
export function cockpitApplyTarget(paneIds: readonly string[]): "mux" | "preview-only" {
  if (paneIds.length === 0) return "preview-only";
  return paneIds.every((id) => id.startsWith("p_")) ? "mux" : "preview-only";
}

/** Clear screen + home, then the cockpit grid — CRLF-joined for raw-mode stdout. */
export function buildFrame(snapshot: WorkspaceSnapshot, now: number, opts?: RenderCockpitOptions): string {
  return CLEAR + renderCockpit(snapshot, now, opts).join("\r\n");
}

/**
 * The panes that have a resolvable session, paired with their record. Pure so
 * the pairing is tested without a daemon: matches on `identity.sessionId`, skips
 * session-less and unmatched panes, and dedupes a session claimed by two panes.
 */
export function sessionsForSnapshot(
  snapshot: WorkspaceSnapshot,
  records: readonly SessionRecord[],
): { label: string; record: SessionRecord }[] {
  const byId = new Map(records.map((r) => [r.sessionId, r]));
  const seen = new Set<string>();
  const out: { label: string; record: SessionRecord }[] = [];
  for (const p of snapshot.panes) {
    const sid = p.identity.sessionId;
    if (!sid || seen.has(sid)) continue;
    const record = byId.get(sid);
    if (!record) continue;
    seen.add(sid);
    out.push({ label: p.identity.cwd ? basename(p.identity.cwd) : p.identity.command, record });
  }
  return out;
}

/**
 * Hidden alias for one release. The tmux popup is gone; ctrl+g opens the
 * sidebar inside `gmux attach`.
 */
export function registerCockpit(program: Command): void {
  program
    .command("cockpit", { hidden: true })
    .description("removed — use gmux attach")
    .action(() => {
      throw legacySurfaceError("gmux cockpit");
    });
}
