/**
 * `gmux organize`: the heuristic planner, the LLM planner's reply parsing +
 * defensive fallback, and `applyPlan`'s executor.
 *
 * No real tmux, no real LLM — non-negotiables #2 and #3. The "LLM" tests spawn
 * a `node -e` script as the provider argv (same trick `provider-process.test.ts`
 * uses): deterministic, no model, no network.
 */

import { describe, expect, it } from "vitest";

import type { OrganizePane, OrganizePlan } from "../src/core/organize-types.js";
import {
  HeuristicOrganizePlanner,
  LlmOrganizePlanner,
  applyPlan,
  parseOrganizePlan,
} from "../src/services/organize.js";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";

function pane(overrides: Partial<OrganizePane> & { paneId: string }): OrganizePane {
  return {
    windowId: null,
    cwd: "/x",
    command: "claude",
    harness: "claude-code",
    state: "working",
    label: null,
    active: false,
    ...overrides,
  };
}

function providerArgv(script: string): string[] {
  return [process.execPath, "-e", script];
}

describe("HeuristicOrganizePlanner", () => {
  it("groups two projects into two windows, each renamed and tiled", async () => {
    const panes: OrganizePane[] = [
      pane({ paneId: "%1", windowId: "@1", cwd: "/repo/alpha", label: "fixing auth" }),
      pane({ paneId: "%2", windowId: "@2", cwd: "/repo/alpha", label: "writing tests" }),
      pane({ paneId: "%3", windowId: "@3", cwd: "/repo/beta", label: "refactor db" }),
    ];

    const plan = await new HeuristicOrganizePlanner().plan(panes);

    expect(plan.summary).toBe("2 project window(s), 1 pane(s) moved");
    expect(plan.steps).toEqual([
      { op: "rename-window", window: { kind: "window", windowId: "@1" }, name: "alpha", description: 'Rename window to "alpha"' },
      { op: "move-pane", paneId: "%2", to: { kind: "window", windowId: "@1" }, description: 'Move %2 (writing tests) → "alpha"' },
      { op: "select-layout", window: { kind: "window", windowId: "@1" }, layout: "tiled", description: 'Tile "alpha"' },
      { op: "rename-window", window: { kind: "window", windowId: "@3" }, name: "beta", description: 'Rename window to "beta"' },
      { op: "select-layout", window: { kind: "window", windowId: "@3" }, layout: "tiled", description: 'Tile "beta"' },
    ]);
  });

  it("synthesizes a fresh window when no pane in a project group has a windowId", async () => {
    const panes: OrganizePane[] = [pane({ paneId: "%1", windowId: null, cwd: "/repo/gamma" })];

    const plan = await new HeuristicOrganizePlanner().plan(panes);

    expect(plan.steps[0]).toEqual({
      op: "new-window",
      handle: "w:gamma",
      name: "gamma",
      description: 'Create window "gamma"',
    });
    // No rename-window: the freshly created window is already named correctly.
    expect(plan.steps.some((s) => s.op === "rename-window")).toBe(false);
    expect(plan.steps).toEqual([
      { op: "new-window", handle: "w:gamma", name: "gamma", description: 'Create window "gamma"' },
      { op: "move-pane", paneId: "%1", to: { kind: "handle", handle: "w:gamma" }, description: 'Move %1 (claude) → "gamma"' },
      { op: "select-layout", window: { kind: "handle", handle: "w:gamma" }, layout: "tiled", description: 'Tile "gamma"' },
    ]);
  });

  it("gathers two or more idle shells into one shells window, even-vertical", async () => {
    const panes: OrganizePane[] = [
      pane({ paneId: "%1", windowId: "@1", cwd: "/repo/alpha" }),
      pane({ paneId: "%9", windowId: "@9", cwd: "/x", command: "zsh", harness: null, state: "idle" }),
      pane({ paneId: "%8", windowId: "@8", cwd: "/x", command: "-bash", harness: null, state: null }),
    ];

    const plan = await new HeuristicOrganizePlanner().plan(panes);

    expect(plan.steps).toContainEqual({
      op: "new-window",
      handle: "w:shells",
      name: "shells",
      description: 'Create window "shells"',
    });
    // Deterministic paneId order within the shells group: %8 before %9.
    expect(plan.steps).toContainEqual({
      op: "move-pane",
      paneId: "%8",
      to: { kind: "handle", handle: "w:shells" },
      description: 'Move %8 (-bash) → "shells"',
    });
    expect(plan.steps).toContainEqual({
      op: "move-pane",
      paneId: "%9",
      to: { kind: "handle", handle: "w:shells" },
      description: 'Move %9 (zsh) → "shells"',
    });
    expect(plan.steps).toContainEqual({
      op: "select-layout",
      window: { kind: "handle", handle: "w:shells" },
      layout: "even-vertical",
      description: 'Arrange "shells"',
    });
  });

  it("emits nothing for a lone idle shell — not worth its own window", async () => {
    const panes: OrganizePane[] = [
      pane({ paneId: "%1", windowId: "@1", cwd: "/repo/alpha" }),
      pane({ paneId: "%9", windowId: "@9", cwd: "/x", command: "zsh", harness: null, state: "idle" }),
    ];

    const plan = await new HeuristicOrganizePlanner().plan(panes);

    expect(plan.steps.some((s) => s.op === "move-pane" && s.paneId === "%9")).toBe(false);
    expect(plan.steps.some((s) => s.op === "new-window" && s.name === "shells")).toBe(false);
  });

  it("skips a redundant move when panes are already grouped in the anchor window", async () => {
    const panes: OrganizePane[] = [
      pane({ paneId: "%1", windowId: "@1", cwd: "/repo/alpha" }),
      pane({ paneId: "%2", windowId: "@1", cwd: "/repo/alpha" }), // already in @1 with %1
    ];

    const plan = await new HeuristicOrganizePlanner().plan(panes);

    expect(plan.steps.some((s) => s.op === "move-pane")).toBe(false);
    expect(plan.summary).toBe("1 project window(s), 0 pane(s) moved");
  });

  it("treats a bare shell mid-'working' as agent-class, never sweeping it into shells", async () => {
    const panes: OrganizePane[] = [
      pane({ paneId: "%1", windowId: "@1", cwd: "/repo/alpha", command: "zsh", harness: null, state: "working" }),
    ];

    const plan = await new HeuristicOrganizePlanner().plan(panes);

    // Grouped as project "alpha", not swept into a shells window.
    expect(plan.steps.some((s) => s.op === "new-window" && s.name === "shells")).toBe(false);
    expect(plan.steps.some((s) => s.op === "rename-window" && s.name === "alpha")).toBe(true);
  });

  it("never emits a destructive op — the union has none to emit", async () => {
    const panes: OrganizePane[] = [
      pane({ paneId: "%1", windowId: "@1", cwd: "/repo/alpha" }),
      pane({ paneId: "%2", windowId: "@2", cwd: "/repo/beta" }),
      pane({ paneId: "%9", windowId: "@9", cwd: "/x", command: "zsh", harness: null, state: "idle" }),
      pane({ paneId: "%8", windowId: "@8", cwd: "/x", command: "bash", harness: null, state: "idle" }),
    ];
    const plan = await new HeuristicOrganizePlanner().plan(panes);
    const allowedOps = new Set(["new-window", "rename-window", "move-pane", "break-pane", "swap-pane", "select-layout"]);
    for (const step of plan.steps) expect(allowedOps.has(step.op)).toBe(true);
  });

  it("is a pure function of its input: identical calls produce identical plans", async () => {
    const panes: OrganizePane[] = [
      pane({ paneId: "%2", windowId: "@2", cwd: "/repo/beta" }),
      pane({ paneId: "%1", windowId: "@1", cwd: "/repo/alpha" }),
      pane({ paneId: "%9", windowId: null, cwd: "/x", command: "fish", harness: null, state: "idle" }),
      pane({ paneId: "%8", windowId: null, cwd: "/x", command: "sh", harness: null, state: "idle" }),
    ];
    const planner = new HeuristicOrganizePlanner();
    const first = await planner.plan([...panes]);
    const second = await planner.plan([...panes].reverse());
    expect(second).toEqual(first);
  });

  it("never references a pane id absent from the input, and binds every handle before use", async () => {
    const panes: OrganizePane[] = [
      pane({ paneId: "%1", windowId: null, cwd: "/repo/alpha" }),
      pane({ paneId: "%2", windowId: null, cwd: "/repo/alpha" }),
    ];
    const plan = await new HeuristicOrganizePlanner().plan(panes);
    const paneIds = new Set(panes.map((p) => p.paneId));
    const bound = new Set<string>();
    for (const step of plan.steps) {
      if (step.op === "new-window" || step.op === "break-pane") bound.add(step.handle);
      if (step.op === "move-pane") {
        expect(paneIds.has(step.paneId)).toBe(true);
        if (step.to.kind === "handle") expect(bound.has(step.to.handle)).toBe(true);
      }
      if ((step.op === "rename-window" || step.op === "select-layout") && step.window.kind === "handle") {
        expect(bound.has(step.window.handle)).toBe(true);
      }
    }
  });
});

