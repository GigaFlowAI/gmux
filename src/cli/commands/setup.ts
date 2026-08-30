/**
 * `gm setup` — choose the harness gigamanage calls for summaries and `gm ask`.
 *
 * The wizard is the only place gigamanage asks a question. Everything it writes
 * is a choice a human made, which is why it goes to the config dir rather than
 * the cache — see core/paths.ts.
 */

import { createInterface, type Interface } from "node:readline/promises";
import type { Command } from "commander";

import { GigamanageError } from "../../core/errors.js";
import { configPath } from "../../core/paths.js";
import { CONFIG_VERSION, type GmConfig, type ProviderChoice } from "../../core/types.js";
import {
  CUSTOM_PROVIDER_ID,
  PROVIDERS,
  onPath,
  toChoice,
  type ProviderSpec,
} from "../../services/providers.js";
import { parseCommand, readConfig, writeConfig } from "../../services/config.js";
import { bold, cyan, dim, green, yellow } from "../format.js";

/** One selectable answer to "which provider?". */
interface Option {
  label: string;
  detail: string;
  /** null = make no model calls. */
  choose: (rl: Interface) => Promise<ProviderChoice | null>;
}

function providerOption(spec: ProviderSpec): Option {
  const installed = onPath(spec.binary);
  return {
    label: spec.displayName,
    detail: installed ? `${spec.summaryArgv.join(" ")}` : `not installed — ${spec.install}`,
    choose: async () => toChoice(spec),
  };
}

/**
 * The menu.
 *
 * Every catalog provider is listed, installed or not, and an uninstalled one is
 * still selectable — you might be about to install it, and a wizard that hides
 * the option you came for is a wizard that sends you to the docs. The line says
 * what's missing and how to get it.
 */
export function buildOptions(): Option[] {
  const options: Option[] = PROVIDERS.map(providerOption);

  options.push({
    label: "Something else",
    detail: "any command that reads a prompt on stdin and writes text",
    choose: async (rl) => {
      for (;;) {
        const raw = (await rl.question(`\n  command (e.g. ${dim("gemini -p")}): `)).trim();
        const command = parseCommand(raw);
        if (command.length > 0) return { id: CUSTOM_PROVIDER_ID, command };
        process.stdout.write(`  ${yellow("A command is required.")}\n`);
      }
    },
  });

  options.push({
    label: "Nothing — make no model calls",
    detail: "no summaries, no `gm ask`. `gm ls` still works on hard facts alone",
    choose: async () => null,
  });

  return options;
}

/**
 * The wizard is a conversation, and it needs a terminal to have one.
 *
 * Not politeness — correctness. `readline/promises` drops lines that arrive
 * while no `question()` is pending, which is every gap between our questions.
 * Piped input therefore loses answers and then blocks on a line that will never
 * come, and the process exits 0 having written nothing: the worst possible
 * failure, because it looks like success.
 *
 * A TTY has no such gap — a human types *after* the prompt. So we require one,
 * and point anyone scripting this at the two things that do work headlessly.
 */
function requireTty(): void {
  if (process.stdin.isTTY === true && process.stdout.isTTY === true) return;
  throw new GigamanageError("`gm setup` needs an interactive terminal.", {
    fix: `Run it in a terminal. To configure without one, set GIGAMANAGE_SUMMARY_CMD='claude -p', or write ${configPath()} directly.`,
    exitCode: 3,
  });
}

/** Read a 1-based menu choice, re-asking until it is valid. */
async function askChoice(rl: Interface, options: readonly Option[], fallback: number): Promise<number> {
  for (;;) {
    const raw = (await rl.question(`\nwhich? [1-${options.length}, default ${fallback}] `)).trim();
    if (raw === "") return fallback;
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= options.length) return n;
    process.stdout.write(`  ${yellow(`Enter a number between 1 and ${options.length}.`)}\n`);
  }
}

async function askYesNo(rl: Interface, question: string, fallback: boolean): Promise<boolean> {
  const hint = fallback ? "Y/n" : "y/N";
  for (;;) {
    const raw = (await rl.question(`${question} [${hint}] `)).trim().toLowerCase();
    if (raw === "") return fallback;
    if (["y", "yes"].includes(raw)) return true;
    if (["n", "no"].includes(raw)) return false;
  }
}

/**
 * The wizard itself. Returns the config it wrote.
 *
 * Takes its own readline interface so the first-run caller and `gm setup` share
 * one implementation and one teardown.
 */
export async function runSetupWizard(options: { firstRun?: boolean } = {}): Promise<GmConfig> {
  requireTty();
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const existing = await readConfig();

    if (options.firstRun) {
      process.stdout.write(
        `\n${bold("Welcome to gigamanage.")}\n${dim(
          "One question before we start: summaries cost model calls, so gm won't make any until you say who to call.",
        )}\n`,
      );
    } else {
      process.stdout.write(`\n${bold("gigamanage setup")}\n`);
    }

    if (existing) {
      const current = existing.provider
        ? existing.provider.command.join(" ")
        : "nothing — no model calls";
      process.stdout.write(`${dim(`currently: ${current}`)}\n`);
    }

    process.stdout.write(`\n${bold("Which harness should gm use for model calls?")}\n`);
    process.stdout.write(
      `${dim("Used to summarize where your sessions landed, and to answer `gm ask`.")}\n\n`,
    );

    const menu = buildOptions();
    // Default to the first installed provider — the answer most people want,
    // and the one that reproduces gm's behavior before config existed.
    const firstInstalled = menu.findIndex((_, i) => {
      const spec = PROVIDERS[i];
      return spec ? onPath(spec.binary) : false;
    });
    const fallback = firstInstalled === -1 ? menu.length : firstInstalled + 1;

    for (const [i, option] of menu.entries()) {
      const spec = PROVIDERS[i];
      const installed = spec ? onPath(spec.binary) : true;
      const mark = spec ? (installed ? green("✓") : dim("○")) : dim(" ");
      process.stdout.write(
        `  ${mark} ${String(i + 1)}. ${bold(option.label)}  ${dim(option.detail)}\n`,
      );
    }

    const picked = menu[(await askChoice(rl, menu, fallback)) - 1]!;
    const provider = await picked.choose(rl);

    // Only worth asking when there is something to call. "None" already answered it.
    const autoSummarize = provider
      ? await askYesNo(
          rl,
          `\n${bold("Keep your 20 most recent sessions summarized in the background?")}\n${dim(
            "This spends tokens as you work. gm ls stays instant either way.",
          )}\n`,
          true,
        )
      : false;

    const config: GmConfig = { version: CONFIG_VERSION, provider, autoSummarize };
    await writeConfig(config);

    process.stdout.write(`\n${green("✓")} ${dim(`saved to ${configPath()}`)}\n`);
    process.stdout.write(
      provider
        ? `${dim("gm will call")} ${cyan(provider.command.join(" "))}${dim(". Change it any time with `gm setup`.")}\n\n`
        : `${dim("gm will make no model calls. Run `gm setup` if you change your mind.")}\n\n`,
    );

    return config;
  } finally {
    rl.close();
  }
}

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("choose the harness gm uses for model calls (summaries and `gm ask`)")
    .action(async () => {
      await runSetupWizard();
    });
}
