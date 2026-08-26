import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";
import {
  AgentSensor,
  hasToolError,
  isAssistantWaiting,
  isEnded,
  makeSensor,
  TerminalSensor,
  tsOf,
} from "../src/services/sensors.js";
import type { PaneIdentity } from "../src/core/gmux-types.js";

const ident: PaneIdentity = {
  paneId: "%1", windowId: "@1", active: false, harness: null, sessionId: null,
  cwd: "/x", command: "zsh", pid: 10,
};

describe("TerminalSensor", () => {
  it("captures the pane tail into an observation", async () => {
    const gw = new FakeTmuxGateway();
    gw.setCapture("%1", "line a\nline b\n");
    const s = new TerminalSensor(ident, gw);
    const obs = await s.observe(5000);
    expect(obs.kind).toBe("terminal");
    expect(obs.tailLines).toEqual(["line a", "line b"]);
    expect(obs.lastActivityTs).toBe(5000);
  });
  it("only bumps lastActivityTs when the content changes", async () => {
    const gw = new FakeTmuxGateway();
    gw.setCapture("%1", "same");
    const s = new TerminalSensor(ident, gw);
    await s.observe(1000);
    const stable = await s.observe(2000);
    expect(stable.lastActivityTs).toBe(1000); // unchanged content
    gw.setCapture("%1", "new content");
    const moved = await s.observe(3000);
    expect(moved.lastActivityTs).toBe(3000);
  });
});

describe("agent-signal helpers", () => {
  it("tsOf reads the shared timestamp field", () => {
    expect(tsOf({ timestamp: "2026-08-11T00:00:00.000Z" })).toBe(Date.parse("2026-08-11T00:00:00.000Z"));
    expect(tsOf({ timestamp: "not a date" })).toBeNull();
    expect(tsOf({})).toBeNull();
    expect(tsOf(undefined)).toBeNull();
  });

  it("isAssistantWaiting looks at the last known speaker", () => {
    expect(isAssistantWaiting([{ type: "user" }, { type: "assistant" }])).toBe(true);
    expect(isAssistantWaiting([{ type: "assistant" }, { type: "user" }])).toBe(false);
    expect(isAssistantWaiting([{ type: "ai-title" }])).toBeUndefined();
  });

  it("hasToolError recognizes Claude Code tool_result errors", () => {
    const row = {
      type: "user",
      message: { content: [{ type: "tool_result", is_error: true }] },
    };
    expect(hasToolError([row])).toBe(true);
    expect(hasToolError([{ type: "user", message: { content: [] } }])).toBe(false);
  });

  it("hasToolError recognizes Codex nonzero exits", () => {
    const failed = {
      type: "response_item",
      payload: { type: "function_call_output", output: "Process exited with code 1" },
    };
    const ok = {
      type: "response_item",
      payload: { type: "function_call_output", output: "Process exited with code 0" },
    };
    expect(hasToolError([failed])).toBe(true);
    expect(hasToolError([ok])).toBe(false);
  });

  it("isEnded recognizes a Codex task_complete marker", () => {
    expect(isEnded([{ type: "event_msg", payload: { type: "task_complete" } }])).toBe(true);
    expect(isEnded([{ type: "event_msg", payload: { type: "agent_message" } }])).toBe(false);
    expect(isEnded([])).toBe(false);
  });
});

describe("AgentSensor", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("tails a transcript file and derives signals", async () => {
    dir = await mkdtemp(join(tmpdir(), "gmux-sensors-"));
    const filePath = join(dir, "session.jsonl");
    const rows = [
      { type: "user", timestamp: "2026-08-11T00:00:00.000Z", message: { content: "hi" } },
      { type: "assistant", timestamp: "2026-08-11T00:00:05.000Z", message: { content: "hello" } },
    ];
    await writeFile(filePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

    const identity: PaneIdentity = {
      paneId: "%2", windowId: "@1", active: true, harness: "claude-code", sessionId: "abc",
      cwd: "/x", command: "claude", pid: 20,
    };
    const sensor = new AgentSensor(identity, filePath);
    const obs = await sensor.observe(9999);

    expect(obs.kind).toBe("agent");
    expect(obs.tailLines).toHaveLength(2);
    expect(obs.lastActivityTs).toBe(Date.parse("2026-08-11T00:00:05.000Z"));
    expect(obs.awaitingInput).toBe(true);
    expect(obs.sawError).toBe(false);
    expect(obs.ended).toBe(false);
    await sensor.teardown();
  });

  it("degrades gracefully when the transcript file does not exist", async () => {
    const identity: PaneIdentity = {
      paneId: "%3", windowId: "@1", active: true, harness: "claude-code", sessionId: "missing",
      cwd: "/x", command: "claude", pid: 30,
    };
    const sensor = new AgentSensor(identity, "/nonexistent/path/session.jsonl");
    const obs = await sensor.observe(4242);
    expect(obs.kind).toBe("agent");
    expect(obs.tailLines).toEqual([]);
    expect(obs.lastActivityTs).toBe(4242);
  });

  it("retries resolution on a miss instead of caching it forever", async () => {
    dir = await mkdtemp(join(tmpdir(), "gmux-sensors-"));
    const filePath = join(dir, "session.jsonl");
    const rows = [{ type: "user", timestamp: "2026-08-11T00:00:00.000Z", message: { content: "hi" } }];

    // Simulates the session index not yet containing the transcript, then
    // picking it up on a later tick.
    let indexedPath: string | null = null;
    const identity: PaneIdentity = {
      paneId: "%4", windowId: "@1", active: true, harness: "claude-code", sessionId: "late",
      cwd: "/x", command: "claude", pid: 40,
    };
    const sensor = new AgentSensor(identity, undefined, async () => indexedPath);

    const first = await sensor.observe(1000);
    expect(first.tailLines).toEqual([]);
    expect(first.lastActivityTs).toBe(1000);

    // Index still doesn't know about it: must still degrade, not throw.
    const second = await sensor.observe(2000);
    expect(second.tailLines).toEqual([]);
    expect(second.lastActivityTs).toBe(2000);

    // The index now has it — the sensor must pick it up on the very next tick.
    await writeFile(filePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    indexedPath = filePath;
    const third = await sensor.observe(3000);
    expect(third.tailLines).toHaveLength(1);
    expect(third.lastActivityTs).toBe(Date.parse("2026-08-11T00:00:00.000Z"));
  });
});

describe("makeSensor", () => {
  it("picks AgentSensor when harness and sessionId are both set", () => {
    const identity: PaneIdentity = {
      paneId: "%1", windowId: "@1", active: false, harness: "claude-code", sessionId: "abc",
      cwd: "/x", command: "claude", pid: 10,
    };
    const sensor = makeSensor(identity, new FakeTmuxGateway());
    expect(sensor).toBeInstanceOf(AgentSensor);
  });

  it("falls back to TerminalSensor otherwise", () => {
    const sensor = makeSensor(ident, new FakeTmuxGateway());
    expect(sensor).toBeInstanceOf(TerminalSensor);
  });
});
