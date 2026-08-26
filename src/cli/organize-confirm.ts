/**
 * The organize confirm-state for the ctrl-g cockpit prompt. Pure string layout
 * and pure key classification — the command owns the terminal and the async
 * plan, and calls these to render the preview and to interpret a keystroke.
 *
 * When the cockpit prompt classifies as a reorganization, the cockpit shows the
 * numbered plan and waits for the user to confirm. NOTHING is applied without
 * that confirmation — this is the preview half of preview-then-apply.
 */

import { organizePreviewLines, type OrganizePlan } from "../core/organize-types.js";

/** The hint shown under the plan: how to apply or back out. */
export const CONFIRM_HINT = "[Enter] apply  [Esc] cancel";

/**
 * The confirm screen: the numbered plan, a blank line, then the hint. Pure, so
 * the rendering is tested without a terminal; the command positions it.
 */
export function confirmFrameLines(plan: OrganizePlan): string[] {
  return [...organizePreviewLines(plan), "", CONFIRM_HINT];
}

/**
 * A monotonic generation guard for the cockpit's async submit flow.
 *
 * Each submit claims a fresh generation with `next()`. A cancel (Esc/ctrl-g
 * while planning) also calls `next()`, invalidating whatever classify/plan is
 * in flight. When that awaited work resolves it checks `isCurrent(gen)` — false
 * means the user backed out (or started another submit) meanwhile, so the late
 * result is DROPPED and can never pop a confirm screen after the user left the
 * planning state. Pure and synchronous, so the guard decision is unit-tested
 * without the raw-mode loop.
 */
export function makeGeneration(): { next: () => number; isCurrent: (gen: number) => boolean } {
  let current = 0;
  return {
    next: () => (current += 1),
    isCurrent: (gen: number) => gen === current,
  };
}

/** What a keystroke means while the confirm screen is up. */
export type ConfirmAction = "apply" | "cancel" | "exit" | "ignore";

/**
 * Classify a keystroke in the confirm state:
 *   - Enter / y  → apply the plan
 *   - Esc / n    → cancel back to the ask box
 *   - ctrl-c / ctrl-d → exit the cockpit entirely (the long-standing hard exits)
 *   - anything else → ignore (the plan stays on screen)
 *
 * Esc cancels here rather than closing the cockpit: with a plan on screen the
 * least-surprising "escape" is out of the confirmation, not out of the peek.
 */
export function confirmKey(s: string): ConfirmAction {
  if (s === "\x03" || s === "\x04") return "exit";
  if (s === "\r" || s === "\n" || s === "y" || s === "Y") return "apply";
  if (s === "\x1b" || s === "n" || s === "N") return "cancel";
  return "ignore";
}
