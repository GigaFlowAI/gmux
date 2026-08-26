/**
 * Config: the one thing gmux remembers because a human said so.
 *
 * Everything else in `~/.cache/gmux` is derived and disposable. This
 * isn't, which is why it lives under the config dir instead — see core/paths.ts.
 *
 * Two rules run through this file:
 *
 * 1. **A bad config is not an error.** Unreadable, malformed, or written by a
 *    future version — all are treated as *absent*. `gmux ls` must not die because
 *    a JSON file got truncated; it should fall back to the behavior of someone
 *    who never ran `gmux setup`, which is a behavior that works.
 * 2. **The env var wins.** `GMUX_SUMMARY_CMD` sat on top before config
 *    existed, and every script, test and CI job that sets it must keep working
 *    without being told about a new file.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { configPath } from "../core/paths.js";
import { DEFAULT_GMUX_CONFIG, type GuardianPolicy, type GmuxConfig } from "../core/gmux-types.js";
import { CONFIG_VERSION, type GmConfig, type ProviderChoice } from "../core/types.js";
import { askArgvFor, firstDetected, summaryArgvFor, type ProviderSpec } from "./providers.js";

/** The last-resort provider, unchanged from before config existed. */
export const FALLBACK_COMMAND: readonly string[] = ["claude", "-p"];

/** The env var that outranks everything here. */
export const SUMMARY_CMD_ENV = "GMUX_SUMMARY_CMD";

/**
 * Set on any `gmux` we spawn ourselves.
 *
 * THE RECURSION GUARD. `gmux ask` runs a provider that may run `gmux grep`, and
 * `gmux grep` would otherwise fire the postAction hook and spawn a summarizer —
 * from inside a process that a summarizer-adjacent call started. The lock would
 * absorb most of it; this stops it being a question in the first place.
 */
export const CHILD_ENV = "GMUX_CHILD";

export function isChildProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[CHILD_ENV];
  return raw != null && raw.trim() !== "" && raw !== "0";
}

/** The env a spawned provider gets: ours, plus the marker. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, [CHILD_ENV]: "1" };
}

export function defaultConfig(): GmConfig {
  return { version: CONFIG_VERSION, provider: null, autoSummarize: false };
}

/** Parse a config blob. Returns null for anything we cannot trust. */
export function parseConfig(raw: string): GmConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const object = parsed as Record<string, unknown>;

  // A config from a future version may mean things we'd misread. Ignoring it is
  // safe; guessing is not.
  const version = object["version"];
  if (typeof version !== "number" || version > CONFIG_VERSION) return null;

  // Every field must be present and well-typed, or the file is not one we
  // wrote and we do not get to guess at what it meant.
  if (typeof object["autoSummarize"] !== "boolean") return null;
  if (!("provider" in object)) return null;

  /**
   * THE DISTINCTION THIS FUNCTION EXISTS FOR.
   *
   * An explicit `"provider": null` is a *decision* — "make no model calls" —
   * and must be honored. A provider that is present but malformed is
   * *corruption*, and must make the whole config untrusted, which resolves to
   * autodetect.
   *
   * Collapsing the two means a truncated write, or a hand-edited file with a
   * typo, silently disables every model-backed feature — permanently, since the
   * file still exists and so the wizard never runs again. The user would see
   * summaries stop and have nothing to look at but a config that reads fine.
   */
  const raw_provider = object["provider"];
  let provider: ProviderChoice | null = null;
  if (raw_provider !== null) {
    provider = parseProvider(raw_provider);
    if (!provider) return null;
  }

  // gmux is newer than the rest of GmConfig, so its absence — or a partial
  // block from a version that wrote fewer fields — must not untrust the whole
  // file. resolveGmuxConfig fills in whatever this leaves out.
  const gmux = parseGmuxBlock(object["gmux"]);

  return { version, provider, autoSummarize: object["autoSummarize"], ...(gmux ? { gmux } : {}) };
}

/**
 * Parse the gmux block leniently: field-by-field, keeping whatever is
 * well-typed and dropping the rest — never the whole block, and never the
 * config it lives in. `resolveGmuxConfig` is what turns this partial result
 * into a complete `GmuxConfig`.
 */
