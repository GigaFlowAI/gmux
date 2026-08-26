/**
 * `gmux organize`: the heuristic planner, the LLM planner's reply parsing +
 * defensive fallback, and `applyPlan`'s executor.
 *
 * No real mux, no real LLM — non-negotiables #2 and #3. The "LLM" tests spawn
 * a `node -e` script as the provider argv (same trick `provider-process.test.ts`
 * uses): deterministic, no model, no network.
 */

import { describe, expect, it } from "vitest";

import type { OrganizePane, OrganizePlan } from "../src/core/organize-types.js";
import { ORGANIZE_PLAN_SCHEMA_VERSION } from "../src/core/organize-types.js";
import { SCHEMA_VERSION } from "../src/core/types.js";
import {
  HeuristicOrganizePlanner,
  LlmOrganizePlanner,
  applyPlan,
  parseOrganizePlan,
} from "../src/services/organize.js";
import { FakeMuxGateway } from "../src/services/mux-gateway.js";

function pane(overrides: Partial<OrganizePane> & { paneId: string }): OrganizePane {
  return {
    tabId: null,
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

describe("schema versions", () => {
  it("keeps SCHEMA_VERSION at 1; organize plans are schemaVersion 2", () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(ORGANIZE_PLAN_SCHEMA_VERSION).toBe(2);
  });
});

describe("HeuristicOrganizePlanner", () => {
  it("v2 plan has schemaVersion 2 and no select-layout", async () => {
    const planner = new HeuristicOrganizePlanner();
    const plan = await planner.plan([
      pane({ paneId: "p_A", cwd: "/r/web", harness: "claude-code" }),
      pane({ paneId: "p_B", cwd: "/r/web", harness: "claude-code" }),
      pane({ paneId: "p_C", cwd: "/r/bill", harness: "codex" }),
    ]);
    expect(plan.schemaVersion).toBe(2);
    expect(plan.steps.some((s) => ["select-layout", "swap-pane", "new-window"].includes(s.op as string))).toBe(false);
    expect(plan.steps.every((s) => ["new-tab", "rename-tab", "move-pane", "break-pane"].includes(s.op))).toBe(true);
  });

  it("groups two projects into two tabs, each renamed, with no tiled layout step", async () => {
    const panes: OrganizePane[] = [
      pane({ paneId: "p_1", tabId: "t_1", cwd: "/repo/alpha", label: "fixing auth" }),
      pane({ paneId: "p_2", tabId: "t_2", cwd: "/repo/alpha", label: "writing tests" }),
      pane({ paneId: "p_3", tabId: "t_3", cwd: "/repo/beta", label: "refactor db" }),
    ];

    const plan = await new HeuristicOrganizePlanner().plan(panes);

    expect(plan.schemaVersion).toBe(2);
    expect(plan.summary).toBe("2 project tab(s), 1 pane(s) moved");
    expect(plan.steps).toEqual([
      { op: "rename-tab", tab: { kind: "tab", tabId: "t_1" }, name: "alpha", description: 'Rename tab to "alpha"' },
      { op: "move-pane", paneId: "p_2", to: { kind: "tab", tabId: "t_1" }, description: 'Move p_2 (writing tests) → "alpha"' },
      { op: "rename-tab", tab: { kind: "tab", tabId: "t_3" }, name: "beta", description: 'Rename tab to "beta"' },
    ]);
  });

  it("synthesizes a fresh tab when no pane in a project group has a tabId", async () => {
    const panes: OrganizePane[] = [pane({ paneId: "p_1", tabId: null, cwd: "/repo/gamma" })];

    const plan = await new HeuristicOrganizePlanner().plan(panes);

    expect(plan.steps[0]).toEqual({
      op: "new-tab",
      handle: "t:gamma",
      name: "gamma",
      description: 'Create tab "gamma"',
    });
    expect(plan.steps.some((s) => s.op === "rename-tab")).toBe(false);
    expect(plan.steps).toEqual([
      { op: "new-tab", handle: "t:gamma", name: "gamma", description: 'Create tab "gamma"' },
      { op: "move-pane", paneId: "p_1", to: { kind: "handle", handle: "t:gamma" }, description: 'Move p_1 (claude) → "gamma"' },
    ]);
  });

  it("gathers two or more idle shells into one shells tab", async () => {
    const panes: OrganizePane[] = [
      pane({ paneId: "p_1", tabId: "t_1", cwd: "/repo/alpha" }),
      pane({ paneId: "p_9", tabId: "t_9", cwd: "/x", command: "zsh", harness: null, state: "idle" }),
      pane({ paneId: "p_8", tabId: "t_8", cwd: "/x", command: "-bash", harness: null, state: null }),
    ];

    const plan = await new HeuristicOrganizePlanner().plan(panes);

    expect(plan.steps).toContainEqual({
      op: "new-tab",
      handle: "t:shells",
      name: "shells",
      description: 'Create tab "shells"',
    });
    expect(plan.steps).toContainEqual({
      op: "move-pane",
      paneId: "p_8",
      to: { kind: "handle", handle: "t:shells" },
      description: 'Move p_8 (-bash) → "shells"',
    });
    expect(plan.steps).toContainEqual({
      op: "move-pane",
      paneId: "p_9",
      to: { kind: "handle", handle: "t:shells" },
      description: 'Move p_9 (zsh) → "shells"',
    });
    expect(plan.steps.some((s) => (s.op as string) === "select-layout")).toBe(false);
  });

  it("emits nothing for a lone idle shell — not worth its own tab", async () => {
    const panes: OrganizePane[] = [
      pane({ paneId: "p_1", tabId: "t_1", cwd: "/repo/alpha" }),
      pane({ paneId: "p_9", tabId: "t_9", cwd: "/x", command: "zsh", harness: null, state: "idle" }),
    ];

    const plan = await new HeuristicOrganizePlanner().plan(panes);

    expect(plan.steps.some((s) => s.op === "move-pane" && s.paneId === "p_9")).toBe(false);
    expect(plan.steps.some((s) => s.op === "new-tab" && s.name === "shells")).toBe(false);
  });

  it("skips a redundant move when panes are already grouped in the anchor tab", async () => {
    const panes: OrganizePane[] = [
      pane({ paneId: "p_1", tabId: "t_1", cwd: "/repo/alpha" }),
      pane({ paneId: "p_2", tabId: "t_1", cwd: "/repo/alpha" }),
    ];

    const plan = await new HeuristicOrganizePlanner().plan(panes);

    expect(plan.steps.some((s) => s.op === "move-pane")).toBe(false);
    expect(plan.summary).toBe("1 project tab(s), 0 pane(s) moved");
  });

  it("treats a bare shell mid-'working' as agent-class, never sweeping it into shells", async () => {
    const panes: OrganizePane[] = [
      pane({ paneId: "p_1", tabId: "t_1", cwd: "/repo/alpha", command: "zsh", harness: null, state: "working" }),
    ];

    const plan = await new HeuristicOrganizePlanner().plan(panes);

    expect(plan.steps.some((s) => s.op === "new-tab" && s.name === "shells")).toBe(false);
    expect(plan.steps.some((s) => s.op === "rename-tab" && s.name === "alpha")).toBe(true);
  });

  it("never emits a destructive op — the union has none to emit", async () => {
    const panes: OrganizePane[] = [
      pane({ paneId: "p_1", tabId: "t_1", cwd: "/repo/alpha" }),
      pane({ paneId: "p_2", tabId: "t_2", cwd: "/repo/beta" }),
      pane({ paneId: "p_9", tabId: "t_9", cwd: "/x", command: "zsh", harness: null, state: "idle" }),
      pane({ paneId: "p_8", tabId: "t_8", cwd: "/x", command: "bash", harness: null, state: "idle" }),
    ];
    const plan = await new HeuristicOrganizePlanner().plan(panes);
    const allowedOps = new Set(["new-tab", "rename-tab", "move-pane", "break-pane"]);
    for (const step of plan.steps) expect(allowedOps.has(step.op)).toBe(true);
  });

  it("is a pure function of its input: identical calls produce identical plans", async () => {
    const panes: OrganizePane[] = [
      pane({ paneId: "p_2", tabId: "t_2", cwd: "/repo/beta" }),
      pane({ paneId: "p_1", tabId: "t_1", cwd: "/repo/alpha" }),
      pane({ paneId: "p_9", tabId: null, cwd: "/x", command: "fish", harness: null, state: "idle" }),
      pane({ paneId: "p_8", tabId: null, cwd: "/x", command: "sh", harness: null, state: "idle" }),
    ];
    const planner = new HeuristicOrganizePlanner();
    const first = await planner.plan([...panes]);
    const second = await planner.plan([...panes].reverse());
    expect(second).toEqual(first);
  });

  it("never references a pane id absent from the input, and binds every handle before use", async () => {
    const panes: OrganizePane[] = [
      pane({ paneId: "p_1", tabId: null, cwd: "/repo/alpha" }),
      pane({ paneId: "p_2", tabId: null, cwd: "/repo/alpha" }),
    ];
    const plan = await new HeuristicOrganizePlanner().plan(panes);
    const paneIds = new Set(panes.map((p) => p.paneId));
    const bound = new Set<string>();
    for (const step of plan.steps) {
      if (step.op === "new-tab" || step.op === "break-pane") bound.add(step.handle);
      if (step.op === "move-pane") {
        expect(paneIds.has(step.paneId)).toBe(true);
        if (step.to.kind === "handle") expect(bound.has(step.to.handle)).toBe(true);
      }
      if (step.op === "rename-tab" && step.tab.kind === "handle") {
        expect(bound.has(step.tab.handle)).toBe(true);
      }
    }
  });
});

describe("parseOrganizePlan", () => {
  const panes: OrganizePane[] = [pane({ paneId: "p_1" }), pane({ paneId: "p_2" })];

  it("parses a bare JSON object", () => {
    const raw = '{"summary":"one move","steps":[{"op":"move-pane","paneId":"p_1","to":{"kind":"tab","tabId":"t_1"},"description":"move it"}]}';
    const plan = parseOrganizePlan(raw, panes);
    expect(plan.schemaVersion).toBe(2);
    expect(plan.summary).toBe("one move");
    expect(plan.steps).toEqual([
      { op: "move-pane", paneId: "p_1", to: { kind: "tab", tabId: "t_1" }, description: "move it" },
    ]);
  });

  it("takes the outermost braces from a fenced reply", () => {
    const raw = '```json\n{"summary":"s","steps":[]}\n```';
    expect(parseOrganizePlan(raw, panes)).toEqual({ schemaVersion: 2, summary: "s", steps: [] });
  });

  it("takes the outermost braces from a prefaced reply", () => {
    const raw = 'Sure, here is the plan:\n{"summary":"s","steps":[]}\nLet me know if you want changes.';
    expect(parseOrganizePlan(raw, panes)).toEqual({ schemaVersion: 2, summary: "s", steps: [] });
  });

  it("drops a step with an unknown op", () => {
    const raw = '{"steps":[{"op":"kill-pane","paneId":"p_1","description":"x"}]}';
    expect(parseOrganizePlan(raw, panes).steps).toEqual([]);
  });

  it("drops select-layout, swap-pane, and new-window as unknown ops", () => {
    const raw =
      '{"steps":[' +
      '{"op":"select-layout","window":{"kind":"window","windowId":"@1"},"layout":"tiled","description":"x"},' +
      '{"op":"swap-pane","a":"p_1","b":"p_2","description":"x"},' +
      '{"op":"new-window","handle":"w:x","name":"x","description":"x"}' +
      "]}";
    expect(parseOrganizePlan(raw, panes).steps).toEqual([]);
  });

  it("drops a step referencing a pane id absent from the input", () => {
    const raw = '{"steps":[{"op":"move-pane","paneId":"p_999","to":{"kind":"tab","tabId":"t_1"},"description":"x"}]}';
    expect(parseOrganizePlan(raw, panes).steps).toEqual([]);
  });

  it("drops a step referencing a handle never bound by an earlier step", () => {
    const raw = '{"steps":[{"op":"move-pane","paneId":"p_1","to":{"kind":"handle","handle":"t:ghost"},"description":"x"}]}';
    expect(parseOrganizePlan(raw, panes).steps).toEqual([]);
  });

  it("accepts a handle bound by an earlier step in the same reply", () => {
    const raw =
      '{"steps":[' +
      '{"op":"new-tab","handle":"t:x","name":"x","description":"create"},' +
      '{"op":"move-pane","paneId":"p_1","to":{"kind":"handle","handle":"t:x"},"description":"move"}' +
      "]}";
    expect(parseOrganizePlan(raw, panes).steps).toHaveLength(2);
  });

  it("returns an empty plan for garbage input", () => {
    expect(parseOrganizePlan("not json at all", panes)).toEqual({ schemaVersion: 2, summary: "", steps: [] });
  });

  it("falls back to a computed summary when the model omits one", () => {
    const raw = '{"steps":[{"op":"new-tab","handle":"t:x","name":"x","description":"create"}]}';
    expect(parseOrganizePlan(raw, panes).summary).toBe("1 step(s)");
  });
});

describe("applyPlan", () => {
  it("executes new-tab, move-pane and records them on the gateway — no layout call", async () => {
    const gw = new FakeMuxGateway();
    const spawned = await gw.spawn({ cwd: "/a", argv: ["claude"], tab: { mode: "new", name: "main" } });
    const plan: OrganizePlan = {
      schemaVersion: 2,
      summary: "s",
      steps: [
        { op: "new-tab", handle: "t:x", name: "x", description: "create" },
        { op: "move-pane", paneId: spawned.paneId, to: { kind: "handle", handle: "t:x" }, description: "move" },
      ],
    };

    const result = await applyPlan(plan, gw);

    expect(result.skipped).toEqual([]);
    expect(result.applied).toHaveLength(2);
    expect(gw.createdTabs.some((t) => t.name === "x")).toBe(true);
    const dest = gw.createdTabs.find((t) => t.name === "x")!.tabId;
    expect(gw.moved).toEqual([{ srcPane: spawned.paneId, dstTab: dest }]);
  });

  it("skips a move-pane for a pane that vanished, and still applies the rest", async () => {
    const gw = new FakeMuxGateway();
    const spawned = await gw.spawn({ cwd: "/a", argv: ["claude"], tab: { mode: "existing", tabId: "t_1" } });
    const plan: OrganizePlan = {
      schemaVersion: 2,
      summary: "s",
      steps: [
        { op: "move-pane", paneId: "p_gone", to: { kind: "tab", tabId: spawned.tabId }, description: "gone" },
        { op: "rename-tab", tab: { kind: "tab", tabId: spawned.tabId }, name: "alpha", description: "rename" },
      ],
    };

    const result = await applyPlan(plan, gw);

    expect(result.applied).toEqual([plan.steps[1]]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain("p_gone");
    expect(gw.renamed).toEqual([{ tabId: spawned.tabId, name: "alpha" }]);
  });

  it("resolves a handle bound by an earlier new-tab to the fake's minted tab id", async () => {
    const gw = new FakeMuxGateway();
    const spawned = await gw.spawn({ cwd: "/a", argv: ["claude"] });
    const plan: OrganizePlan = {
      schemaVersion: 2,
      summary: "s",
      steps: [
        { op: "new-tab", handle: "t:first", name: "first", description: "create first" },
        { op: "new-tab", handle: "t:second", name: "second", description: "create second" },
        { op: "move-pane", paneId: spawned.paneId, to: { kind: "handle", handle: "t:second" }, description: "move into second" },
      ],
    };

    const result = await applyPlan(plan, gw);

    expect(result.skipped).toEqual([]);
    const created = gw.createdTabs.filter((t) => t.name === "first" || t.name === "second");
    expect(created.map((t) => t.name)).toEqual(["first", "second"]);
    expect(gw.moved).toEqual([{ srcPane: spawned.paneId, dstTab: created[1]!.tabId }]);
  });

  it("skips a step referencing an unbound handle without touching the gateway", async () => {
    const gw = new FakeMuxGateway();
    const spawned = await gw.spawn({ cwd: "/a", argv: ["claude"] });
    const plan: OrganizePlan = {
      schemaVersion: 2,
      summary: "s",
      steps: [{ op: "move-pane", paneId: spawned.paneId, to: { kind: "handle", handle: "t:ghost" }, description: "x" }],
    };

    const result = await applyPlan(plan, gw);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain("t:ghost");
    expect(gw.moved).toEqual([]);
  });

  it("skips just the step whose gateway call throws, and keeps applying the rest", async () => {
    const gw = new FakeMuxGateway();
    const a = await gw.spawn({ cwd: "/a", argv: ["claude"], tab: { mode: "existing", tabId: "t_1" } });
    await gw.spawn({ cwd: "/a", argv: ["claude"], tab: { mode: "existing", tabId: "t_2" } });
    gw.movePane = async () => {
      throw new Error("mux: can't move that pane");
    };

    const plan: OrganizePlan = {
      schemaVersion: 2,
      summary: "s",
      steps: [
        { op: "move-pane", paneId: a.paneId, to: { kind: "tab", tabId: "t_2" }, description: "move" },
        { op: "rename-tab", tab: { kind: "tab", tabId: "t_1" }, name: "alpha", description: "rename" },
      ],
    };

    const result = await applyPlan(plan, gw);

    expect(result.applied).toEqual([plan.steps[1]]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain("can't move");
    expect(gw.renamed).toEqual([{ tabId: "t_1", name: "alpha" }]);
  });

  it("skips a v1 plan rather than applying window ops to mux", async () => {
    const gw = new FakeMuxGateway();
    await gw.spawn({ cwd: "/a", argv: ["claude"] });
    const plan = {
      schemaVersion: 1,
      summary: "legacy",
      steps: [{ op: "new-tab", handle: "t:x", name: "x", description: "create" }],
    } as OrganizePlan;

    const result = await applyPlan(plan, gw);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain("schemaVersion 1");
    expect(gw.createdTabs.filter((t) => t.name === "x")).toEqual([]);
  });

  it("never calls a destructive gateway method — close is not an organize verb", async () => {
    const gw = new FakeMuxGateway();
    const plan: OrganizePlan = { schemaVersion: 2, summary: "s", steps: [] };
    await applyPlan(plan, gw);
    expect(gw.closed).toEqual([]);
  });
});

describe("LlmOrganizePlanner", () => {
  const panes: OrganizePane[] = [pane({ paneId: "p_1", tabId: "t_1", cwd: "/repo/alpha" })];

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
      steps: [{ op: "rename-tab", tab: { kind: "tab", tabId: "t_1" }, name: "alpha", description: "rename it" }],
    });
    const argv = providerArgv(`process.stdout.write(${JSON.stringify(reply)})`);
    const planner = new LlmOrganizePlanner(new HeuristicOrganizePlanner(), argv);

    const plan = await planner.plan(panes, "group by project");

    expect(plan.schemaVersion).toBe(2);
    expect(plan.summary).toBe("one rename");
    expect(plan.steps).toEqual([
      { op: "rename-tab", tab: { kind: "tab", tabId: "t_1" }, name: "alpha", description: "rename it" },
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
