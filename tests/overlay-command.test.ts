import { describe, expect, it } from "vitest";

import type { SessionView, TmuxPane } from "../src/core/types.js";
import type { ResolvedPane } from "../src/services/tmux-resolve.js";
import { buildCells, isCloseKey } from "../src/cli/commands/overlay.js";

function pane(id: string, cwd: string): TmuxPane {
  return {
    paneId: id,
    left: 0,
    top: 0,
    width: 40,
    height: 20,
    cwd,
    command: "claude",
    pid: 100,
    windowId: "@1",
    active: false,
  };
}

function viewFor(sessionId: string): SessionView {
  return {
    record: {
      harness: "claude-code", sessionId, filePath: "/f", cwd: "/repo", project: "repo",
      gitBranch: null, startedAt: null, updatedAt: "2026-08-10T00:00:00.000Z", messageCount: 1,
      userPromptCount: 1, title: null, lastUserPrompt: null, recentUserPrompts: [], arcPrompts: [],
      filesTouched: [], prLinks: [], lastAssistantText: null, lastToolFailure: null,
      endedMidTask: false, isSidechain: false, isAutomated: false,
    },
    summary: null,
  };
}

describe("isCloseKey", () => {
  it("closes on ctrl-g, so the same key that opens the overlay dismisses it", () => {
    expect(isCloseKey("\x07")).toBe(true);
  });

  it("still closes on Esc, ctrl-c and ctrl-d", () => {
    expect(isCloseKey("\x1b")).toBe(true);
    expect(isCloseKey("\x03")).toBe(true);
    expect(isCloseKey("\x04")).toBe(true);
  });

  it("does not close on ordinary input meant for the ask box", () => {
    expect(isCloseKey("g")).toBe(false);
    expect(isCloseKey("\r")).toBe(false);
    expect(isCloseKey("\x12")).toBe(false); // ctrl-r is force-refresh, not close
  });
});

describe("buildCells", () => {
  it("pairs each resolved pane with its view and marks in-flight refreshes", () => {
    const resolved: ResolvedPane[] = [
      { pane: pane("%1", "/repo"), record: viewFor("s1").record },
      { pane: pane("%2", "/plain"), record: null },
    ];
    const views = [viewFor("s1")];
    const cells = buildCells(resolved, views, new Set(["s1"]));

    expect(cells).toHaveLength(2);
    expect(cells[0]!.view?.record.sessionId).toBe("s1");
    expect(cells[0]!.refreshing).toBe(true);
    expect(cells[1]!.view).toBeNull();
    expect(cells[1]!.refreshing).toBe(false);
  });
});