function parseGmuxBlock(value: unknown): GmuxConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  const result: Partial<GmuxConfig> = {};
  if (object["guardianPolicy"] === "off" || object["guardianPolicy"] === "notify" || object["guardianPolicy"] === "auto") {
    result.guardianPolicy = object["guardianPolicy"];
  }
  if (typeof object["memoryThreshold"] === "number") result.memoryThreshold = object["memoryThreshold"];
  if (typeof object["cooldownSeconds"] === "number") result.cooldownSeconds = object["cooldownSeconds"];
  if (typeof object["tickMs"] === "number") result.tickMs = object["tickMs"];
  if (Object.keys(result).length === 0) return undefined;
  return result as GmuxConfig;
}

/**
 * Fill in whatever a stored `gmux` block leaves out, from `DEFAULT_GMUX_CONFIG`.
 *
 * Never fails on a missing or partial block — older configs have none at all,
 * and `parseGmuxBlock` above only ever keeps well-typed fields, so what
 * reaches here is trustworthy as far as it goes.
 */
export function resolveGmuxConfig(config: GmConfig | null): GmuxConfig {
  const g = config?.gmux;
  if (!g) return { ...DEFAULT_GMUX_CONFIG };
  const policy: GuardianPolicy =
    g.guardianPolicy === "off" || g.guardianPolicy === "notify" || g.guardianPolicy === "auto"
      ? g.guardianPolicy
      : DEFAULT_GMUX_CONFIG.guardianPolicy;
  return {
    guardianPolicy: policy,
    memoryThreshold: typeof g.memoryThreshold === "number" ? g.memoryThreshold : DEFAULT_GMUX_CONFIG.memoryThreshold,
    cooldownSeconds: typeof g.cooldownSeconds === "number" ? g.cooldownSeconds : DEFAULT_GMUX_CONFIG.cooldownSeconds,
    tickMs: typeof g.tickMs === "number" ? g.tickMs : DEFAULT_GMUX_CONFIG.tickMs,
  };
}

/**
 * Parse a provider. Null means malformed — NOT "no provider".
 *
 * The caller turns a null here into an untrusted config. A command containing
 * anything that is not a string is rejected rather than filtered: dropping the
 * bad part would spawn a *different* command than the one on disk, which is a
 * worse outcome than declining to spawn anything.
 */
function parseProvider(value: unknown): ProviderChoice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const id = object["id"];
  const command = object["command"];
  if (typeof id !== "string" || id.trim() === "") return null;
  if (!Array.isArray(command) || command.length === 0) return null;
  if (!command.every((part): part is string => typeof part === "string")) return null;
  return { id, command: [...command] };
}

/** The config on disk, or null when there isn't a usable one. */
export async function readConfig(): Promise<GmConfig | null> {
  try {
    return parseConfig(await readFile(configPath(), "utf8"));
  } catch {
    return null; // Absent, unreadable — same answer either way.
  }
}

/**
 * True when a config file exists, however broken.
 *
 * Distinct from `readConfig() !== null` on purpose: the first-run wizard keys
 * off *existence*, so a corrupt file doesn't re-launch the wizard on every
 * single run. It falls back to defaults quietly instead, and `gmux doctor` says so.
 */
