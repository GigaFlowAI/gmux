import { describe, expect, it } from "vitest";
import { snapshotLabel, stateGlyph } from "../src/cli/tmux-label.js";
import type { PaneEntry } from "../src/core/workspace-types.js";

const entry = (over: Partial<PaneEntry>): PaneEntry => ({
  identity: { paneId: "%1", windowId: "@1", active: true, harness: null, sessionId: null, cwd: "/x/webshop", command: "node", pid: 1 },
  state: "working", semantics: null, resources: null, lastActivityTs: 0, ts: 0, gone: false, ...over,
});

describe("border labels from snapshot", () => {
  it("maps states to glyphs", () => {
    expect(stateGlyph("working")).toBe("●");
    expect(stateGlyph("waiting")).toBe("◔");
    expect(stateGlyph("error")).toBe("✗");
  });
  it("uses the project name and falls back to state when unsummarized", () => {
    expect(snapshotLabel(entry({}))).toBe("● webshop — working");
  });
  it("prefers the semantic label once it arrives", () => {
    const e = entry({ semantics: { label: "running tests", card: null, fingerprint: "x", updatedAt: 0, stale: false } });
    expect(snapshotLabel(e)).toBe("● webshop — running tests");
  });
});
