import { describe, expect, it } from "vitest";
import { renderCockpit, formatBytes, relativeTime } from "../src/cli/cockpit-render.js";
import type { WorkspaceSnapshot } from "../src/core/workspace-types.js";

const snap: WorkspaceSnapshot = {
  version: 3, updatedAt: 100_000,
  panes: [{
    identity: { paneId: "%1", windowId: "@1", active: true, harness: "claude-code", sessionId: "s", cwd: "/x/webshop", command: "node", pid: 1 },
    state: "working", semantics: { label: "running e2e tests", card: null, fingerprint: "x", updatedAt: 0, stale: false },
    resources: { perPaneRss: 4_509_715_660, ts: 0 }, lastActivityTs: 95_000, ts: 95_000, gone: false,
  }],
  hostPressure: null, guardianLog: [],
};

describe("renderCockpit", () => {
  it("formats bytes and relative time", () => {
    expect(formatBytes(4_509_715_660)).toBe("4.2 GB");
    expect(relativeTime(95_000, 100_000)).toBe("5s ago");
  });
  it("renders a pane row with glyph, project, label, memory, activity", () => {
    const lines = renderCockpit(snap, 100_000, 120).join("\n");
    expect(lines).toContain("● webshop");
    expect(lines).toContain("running e2e tests");
    expect(lines).toContain("4.2 GB");
    expect(lines).toContain("5s ago");
  });
});

describe("cockpit chrome", () => {
  it("always shows the work-report key hint (ctrl-v, since v types into the prompt)", () => {
    expect(renderCockpit(snap, 100_000, 120).join("\n")).toContain("⌃v: work report");
  });
  it("shows a status banner when one is set", () => {
    const lines = renderCockpit(snap, 100_000, { status: "✓ work report: file:///tmp/x.html" }).join("\n");
    expect(lines).toContain("file:///tmp/x.html");
  });
});

describe("cockpit ask answers", () => {
  it("renders the question and each session's answer", () => {
    const lines = renderCockpit(snap, 100_000, {
      ask: { question: "what's blocking?", rows: [{ label: "webshop", answer: "waiting on CI" }] },
    }).join("\n");
    expect(lines).toContain("» what's blocking?");
    expect(lines).toContain("webshop: waiting on CI");
  });
  it("shows an asking… placeholder until an answer lands", () => {
    const lines = renderCockpit(snap, 100_000, {
      ask: { question: "status?", rows: [{ label: "webshop", answer: null }] },
    }).join("\n");
    expect(lines).toContain("webshop: ⧗ asking…");
  });
  it("renders no answers block when there are no rows", () => {
    const lines = renderCockpit(snap, 100_000, { ask: { question: "x", rows: [] } }).join("\n");
    expect(lines).not.toContain("» x");
  });
});
