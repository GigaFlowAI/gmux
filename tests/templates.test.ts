/**
 * Workspace templates: idle $SHELL titled tests/logs/review on tool-start.
 *
 * No real mux, no real models. FakeMuxGateway + JSONL fixtures.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ToolStart } from "../src/core/mux-types.js";
import {
  TEMPLATE_COOLDOWN_MS,
  TEMPLATE_IDS,
  applyTemplateActs,
  decideTemplates,
  idleShellArgv,
  isTemplateId,
  parseToolStarts,
  reviewHit,
  TemplateEngine,
  templateSpawnOpts,
} from "../src/services/templates.js";
import { FakeMuxGateway } from "../src/services/mux-gateway.js";
import { AgentSensor } from "../src/services/sensors.js";
import { SidecarDaemon } from "../src/services/sidecar-daemon.js";
import { WorkspaceModel } from "../src/services/workspace.js";
import type { Observation, PaneIdentity } from "../src/core/gmux-types.js";
import type { Sensor } from "../src/services/sensors.js";
import { claudeBashToolUse, codexShellFunctionCall } from "./fixtures/build.js";

const shell = idleShellArgv();

const start = (overrides: Partial<ToolStart> & Pick<ToolStart, "command">): ToolStart => ({
  callId: "1",
  paneId: "p_a",
  ...overrides,
});

describe("decideTemplates", () => {
  it("does not re-exec captured argv", () => {
    const acts = decideTemplates({
      workspaceId: "ws_1",
      live: [],
      starts: [{ callId: "1", command: "pnpm dev", paneId: "p_a" }],
      seen: new Set(),
    });
    expect(acts[0]?.argv).toEqual([process.env.SHELL ?? "/bin/zsh"]);
    expect(acts[0]?.title).toBe("logs");
    expect(acts[0]?.argv).not.toContain("pnpm");
  });

  it("dedups on callId and (workspaceId, templateId)", () => {
    const seen = new Set(["1"]);
    const acts = decideTemplates({
      workspaceId: "ws_1",
      live: [{ templateId: "logs", workspaceId: "ws_1" }],
      starts: [{ callId: "1", command: "pnpm dev", paneId: "p_a" }],
      seen,
    });
    expect(acts).toEqual([]);
  });

  it("first-match-wins: tests beats logs on a mixed command", () => {
    const acts = decideTemplates({
      workspaceId: "ws_1",
      live: [],
      starts: [start({ command: "pnpm test && pnpm dev" })],
      seen: new Set(),
    });
    expect(acts).toHaveLength(1);
    expect(acts[0]?.title).toBe("tests");
    expect(acts[0]?.templateId).toBe("tests");
  });

  it("one live pane per (workspaceId, templateId); other workspaces are independent", () => {
    const blocked = decideTemplates({
      workspaceId: "ws_1",
      live: [{ templateId: "logs", workspaceId: "ws_1" }],
      starts: [start({ callId: "2", command: "vite" })],
      seen: new Set(),
    });
    expect(blocked).toEqual([]);

    const otherWs = decideTemplates({
      workspaceId: "ws_2",
      live: [{ templateId: "logs", workspaceId: "ws_1" }],
      starts: [start({ callId: "3", command: "vite" })],
      seen: new Set(),
    });
    expect(otherWs).toHaveLength(1);
    expect(otherWs[0]?.title).toBe("logs");
  });

  it("records seen callIds so the same start is never re-matched", () => {
    const seen = new Set<string>();
    const first = decideTemplates({
      workspaceId: "ws_1",
      live: [],
      starts: [start({ callId: "c1", command: "npm test" })],
      seen,
    });
    expect(first).toHaveLength(1);
    const second = decideTemplates({
      workspaceId: "ws_1",
      live: [],
      starts: [start({ callId: "c1", command: "npm test" })],
      seen,
    });
    expect(second).toEqual([]);
  });

  it("cools down 60s after close", () => {
    const acts = decideTemplates({
      workspaceId: "ws_1",
      live: [],
      starts: [start({ callId: "2", command: "pnpm dev" })],
      seen: new Set(),
      now: 70_000,
      closedAt: new Map([["ws_1:logs", 20_000]]),
    });
    expect(acts).toEqual([]);
    expect(TEMPLATE_COOLDOWN_MS).toBe(60_000);
  });

  it("respawns after the 60s cooldown", () => {
    const acts = decideTemplates({
      workspaceId: "ws_1",
      live: [],
      starts: [start({ callId: "2", command: "pnpm dev" })],
      seen: new Set(),
      now: 80_001,
      closedAt: new Map([["ws_1:logs", 20_000]]),
    });
    expect(acts[0]?.title).toBe("logs");
  });

  it("occupies the template id within one decide so two starts do not double-spawn", () => {
    const acts = decideTemplates({
      workspaceId: "ws_1",
      live: [],
      starts: [
        start({ callId: "a", command: "pnpm dev" }),
        start({ callId: "b", command: "tail -f /tmp/app.log" }),
      ],
      seen: new Set(),
    });
    expect(acts).toHaveLength(1);
    expect(acts[0]?.title).toBe("logs");
  });
});

describe("reviewHit", () => {
  it("review matches headline/overview regex only", () => {
    expect(reviewHit("fix login", "open PR 12")).toBe(true);
    expect(reviewHit("wiring checkout", "tests going green")).toBe(false);
  });

  it("is case-insensitive and needs a word boundary", () => {
    expect(reviewHit("Review the diff", "")).toBe(true);
    expect(reviewHit("open a pull request", "")).toBe(true);
    expect(reviewHit("preview the checkout", "")).toBe(false);
  });
});

describe("review template", () => {
  it("spawns review when the command matches and headline/overview hit", () => {
    const acts = decideTemplates({
      workspaceId: "ws_1",
      live: [],
      starts: [start({ command: "gh pr diff" })],
      seen: new Set(),
      headline: "fix login",
      overview: "open PR 12",
    });
    expect(acts[0]?.title).toBe("review");
  });

  it("does not spawn review on command match alone", () => {
    const acts = decideTemplates({
      workspaceId: "ws_1",
      live: [],
      starts: [start({ command: "gh pr view" })],
      seen: new Set(),
      headline: "wiring checkout",
      overview: "tests going green",
    });
    expect(acts).toEqual([]);
  });

  it("reviewHit uses the emitting pane's semantics, not a workspace-wide headline", () => {
    const siblingWouldHit = decideTemplates({
      workspaceId: "ws_1",
      live: [],
      starts: [{ callId: "a", command: "gh pr diff", paneId: "p_a" }],
      seen: new Set(),
      headline: "fix login",
      overview: "open PR 12",
      semanticsByPane: new Map([
        ["p_a", { headline: "wiring checkout", overview: "tests going green" }],
      ]),
    });
    expect(siblingWouldHit).toEqual([]);

    const emitterHits = decideTemplates({
      workspaceId: "ws_1",
      live: [],
      starts: [{ callId: "b", command: "gh pr diff", paneId: "p_a" }],
      seen: new Set(),
      headline: "wiring checkout",
      overview: "tests going green",
      semanticsByPane: new Map([
        ["p_a", { headline: "fix login", overview: "open PR 12" }],
      ]),
    });
    expect(emitterHits[0]?.title).toBe("review");
  });
});

describe("parseToolStarts", () => {
  it("reads Claude Bash tool_use id + input.command", () => {
    const starts = parseToolStarts([claudeBashToolUse({ id: "toolu_1", command: "pnpm test" })], "p_a");
    expect(starts).toEqual([{ callId: "toolu_1", command: "pnpm test", paneId: "p_a" }]);
  });

  it("skips non-Bash tool_use and missing command", () => {
    const write = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "/x" } }] },
    };
    const noCmd = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: 12 } }] },
    };
    expect(parseToolStarts([write, noCmd], "p_a")).toEqual([]);
  });

  it("reads Codex function_call name shell arguments.cmd", () => {
    const starts = parseToolStarts(
      [codexShellFunctionCall({ callId: "call_9", cmd: "cargo test" })],
      "p_b",
    );
    expect(starts).toEqual([{ callId: "call_9", command: "cargo test", paneId: "p_b" }]);
  });

  it("hashes Codex callId when id and call_id are omitted", () => {
    const row = codexShellFunctionCall({ cmd: "go test" });
    const starts = parseToolStarts([row], "p_b");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.callId).toMatch(/^[0-9a-f]{16}$/);
    expect(starts[0]!.command).toBe("go test");
    expect(parseToolStarts([row], "p_b")[0]!.callId).toBe(starts[0]!.callId);
  });

  it("skips Codex function_call when cmd is missing or arguments are not JSON", () => {
    const noCmd = {
      type: "response_item",
      payload: { type: "function_call", name: "shell", call_id: "x", arguments: JSON.stringify({ cwd: "/" }) },
    };
    const badJson = {
      type: "response_item",
      payload: { type: "function_call", name: "shell", call_id: "y", arguments: "{not json" },
    };
    const other = {
      type: "response_item",
      payload: { type: "function_call", name: "apply_patch", call_id: "z", arguments: "{}" },
    };
    expect(parseToolStarts([noCmd, badJson, other], "p_b")).toEqual([]);
  });
});

describe("applyTemplateActs", () => {
  it("spawns idle $SHELL in a new tab without stealing focus", async () => {
    const gw = new FakeMuxGateway();
    const parent = await gw.spawn({ cwd: "/repo", argv: ["claude"], tab: { mode: "new", name: "agent" } });
    gw.setClientFocus("c1", parent.paneId);
    const acts = decideTemplates({
      workspaceId: "ws_1",
      live: [],
      starts: [start({ callId: "1", command: "pnpm test", paneId: parent.paneId })],
      seen: new Set(),
    });
    await applyTemplateActs(gw, acts, new Map([[parent.paneId, { cwd: "/repo" }]]));
    expect(gw.spawned).toHaveLength(2);
    expect(gw.spawned[1]!.opts.argv).toEqual(shell);
    expect(gw.spawned[1]!.opts.tab).toEqual({ mode: "new", name: "tests" });
    expect(gw.spawned[1]!.opts.focus).toBe(false);
    expect(gw.spawned[1]!.opts.cwd).toBe("/repo");
    expect(gw.focusedPaneId("c1")).toBe(parent.paneId);
    const panes = await gw.listPanes();
    expect(panes[1]!.templateId).toBe("tests");
  });
});

describe("templateSpawnOpts / CLI", () => {
  it("gmux spawn --template is an idle shell titled tests|logs|review", () => {
    expect(TEMPLATE_IDS).toEqual(["tests", "logs", "review"]);
    expect(isTemplateId("tests")).toBe(true);
    expect(isTemplateId("dev")).toBe(false);
    const opts = templateSpawnOpts("review", "/repo");
    expect(opts.argv).toEqual(shell);
    expect(opts.tab).toEqual({ mode: "new", name: "review" });
    expect(opts.focus).toBe(false);
    expect(opts.templateId).toBe("review");
    expect(opts.cwd).toBe("/repo");
  });
});

describe("SidecarDaemon templates", () => {
  it("spawns a logs pane from a new toolStart and never changes focus", async () => {
    const gw = new FakeMuxGateway();
    const parent = await gw.spawn({ cwd: "/app", argv: ["claude"], tab: { mode: "new", name: "agent" } });
    gw.setClientFocus("c1", parent.paneId);

    class ToolSensor implements Sensor {
      readonly kind = "agent" as const;
      constructor(private id: PaneIdentity) {}
      async observe(now: number): Promise<Observation> {
        return {
          paneId: this.id.paneId,
          kind: "agent",
          ts: now,
          tailLines: [],
          lastActivityTs: now,
          toolStarts: [{ callId: "t1", command: "pnpm dev", paneId: this.id.paneId }],
        };
      }
      async teardown(): Promise<void> {}
    }

    const d = new SidecarDaemon({
      gateway: gw,
      model: new WorkspaceModel(),
      now: () => 100_000,
      makeSensor: (id) => new ToolSensor(id),
    });
    await d.tickOnce();
    expect(gw.spawned).toHaveLength(2);
    expect(gw.spawned[1]!.opts.argv).toEqual(shell);
    expect(gw.spawned[1]!.opts.tab).toEqual({ mode: "new", name: "logs" });
    expect(gw.spawned[1]!.opts.focus).toBe(false);
    expect(gw.focusedPaneId("c1")).toBe(parent.paneId);
  });

  it("review uses the emitting pane's semantics, not a sibling's", async () => {
    const gw = new FakeMuxGateway();
    const emitter = await gw.spawn({ cwd: "/app", argv: ["claude"], tab: { mode: "new", name: "agent-a" } });
    const sibling = await gw.spawn({ cwd: "/app", argv: ["claude"], tab: { mode: "new", name: "agent-b" } });
    const model = new WorkspaceModel();
    let round = 0;

    class PaneSensor implements Sensor {
      readonly kind = "agent" as const;
      constructor(private id: PaneIdentity) {}
      async observe(now: number): Promise<Observation> {
        const toolStarts =
          round >= 1 && this.id.paneId === emitter.paneId
            ? [{ callId: "pr1", command: "gh pr diff", paneId: this.id.paneId }]
            : [];
        return {
          paneId: this.id.paneId,
          kind: "agent",
          ts: now,
          tailLines: [],
          lastActivityTs: now,
          toolStarts,
        };
      }
      async teardown(): Promise<void> {}
    }

    const d = new SidecarDaemon({
      gateway: gw,
      model,
      now: () => 100_000,
      makeSensor: (id) => new PaneSensor(id),
    });
    await d.tickOnce();
    model.applySemantics(emitter.paneId, {
      label: "wiring checkout", card: "tests going green", fingerprint: "a", updatedAt: 1, stale: false,
    });
    model.applySemantics(sibling.paneId, {
      label: "fix login", card: "open PR 12", fingerprint: "b", updatedAt: 1, stale: false,
    });
    round = 1;
    await d.tickOnce();
    expect(gw.spawned.some((s) => s.opts.templateId === "review")).toBe(false);

    const d2gw = new FakeMuxGateway();
    const e2 = await d2gw.spawn({ cwd: "/app", argv: ["claude"], tab: { mode: "new", name: "agent-a" } });
    const s2 = await d2gw.spawn({ cwd: "/app", argv: ["claude"], tab: { mode: "new", name: "agent-b" } });
    const model2 = new WorkspaceModel();
    let round2 = 0;
    class PaneSensor2 implements Sensor {
      readonly kind = "agent" as const;
      constructor(private id: PaneIdentity) {}
      async observe(now: number): Promise<Observation> {
        const toolStarts =
          round2 >= 1 && this.id.paneId === e2.paneId
            ? [{ callId: "pr2", command: "gh pr diff", paneId: this.id.paneId }]
            : [];
        return {
          paneId: this.id.paneId, kind: "agent", ts: now, tailLines: [], lastActivityTs: now, toolStarts,
        };
      }
      async teardown(): Promise<void> {}
    }
    const d2 = new SidecarDaemon({
      gateway: d2gw, model: model2, now: () => 200_000, makeSensor: (id) => new PaneSensor2(id),
    });
    await d2.tickOnce();
    model2.applySemantics(e2.paneId, {
      label: "fix login", card: "open PR 12", fingerprint: "a", updatedAt: 1, stale: false,
    });
    model2.applySemantics(s2.paneId, {
      label: "wiring checkout", card: "tests going green", fingerprint: "b", updatedAt: 1, stale: false,
    });
    round2 = 1;
    await d2.tickOnce();
    expect(d2gw.spawned.some((s) => s.opts.templateId === "review")).toBe(true);
  });
});

describe("TemplateEngine spawn failure", () => {
  it("does not burn callId when spawn fails; retries on the next apply", async () => {
    const gw = new FakeMuxGateway();
    const parent = await gw.spawn({ cwd: "/repo", argv: ["claude"], tab: { mode: "new", name: "agent" } });
    gw.failNextSpawns = 1;
    const engine = new TemplateEngine(gw);
    const panes = [{ paneId: parent.paneId, cwd: "/repo", workspaceId: "ws_test", templateId: null }];
    const starts = [{ callId: "c1", command: "pnpm test", paneId: parent.paneId }];
    await engine.apply({ workspaceId: "ws_test", panes, starts, now: 1 });
    expect(gw.spawned.filter((s) => s.opts.templateId === "tests")).toHaveLength(0);
    await engine.apply({ workspaceId: "ws_test", panes, starts: [], now: 2 });
    expect(gw.spawned.some((s) => s.opts.templateId === "tests")).toBe(true);
  });
});

describe("AgentSensor toolStarts (fixtures)", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("emits Claude Bash and Codex shell starts once per callId", async () => {
    dir = await mkdtemp(join(tmpdir(), "gmux-templates-"));
    const filePath = join(dir, "session.jsonl");
    const rows = [
      claudeBashToolUse({ id: "toolu_1", command: "pnpm test" }),
      codexShellFunctionCall({ callId: "call_1", cmd: "tail -f app.log" }),
    ];
    await writeFile(filePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    const identity: PaneIdentity = {
      paneId: "p_s", windowId: null, active: true, harness: "claude-code", sessionId: "abc",
      cwd: "/x", command: "claude", pid: 20,
    };
    const sensor = new AgentSensor(identity, filePath);
    const first = await sensor.observe(1);
    expect(first.toolStarts).toEqual([
      { callId: "toolu_1", command: "pnpm test", paneId: "p_s" },
      { callId: "call_1", command: "tail -f app.log", paneId: "p_s" },
    ]);
    const second = await sensor.observe(2);
    expect(second.toolStarts).toEqual([]);
  });
});
