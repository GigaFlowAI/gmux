/**
 * Claude Code adapter.
 *
 * Layout: ~/.claude/projects/<slugified-cwd>/<session-uuid>.jsonl
 * Each line is a tagged record; the ones we care about are `user`, `assistant`,
 * `ai-title`, `last-prompt` and `pr-link`.
 *
 * Note on `ai-title`: Claude Code writes it early and never revises it, so it
 * describes where a session STARTED. We keep it as `title` for reference, but
 * the summary layer is what tells you where the work LANDED.
 */

import { readdir, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { existsSync } from "node:fs";

import { harnessHome } from "../core/paths.js";
import type { PrLink, SessionRecord, SessionRef } from "../core/types.js";
import { truncate } from "../core/text.js";
import { readJsonl, DecimatingSampler, RingBuffer } from "./jsonl.js";
import type { HarnessAdapter, ResumeCommand } from "./types.js";

/** How many recent human turns to keep for the summarizer. */
const RECENT_PROMPT_COUNT = 12;
/** Waypoints sampled across the whole session. See DecimatingSampler. */
const ARC_PROMPT_COUNT = 8;
/** A failure or interruption this close to the end means the work was cut short. */
const END_WINDOW = 10;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly id = "claude-code";
  readonly displayName = "Claude Code";
  readonly processNames = ["claude"] as const;
  readonly launchCommand = "claude";

  private root(): string {
    return join(harnessHome(), ".claude", "projects");
  }

  async isAvailable(): Promise<boolean> {
    return existsSync(this.root());
  }

  /**
   * Discovery walks the whole tree, not just the top level.
   *
   * A project directory holds its top-level sessions as `<uuid>.jsonl`, but
   * subagent transcripts live deeper, under `<uuid>/subagents/agent-*.jsonl`,
   * and can nest again inside each other. Those are the sidechains: on this
   * author's machine they outnumber real sessions roughly nine to one, which is
   * exactly why they are hidden by default — and why they must still be found,
   * so `--include-sidechains` and `gm grep` can reach them.
   */
  async listSessions(): Promise<SessionRef[]> {
    const root = this.root();
    if (!existsSync(root)) return [];
    return this.walk(root);
  }

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
      if (!entry.name.endsWith(".jsonl")) continue;
      try {
        const stats = await stat(path);
        if (!stats.isFile() || stats.size === 0) continue;
        refs.push({
          harness: this.id,
          sessionId: entry.name.replace(/\.jsonl$/, ""),
          filePath: path,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
        });
      } catch {
        continue; // Vanished mid-scan; a live harness rewrites these constantly.
      }
    }
    return refs;
  }

  async parseSession(ref: SessionRef): Promise<SessionRecord> {
    const prompts = new RingBuffer<string>(RECENT_PROMPT_COUNT);
    const arc = new DecimatingSampler<string>(ARC_PROMPT_COUNT);
    const filesTouched = new Set<string>();
    const prLinks: PrLink[] = [];

    let cwd: string | null = null;
    let gitBranch: string | null = null;
    let title: string | null = null;
    let lastPrompt: string | null = null;
    let startedAt: string | null = null;
    let updatedAt: string | null = null;
    let lastAssistantText: string | null = null;
    let lastToolFailure: string | null = null;
    // A transcript under `subagents/` is a sidechain even if no line says so.
    let isSidechain = ref.filePath.includes(`${sep}subagents${sep}`);
    let isAutomated = false;

    let messageCount = 0;
    let userPromptCount = 0;
    let interruptedAt = -1;
    let failureAt = -1;

    for await (const entry of readJsonl(ref.filePath)) {
      const type = str(entry["type"]);

      // Session-level metadata lines.
      if (type === "ai-title") {
        title = str(entry["aiTitle"]) ?? title;
        continue;
      }
      if (type === "last-prompt") {
        lastPrompt = str(entry["lastPrompt"]) ?? lastPrompt;
        continue;
      }
      if (type === "pr-link") {
        // Claude Code re-emits this line on every turn, so the same PR appears
        // hundreds of times in a long session. Keep one entry per PR.
        const number = num(entry["prNumber"]);
        const url = str(entry["prUrl"]);
        if (number !== null && url && !prLinks.some((pr) => pr.url === url)) {
          prLinks.push({ number, url, repository: str(entry["prRepository"]) ?? undefined });
        }
        continue;
      }

      if (type !== "user" && type !== "assistant") continue;

      messageCount += 1;
      const timestamp = str(entry["timestamp"]);
      if (timestamp) {
        startedAt ??= timestamp;
        updatedAt = timestamp;
      }
      cwd ??= str(entry["cwd"]);
      gitBranch ??= str(entry["gitBranch"]);
      if (entry["isSidechain"] === true) isSidechain = true;
      // `sdk-cli` / `sdk` mark a headless `claude -p` run rather than a
      // conversation someone actually had.
      if (str(entry["entrypoint"])?.startsWith("sdk") || str(entry["promptSource"]) === "sdk") {
        isAutomated = true;
      }
      if (entry["interruptedMessageId"] != null) interruptedAt = messageCount;

      const message = obj(entry["message"]);
      const content = message?.["content"];

      if (type === "user") {
        // A `user` line is either a real human turn or a tool result being fed
        // back to the model. Only the former is a prompt.
        if (entry["isMeta"] === true) continue;
        const text = humanText(content);
        if (text) {
          userPromptCount += 1;
          prompts.push(text);
          arc.push(text);
        }
        if (hasToolError(content)) {
          failureAt = messageCount;
          lastToolFailure = truncate(toolErrorText(content) ?? "tool call failed", 300);
        }
        continue;
      }

      // Assistant turn.
      const text = assistantText(content);
      if (text) lastAssistantText = text;
      for (const file of editedFiles(content)) filesTouched.add(file);
    }

    const endedMidTask =
      (interruptedAt > 0 && messageCount - interruptedAt <= END_WINDOW) ||
      (failureAt > 0 && messageCount - failureAt <= END_WINDOW);

    const recentUserPrompts = prompts.toArray();
    const arcPrompts = arc.toArray();

    return {
      harness: this.id,
      sessionId: ref.sessionId,
      filePath: ref.filePath,
      cwd,
      project: projectName(cwd),
      // "HEAD" means detached or unknown; it tells the reader nothing.
      gitBranch: gitBranch === "HEAD" ? null : gitBranch,
      startedAt,
      updatedAt: updatedAt ?? new Date(ref.mtimeMs).toISOString(),
      messageCount,
      userPromptCount,
      title,
      lastUserPrompt: lastPrompt ?? recentUserPrompts[recentUserPrompts.length - 1] ?? null,
      recentUserPrompts,
      arcPrompts,
      filesTouched: [...filesTouched],
      prLinks,
      lastAssistantText: lastAssistantText ? truncate(lastAssistantText, 1500) : null,
      lastToolFailure,
      endedMidTask,
      isSidechain,
      isAutomated,
    };
  }

  resumeCommand(record: SessionRecord): ResumeCommand {
    return {
      command: "claude",
      args: ["--resume", record.sessionId],
      cwd: record.cwd ?? process.cwd(),
    };
  }
}

