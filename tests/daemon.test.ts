import { describe, expect, it } from "vitest";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";
import { FakeMuxGateway } from "../src/services/mux-gateway.js";
import { WorkspaceModel } from "../src/services/workspace.js";
import { Daemon } from "../src/services/daemon.js";
import { SidecarDaemon } from "../src/services/sidecar-daemon.js";
import type { PaneIdentity, Observation } from "../src/core/gmux-types.js";
import type { Sensor } from "../src/services/sensors.js";
import type { TmuxPane } from "../src/core/types.js";

const pane = (id: string): TmuxPane => ({ paneId: id, left: 0, top: 0, width: 80, height: 24, cwd: "/x", command: "zsh", pid: 10, windowId: "@1", active: true });

// sensor stub: always "just active"
class StubSensor implements Sensor {
  readonly kind = "terminal" as const;
  constructor(private id: PaneIdentity, private now: () => number) {}
  async observe(now: number): Promise<Observation> { return { paneId: this.id.paneId, kind: "terminal", ts: now, tailLines: [], lastActivityTs: now }; }
  async teardown(): Promise<void> {}
}

describe("Daemon.tickOnce", () => {
  it("classifies a freshly-active pane as working and stores it", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([pane("%1")]);
    const model = new WorkspaceModel();
    let clock = 100_000;
    const d = new Daemon({ gateway: gw, model, now: () => clock, makeSensor: (id) => new StubSensor(id, () => clock) });
    await d.tickOnce();
    expect(model.snapshot().panes[0]!.state).toBe("working");
  });
  it("evicts a pane that vanishes", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([pane("%1")]);
    const model = new WorkspaceModel();
    let clock = 100_000;
    const d = new Daemon({ gateway: gw, model, now: () => clock, makeSensor: (id) => new StubSensor(id, () => clock) });
    await d.tickOnce();
    gw.setPanes([]);
    await d.tickOnce();
    expect(model.snapshot().panes).toHaveLength(0);
  });
});

describe("SidecarDaemon.tickOnce", () => {
  it("classifies a mux pane as working and reports a patch by paneId", async () => {
    const gw = new FakeMuxGateway();
    const spawned = await gw.spawn({ cwd: "/t", argv: ["zsh"] });
    gw.setGrid(spawned.paneId, {
      paneId: spawned.paneId,
      cols: 80,
      rows: 24,
      lines: [{ text: "hello", intensity: [1, 1, 1, 1, 1] }],
      alternateScreen: false,
      foregroundCommand: "zsh",
    });
    const model = new WorkspaceModel();
    const patches: Array<{ paneId: string; state?: string }> = [];
    const d = new SidecarDaemon({
      gateway: gw,
      model,
      now: () => 100_000,
      report: async (patch) => { patches.push(patch); },
    });
    await d.tickOnce();
    expect(model.snapshot().panes[0]!.state).toBe("working");
    expect(patches[0]?.paneId).toBe(spawned.paneId);
    expect(patches[0]?.state).toBe("working");
  });
});
