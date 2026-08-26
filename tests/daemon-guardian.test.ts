import { describe, expect, it } from "vitest";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";
import { WorkspaceModel } from "../src/services/workspace.js";
import { Daemon } from "../src/services/daemon.js";
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
});
