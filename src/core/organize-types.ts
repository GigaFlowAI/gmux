/**
 * Pure plan representation for `gmux organize`.
 *
 * A plan never carries a destructive op: the tagged union below is 1:1 with
 * the mux gateway's grouping verbs (`newTab`, `renameTab`, `movePane`,
 * `breakPane`) and nothing else. There is deliberately no `pane.close` /
 * `tab.close` step — reorganization relocates panes, it never destroys their
 * processes. Tabs are groups, not tiles: no `select-layout` / `swap-pane`.
 */

import type { PaneState } from "./gmux-types.js";

/**
 * A tab a step acts on. Either a tab that already exists in mux (`t_…`),
 * or one that an earlier `new-tab`/`break-pane` step in THIS plan creates,
 * referenced by a plan-local symbolic handle. Handles let the plan be fully
 * built (and printed) before any tab id exists.
 */
export type TabTarget = { kind: "tab"; tabId: string } | { kind: "handle"; handle: string };

/**
 * The flattened, normalized view of a pane the planner reasons over. Built from
 * either the mux snapshot (rich: state + label) or a live registry diff (lean).
 */
export interface OrganizePane {
  paneId: string;
  tabId: string | null;
  cwd: string;
  command: string; // foreground command / argv[0]
  harness: string | null; // resolved harness id, or null for a plain shell
  state: PaneState | null; // present only from the daemon snapshot
  label: string | null; // semantic headline, when available
  active: boolean;
}

/**
 * One reorg step. Tagged union, 1:1 with a MuxGateway verb, plus a human
 * `description` used verbatim in the dry-run preview.
 */
export type OrganizeStep =
  | { op: "new-tab"; handle: string; name: string; description: string }
  | { op: "rename-tab"; tab: TabTarget; name: string; description: string }
  | { op: "move-pane"; paneId: string; to: TabTarget; description: string }
  | { op: "break-pane"; paneId: string; handle: string; name?: string; description: string };

/** 1 = legacy tmux window ops; 2 = mux tab grouping. Not `SCHEMA_VERSION`. */
export const ORGANIZE_PLAN_SCHEMA_VERSION = 2;

export interface OrganizePlan {
  schemaVersion: number;
  /** One line for the dry-run header, e.g. "3 tabs, 5 panes moved". */
  summary: string;
  /** Ordered; executed top to bottom. */
  steps: OrganizeStep[];
}

/** Something that turns a pane snapshot (+ optional natural-language intent) into a plan. */
export interface OrganizePlanner {
  plan(panes: OrganizePane[], intent?: string): Promise<OrganizePlan>;
}

/**
 * Pure. The plan as numbered preview lines: the summary, then one line per step
 * (`1. <description>`). No footer and no styling — callers append their own
 * ("run with --apply" for the command, an apply/cancel hint for the overlay).
 * Shared so the CLI command and the confirm drawer render an identical plan.
 */
export function organizePreviewLines(plan: OrganizePlan): string[] {
  const lines = [plan.summary];
  plan.steps.forEach((step, i) => lines.push(`${i + 1}. ${step.description}`));
  return lines;
}
