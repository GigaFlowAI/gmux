import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";

import { ClaudeCodeAdapter, projectName } from "../src/adapters/claude-code.js";
import { CodexAdapter, exitFailure, patchedFiles } from "../src/adapters/codex.js";
import { DecimatingSampler } from "../src/adapters/jsonl.js";
import { claudeLines, codexLines, tempHome, writeClaudeSession, writeCodexSession } from "./fixtures/build.js";

let home: string;
const CLAUDE_ID = "581cb3f8-7a1c-4dd0-a887-5f55f9184619";
const CODEX_ID = "019e9a77-740f-7903-942c-caab943b6101";

beforeEach(async () => {
  home = await tempHome();
  process.env.GIGAMANAGE_HOME = home;
});

afterEach(async () => {
  delete process.env.GIGAMANAGE_HOME;
  await rm(home, { recursive: true, force: true });
});

describe("ClaudeCodeAdapter", () => {
  it("discovers sessions and extracts the facts that matter", async () => {
    await writeClaudeSession(home, {
      slug: "-Users-dev-Projects-acme",
      sessionId: CLAUDE_ID,
      lines: claudeLines(CLAUDE_ID),
    });

    const adapter = new ClaudeCodeAdapter();
    const refs = await adapter.listSessions();
    expect(refs).toHaveLength(1);

    const record = await adapter.parseSession(refs[0]!);

    expect(record.harness).toBe("claude-code");
    expect(record.sessionId).toBe(CLAUDE_ID);
    expect(record.cwd).toBe("/Users/dev/Projects/acme");
    expect(record.project).toBe("acme");
    expect(record.gitBranch).toBe("fix-auth");
    expect(record.title).toBe("Set up the auth module");
    expect(record.filesTouched).toEqual(["/Users/dev/Projects/acme/src/auth.ts"]);
    expect(record.prLinks).toEqual([
      { number: 142, url: "https://github.com/acme/acme/pull/142", repository: "acme/acme" },
    ]);
  });

  it("counts only human turns as prompts, not tool results or injected reminders", async () => {
    await writeClaudeSession(home, {
      slug: "-Users-dev-Projects-acme",
      sessionId: CLAUDE_ID,
      lines: claudeLines(CLAUDE_ID),
    });
    const adapter = new ClaudeCodeAdapter();
    const record = await adapter.parseSession((await adapter.listSessions())[0]!);

    // Two real human turns. The system-reminder and the tool_result are neither.
    expect(record.recentUserPrompts).toEqual(["set up the auth module", "the admin case still 401s"]);
    expect(record.userPromptCount).toBe(2);
    expect(record.lastUserPrompt).toBe("the admin case still 401s");
  });

  it("flags a session that ended on a failing tool call", async () => {
    await writeClaudeSession(home, {
      slug: "-Users-dev-Projects-acme",
      sessionId: CLAUDE_ID,
      lines: claudeLines(CLAUDE_ID),
    });
    const adapter = new ClaudeCodeAdapter();
    const record = await adapter.parseSession((await adapter.listSessions())[0]!);

    expect(record.endedMidTask).toBe(true);
    expect(record.lastToolFailure).toContain("expected 200, got 401");
  });

  it("records one entry per PR, however many times the harness re-emits it", async () => {
    // Claude Code re-writes its pr-link line on every turn.
    const repeated = [
      ...claudeLines(CLAUDE_ID),
      ...Array.from({ length: 50 }, () => ({
        type: "pr-link",
        prNumber: 142,
        prUrl: "https://github.com/acme/acme/pull/142",
        sessionId: CLAUDE_ID,
      })),
    ];
    await writeClaudeSession(home, { slug: "-Users-dev-acme", sessionId: CLAUDE_ID, lines: repeated });

    const adapter = new ClaudeCodeAdapter();
    const record = await adapter.parseSession((await adapter.listSessions())[0]!);

    expect(record.prLinks).toHaveLength(1);
  });

  it("marks a headless `claude -p` run as automated, not as a session you'd resume", async () => {
    const headless = claudeLines(CLAUDE_ID).map((line) => {
      const entry = line as Record<string, unknown>;
      return entry["type"] === "user" || entry["type"] === "assistant"
        ? { ...entry, entrypoint: "sdk-cli", promptSource: "sdk" }
        : entry;
    });
    await writeClaudeSession(home, { slug: "-Users-dev-acme", sessionId: CLAUDE_ID, lines: headless });

    const adapter = new ClaudeCodeAdapter();
    const record = await adapter.parseSession((await adapter.listSessions())[0]!);

    expect(record.isAutomated).toBe(true);
  });

  it("treats an interactive session as not automated", async () => {
    await writeClaudeSession(home, { slug: "-Users-dev-acme", sessionId: CLAUDE_ID, lines: claudeLines(CLAUDE_ID) });
    const adapter = new ClaudeCodeAdapter();
    const record = await adapter.parseSession((await adapter.listSessions())[0]!);

    expect(record.isAutomated).toBe(false);
  });

  it("resumes with `claude --resume` in the session's own directory", async () => {
    const adapter = new ClaudeCodeAdapter();
    const command = adapter.resumeCommand({
      harness: "claude-code",
      sessionId: CLAUDE_ID,
      cwd: "/Users/dev/Projects/acme",
    } as never);

    expect(command.command).toBe("claude");
    expect(command.args).toEqual(["--resume", CLAUDE_ID]);
    expect(command.cwd).toBe("/Users/dev/Projects/acme");
  });

  it("attributes a worktree session to its repo, not to the branch directory", () => {
    expect(projectName("/Users/dev/Projects/acme/.claude/worktrees/fix-auth")).toBe("acme");
    expect(projectName("/Users/dev/Projects/acme")).toBe("acme");
    expect(projectName(null)).toBeNull();
  });
});

