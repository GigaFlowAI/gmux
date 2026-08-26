import { basename } from "node:path";
import { formatBytes } from "../core/bytes.js";
import type { HostPressure, PaneEntry, WorkspaceSnapshot } from "../core/workspace-types.js";
import { stateGlyph } from "./tmux-label.js";

export { formatBytes };

export function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function paneRow(e: PaneEntry, now: number): string {
  const name = e.identity.cwd ? basename(e.identity.cwd) : e.identity.command;
  const label = e.semantics?.label ?? e.state;
  const mem = e.resources ? formatBytes(e.resources.perPaneRss) : "—";
  const activity = e.lastActivityTs ? relativeTime(e.lastActivityTs, now) : "—";
  return `${stateGlyph(e.state)} ${name}  ${label}  [${mem}]  ${activity}`;
}

export function unattributedLine(host: HostPressure | null): string | null {
  if (!host || host.unattributed <= 0) return null;
  return `  unattributed: ${formatBytes(host.unattributed)} (source outside tracked panes)`;
}

/** A broadcast question and each session's answer (null while still landing). */
export interface CockpitAsk {
  question: string;
  rows: { label: string; answer: string | null }[];
}

export interface RenderCockpitOptions {
  width?: number;
  stale?: { ageMs: number } | null;
  status?: string | null;
  ask?: CockpitAsk | null;
}

/** Normalizes the legacy positional `width` arg and the newer options object into one shape. */
function normalizeCockpitOptions(widthOrOpts: number | RenderCockpitOptions | undefined): { width: number; stale: { ageMs: number } | null; status: string | null; ask: CockpitAsk | null } {
  if (typeof widthOrOpts === "number") return { width: widthOrOpts, stale: null, status: null, ask: null };
  return { width: widthOrOpts?.width ?? 120, stale: widthOrOpts?.stale ?? null, status: widthOrOpts?.status ?? null, ask: widthOrOpts?.ask ?? null };
}

export function renderCockpit(
  snapshot: WorkspaceSnapshot,
  now: number,
  widthOrOpts?: number | RenderCockpitOptions,
): string[] {
  const { width, stale, status, ask } = normalizeCockpitOptions(widthOrOpts);
  const lines: string[] = [];
  if (stale) lines.push(`⚠ daemon not connected — snapshot ${relativeTime(now - stale.ageMs, now)}`);
  if (status) lines.push(status);
  for (const g of snapshot.guardianLog.slice(-3)) lines.push(`⚠ ${g.message}`);
  if (snapshot.guardianLog.length > 0) lines.push("");
  lines.push(`gm — ${snapshot.panes.length} panes`);

  // Sort panes by memory descending if any have resources
  const hasResources = snapshot.panes.some((p) => p.resources);
  const sortedPanes = hasResources
    ? [...snapshot.panes].sort((a, b) => (b.resources?.perPaneRss ?? 0) - (a.resources?.perPaneRss ?? 0))
    : snapshot.panes;

  for (const e of sortedPanes) lines.push(paneRow(e, now));

  // Add unattributed line if present
  const unattr = unattributedLine(snapshot.hostPressure);
  if (unattr) lines.push(unattr);

  // A broadcast question's per-session answers, terse (one clipped line each).
  if (ask && ask.rows.length > 0) {
    lines.push("", `» ${ask.question}`);
    for (const r of ask.rows) lines.push(`  ${r.label}: ${r.answer ?? "⧗ asking…"}`);
  }

  lines.push("", "⌃v: work report");

  // Hard clip to width — not word-aware, matches the terse style elsewhere
  // in this file. Every line (banner, guardian warnings, header, pane rows,
  // unattributed line) goes through the same clip uniformly.
  return lines.map((l) => (l.length > width ? l.slice(0, width) : l));
}