describe("parseOrganizePlan", () => {
  const panes: OrganizePane[] = [pane({ paneId: "%1" }), pane({ paneId: "%2" })];

  it("parses a bare JSON object", () => {
    const raw = '{"summary":"one move","steps":[{"op":"move-pane","paneId":"%1","to":{"kind":"window","windowId":"@1"},"description":"move it"}]}';
    const plan = parseOrganizePlan(raw, panes);
    expect(plan.summary).toBe("one move");
    expect(plan.steps).toEqual([
      { op: "move-pane", paneId: "%1", to: { kind: "window", windowId: "@1" }, description: "move it" },
    ]);
  });

  it("takes the outermost braces from a fenced reply", () => {
    const raw = '```json\n{"summary":"s","steps":[]}\n```';
    expect(parseOrganizePlan(raw, panes)).toEqual({ summary: "s", steps: [] });
  });

  it("takes the outermost braces from a prefaced reply", () => {
    const raw = 'Sure, here is the plan:\n{"summary":"s","steps":[]}\nLet me know if you want changes.';
    expect(parseOrganizePlan(raw, panes)).toEqual({ summary: "s", steps: [] });
  });

  it("drops a step with an unknown op", () => {
    const raw = '{"steps":[{"op":"kill-pane","paneId":"%1","description":"x"}]}';
    expect(parseOrganizePlan(raw, panes).steps).toEqual([]);
  });

  it("drops a step referencing a pane id absent from the input", () => {
    const raw = '{"steps":[{"op":"move-pane","paneId":"%999","to":{"kind":"window","windowId":"@1"},"description":"x"}]}';
    expect(parseOrganizePlan(raw, panes).steps).toEqual([]);
  });

  it("drops a step referencing a handle never bound by an earlier step", () => {
    const raw = '{"steps":[{"op":"move-pane","paneId":"%1","to":{"kind":"handle","handle":"w:ghost"},"description":"x"}]}';
    expect(parseOrganizePlan(raw, panes).steps).toEqual([]);
  });

  it("accepts a handle bound by an earlier step in the same reply", () => {
    const raw =
      '{"steps":[' +
      '{"op":"new-window","handle":"w:x","name":"x","description":"create"},' +
      '{"op":"move-pane","paneId":"%1","to":{"kind":"handle","handle":"w:x"},"description":"move"}' +
      "]}";
    expect(parseOrganizePlan(raw, panes).steps).toHaveLength(2);
  });

  it("drops a select-layout step with an invalid layout name", () => {
    const raw = '{"steps":[{"op":"select-layout","window":{"kind":"window","windowId":"@1"},"layout":"spiral","description":"x"}]}';
    expect(parseOrganizePlan(raw, panes).steps).toEqual([]);
  });

  it("returns an empty plan for garbage input", () => {
    expect(parseOrganizePlan("not json at all", panes)).toEqual({ summary: "", steps: [] });
  });

  it("falls back to a computed summary when the model omits one", () => {
    const raw = '{"steps":[{"op":"new-window","handle":"w:x","name":"x","description":"create"}]}';
    expect(parseOrganizePlan(raw, panes).summary).toBe("1 step(s)");
  });
});

