import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";
import { WorkspaceModel } from "../src/services/workspace.js";
import { Daemon } from "../src/services/daemon.js";
import { ModelServer } from "../src/services/daemon-socket.js";
import { subscribe } from "../src/services/daemon-client.js";
import type { WorkspaceSnapshot } from "../src/core/workspace-types.js";
import type { Sensor } from "../src/services/sensors.js";

let server: ModelServer | undefined;
afterEach(async () => { await server?.stop(); });

class ActiveSensor implements Sensor {
  readonly kind = "terminal" as const;
  constructor(private id: { paneId: string }) {}
  async observe(now: number) { return { paneId: this.id.paneId, kind: "terminal" as const, ts: now, tailLines: [], lastActivityTs: now }; }
  async teardown() {}
}

describe("gm phase 0 — always-on loop", () => {
  it("a pane's state reaches a socket subscriber without any LLM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-"));
    const sock = join(dir, "d.sock");
    const snap = join(dir, "snap.json");
    const gw = new FakeTmuxGateway();
    gw.setPanes([{ paneId: "%9", left: 0, top: 0, width: 80, height: 24, cwd: "/x/webshop", command: "node", pid: 5, windowId: "@1", active: true }]);
    const model = new WorkspaceModel();
    server = new ModelServer(model, sock, snap);
    await server.start();
    const daemon = new Daemon({ gateway: gw, model, now: () => 100_000, makeSensor: (id) => new ActiveSensor(id) });

    const seen: WorkspaceSnapshot[] = [];
    const got = new Promise<void>((resolve) => {
      const stop = subscribe((s) => { seen.push(s); if (s.panes.some((p) => p.state === "working")) { stop(); resolve(); } }, { socketPath: sock });
    });
    await daemon.tickOnce();
    await got;
    expect(seen.at(-1)!.panes[0]!.identity.paneId).toBe("%9");
    expect(seen.at(-1)!.panes[0]!.state).toBe("working");
  });
});
