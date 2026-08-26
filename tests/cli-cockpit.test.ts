import { describe, expect, it } from "vitest";
import { buildFrame, sessionsForSnapshot } from "../src/cli/commands/cockpit.js";
import type { WorkspaceSnapshot } from "../src/core/gmux-types.js";
import type { SessionRecord } from "../src/core/types.js";

const snap: WorkspaceSnapshot = { version: 1, updatedAt: 0, panes: [], hostPressure: null, guardianLog: [] };

describe("cockpit buildFrame", () => {
  it("clears the screen and shows the pane count", () => {
    const frame = buildFrame(snap, 0);
    expect(frame).toContain("\x1b[2J"); // clear
    expect(frame).toContain("gmux — 0 panes");
  });
});

function pane(sessionId: string | null, cwd: string) {
  return {
    identity: { paneId: "%1", windowId: "@1", active: true, harness: "claude-code" as const, sessionId, cwd, command: "node", pid: 1 },
    state: "working" as const, semantics: null, resources: null, lastActivityTs: 0, ts: 0, gone: false,
  };
}
const rec = (sessionId: string): SessionRecord => ({
  harness: "claude-code", sessionId, filePath: "/x", cwd: "/w", project: "w", gitBranch: null,
  startedAt: null, updatedAt: "t", messageCount: 1, userPromptCount: 1, title: null, lastUserPrompt: null,
  recentUserPrompts: [], arcPrompts: [], filesTouched: [], prLinks: [], lastAssistantText: null,
  lastToolFailure: null, endedMidTask: false, isSidechain: false, isAutomated: false,
});

describe("sessionsForSnapshot", () => {
  it("pairs panes that have a matching record, skips session-less and unmatched panes, dedupes", () => {
    const snapshot = { version: 1, updatedAt: 0, panes: [pane("s1", "/w/shop"), pane(null, "/w/none"), pane("s1", "/w/dup"), pane("s9", "/w/x")], hostPressure: null, guardianLog: [] };
    const out = sessionsForSnapshot(snapshot, [rec("s1")]);
    expect(out.map((s) => s.label)).toEqual(["shop"]); // s1 once (basename of first pane), no null, no unmatched s9
    expect(out[0]!.record.sessionId).toBe("s1");
  });
});