describe("applyPlan", () => {
  it("executes new-window, move-pane, select-layout and records them on the gateway", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([
      { paneId: "%1", left: 0, top: 0, width: 80, height: 24, cwd: "/a", command: "claude", pid: 1, windowId: "@1", active: false },
    ]);
    const plan: OrganizePlan = {
      summary: "s",
      steps: [
        { op: "new-window", handle: "w:x", name: "x", description: "create" },
        { op: "move-pane", paneId: "%1", to: { kind: "handle", handle: "w:x" }, description: "move" },
        { op: "select-layout", window: { kind: "handle", handle: "w:x" }, layout: "tiled", description: "tile" },
      ],
    };

    const result = await applyPlan(plan, gw);

    expect(result.skipped).toEqual([]);
    expect(result.applied).toHaveLength(3);
    expect(gw.created).toEqual([{ windowId: "@100", name: "x" }]);
    expect(gw.joins).toEqual([{ srcPane: "%1", dst: "@100" }]);
    expect(gw.layouts).toEqual([{ windowId: "@100", layout: "tiled" }]);
  });

  it("skips a move-pane for a pane that vanished, and still applies the rest", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([
      { paneId: "%1", left: 0, top: 0, width: 80, height: 24, cwd: "/a", command: "claude", pid: 1, windowId: "@1", active: false },
    ]);
    const plan: OrganizePlan = {
      summary: "s",
      steps: [
        { op: "move-pane", paneId: "%999", to: { kind: "window", windowId: "@1" }, description: "gone" },
        { op: "rename-window", window: { kind: "window", windowId: "@1" }, name: "alpha", description: "rename" },
      ],
    };

    const result = await applyPlan(plan, gw);

    expect(result.applied).toEqual([plan.steps[1]]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain("%999");
    expect(gw.renamed).toEqual([{ windowId: "@1", name: "alpha" }]);
  });

  it("resolves a handle bound by an earlier new-window to the fake's minted window id", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([
      { paneId: "%1", left: 0, top: 0, width: 80, height: 24, cwd: "/a", command: "claude", pid: 1, windowId: "@1", active: false },
    ]);
    const plan: OrganizePlan = {
      summary: "s",
      steps: [
        { op: "new-window", handle: "w:first", name: "first", description: "create first" },
        { op: "new-window", handle: "w:second", name: "second", description: "create second" },
        { op: "move-pane", paneId: "%1", to: { kind: "handle", handle: "w:second" }, description: "move into second" },
      ],
    };

    const result = await applyPlan(plan, gw);

    expect(result.skipped).toEqual([]);
    expect(gw.created).toEqual([
      { windowId: "@100", name: "first" },
      { windowId: "@101", name: "second" },
    ]);
    expect(gw.joins).toEqual([{ srcPane: "%1", dst: "@101" }]);
  });

  it("skips a step referencing an unbound handle without touching the gateway", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([
      { paneId: "%1", left: 0, top: 0, width: 80, height: 24, cwd: "/a", command: "claude", pid: 1, windowId: "@1", active: false },
    ]);
    const plan: OrganizePlan = {
      summary: "s",
      steps: [{ op: "move-pane", paneId: "%1", to: { kind: "handle", handle: "w:ghost" }, description: "x" }],
    };

    const result = await applyPlan(plan, gw);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain("w:ghost");
    expect(gw.joins).toEqual([]);
  });

  it("skips just the step whose gateway call throws, and keeps applying the rest", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([
      { paneId: "%1", left: 0, top: 0, width: 80, height: 24, cwd: "/a", command: "claude", pid: 1, windowId: "@1", active: false },
      { paneId: "%2", left: 0, top: 0, width: 80, height: 24, cwd: "/a", command: "claude", pid: 2, windowId: "@2", active: false },
    ]);
    gw.swapPane = async () => {
      throw new Error("tmux: can't swap those panes");
    };

    const plan: OrganizePlan = {
      summary: "s",
      steps: [
        { op: "swap-pane", a: "%1", b: "%2", description: "swap" },
        { op: "rename-window", window: { kind: "window", windowId: "@1" }, name: "alpha", description: "rename" },
      ],
    };

    const result = await applyPlan(plan, gw);

    expect(result.applied).toEqual([plan.steps[1]]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain("can't swap");
    expect(gw.renamed).toEqual([{ windowId: "@1", name: "alpha" }]);
  });

  it("never calls a destructive gateway method — none exists on the interface", async () => {
    const gw = new FakeTmuxGateway();
    expect((gw as unknown as Record<string, unknown>)["killPane"]).toBeUndefined();
    expect((gw as unknown as Record<string, unknown>)["killWindow"]).toBeUndefined();
  });
});

