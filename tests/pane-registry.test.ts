import { describe, expect, it } from "vitest";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";
import { PaneRegistry } from "../src/services/pane-registry.js";
import type { TmuxPane } from "../src/core/types.js";

const pane = (id: string, cmd = "node"): TmuxPane => ({
  paneId: id, left: 0, top: 0, width: 80, height: 24, cwd: "/x", command: cmd, pid: 10, windowId: "@1", active: false,
});
// resolve stub: nothing is an agent
const noResolve = async (panes: TmuxPane[]) => panes.map((p) => ({ pane: p, record: null }));

describe("PaneRegistry.diff", () => {
  it("reports appeared panes on first diff", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([pane("%1"), pane("%2")]);
    const reg = new PaneRegistry(gw, noResolve);
    const d = await reg.diff();
    expect(d.appeared.sort()).toEqual(["%1", "%2"]);
    expect(d.vanished).toEqual([]);
    expect(d.present).toHaveLength(2);
  });
  it("reports vanished panes on the next diff", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([pane("%1"), pane("%2")]);
    const reg = new PaneRegistry(gw, noResolve);
    await reg.diff();
    gw.setPanes([pane("%1")]);
    const d = await reg.diff();
    expect(d.appeared).toEqual([]);
    expect(d.vanished).toEqual(["%2"]);
  });
});
