import { describe, expect, it } from "vitest";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";
import { FakeMuxGateway } from "../src/services/mux-gateway.js";
import { WorkspaceModel } from "../src/services/workspace.js";
import { Daemon } from "../src/services/daemon.js";
import { SidecarDaemon } from "../src/services/sidecar-daemon.js";
import { ResourceMonitor } from "../src/services/resources.js";
import { Guardian } from "../src/services/guardian.js";
import type { Sensor } from "../src/services/sensors.js";

// An agent pane: resolve stub makes it look resolved by giving the registry a link is hard here,
// so drive identity via a makeSensor + a resolve that marks harness. Simpler: use gateway pane whose
// registry resolve returns a record. For this test, inject makeSensor and rely on resources+guardian.
const pane = { paneId: "%1", left: 0, top: 0, width: 80, height: 24, cwd: "/x/webshop-build", command: "node", pid: 100, windowId: "@1", active: true };
class Busy implements Sensor { readonly kind = "terminal" as const; constructor(private id: {paneId:string}) {}
  async observe(now: number){return {paneId:this.id.paneId,kind:"terminal" as const,ts:now,tailLines:[],lastActivityTs:now};} async teardown(){} }

describe("daemon guardian integration", () => {
  it("broadcasts to an agent pane over threshold and logs it", async () => {
    const gw = new FakeTmuxGateway(); gw.setPanes([pane]);
    const model = new WorkspaceModel();
    // Force the pane to be an agent by resolving it via a custom registry resolve is out of scope here;
    // instead assert the log entry + that a send happened when guardian sees an agent.
    const resources = new ResourceMonitor({
      psSnapshot: async () => "  PID  PPID    RSS COMM\n  100     1  9000000 node\n",
      hostMemory: async () => ({ usedRatio: 0.95, usedBytes: 32e9 }),
    });
    const guardian = new Guardian({ policy: "auto", threshold: 0.9, cooldownSeconds: 300 });
    const d = new Daemon({
      gateway: gw, model, now: () => 100_000, makeSensor: (id) => new Busy(id),
      resources, guardian,
      // resolveOverride marks every pane as an agent for this test:
      resolveAgents: (panes) => panes.map((p) => p.paneId),
    });
    await d.tickOnce();
    const snap = model.snapshot();
    expect(snap.hostPressure!.usedRatio).toBe(0.95);
    expect(snap.guardianLog.length).toBe(1);
    expect(gw.sent.length).toBeGreaterThan(0);
  });

  it("sidecar broadcasts via guardian.broadcast, never pane.send_keys", async () => {
    const gw = new FakeMuxGateway();
    const spawned = await gw.spawn({ cwd: "/x/webshop", argv: ["node"] });
    const panes = await gw.listPanes();
    const pid = panes[0]!.pid;
    const broadcasts: string[] = [];
    const d = new SidecarDaemon({
      gateway: gw,
      model: new WorkspaceModel(),
      now: () => 100_000,
      makeSensor: (id) => new Busy(id),
      resources: new ResourceMonitor({
        psSnapshot: async () => `  PID  PPID    RSS COMM\n  ${pid}     1  9000000 node\n`,
        hostMemory: async () => ({ usedRatio: 0.95, usedBytes: 32e9 }),
      }),
      guardian: new Guardian({ policy: "auto", threshold: 0.9, cooldownSeconds: 300 }),
      resolveAgents: (present) => present.map((p) => p.paneId),
      broadcast: async (message) => { broadcasts.push(message); },
    });
    await d.tickOnce();
    expect(gw.sent).toEqual([]);
    expect(broadcasts.length).toBeGreaterThan(0);
    expect(broadcasts[0]).not.toMatch(/window `/);
    expect(spawned.paneId).toBeTruthy();
  });

  it("reports harness and sessionId onto mux before broadcast", async () => {
    const gw = new FakeMuxGateway();
    await gw.spawn({ cwd: "/x/webshop", argv: ["node"] });
    const panes = await gw.listPanes();
    const pid = panes[0]!.pid;
    const patches: Array<{ harness?: string | null; sessionId?: string | null }> = [];
    const broadcasts: string[] = [];
    const d = new SidecarDaemon({
      gateway: gw,
      model: new WorkspaceModel(),
      now: () => 100_000,
      makeSensor: (id) => new Busy(id),
      resources: new ResourceMonitor({
        psSnapshot: async () => `  PID  PPID    RSS COMM\n  ${pid}     1  9000000 node\n`,
        hostMemory: async () => ({ usedRatio: 0.95, usedBytes: 32e9 }),
      }),
      guardian: new Guardian({ policy: "auto", threshold: 0.9, cooldownSeconds: 300 }),
      resolveAgents: (present) => present.map((p) => p.paneId),
      report: async (patch) => { patches.push(patch); },
      broadcast: async (message) => { broadcasts.push(message); },
    });
    await d.tickOnce();
    expect(patches.some((p) => p.harness === "test-agent" && Boolean(p.sessionId))).toBe(true);
    expect(broadcasts.length).toBeGreaterThan(0);
  });

  it("does not invent a broadcast when intel is down (no broadcast hook)", async () => {
    const gw = new FakeMuxGateway();
    await gw.spawn({ cwd: "/x/webshop", argv: ["node"] });
    const panes = await gw.listPanes();
    const pid = panes[0]!.pid;
    const d = new SidecarDaemon({
      gateway: gw,
      model: new WorkspaceModel(),
      now: () => 100_000,
      makeSensor: (id) => new Busy(id),
      resources: new ResourceMonitor({
        psSnapshot: async () => `  PID  PPID    RSS COMM\n  ${pid}     1  9000000 node\n`,
        hostMemory: async () => ({ usedRatio: 0.95, usedBytes: 32e9 }),
      }),
      guardian: new Guardian({ policy: "auto", threshold: 0.9, cooldownSeconds: 300 }),
      resolveAgents: (present) => present.map((p) => p.paneId),
    });
    await d.tickOnce();
    expect(gw.sent).toEqual([]);
  });
});
