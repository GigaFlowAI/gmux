import { describe, expect, it } from "vitest";

import type { PaneLink, SessionRecord, TmuxPane } from "../src/core/types.js";
import {
  harnessForCommand,
  resolvePaneToRecord,
  resolvePanesWithHints,
} from "../src/services/tmux-resolve.js";

function record(over: Partial<SessionRecord>): SessionRecord {
  return {
    harness: "claude-code",
    sessionId: "s",
    filePath: "/f",
    cwd: "/repo",
    project: "repo",
    gitBranch: null,
    startedAt: null,
    updatedAt: "2026-08-10T00:00:00.000Z",
    messageCount: 1,
    userPromptCount: 1,
    title: null,
    lastUserPrompt: null,
    recentUserPrompts: [],
    arcPrompts: [],
    filesTouched: [],
    prLinks: [],
    lastAssistantText: null,
    lastToolFailure: null,
    endedMidTask: false,
    isSidechain: false,
    isAutomated: false,
    ...over,
  };
}

function pane(over: Partial<TmuxPane>): TmuxPane {
  return { paneId: "%1", left: 0, top: 0, width: 40, height: 20, cwd: "/repo", command: "claude", pid: 100, ...over };
}

describe("harnessForCommand", () => {
  it("maps a distinctive command to its harness", () => {
    expect(harnessForCommand("claude")).toBe("claude-code");
    expect(harnessForCommand("codex")).toBe("codex");
  });
  it("returns null for a non-distinctive command", () => {
    expect(harnessForCommand("node")).toBeNull();
    expect(harnessForCommand("zsh")).toBeNull();
  });
});

describe("resolvePaneToRecord", () => {
  const links: PaneLink[] = [{ paneId: "%1", harness: "codex", sessionId: "exact" }];

  it("prefers an explicit link over the heuristic", () => {
    const records = [record({ sessionId: "exact", harness: "codex", cwd: "/other" }), record({ sessionId: "newer", cwd: "/repo" })];
    expect(resolvePaneToRecord(pane({}), records, links)!.sessionId).toBe("exact");
  });

  it("falls back to the newest session in the pane's cwd", () => {
    const records = [
      record({ sessionId: "old", cwd: "/repo", updatedAt: "2026-08-01T00:00:00.000Z" }),
      record({ sessionId: "new", cwd: "/repo", updatedAt: "2026-08-09T00:00:00.000Z" }),
      record({ sessionId: "elsewhere", cwd: "/other", updatedAt: "2026-08-10T00:00:00.000Z" }),
    ];
    expect(resolvePaneToRecord(pane({ paneId: "%2" }), records, [])!.sessionId).toBe("new");
  });

  it("prefers the harness the command points to when the cwd is shared", () => {
    const records = [
      record({ sessionId: "cc", harness: "claude-code", cwd: "/repo", updatedAt: "2026-08-01T00:00:00.000Z" }),
      record({ sessionId: "cx", harness: "codex", cwd: "/repo", updatedAt: "2026-08-09T00:00:00.000Z" }),
    ];
    expect(resolvePaneToRecord(pane({ paneId: "%2", command: "claude" }), records, [])!.sessionId).toBe("cc");
  });

  it("returns null when nothing matches the cwd", () => {
    const records = [record({ cwd: "/other" })];
    expect(resolvePaneToRecord(pane({ paneId: "%2", cwd: "/nope" }), records, [])).toBeNull();
  });
});

describe("resolvePaneToRecord with a process hint", () => {
  it("uses the argv session id over the pane cwd (exact)", () => {
    const records = [
      record({ sessionId: "argv", harness: "codex", cwd: "/repo" }),
      record({ sessionId: "bycwd", cwd: "/home", updatedAt: "2026-08-10T00:00:00.000Z" }),
    ];
    const hint = { argvSession: { harness: "codex", sessionId: "argv" }, agentCwd: null };
    // Pane's own cwd is home, which matches "bycwd" — but the argv id wins.
    expect(
      resolvePaneToRecord(pane({ paneId: "%2", cwd: "/home" }), records, [], hint)!.sessionId,
    ).toBe("argv");
  });

  it("falls through to the agent's real cwd when the argv id is unknown", () => {
    const records = [record({ sessionId: "inrepo", cwd: "/repo", updatedAt: "2026-08-09T00:00:00.000Z" })];
    const hint = {
      argvSession: { harness: "codex", sessionId: "not-indexed-yet" },
      agentCwd: "/repo",
    };
    // Pane cwd is home (no match); the agent process cwd is /repo.
    expect(
      resolvePaneToRecord(pane({ paneId: "%2", cwd: "/home" }), records, [], hint)!.sessionId,
    ).toBe("inrepo");
  });

  it("prefers the agent cwd over the pane cwd", () => {
    const records = [
      record({ sessionId: "shellcwd", cwd: "/home", updatedAt: "2026-08-10T00:00:00.000Z" }),
      record({ sessionId: "agentcwd", cwd: "/repo", updatedAt: "2026-08-01T00:00:00.000Z" }),
    ];
    const hint = { argvSession: null, agentCwd: "/repo" };
    expect(
      resolvePaneToRecord(pane({ paneId: "%2", cwd: "/home" }), records, [], hint)!.sessionId,
    ).toBe("agentcwd");
  });

  it("behaves as before when no hint is given", () => {
    const records = [record({ sessionId: "cwd", cwd: "/repo" })];
    expect(resolvePaneToRecord(pane({ paneId: "%2", cwd: "/repo" }), records, [])!.sessionId).toBe("cwd");
  });
});

