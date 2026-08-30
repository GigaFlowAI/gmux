/**
 * Fixture builders: write real session trees to a temp dir so adapters are
 * exercised against the filesystem, not against a mocked-out one.
 */

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "gigamanage-test-"));
}

function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/** Write a Claude Code session at ~/.claude/projects/<slug>/<id>.jsonl */
export async function writeClaudeSession(
  home: string,
  options: { slug: string; sessionId: string; lines: unknown[] },
): Promise<string> {
  const dir = join(home, ".claude", "projects", options.slug);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${options.sessionId}.jsonl`);
  await writeFile(path, jsonl(options.lines), "utf8");
  return path;
}

/** Write a Codex rollout at ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl */
export async function writeCodexSession(
  home: string,
  options: { date: string; sessionId: string; lines: unknown[] },
): Promise<string> {
  const [year, month, day] = options.date.split("-") as [string, string, string];
  const dir = join(home, ".codex", "sessions", year, month, day);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-${options.date}T10-00-00-${options.sessionId}.jsonl`);
  await writeFile(path, jsonl(options.lines), "utf8");
  return path;
}

/** A realistic Claude Code session: renamed mid-flight, ends on a failing test. */
export function claudeLines(sessionId: string): unknown[] {
  const base = { sessionId, cwd: "/Users/dev/Projects/acme", gitBranch: "fix-auth", version: "2.0" };
  return [
    { type: "agent-setting", agentSetting: "claude", sessionId },
    // The title is written early and never revised — this is the staleness we fix.
    { type: "ai-title", aiTitle: "Set up the auth module", sessionId },
    {
      ...base,
      type: "user",
      timestamp: "2026-07-10T10:00:00.000Z",
      message: { role: "user", content: "set up the auth module" },
    },
    {
      ...base,
      type: "assistant",
      timestamp: "2026-07-10T10:01:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Adding the auth module." },
          { type: "tool_use", name: "Write", input: { file_path: "/Users/dev/Projects/acme/src/auth.ts" } },
        ],
      },
    },
    // Injected context, not a human turn. Must not be treated as a prompt.
    {
      ...base,
      type: "user",
      timestamp: "2026-07-10T10:02:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "<system-reminder>be careful</system-reminder>" }],
      },
    },
    // A tool result being fed back, not a human turn.
    {
      ...base,
      type: "user",
      timestamp: "2026-07-10T10:03:00.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", is_error: true, content: "FAIL src/auth.test.ts: expected 200, got 401" }],
      },
    },
    {
      ...base,
      type: "user",
      timestamp: "2026-07-10T10:04:00.000Z",
      message: { role: "user", content: "the admin case still 401s" },
    },
    {
      ...base,
      type: "assistant",
      timestamp: "2026-07-10T10:05:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Still failing for admins." }] },
    },
    { type: "pr-link", prNumber: 142, prUrl: "https://github.com/acme/acme/pull/142", prRepository: "acme/acme", sessionId },
    { type: "last-prompt", lastPrompt: "the admin case still 401s", sessionId },
  ];
}

/** A realistic Codex rollout, interrupted: task_started with no task_complete. */
export function codexLines(sessionId: string): unknown[] {
  const stamp = (s: string) => `2026-07-11T${s}.000Z`;
  return [
    {
      type: "session_meta",
      timestamp: stamp("10:00:00"),
      payload: { id: sessionId, cwd: "/Users/dev/Projects/beta", originator: "codex_cli", cli_version: "0.135.0" },
    },
    { type: "event_msg", timestamp: stamp("10:00:01"), payload: { type: "task_started", turn_id: "t1" } },
    {
      type: "event_msg",
      timestamp: stamp("10:00:02"),
      payload: { type: "user_message", message: "port the parser to typescript" },
    },
    // Developer-role injection: system text, not conversation. Must be ignored.
    {
      type: "response_item",
      timestamp: stamp("10:00:03"),
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "<permissions instructions> sandbox is read-only" }],
      },
    },
    {
      type: "response_item",
      timestamp: stamp("10:00:04"),
      payload: {
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({ cmd: "apply_patch '*** Update File: src/parser.ts\\n+code'" }),
      },
    },
    {
      type: "response_item",
      timestamp: stamp("10:00:05"),
      payload: { type: "function_call_output", output: "Process exited with code 1\nTypeError: bad token" },
    },
    {
      type: "event_msg",
      timestamp: stamp("10:00:06"),
      payload: { type: "agent_message", message: "The parser compiles but the lexer test fails." },
    },
    // No task_complete: this session was cut off.
  ];
}