describe("CodexAdapter", () => {
  it("discovers date-nested rollouts and extracts conversation from event_msg", async () => {
    await writeCodexSession(home, { date: "2026-07-11", sessionId: CODEX_ID, lines: codexLines(CODEX_ID) });

    const adapter = new CodexAdapter();
    const refs = await adapter.listSessions();
    expect(refs).toHaveLength(1);
    expect(refs[0]!.sessionId).toBe(CODEX_ID);

    const record = await adapter.parseSession(refs[0]!);

    expect(record.harness).toBe("codex");
    expect(record.cwd).toBe("/Users/dev/Projects/beta");
    expect(record.project).toBe("beta");
    // The developer-role permissions blob is not a human turn.
    expect(record.recentUserPrompts).toEqual(["port the parser to typescript"]);
    expect(record.lastAssistantText).toBe("The parser compiles but the lexer test fails.");
    expect(record.filesTouched).toEqual(["src/parser.ts"]);
    expect(record.lastToolFailure).toContain("TypeError: bad token");
  });

  it("treats a task_started with no task_complete as an interrupted session", async () => {
    await writeCodexSession(home, { date: "2026-07-11", sessionId: CODEX_ID, lines: codexLines(CODEX_ID) });
    const adapter = new CodexAdapter();
    const record = await adapter.parseSession((await adapter.listSessions())[0]!);

    expect(record.endedMidTask).toBe(true);
  });

  it("treats a completed task as finished", async () => {
    const lines = [
      ...codexLines(CODEX_ID),
      { type: "event_msg", timestamp: "2026-07-11T10:00:07.000Z", payload: { type: "task_complete", last_agent_message: "Done." } },
    ];
    await writeCodexSession(home, { date: "2026-07-11", sessionId: CODEX_ID, lines });
    const adapter = new CodexAdapter();
    const record = await adapter.parseSession((await adapter.listSessions())[0]!);

    expect(record.endedMidTask).toBe(false);
    expect(record.lastAssistantText).toBe("Done.");
  });

  it("marks a `codex exec` rollout as automated", async () => {
    const lines = codexLines(CODEX_ID).map((line) => {
      const entry = line as Record<string, unknown>;
      if (entry["type"] !== "session_meta") return entry;
      const payload = entry["payload"] as Record<string, unknown>;
      return { ...entry, payload: { ...payload, originator: "codex_exec", source: "exec" } };
    });
    await writeCodexSession(home, { date: "2026-07-11", sessionId: CODEX_ID, lines });

    const adapter = new CodexAdapter();
    const record = await adapter.parseSession((await adapter.listSessions())[0]!);

    expect(record.isAutomated).toBe(true);
  });

  it("resumes with `codex resume`", () => {
    const command = new CodexAdapter().resumeCommand({
      harness: "codex",
      sessionId: CODEX_ID,
      cwd: "/Users/dev/Projects/beta",
    } as never);

    expect(command.command).toBe("codex");
    expect(command.args).toEqual(["resume", CODEX_ID]);
  });

  it("reads changed files out of an apply_patch payload", () => {
    expect(patchedFiles("*** Update File: src/a.ts\n*** Add File: src/b.ts")).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(patchedFiles("no patch here")).toEqual([]);
  });

  it("only treats a nonzero exit as a failure", () => {
    expect(exitFailure("Process exited with code 0\nfine")).toBeNull();
    expect(exitFailure("Process exited with code 2\nboom")).toContain("boom");
    expect(exitFailure(null)).toBeNull();
  });
});

