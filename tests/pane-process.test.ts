import { describe, expect, it } from "vitest";

import {
  descendantsOf,
  parseAgentSession,
  parseElapsedSeconds,
  parseProcessSnapshot,
  pickAgentProcess,
  type AgentProcess,
} from "../src/services/pane-process.js";

const CODEX = "node /Users/me/.local/bin/codex resume 019fee8d-51a2-7f60-9cff-e7f9db4b100e";
const CLAUDE = "node /Users/me/.local/bin/claude --resume 3ec20d5a-2322-41f3-9a1d-956822e72a3d";

describe("parseAgentSession", () => {
  it("reads a codex session id from `codex resume <uuid>`", () => {
    expect(parseAgentSession(CODEX)).toEqual({
      harness: "codex",
      sessionId: "019fee8d-51a2-7f60-9cff-e7f9db4b100e",
    });
  });

  it("reads a claude session id from `claude --resume <uuid>`", () => {
    expect(parseAgentSession(CLAUDE)).toEqual({
      harness: "claude-code",
      sessionId: "3ec20d5a-2322-41f3-9a1d-956822e72a3d",
    });
  });

  it("reads claude's short `-r <uuid>` form", () => {
    expect(parseAgentSession("claude -r 3ec20d5a-2322-41f3-9a1d-956822e72a3d")?.harness).toBe(
      "claude-code",
    );
  });

  it("returns null for a bare harness with no session id", () => {
    expect(parseAgentSession("node /Users/me/.local/bin/codex")).toBeNull();
    expect(parseAgentSession("claude")).toBeNull();
  });

  it("returns null for an MCP child or unrelated node process", () => {
    expect(parseAgentSession("node ./mcp/server.mjs")).toBeNull();
    expect(parseAgentSession("npm exec @playwright/mcp@latest")).toBeNull();
  });

  it("returns null for a malformed id", () => {
    expect(parseAgentSession("codex resume not-a-uuid")).toBeNull();
  });
});

describe("pickAgentProcess", () => {
  it("prefers the process whose argv yields a session id", () => {
    const procs: AgentProcess[] = [
      { pid: 1, command: "node ./mcp/server.mjs" },
      { pid: 2, command: CODEX },
      { pid: 3, command: "node .bin/playwright-mcp" },
    ];
    expect(pickAgentProcess(procs)?.pid).toBe(2);
  });

  it("falls back to a bare harness invocation (for its cwd) when no id is present", () => {
    const procs: AgentProcess[] = [
      { pid: 1, command: "node ./mcp/server.mjs" },
      { pid: 2, command: "node /Users/me/.local/bin/codex" },
    ];
    expect(pickAgentProcess(procs)?.pid).toBe(2);
  });

  it("returns null when the tree holds no harness process", () => {
    const procs: AgentProcess[] = [
      { pid: 1, command: "node ./mcp/server.mjs" },
      { pid: 2, command: "-zsh" },
    ];
    expect(pickAgentProcess(procs)).toBeNull();
  });
});

describe("parseElapsedSeconds", () => {
  it("parses MM:SS", () => {
    expect(parseElapsedSeconds("15:04")).toBe(15 * 60 + 4);
  });
  it("parses HH:MM:SS", () => {
    expect(parseElapsedSeconds("01:15:04")).toBe(3600 + 15 * 60 + 4);
  });
  it("parses DD-HH:MM:SS", () => {
    expect(parseElapsedSeconds("04-07:41:28")).toBe(4 * 86400 + 7 * 3600 + 41 * 60 + 28);
  });
  it("returns null for junk", () => {
    expect(parseElapsedSeconds("-")).toBeNull();
    expect(parseElapsedSeconds("")).toBeNull();
  });
});

describe("process snapshot", () => {
  // `ps -eo pid=,ppid=,etime=,command=` — etime is `[[DD-]HH:]MM:SS`, no spaces.
  const OUTPUT = [
    "  100     1    01:00:00 -zsh",
    "  200   100       05:00 node /Users/me/.local/bin/gm run codex",
    "  300   200       04:30 node /Users/me/.local/bin/codex resume 019fee8d-51a2-7f60-9cff-e7f9db4b100e",
    "  400   300       00:10 node ./mcp/server.mjs",
    "  999     1 04-07:41:28 some other process",
  ].join("\n");

  it("parses `ps` output into a pid → {ppid, command, elapsedSeconds} map", () => {
    const snap = parseProcessSnapshot(OUTPUT);
    expect(snap.get(300)).toEqual({
      ppid: 200,
      command: "node /Users/me/.local/bin/codex resume 019fee8d-51a2-7f60-9cff-e7f9db4b100e",
      elapsedSeconds: 4 * 60 + 30,
    });
    expect(snap.get(100)?.elapsedSeconds).toBe(3600);
    expect(snap.size).toBe(5);
  });

  it("walks every descendant of a root pid, in memory", () => {
    const snap = parseProcessSnapshot(OUTPUT);
    const kids = descendantsOf(100, snap).map((p) => p.pid).sort((a, b) => a - b);
    expect(kids).toEqual([200, 300, 400]); // not 999 (unrelated) or 100 (the root)
  });

  it("returns no descendants for a leaf, and finds the agent via pick", () => {
    const snap = parseProcessSnapshot(OUTPUT);
    expect(descendantsOf(999, snap)).toEqual([]);
    // The agent under the shell resolves to the codex process (via its argv id).
    const agent = pickAgentProcess(descendantsOf(100, snap));
    expect(parseAgentSession(agent!.command)?.sessionId).toBe("019fee8d-51a2-7f60-9cff-e7f9db4b100e");
  });
});
