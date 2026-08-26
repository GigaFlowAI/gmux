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

const emptyPlan: OrganizePlan = { schemaVersion: 2, summary: "0 project tab(s), 0 pane(s) moved", steps: [] };

const plan: OrganizePlan = {
  schemaVersion: 2,
  summary: "2 project tab(s), 1 pane(s) moved",
  steps: [
    { op: "rename-tab", tab: { kind: "tab", tabId: "t_1" }, name: "alpha", description: 'Rename tab to "alpha"' },
    { op: "move-pane", paneId: "p_3", to: { kind: "tab", tabId: "t_1" }, description: 'Move p_3 (writing tests) → "alpha"' },
  ],
};

describe("renderOrganizePreview", () => {
  it("numbers each step's description, prefixed by the summary line", () => {
    const text = renderOrganizePreview(plan);
    const lines = text.split("\n");
    expect(lines[0]).toBe(plan.summary);
    expect(lines[1]).toContain('1. Rename tab to "alpha"');
    expect(lines[2]).toContain('2. Move p_3 (writing tests) → "alpha"');
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