export async function configExists(): Promise<boolean> {
  try {
    await readFile(configPath(), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Write config through a temp file and a rename, so a kill can't truncate it. */
export async function writeConfig(config: GmConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

/**
 * Split a command string into argv, honoring quotes and backslash escapes.
 *
 * Splitting on whitespace alone was wrong in a way that fails quietly: a
 * perfectly reasonable `llm -m "model name"` became four arguments with literal
 * quote characters embedded — `["llm","-m","\"model","name\""]` — and gmux then
 * spawned a command the user never typed. The wizard invites free-form input, so
 * "don't type spaces in your arguments" is not a rule we get to have.
 *
 * This is not a shell. It handles the quoting a person actually uses in an
 * answer to a prompt — single quotes, double quotes, backslash escapes — and
 * deliberately does NOT do expansion, substitution, globbing or operators. The
 * argv goes to `spawn` without a shell, so there is nothing for those to mean,
 * and pretending otherwise would invite an injection surface where none exists.
 *
 * An unterminated quote closes at end of input rather than throwing: the user is
 * standing at a prompt, and taking their obvious intent beats an error message
 * about lexing.
 */
export function parseCommand(input: string): string[] {
  const argv: string[] = [];
  let current = "";
  let started = false; // Distinguishes a real empty argument ("") from no argument.
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;

    if (quote === null && (char === " " || char === "\t" || char === "\n")) {
      if (started) argv.push(current);
      current = "";
      started = false;
      continue;
    }

    // Backslash escapes the next character, except inside single quotes — where
    // a backslash is a literal backslash, as in every POSIX shell.
    if (char === "\\" && quote !== "'" && i + 1 < input.length) {
      current += input[++i]!;
      started = true;
      continue;
    }

    if (quote === null && (char === '"' || char === "'")) {
      quote = char;
      started = true; // `gmux ask ""` is an empty argument, not an absent one.
      continue;
    }

    if (char === quote) {
      quote = null;
      continue;
    }

    current += char;
    started = true;
  }

  if (started) argv.push(current);
  return argv;
}

/**
 * The command to use for summaries, or null for "make no model calls".
 *
 * Pure, and takes `detected` rather than probing PATH itself, so the precedence
 * rule can be tested without a machine that happens to have Claude installed.
 *
 * Highest wins:
 *   1. GMUX_SUMMARY_CMD
 *   2. config.provider.command
 *   3. first detected provider
 *   4. `claude -p`
 *
 * Rules 3 and 4 are the pre-config behavior, preserved exactly: someone with no
 * config file sees no change at all.
 */
export function resolveSummaryCommand(
  config: GmConfig | null,
  env: NodeJS.ProcessEnv = process.env,
  detected: ProviderSpec | null = firstDetected(),
): string[] | null {
  const override = env[SUMMARY_CMD_ENV];
  if (override && override.trim() !== "") return parseCommand(override);

  // Only an existing config can say "no": absent config means "not asked yet",
  // which falls through to autodetect rather than to silence. A known provider
  // re-derives from the catalog (summaryArgvFor), so a flag added after setup
  // reaches it — the same self-healing resolveAskCommand already has.
  if (config) return config.provider ? summaryArgvFor(config.provider) : null;

  if (detected) return [...detected.summaryArgv];
  return [...FALLBACK_COMMAND];
}

/**
 * The command to use for `gmux ask`, or null for "make no model calls".
 *
 * Same precedence, but the catalog's `askArgv` is used where we recognise the
 * provider — that's the variant permitted to run `gmux grep`.
 */
export function resolveAskCommand(
  config: GmConfig | null,
  env: NodeJS.ProcessEnv = process.env,
  detected: ProviderSpec | null = firstDetected(),
): string[] | null {
  const override = env[SUMMARY_CMD_ENV];
  if (override && override.trim() !== "") return parseCommand(override);

  if (config) return config.provider ? askArgvFor(config.provider) : null;

  if (detected) return [...detected.askArgv];
  return [...FALLBACK_COMMAND];
}

/**
 * Whether background summaries are allowed.
 *
 * `GMUX_AUTO_SUMMARIZE=0` is checked by the caller and still wins. This
 * adds the config answer: a user who said "no" in the wizard has said it once
 * and for good, and must not be asked again by a token spend they declined.
 *
 * No config means yes — the pre-config default.
 */
export function autoSummarizeAllowed(config: GmConfig | null): boolean {
  return config ? config.autoSummarize : true;
}

/**
 * Whether a bare `gmux` should drop into the setup wizard.
 *
 * Pure, and takes the world as data, because the interesting cases are exactly
 * the ones you cannot reproduce in a test terminal. Same reason `fzfArgs` is
 * split from the spawn.
 *
 * The TTY and `--json` gates are not politeness — they are non-negotiable #4.
 * `gmux ls --json` is an interface agents call; a version of it that can block on
 * a human prompt is a broken interface, whatever it prints.
 */
export interface SetupGate {
  hasConfig: boolean;
  /** Both stdin and stdout. A wizard needs to ask AND to be seen. */
  isTty: boolean;
  isJson: boolean;
  /** The command commander resolved, e.g. "pick", "ls", "__picker-rows". */
  commandName: string;
}

export function shouldRunSetupWizard(gate: SetupGate): boolean {
  if (gate.hasConfig) return false;
  if (!gate.isTty) return false;
  if (gate.isJson) return false;
  // `__`-prefixed commands are the hidden internals we spawn at ourselves.
  // Neither has a human at the other end, and `__picker-rows` runs while fzf
  // owns the terminal — a prompt there would corrupt the display.
  if (gate.commandName.startsWith("__")) return false;
  if (gate.commandName === "setup") return false;
  return true;
}
