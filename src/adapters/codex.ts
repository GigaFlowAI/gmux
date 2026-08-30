/**
 * Codex adapter.
 *
 * Layout: ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl
 * Lines are tagged `session_meta`, `event_msg`, `response_item` or `turn_context`.
 *
 * We read human turns and agent replies from `event_msg` rather than
 * `response_item/message`, because the latter also carries `developer`-role
 * system injections that are not conversation.
 *
 * Codex gives us a signal Claude Code does not: a `task_started` with no matching
 * `task_complete` means the session was genuinely cut off mid-task.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { harnessHome } from "../core/paths.js";
import type { SessionRecord, SessionRef } from "../core/types.js";
import { truncate } from "../core/text.js";
import { readJsonl, DecimatingSampler, RingBuffer } from "./jsonl.js";
import { projectName } from "./claude-code.js";
import type { HarnessAdapter, ResumeCommand } from "./types.js";

const RECENT_PROMPT_COUNT = 12;
/** Waypoints sampled across the whole session. See DecimatingSampler. */
const ARC_PROMPT_COUNT = 8;

/** `rollout-2026-06-05T18-06-20-<uuid>.jsonl` → the uuid. */
const ROLLOUT_FILE = /^rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Markers inside an apply_patch payload naming the files it changes. */
const PATCH_TARGET = /\*\*\* (?:Update|Add|Delete) File: (.+)/g;

export class CodexAdapter implements HarnessAdapter {
  readonly id = "codex";
  readonly displayName = "Codex";
  readonly processNames = ["codex"] as const;
  readonly launchCommand = "codex";

  private root(): string {
    return join(harnessHome(), ".codex", "sessions");
  }

  async isAvailable(): Promise<boolean> {
    return existsSync(this.root());
  }

  async listSessions(): Promise<SessionRef[]> {
    const root = this.root();
    if (!existsSync(root)) return [];
    return this.walk(root);
  }

  /** Sessions nest under year/month/day, so discovery is a bounded recursive walk. */
  private async walk(dir: string): Promise<SessionRef[]> {
    const refs: SessionRef[] = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return refs;
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        refs.push(...(await this.walk(path)));
        continue;
      }
      const match = ROLLOUT_FILE.exec(entry.name);
      if (!match) continue;
      try {
        const stats = await stat(path);
        if (!stats.isFile() || stats.size === 0) continue;
        refs.push({
          harness: this.id,
          sessionId: match[1]!,
          filePath: path,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
        });
      } catch {
        continue;
      }
    }
    return refs;
  }

  async parseSession(ref: SessionRef): Promise<SessionRecord> {
    const prompts = new RingBuffer<string>(RECENT_PROMPT_COUNT);
    const arc = new DecimatingSampler<string>(ARC_PROMPT_COUNT);
    const filesTouched = new Set<string>();

    let cwd: string | null = null;
    let startedAt: string | null = null;
    let updatedAt: string | null = null;
    let lastAssistantText: string | null = null;
    let lastToolFailure: string | null = null;

    let messageCount = 0;
    let userPromptCount = 0;
    let tasksStarted = 0;
    let tasksCompleted = 0;
    let isAutomated = false;

    for await (const entry of readJsonl(ref.filePath)) {
      const type = str(entry["type"]);
      const payload = obj(entry["payload"]);
      const timestamp = str(entry["timestamp"]);
      if (timestamp) {
        startedAt ??= timestamp;
        updatedAt = timestamp;
      }
      if (!payload) continue;

      if (type === "session_meta") {
        cwd ??= str(payload["cwd"]);
        // `codex exec` is the non-interactive entrypoint — automation, not a
        // conversation someone sat through.
        if (str(payload["originator"]) === "codex_exec" || str(payload["source"]) === "exec") {
          isAutomated = true;
        }
        continue;
      }

      if (type === "turn_context") {
        cwd ??= str(payload["cwd"]);
        continue;
      }

      if (type === "event_msg") {
        const kind = str(payload["type"]);
        if (kind === "user_message") {
          const text = str(payload["message"]);
          if (text) {
            messageCount += 1;
            userPromptCount += 1;
            const prompt = truncate(text, 600);
            prompts.push(prompt);
            arc.push(prompt);
          }
        } else if (kind === "agent_message") {
          const text = str(payload["message"]);
          if (text) {
            messageCount += 1;
            lastAssistantText = text;
          }
        } else if (kind === "task_started") {
          tasksStarted += 1;
        } else if (kind === "task_complete") {
          tasksCompleted += 1;
          lastAssistantText = str(payload["last_agent_message"]) ?? lastAssistantText;
        }
        continue;
      }

      if (type === "response_item") {
        const kind = str(payload["type"]);
        if (kind === "function_call") {
          const args = str(payload["arguments"]);
          if (args) for (const file of patchedFiles(args)) filesTouched.add(file);
        } else if (kind === "function_call_output") {
          const output = str(payload["output"]);
          const failure = exitFailure(output);
          if (failure) lastToolFailure = truncate(failure, 300);
        }
      }
    }

    const recentUserPrompts = prompts.toArray();
    const arcPrompts = arc.toArray();
    // A turn was started and never completed: the session was interrupted.
    const endedMidTask = tasksStarted > tasksCompleted;

    return {
      harness: this.id,
      sessionId: ref.sessionId,
      filePath: ref.filePath,
      cwd,
      project: projectName(cwd),
      gitBranch: null, // Codex does not record the branch in its rollout files.
      startedAt,
      updatedAt: updatedAt ?? new Date(ref.mtimeMs).toISOString(),
      messageCount,
      userPromptCount,
      title: null, // Codex writes no title; the summary layer supplies one.
      lastUserPrompt: recentUserPrompts[recentUserPrompts.length - 1] ?? null,
      recentUserPrompts,
      arcPrompts,
      filesTouched: [...filesTouched],
      prLinks: [],
      lastAssistantText: lastAssistantText ? truncate(lastAssistantText, 1500) : null,
      lastToolFailure,
      endedMidTask,
      isSidechain: false,
      isAutomated,
    };
  }

  resumeCommand(record: SessionRecord): ResumeCommand {
    return {
      command: "codex",
      args: ["resume", record.sessionId],
      cwd: record.cwd ?? process.cwd(),
    };
  }
}

/**
 * Pull file paths out of an apply_patch payload, wherever it is embedded.
 *
 * The payload usually arrives inside a JSON-encoded argument string, so the
 * patch's own newlines show up as the two characters `\` `n` rather than as a
 * line break. A path therefore ends at the first backslash or quote, not at the
 * end of the line.
 */
export function patchedFiles(args: string): string[] {
  const files: string[] = [];
  for (const match of args.matchAll(PATCH_TARGET)) {
    const file = match[1]?.split(/[\\"']/)[0]?.trim();
    if (file) files.push(file);
  }
  return files;
}

/** Codex reports shell failures in prose; a nonzero exit is the signal. */
export function exitFailure(output: string | null): string | null {
  if (!output) return null;
  const match = /Process exited with code (\d+)/.exec(output);
  if (!match || match[1] === "0") return null;
  return output.trim();
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
