/**
 * The catalog of model CLIs gigamanage knows how to call.
 *
 * This is deliberately NOT `adapters/registry.ts`, and the two must not be
 * merged. They are different axes that only coincidentally share names today:
 *
 * - An **adapter** reads sessions off disk. It answers "what happened?"
 * - A **provider** makes a model call. It answers "what does it mean?"
 *
 * You might read Claude Code transcripts while running summaries through Codex.
 * A provider may exist that no adapter parses. Conflating them would couple two
 * things that have no reason to move together.
 *
 * A provider is described by argv, not by an SDK. That is the entire abstraction
 * — see docs/architecture.md — and it is why adding one is four lines here.
 */

import { spawnSync } from "node:child_process";

import type { ProviderChoice } from "../core/types.js";

export interface ProviderSpec {
  /** Stable id, recorded in config. */
  id: string;
  displayName: string;
  /** The binary probed on PATH. */
  binary: string;
  /** argv for a one-shot summary call: prompt on stdin, text on stdout. */
  summaryArgv: string[];
  /**
   * argv for an `gm ask` call.
   *
   * Differs from `summaryArgv` in exactly one way: it grants the model
   * permission to run `gm grep`, so it can dig past the summaries into the
   * transcripts. The tool loop is the harness's — we parse no tool calls.
   */
  askArgv: string[];
  /** What to tell a user who hasn't got it. */
  install: string;
}

/** The id used when a user supplies their own command. */
export const CUSTOM_PROVIDER_ID = "custom";

/**
 * Known providers, in preference order — the first one detected becomes the
 * default when there is no config, which reproduces today's `claude -p`.
 */
export const PROVIDERS: readonly ProviderSpec[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    binary: "claude",
    summaryArgv: ["claude", "-p"],
    // Bash is scoped to `gm grep` alone: the model may read what it already has
    // the ids for, and nothing else. A blanket Bash grant would hand a session
    // summariser the whole machine.
    askArgv: ["claude", "-p", "--allowedTools", "Bash(gm grep:*)"],
    install: "npm install -g @anthropic-ai/claude-code",
  },
  {
    id: "codex",
    displayName: "Codex",
    binary: "codex",
    // These prompts describe sessions, not the repository gm happens to be
    // launched from. Codex must therefore work outside a trusted git checkout.
    summaryArgv: ["codex", "exec", "--skip-git-repo-check"],
    askArgv: [
      "codex",
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
    ],
    install: "npm install -g @openai/codex",
  },
];

/** True when `binary` resolves on PATH. */
export function onPath(binary: string): boolean {
  if (binary.trim() === "") return false;
  return spawnSync("which", [binary], { stdio: "ignore" }).status === 0;
}

export function providerById(id: string): ProviderSpec | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

/** Every catalog provider actually installed on this machine, in catalog order. */
export function detectProviders(): ProviderSpec[] {
  return PROVIDERS.filter((provider) => onPath(provider.binary));
}

/** The provider we'd pick for someone who has never run `gm setup`. */
export function firstDetected(): ProviderSpec | null {
  return detectProviders()[0] ?? null;
}

/**
 * The summary argv for a configured choice.
 *
 * A catalog provider gets its current `summaryArgv` — NOT the `command` frozen
 * into config at setup time. That stored command is only ever a snapshot of the
 * catalog, and a snapshot goes stale: codex gained `--skip-git-repo-check` after
 * it shipped, and a config written before that would otherwise call codex
 * without the flag forever, failing every summary with "not inside a trusted
 * directory". The catalog is the source of truth for a known id; the stored
 * command matters only for a `custom` provider, whose flags we cannot invent.
 *
 * The exact mirror of `askArgvFor` — the two must move together, or ask
 * self-heals across catalog fixes while summarize silently does not.
 */
export function summaryArgvFor(choice: ProviderChoice): string[] {
  const spec = providerById(choice.id);
  return spec ? [...spec.summaryArgv] : [...choice.command];
}

/**
 * The ask argv for a configured choice.
 *
 * A catalog provider gets its `askArgv` — the variant with the grep grant. A
 * custom command cannot: we don't know its flags, so we run it exactly as the
 * user wrote it. It may still answer from the summaries alone, which is the
 * degraded-but-working outcome rather than a broken one.
 */
export function askArgvFor(choice: ProviderChoice): string[] {
  const spec = providerById(choice.id);
  return spec ? [...spec.askArgv] : [...choice.command];
}

/** Turn a catalog entry into the thing that gets written to config. */
export function toChoice(spec: ProviderSpec): ProviderChoice {
  return { id: spec.id, command: [...spec.summaryArgv] };
}
