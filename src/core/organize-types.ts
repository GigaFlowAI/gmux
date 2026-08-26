/**
 * Pure plan representation for `gmux organize`.
 *
 * A plan never carries a destructive op: the tagged union below is 1:1 with
 * the tmux gateway's relocation verbs (`newWindow`, `renameWindow`,
 * `joinPane`, `breakPane`, `swapPane`, `selectLayout`) and nothing else. There
 * is deliberately no `kill-pane`/`kill-window` step — see the design
 * invariant in the organize spec: reorganization relocates panes, it never
 * destroys their processes.
 */

import type { PaneState } from "./gmux-types.js";

/** tmux preset layouts we allow the planner to choose. */
export const LAYOUTS = [
  "tiled",
  "even-horizontal",
  "even-vertical",
  "main-horizontal",
  "main-vertical",
] as const;
export type LayoutName = (typeof LAYOUTS)[number];

export function isLayoutName(v: string): v is LayoutName {
  return (LAYOUTS as readonly string[]).includes(v);
}

/**
 * A window a step acts on. Either a window that already exists in tmux ("@N"),
 * or one that an earlier `new-window`/`break-pane` step in THIS plan creates,
 * referenced by a plan-local symbolic handle. Handles let the plan be fully
 * built (and printed) before any "@N" id exists.
 */
export type WindowTarget = { kind: "window"; windowId: string } | { kind: "handle"; handle: string };

/**
 * The flattened, normalized view of a pane the planner reasons over. Built from
 * either the daemon snapshot (rich: state + label) or a live registry diff (lean).
 */
export interface OrganizePane {
  paneId: string; // "%N"
  windowId: string | null; // "@N"
  cwd: string;
  command: string; // pane_current_command
  harness: string | null; // resolved harness id, or null for a plain shell
  state: PaneState | null; // present only from the daemon snapshot
  label: string | null; // semantic headline, when available
  active: boolean;
}

/**
 * One reorg step. Tagged union, 1:1 with a gateway verb, plus a human
 * `description` used verbatim in the dry-run preview.
 */
export type OrganizeStep =
  | { op: "new-window"; handle: string; name: string; description: string }
  | { op: "rename-window"; window: WindowTarget; name: string; description: string }
  | { op: "move-pane"; paneId: string; to: WindowTarget; description: string }
  | { op: "break-pane"; paneId: string; handle: string; name?: string; description: string }
  | { op: "swap-pane"; a: string; b: string; description: string }
  | { op: "select-layout"; window: WindowTarget; layout: LayoutName; description: string };

export interface OrganizePlan {
  /** One line for the dry-run header, e.g. "3 windows, 5 panes moved". */
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
 * Shared so the CLI command and the ctrl-g overlay render an identical plan.
 */
export function organizePreviewLines(plan: OrganizePlan): string[] {
  const lines = [plan.summary];
  plan.steps.forEach((step, i) => lines.push(`${i + 1}. ${step.description}`));
  return lines;
}
