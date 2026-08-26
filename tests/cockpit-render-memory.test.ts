import { describe, expect, it } from "vitest";
import { renderCockpit } from "../src/cli/cockpit-render.js";
import type { WorkspaceSnapshot, PaneEntry } from "../src/core/workspace-types.js";

const pane = (id: string, rss: number, name: string): PaneEntry => ({
  identity: { paneId: id, windowId: "@1", active: false, harness: null, sessionId: null, cwd: `/x/${name}`, command: "node", pid: 1 },
  state: "working", semantics: null, resources: { perPaneRss: rss, ts: 0 }, lastActivityTs: 0, ts: 0, gone: false,
});
const snap: WorkspaceSnapshot = {
  version: 1, updatedAt: 0,
  panes: [pane("%1", 1e9, "small"), pane("%2", 5e9, "hog")],
  hostPressure: { usedRatio: 0.7, unattributed: 12e9, ts: 0 },
  guardianLog: [{ ts: 0, pressure: 0.92, culpritPaneId: null, culpritLabel: "a source outside tracked panes", action: "log-only", message: "host memory 92% — top consumer: a source outside tracked panes" }],
};

describe("cockpit memory view", () => {
  it("ranks the hog first and shows the guardian log", () => {
    const lines = renderCockpit(snap, 0);
    const hogIdx = lines.findIndex((l) => l.includes("hog"));
    const smallIdx = lines.findIndex((l) => l.includes("small"));
    expect(hogIdx).toBeLessThan(smallIdx);
    expect(lines.join("\n")).toContain("host memory 92%");
  });
  it("surfaces dominant unattributed memory honestly", () => {
    expect(renderCockpit(snap, 0).join("\n")).toContain("unattributed");
  });
});
