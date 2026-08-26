/**
 * Ask-box intent router.
 *
 * The ctrl-g overlay's ask box takes free text. Most of it is a *question* for
 * the running agents (the existing broadcast). Some of it is a request to
 * *rearrange the tmux workspace* ("group these by project", "put the shells in
 * their own window"). `classifyIntent` decides which, using the same provider
 * plumbing as summaries — a one-shot CLI that reads a prompt and writes text.
 *
 * SAFETY: this defaults to "ask" on every uncertainty. Empty prompt, no
 * provider configured, a spawn failure, a timeout, or any reply that is not an
 * unambiguous "ORGANIZE" all resolve to "ask", so a normal question is never
 * misread as a reorganization. The caller then previews-and-confirms before
 * anything touches tmux; misclassifying the other direction (a genuine reorg
 * read as a question) merely broadcasts it, which is harmless.
 */

import { readConfig, resolveSummaryCommand } from "./config.js";
import { runProviderCommand } from "./provider-process.js";

export type AskIntent = "organize" | "ask";

/** Kept tight: this is a single-word classification, not a summary or an answer. */
const CLASSIFY_TIMEOUT_MS = 30_000;

export interface ClassifyDeps {
  /**
   * The provider argv. Left `undefined` it is resolved from config (same as the
   * summarizer). Pass `null` for "no provider" and a concrete argv (e.g. a
   * `node -e` fake) in tests. When passed, it is used as-is — no config read.
   */
  command?: string[] | null;
  /** The spawn seam, injectable for tests. Defaults to the real provider run. */
  run?: typeof runProviderCommand;
}

/** Pure. The one-shot classification prompt. */
export function buildClassifyPrompt(prompt: string): string {
  return [
    "Classify the user's message. Reply with exactly one word and nothing else:",
    "ORGANIZE if it asks to rearrange/reorganize the tmux workspace layout (windows, panes, tiling, grouping, moving panes),",
    "or ASK if it is a question or instruction for the running agents.",
    "",
    `Message: ${prompt}`,
  ].join("\n");
}

/**
 * Pure. Reads a raw provider reply as an intent, conservatively: only the
 * unambiguous first word "organize" (case-insensitive, punctuation ignored)
 * counts as ORGANIZE. Anything else — including empty, prose, or "ask" — is
 * "ask". Mirrors the classifier's "reply with exactly one word" instruction
 * while tolerating a trailing period or newline.
 */
export function parseIntent(raw: string): AskIntent {
  const first = raw.toLowerCase().match(/[a-z]+/);
  return first && first[0] === "organize" ? "organize" : "ask";
}

/**
 * Decide whether an ask-box prompt is a workspace-reorganization request
 * ("organize") or a question for the agents ("ask"). Never throws; every
 * failure path returns "ask".
 */
export async function classifyIntent(prompt: string, deps: ClassifyDeps = {}): Promise<AskIntent> {
  const trimmed = prompt.trim();
  if (trimmed === "") return "ask"; // Nothing to classify — and never spawn for it.

  const argv = deps.command !== undefined ? deps.command : resolveSummaryCommand(await readConfig());
  if (!argv || argv.length === 0) return "ask"; // No provider is a "no", not an error.

  try {
    const run = deps.run ?? runProviderCommand;
    const raw = await run(argv, buildClassifyPrompt(trimmed), { timeoutMs: CLASSIFY_TIMEOUT_MS });
    return parseIntent(raw);
  } catch {
    return "ask"; // Timeout, nonzero exit, spawn failure — default to the safe path.
  }
}
