/**
 * `gmux organize`: the pure preview renderer only. The live tmux path
 * (sensing panes, constructing `RealTmuxGateway`, calling `applyPlan`) is
 * exercised in `organize.test.ts` (planner/apply units) — this file stays
 * hermetic and just checks the dry-run text `registerOrganize`'s action
 * writes to stdout.
 */

import { describe, expect, it } from "vitest";

import type { OrganizePlan } from "../src/core/organize-types.js";
import { renderOrganizePreview } from "../src/cli/commands/organize.js";

const emptyPlan: OrganizePlan = { summary: "0 project window(s), 0 pane(s) moved", steps: [] };

const plan: OrganizePlan = {
  summary: "2 project window(s), 1 pane(s) moved",
  steps: [
    { op: "rename-window", window: { kind: "window", windowId: "@1" }, name: "alpha", description: 'Rename window to "alpha"' },
    { op: "move-pane", paneId: "%3", to: { kind: "window", windowId: "@1" }, description: 'Move %3 (writing tests) → "alpha"' },
    { op: "select-layout", window: { kind: "window", windowId: "@1" }, layout: "tiled", description: 'Tile "alpha"' },
  ],
};

describe("renderOrganizePreview", () => {
  it("numbers each step's description, prefixed by the summary line", () => {
    const text = renderOrganizePreview(plan);
    const lines = text.split("\n");
    expect(lines[0]).toBe(plan.summary);
    expect(lines[1]).toContain('1. Rename window to "alpha"');
    expect(lines[2]).toContain('2. Move %3 (writing tests) → "alpha"');
    expect(lines[3]).toContain('3. Tile "alpha"');
  });

  it("ends with a hint to pass --apply", () => {
    const text = renderOrganizePreview(plan);
    expect(text).toContain("run with --apply to execute");
  });

  it("prints just the summary and the hint when there are no steps", () => {
    const text = renderOrganizePreview(emptyPlan);
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(emptyPlan.summary);
  });

  it("is a pure function of the plan — no ANSI-dependent env state, no I/O", () => {
    expect(renderOrganizePreview(plan)).toBe(renderOrganizePreview(plan));
  });
});
