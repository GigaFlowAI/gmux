import { describe, expect, it } from "vitest";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";
import { WorkspaceModel } from "../src/services/workspace.js";
import { Daemon } from "../src/services/daemon.js";
import type { Sensor } from "../src/services/sensors.js";

class Busy implements Sensor {
  readonly kind = "terminal" as const;
  constructor(private id: { paneId: string }) {}
  async observe(now: number) {
    return { paneId: this.id.paneId, kind: "terminal" as const, ts: now, tailLines: [], lastActivityTs: now };
  }
  async teardown() {}
}

describe("gm invariants", () => {
  it("a gateway that throws on listPanes does not crash the tick", async () => {
    const gw = new FakeTmuxGateway();
    (gw as any).listPanes = async () => {
      throw new Error("tmux down");
    };
    const model = new WorkspaceModel();
    const d = new Daemon({ gateway: gw, model, now: () => 0, makeSensor: (id) => new Busy(id) });
    await expect(d.tickOnce()).resolves.toBeUndefined(); // swallowed, loop survives
  });

  it("a sensor that throws leaves other panes classified", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([
      { paneId: "%good", left: 0, top: 0, width: 80, height: 24, cwd: "/x", command: "zsh", pid: 1, windowId: "@1", active: true },
      { paneId: "%bad", left: 0, top: 0, width: 80, height: 24, cwd: "/x", command: "zsh", pid: 2, windowId: "@1", active: false },
    ]);
    const model = new WorkspaceModel();
    const d = new Daemon({
      gateway: gw,
      model,
      now: () => 100_000,
      makeSensor: (id) =>
        id.paneId === "%bad"
          ? ({ kind: "terminal", observe: async () => { throw new Error("boom"); }, teardown: async () => {} } as Sensor)
          : new Busy(id),
    });
    await d.tickOnce();
    const panes = model.snapshot().panes;
    expect(panes.find((p) => p.identity.paneId === "%good")!.state).toBe("working");
  });
});