describe("resolvePanesWithHints — no two panes claim the same session", () => {
  it("a fresh pane does not copy the session another pane resolves exactly", () => {
    const records = [
      record({ sessionId: "active", harness: "codex", cwd: "/repo", updatedAt: "2026-08-10T00:00:00.000Z" }),
      record({ sessionId: "fresh", harness: "codex", cwd: "/repo", updatedAt: "2026-08-09T00:00:00.000Z" }),
    ];
    const panes = [pane({ paneId: "%1" }), pane({ paneId: "%2" })];
    const hints = [
      { argvSession: { harness: "codex", sessionId: "active" }, agentCwd: null }, // %1 exact
      { argvSession: null, agentCwd: "/repo" }, // %2 fresh — cwd only
    ];
    const resolved = resolvePanesWithHints(panes, records, [], hints);
    expect(resolved[0]!.record?.sessionId).toBe("active");
    // The fresh pane must NOT copy the active session; it takes the next one.
    expect(resolved[1]!.record?.sessionId).toBe("fresh");
  });

  it("two fresh panes in one cwd get different sessions", () => {
    const records = [
      record({ sessionId: "a", harness: "codex", cwd: "/repo", updatedAt: "2026-08-10T00:00:00.000Z" }),
      record({ sessionId: "b", harness: "codex", cwd: "/repo", updatedAt: "2026-08-09T00:00:00.000Z" }),
    ];
    const panes = [pane({ paneId: "%1" }), pane({ paneId: "%2" })];
    const hints = [
      { argvSession: null, agentCwd: "/repo" },
      { argvSession: null, agentCwd: "/repo" },
    ];
    const ids = resolvePanesWithHints(panes, records, [], hints)
      .map((r) => r.record?.sessionId)
      .sort();
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("resolvePanesWithHints — pairs fresh panes to sessions by process start order", () => {
  // Two fresh claude panes in the same cwd. Neither has a session id on its
  // command line, so the only discriminator is which process started first. The
  // pairing must follow that — NOT the panes' array order, and NOT updatedAt
  // recency — so a summary sticks to the pane actually running that session.
  const older = record({
    sessionId: "older",
    cwd: "/repo",
    startedAt: "2026-08-11T08:00:00.000Z",
    updatedAt: "2026-08-11T09:00:00.000Z",
  });
  const newer = record({
    sessionId: "newer",
    cwd: "/repo",
    startedAt: "2026-08-11T10:00:00.000Z",
    updatedAt: "2026-08-11T12:00:00.000Z", // newest updatedAt — old code would grab this first
  });

  it("assigns the older-started session to the older process, whatever the array order", () => {
    const records = [newer, older];
    // Array order deliberately mismatches recency: the OLDER process comes first.
    const panes = [pane({ paneId: "%1" }), pane({ paneId: "%2" })];
    const hints = [
      { argvSession: null, agentHarness: "claude-code", agentCwd: "/repo", agentElapsedSeconds: 6000 }, // older proc
      { argvSession: null, agentHarness: "claude-code", agentCwd: "/repo", agentElapsedSeconds: 60 }, // newer proc
    ];
    const resolved = resolvePanesWithHints(panes, records, [], hints);
    expect(resolved[0]!.record?.sessionId).toBe("older"); // older process → older session
    expect(resolved[1]!.record?.sessionId).toBe("newer"); // newer process → newer session
  });

  it("still gives the two panes distinct sessions", () => {
    const ids = resolvePanesWithHints(
      [pane({ paneId: "%1" }), pane({ paneId: "%2" })],
      [newer, older],
      [],
      [
        { argvSession: null, agentHarness: "claude-code", agentCwd: "/repo", agentElapsedSeconds: 60 },
        { argvSession: null, agentHarness: "claude-code", agentCwd: "/repo", agentElapsedSeconds: 6000 },
      ],
    )
      .map((r) => r.record?.sessionId)
      .sort();
    expect(ids).toEqual(["newer", "older"]);
  });
});

describe("resolveHeuristic respects the agent's real harness", () => {
  it("a fresh claude pane never resolves to a codex session in the same cwd", () => {
    const records = [
      // Only codex sessions exist in /repo — a claude pane must NOT grab one.
      record({ sessionId: "cx", harness: "codex", cwd: "/repo", updatedAt: "2026-08-10T00:00:00.000Z" }),
    ];
    const hint = { argvSession: null, agentHarness: "claude-code", agentCwd: "/repo" };
    expect(resolvePaneToRecord(pane({ paneId: "%9", cwd: "/repo" }), records, [], hint)).toBeNull();
  });

  it("a fresh claude pane resolves to a claude session in its cwd", () => {
    const records = [
      record({ sessionId: "cx", harness: "codex", cwd: "/repo", updatedAt: "2026-08-10T00:00:00.000Z" }),
      record({ sessionId: "cc", harness: "claude-code", cwd: "/repo", updatedAt: "2026-08-01T00:00:00.000Z" }),
    ];
    const hint = { argvSession: null, agentHarness: "claude-code", agentCwd: "/repo" };
    expect(resolvePaneToRecord(pane({ paneId: "%9", cwd: "/repo" }), records, [], hint)!.sessionId).toBe("cc");
  });
});
