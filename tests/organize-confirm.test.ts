/**
 * The cockpit's organize confirm-state helpers: the pure preview renderer and
 * the pure key classifier. The live raw-mode loop is glue (covered lightly, as
 * the rest of the cockpit is); these two pure seams carry the behavior worth
 * pinning — the plan is shown correctly, and Esc cancels rather than closes.
 */

import { describe, expect, it } from "vitest";

import type { OrganizePlan } from "../src/core/organize-types.js";
import { CONFIRM_HINT, confirmFrameLines, confirmKey, makeGeneration } from "../src/cli/organize-confirm.js";

const plan: OrganizePlan = {
  summary: "2 project window(s), 1 pane(s) moved",
  steps: [
    { op: "rename-window", window: { kind: "window", windowId: "@1" }, name: "alpha", description: 'Rename window to "alpha"' },
    { op: "move-pane", paneId: "%2", to: { kind: "window", windowId: "@1" }, description: 'Move %2 → "alpha"' },
  ],
};

describe("confirmFrameLines", () => {
  it("renders the summary, numbered steps, a blank line, then the hint", () => {
    expect(confirmFrameLines(plan)).toEqual([
      "2 project window(s), 1 pane(s) moved",
      '1. Rename window to "alpha"',
      '2. Move %2 → "alpha"',
      "",
      CONFIRM_HINT,
    ]);
  });

  it("renders an empty plan as just the summary, blank line, and hint", () => {
    expect(confirmFrameLines({ summary: "nothing to do", steps: [] })).toEqual([
      "nothing to do",
      "",
      CONFIRM_HINT,
    ]);
  });
});

describe("confirmKey", () => {
  it("applies on Enter or y", () => {
    expect(confirmKey("\r")).toBe("apply");
    expect(confirmKey("\n")).toBe("apply");
    expect(confirmKey("y")).toBe("apply");
    expect(confirmKey("Y")).toBe("apply");
  });

  it("cancels on Esc or n — Esc backs out of the plan, it does not close the overlay", () => {
    expect(confirmKey("\x1b")).toBe("cancel");
    expect(confirmKey("n")).toBe("cancel");
    expect(confirmKey("N")).toBe("cancel");
  });

  it("still hard-exits on ctrl-c and ctrl-d", () => {
    expect(confirmKey("\x03")).toBe("exit");
    expect(confirmKey("\x04")).toBe("exit");
  });

  it("ignores any other key, leaving the plan on screen", () => {
    expect(confirmKey("a")).toBe("ignore");
    expect(confirmKey(" ")).toBe("ignore");
    expect(confirmKey("\x12")).toBe("ignore"); // ctrl-r is not a confirm action
  });
});

describe("makeGeneration", () => {
  it("treats a freshly claimed generation as current", () => {
    const g = makeGeneration();
    const gen = g.next();
    expect(g.isCurrent(gen)).toBe(true);
  });

  it("invalidates an earlier generation once a new one is claimed (cancel drops the stale result)", () => {
    const g = makeGeneration();
    const first = g.next(); // a submit starts
    g.next(); // a cancel (or a second submit) claims a new generation
    expect(g.isCurrent(first)).toBe(false); // the late classify/plan is dropped
  });

  it("hands out strictly increasing generations", () => {
    const g = makeGeneration();
    expect(g.next()).toBe(1);
    expect(g.next()).toBe(2);
    expect(g.next()).toBe(3);
  });
});
