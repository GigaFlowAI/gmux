/**
 * Ask: questions about the sessions you already have, answered from the
 * summaries you already paid for.
 *
 * The design decision worth knowing before you change anything here:
 *
 * **The tool loop is the harness's, not ours.** The prompt tells the model it
 * may run `gm grep '<query>' --json`, and the provider is invoked with exactly
 * that permission (see providers.ts `askArgv`). We parse no tool calls and speak
 * no vendor protocol — the abstraction stays "a CLI that reads a prompt and
 * writes text", which is the only reason gigamanage depends on no vendor SDK.
 *
 * The cost is that we don't meter how many greps the model runs. Accepted: grep
 * is read-only and cheap, and the provider's own turn limit bounds it.
 *
 * The context block is bounded the way `distill()` is bounded — a few KB
 * regardless of how many sessions you have — because a REPL re-sends it every
 * turn.
 */

import { AskProviderError } from "../core/errors.js";
import { relativeAge, truncate } from "../core/text.js";
import type { AskContext, AskProvider, AskTurn, SessionView } from "../core/types.js";
import { readConfig, resolveAskCommand } from "./config.js";
import { runProviderCommand } from "./provider-process.js";
import { onPath } from "./providers.js";

/**
 * Ask gets longer than a summary does: the model may run several greps before
 * it answers, and each is a subprocess of its own.
 */
export const ASK_TIMEOUT_MS = 300_000;

/** How many sessions go into the block. Matches the picker's default window. */
export const ASK_SESSION_LIMIT = 20;

/** Per-session caps. A refactor touching 200 files must not eat the prompt. */
const MAX_FILES_PER_SESSION = 8;
const MAX_FIELD_CHARS = 240;

export function buildAskContext(
  views: readonly SessionView[],
  focusId: string | null = null,
  limit: number = ASK_SESSION_LIMIT,
): AskContext {
  const sessions = [...views]
    .sort((a, b) => b.record.updatedAt.localeCompare(a.record.updatedAt))
    .slice(0, limit);

  // Only claim focus on a session that actually made the window — otherwise the
  // prompt would point at a session whose details aren't in it.
  const focused = focusId
    ? (sessions.find((v) => v.record.sessionId.startsWith(focusId))?.record.sessionId ?? null)
    : null;

  return { sessions, focusId: focused };
}

/** Short id: what a human types and what the model should quote back. */
export function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function renderSession(view: SessionView, index: number, focusId: string | null, now: Date): string {
  const { record, summary } = view;
  const lines: string[] = [];

  const flags = [
    record.endedMidTask ? "ENDED MID-TASK" : "",
    record.sessionId === focusId ? "← the session the user is looking at" : "",
  ].filter((f) => f !== "");

  const where = record.gitBranch ? `${record.project ?? "?"}/${record.gitBranch}` : (record.project ?? "?");
  lines.push(
    `### ${index + 1}. ${where} · ${relativeAge(record.updatedAt, now)} ago · id ${shortId(record.sessionId)}${
      flags.length > 0 ? `  [${flags.join(" · ")}]` : ""
    }`,
  );
  lines.push(`harness: ${record.harness}`);

  if (summary) {
    lines.push(`headline: ${truncate(summary.headline, MAX_FIELD_CHARS)}`);
    if (summary.overview) lines.push(`what it's about: ${truncate(summary.overview, MAX_FIELD_CHARS)}`);
    if (summary.landed) lines.push(`landed: ${truncate(summary.landed, MAX_FIELD_CHARS)}`);
    if (summary.open) lines.push(`open: ${truncate(summary.open, MAX_FIELD_CHARS)}`);
    if (summary.nextStep) lines.push(`next step: ${truncate(summary.nextStep, MAX_FIELD_CHARS)}`);
  } else {
    // No summary yet. Say so rather than omitting the session: a gap the model
    // knows about is a caveat it can give you, and one it doesn't is a lie.
    lines.push("summary: NOT YET WRITTEN — the facts below are all we know");
    if (record.title) lines.push(`title (recorded at session START, often stale): ${record.title}`);
    if (record.lastUserPrompt) {
      lines.push(`the developer's last instruction: ${truncate(record.lastUserPrompt, MAX_FIELD_CHARS)}`);
    }
  }

  if (record.filesTouched.length > 0) {
    const shown = record.filesTouched.slice(0, MAX_FILES_PER_SESSION);
    const more = record.filesTouched.length - shown.length;
    lines.push(`files: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`);
  }
  if (record.lastToolFailure) {
    lines.push(`last failing command: ${truncate(record.lastToolFailure, MAX_FIELD_CHARS)}`);
  }

  return lines.join("\n");
}