/**
 * Display name for a session's project.
 *
 * Worktrees live at `<repo>/.claude/worktrees/<branch>`, which would otherwise
 * show up as a project named after the branch. Attribute those to the repo.
 */
export function projectName(cwd: string | null): string | null {
  if (!cwd) return null;
  const marker = `${sep}.claude${sep}worktrees${sep}`;
  const at = cwd.indexOf(marker);
  const path = at === -1 ? cwd : cwd.slice(0, at);
  const name = basename(path);
  return name === "" ? null : name;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function blocks(content: unknown): Record<string, unknown>[] {
  return Array.isArray(content) ? content.filter((b): b is Record<string, unknown> => !!obj(b)) : [];
}

/**
 * Text the human actually typed.
 *
 * Filters out the machinery Claude Code injects into `user` lines: tool results,
 * slash-command envelopes, and `<system-reminder>` blocks. Those are not prompts,
 * and letting them through would poison the summaries.
 */
export function humanText(content: unknown): string | null {
  let raw: string | null = null;

  if (typeof content === "string") {
    raw = content;
  } else {
    const texts = blocks(content)
      .filter((b) => b["type"] === "text")
      .map((b) => str(b["text"]))
      .filter((t): t is string => t !== null);
    if (texts.length > 0) raw = texts.join("\n");
  }
  if (raw === null) return null;

  const cleaned = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, "")
    .replace(/<local-command-[\s\S]*?<\/local-command-[a-z-]+>/g, "")
    .trim();

  if (cleaned === "") return null;
  if (cleaned.startsWith("Caveat: The messages below")) return null;
  return truncate(cleaned, 600);
}

function assistantText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  const texts = blocks(content)
    .filter((b) => b["type"] === "text")
    .map((b) => str(b["text"]))
    .filter((t): t is string => t !== null);
  return texts.length > 0 ? texts.join("\n").trim() || null : null;
}

/** Files the assistant edited, read off its `tool_use` blocks. */
export function editedFiles(content: unknown): string[] {
  const files: string[] = [];
  for (const block of blocks(content)) {
    if (block["type"] !== "tool_use") continue;
    const name = str(block["name"]);
    if (!name || !EDIT_TOOLS.has(name)) continue;
    const input = obj(block["input"]);
    const file = input ? str(input["file_path"]) : null;
    if (file) files.push(file);
  }
  return files;
}

function hasToolError(content: unknown): boolean {
  return blocks(content).some((b) => b["type"] === "tool_result" && b["is_error"] === true);
}

function toolErrorText(content: unknown): string | null {
  for (const block of blocks(content)) {
    if (block["type"] !== "tool_result" || block["is_error"] !== true) continue;
    const inner = block["content"];
    if (typeof inner === "string") return inner;
    const text = blocks(inner)
      .map((b) => str(b["text"]))
      .find((t): t is string => t !== null);
    if (text) return text;
  }
  return null;
}