describe("LlmOrganizePlanner", () => {
  const panes: OrganizePane[] = [pane({ paneId: "%1", windowId: "@1", cwd: "/repo/alpha" })];

  it("falls back to heuristic when argv is explicitly null (no provider configured)", async () => {
    const heuristicPlan = await new HeuristicOrganizePlanner().plan(panes, "tidy up");
    const planner = new LlmOrganizePlanner(new HeuristicOrganizePlanner(), null);
    const plan = await planner.plan(panes, "tidy up");
    expect(plan).toEqual(heuristicPlan);
  });

  it("falls back to heuristic when no intent is given, without needing a provider", async () => {
    const heuristicPlan = await new HeuristicOrganizePlanner().plan(panes, undefined);
    const planner = new LlmOrganizePlanner(new HeuristicOrganizePlanner(), null);
    const plan = await planner.plan(panes);
    expect(plan).toEqual(heuristicPlan);
  });

  it("parses a well-formed reply from the provider into a real plan", async () => {
    const reply = JSON.stringify({
      summary: "one rename",
      steps: [{ op: "rename-window", window: { kind: "window", windowId: "@1" }, name: "alpha", description: "rename it" }],
    });
    const argv = providerArgv(`process.stdout.write(${JSON.stringify(reply)})`);
    const planner = new LlmOrganizePlanner(new HeuristicOrganizePlanner(), argv);

    const plan = await planner.plan(panes, "group by project");

    expect(plan.summary).toBe("one rename");
    expect(plan.steps).toEqual([
      { op: "rename-window", window: { kind: "window", windowId: "@1" }, name: "alpha", description: "rename it" },
    ]);
  });

  it("falls back to heuristic when the provider returns garbage", async () => {
    const argv = providerArgv(`process.stdout.write("not json at all")`);
    const heuristicPlan = await new HeuristicOrganizePlanner().plan(panes, "group by project");
    const planner = new LlmOrganizePlanner(new HeuristicOrganizePlanner(), argv);

    const plan = await planner.plan(panes, "group by project");

    expect(plan).toEqual(heuristicPlan);
  });

  it("falls back to heuristic when the provider exits nonzero", async () => {
    const argv = providerArgv(`process.exit(1)`);
    const heuristicPlan = await new HeuristicOrganizePlanner().plan(panes, "group by project");
    const planner = new LlmOrganizePlanner(new HeuristicOrganizePlanner(), argv);

    const plan = await planner.plan(panes, "group by project");

    expect(plan).toEqual(heuristicPlan);
  });

  it("falls back to heuristic when the reply parses to zero usable steps", async () => {
    const argv = providerArgv(`process.stdout.write('{"steps":[{"op":"kill-pane"}]}')`);
    const heuristicPlan = await new HeuristicOrganizePlanner().plan(panes, "group by project");
    const planner = new LlmOrganizePlanner(new HeuristicOrganizePlanner(), argv);

    const plan = await planner.plan(panes, "group by project");

    expect(plan).toEqual(heuristicPlan);
  });
});
