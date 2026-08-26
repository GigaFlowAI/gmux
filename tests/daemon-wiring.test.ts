/**
 * Regression-proofs FIX A: `gmux daemon run` must assemble ALL four phases.
 *
 * Hermetic — no real processes, no socket. It exercises the pure assembly
 * helper `buildDaemonDeps` (what the `run` action calls) and asserts the
 * returned deps carry a semantic worker, a resource monitor, and a guardian
 * configured from the passed `GmuxConfig`.
 */
import { describe, expect, it } from "vitest";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";
import { buildDaemonDeps } from "../src/cli/commands/daemon.js";
import { WorkspaceModel } from "../src/services/workspace.js";
import { Guardian } from "../src/services/guardian.js";
import { ResourceMonitor } from "../src/services/resources.js";
import { SemanticWorker, type LabelProvider } from "../src/services/semantic.js";
import type { GmuxConfig, HostPressure, PaneEntry } from "../src/core/gmux-types.js";

const stubProvider: LabelProvider = {
  async label() {
    return { label: "stub", card: "stub" };
  },
};

const sampleConfig: GmuxConfig = {
  guardianPolicy: "notify",
  memoryThreshold: 0.5,
  cooldownSeconds: 300,
  tickMs: 1500,
};

describe("buildDaemonDeps", () => {
  it("assembles all four phases (gateway/model + semantic + resources + guardian)", () => {
    const gateway = new FakeTmuxGateway();
    const model = new WorkspaceModel();
    const deps = buildDaemonDeps(gateway, model, sampleConfig, stubProvider);

    expect(deps.gateway).toBe(gateway);
    expect(deps.model).toBe(model);
    expect(typeof deps.now).toBe("function");
    expect(deps.semantic).toBeInstanceOf(SemanticWorker);
    expect(deps.resources).toBeInstanceOf(ResourceMonitor);
    expect(deps.guardian).toBeInstanceOf(Guardian);
    // Production must NOT wire the test-only agent-resolution seam.
    expect(deps.resolveAgents).toBeUndefined();
  });

  it("configures the guardian from the passed config (policy + threshold)", () => {
    const deps = buildDaemonDeps(new FakeTmuxGateway(), new WorkspaceModel(), sampleConfig, stubProvider);

    // usedRatio 0.6 is over the config's 0.5 threshold but UNDER the default
    // 0.9 — so a "notify" here proves both the policy and the threshold came
    // from `sampleConfig`, not from DEFAULT_GMUX_CONFIG.
    const host: HostPressure = { usedRatio: 0.6, unattributed: 0, ts: 1000 };
    const agent: PaneEntry = {
      identity: {
        paneId: "%1", windowId: "@1", active: true, harness: "claude", sessionId: "s1",
        cwd: "/x", command: "claude", pid: 10,
      },
      state: "working", semantics: null, resources: { perPaneRss: 1024, ts: 1000 },
      lastActivityTs: 0, ts: 1000, gone: false,
    };
    const decision = deps.guardian!.decide(host, [agent], 1000);
    expect(decision.action).toBe("notify");
  });
});