describe("DecimatingSampler", () => {
  function sample(count: number, capacity = 8): number[] {
    const s = new DecimatingSampler<number>(capacity);
    for (let i = 1; i <= count; i += 1) s.push(i);
    return s.toArray();
  }

  it("keeps everything when the stream fits", () => {
    expect(sample(8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("always retains the first item — that is the original ask", () => {
    expect(sample(2000)[0]).toBe(1);
  });

  it("stays evenly spaced as the stream grows", () => {
    expect(sample(20)).toEqual([1, 5, 9, 13, 17]);
    expect(sample(200)).toEqual([1, 33, 65, 97, 129, 161, 193]);
  });

  it("stays bounded no matter how long the stream is", () => {
    expect(sample(100_000).length).toBeLessThanOrEqual(8);
  });

  it("holds an empty stream", () => {
    expect(sample(0)).toEqual([]);
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new DecimatingSampler<number>(0)).toThrow(RangeError);
    expect(() => new DecimatingSampler<number>(-1)).toThrow(RangeError);
  });

  it("retains exactly the first item forever at capacity 1", () => {
    expect(sample(1, 1)).toEqual([1]);
    expect(sample(2000, 1)).toEqual([1]);
  });
});

describe("the session arc", () => {
  const base = { sessionId: CLAUDE_ID, cwd: "/Users/dev/Projects/acme", gitBranch: "main", version: "2.0" };

  async function parseClaude(lines: unknown[]) {
    await writeClaudeSession(home, { slug: "-Users-dev-Projects-acme", sessionId: CLAUDE_ID, lines });
    const adapter = new ClaudeCodeAdapter();
    const refs = await adapter.listSessions();
    return adapter.parseSession(refs[0]!);
  }

  it("keeps the original ask on a session far longer than the tail window", async () => {
    const record = await parseClaude(
      Array.from({ length: 30 }, (_, i) => ({
        ...base,
        type: "user",
        timestamp: `2026-07-10T10:${String(i).padStart(2, "0")}:00.000Z`,
        message: { role: "user", content: `turn ${i + 1}` },
      })),
    );

    // The tail window has long since dropped turn 1 ...
    expect(record.recentUserPrompts).not.toContain("turn 1");
    // ... but the arc still has it.
    expect(record.arcPrompts[0]).toBe("turn 1");
    expect(record.arcPrompts.length).toBeLessThanOrEqual(8);
  });

  it("excludes injected context from the arc, exactly as the tail does", async () => {
    const record = await parseClaude(claudeLines(CLAUDE_ID));

    // No <system-reminder>, no tool_result — humanText() guards both windows.
    expect(record.arcPrompts).toEqual(["set up the auth module", "the admin case still 401s"]);
  });

  it("keeps the original ask for codex too", async () => {
    await writeCodexSession(home, {
      date: "2026-07-11",
      sessionId: CODEX_ID,
      lines: [
        {
          type: "session_meta",
          timestamp: "2026-07-11T10:00:00.000Z",
          payload: { id: CODEX_ID, cwd: "/Users/dev/Projects/beta", originator: "codex_cli" },
        },
        ...Array.from({ length: 30 }, (_, i) => ({
          type: "event_msg",
          timestamp: `2026-07-11T10:${String(i).padStart(2, "0")}:00.000Z`,
          payload: { type: "user_message", message: `turn ${i + 1}` },
        })),
      ],
    });

    const adapter = new CodexAdapter();
    const refs = await adapter.listSessions();
    const record = await adapter.parseSession(refs[0]!);

    expect(record.recentUserPrompts).not.toContain("turn 1");
    expect(record.arcPrompts[0]).toBe("turn 1");
  });
});