/**
 * The prompt for one turn.
 *
 * `turns` is the conversation so far. We re-send it because `claude -p` is
 * one-shot and `--resume` is Claude-specific — carrying state in memory and
 * replaying it is what keeps this working for any provider. Bounded, because
 * the context block is.
 */
export function buildAskPrompt(
  context: AskContext,
  turns: readonly AskTurn[],
  question: string,
  now: Date = new Date(),
): string {
  const lines: string[] = [
    "You are helping a developer decide what to work on next, using summaries of their recent AI coding-agent sessions.",
    "",
    "Each session below was summarized from the ARC of its transcript — what the developer originally asked for, how the work moved, and where it ended — so the fields describe both what the work IS and where it LANDED. A session's `title` is different: it was recorded in the session's first seconds and never revised, so it names the opening prompt and is usually stale. Trust the summary over the title.",
    "",
    `## The developer's ${context.sessions.length} most recent session${context.sessions.length === 1 ? "" : "s"}`,
    "",
  ];

  if (context.sessions.length === 0) {
    lines.push("(none — the developer has no indexed sessions)");
  } else {
    lines.push(context.sessions.map((v, i) => renderSession(v, i, context.focusId, now)).join("\n\n"));
  }

  lines.push(
    "",
    "## Digging deeper",
    "",
    "The summaries above are all you have by default. If answering well needs detail they don't carry — what was actually said, the text of an error, whether something was tried — you can search the full transcripts:",
    "",
    "    gm grep '<query>' --json",
    "",
    "Useful flags: `-p <project>` narrows to one repo, `-n <count>` caps results, `-e` treats the query as a regex.",
    "Run it when it would change your answer. Don't run it to confirm something the summaries already say, and don't guess at detail you could have looked up.",
  );

  if (turns.length > 0) {
    lines.push("", "## The conversation so far", "");
    for (const turn of turns) {
      lines.push(`Developer: ${turn.question}`, `You: ${turn.answer}`, "");
    }
  }

  lines.push(
    "",
    "## The question",
    "",
    question,
    "",
    "## How to answer",
    "",
    "Answer in plain prose for a terminal — no markdown headers, no tables.",
    "Be specific: name the session (by its short id), the files, the errors. Point at where to look.",
    "Ground every claim in the evidence above or in what you grep. If the summaries don't support an answer, say what's missing rather than filling the gap.",
    "Be brief. This is read in a terminal between other work.",
  );

  return lines.join("\n");
}

export class CliAskProvider implements AskProvider {
  readonly name: string;
  private readonly argv: string[];

  constructor(argv: string[]) {
    this.argv = argv;
    this.name = argv.join(" ");
  }

  async isAvailable(): Promise<boolean> {
    const binary = this.argv[0];
    if (!binary) return false;
    return onPath(binary);
  }

  async ask(prompt: string): Promise<string> {
    try {
      const output = await runProviderCommand(this.argv, prompt, { timeoutMs: ASK_TIMEOUT_MS });
      const answer = output.trim();
      if (answer === "") throw new Error("reply was empty");
      return answer;
    } catch (error) {
      throw new AskProviderError(this.name, (error as Error).message);
    }
  }
}

/**
 * The ask provider for the current config, or null when the user has said no to
 * model calls.
 *
 * Null is an answer, not a failure — `provider: null` in config means exactly
 * this, and the caller renders it as "run `gm setup`" rather than as an error.
 */
export async function defaultAskProvider(): Promise<CliAskProvider | null> {
  const command = resolveAskCommand(await readConfig());
  return command ? new CliAskProvider(command) : null;
}
