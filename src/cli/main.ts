#!/usr/bin/env node
/**
 * gigamanage — browse, search and resume agent coding sessions.
 *
 * Every read command supports `--json`. That is deliberate: gigamanage is a tool
 * for agents as much as for people, and an agent can only use what it can parse.
 */

import { createRequire } from "node:module";

import { Command } from "commander";

import { GigamanageError } from "../core/errors.js";
import { maybeAutoSummarize } from "../services/auto-summarize.js";
import { configExists, shouldRunSetupWizard } from "../services/config.js";
import { registerAsk } from "./commands/ask.js";
import { registerAskCancel } from "./commands/__ask-cancel.js";
import { registerAskRun } from "./commands/__ask-run.js";
import { registerAskSend } from "./commands/__ask-send.js";
import { registerAutoSummarizeWorker } from "./commands/auto.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerSetup, runSetupWizard } from "./commands/setup.js";
import { registerGrep } from "./commands/grep.js";
import { registerIndex } from "./commands/index-cmd.js";
import { registerLs } from "./commands/ls.js";
import { registerOverlay } from "./commands/overlay.js";
import { registerWatch } from "./commands/watch.js";
import { registerPick } from "./commands/pick.js";
import { registerPickerRows } from "./commands/picker-rows.js";
import { registerPreviewCard } from "./commands/__preview-card.js";
import { registerResume } from "./commands/resume.js";
import { registerRun } from "./commands/run.js";
import { registerShow } from "./commands/show.js";
import { registerSummarize } from "./commands/summarize.js";
import { registerTmux } from "./commands/tmux.js";
import { red, dim } from "./format.js";

/**
 * Read the version from package.json rather than hardcoding it.
 *
 * A hardcoded string silently drifts on every release — v0.1.1 shipped
 * reporting `0.1.0`. Resolves to the package root from both `dist/cli/` (built)
 * and `src/cli/` (via tsx).
 */
const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

const program = new Command();

program
  .name("gm")
  .description("Browse, search and resume your AI coding agent sessions.")
  .version(version)
  .option("--no-color", "disable coloured output")
  .option("--no-auto-summarize", "do not summarize recent sessions in the background")
  .hook("preAction", async (thisCommand, actionCommand) => {
    if (thisCommand.opts()["color"] === false) process.env.NO_COLOR = "1";

    /**
     * First run: ask who to call, before spending anything on calling them.
     *
     * Every gate here is load-bearing. `gm ls --json` is an interface agents
     * call, and a version of it that can block on a human prompt is a broken
     * interface whatever it prints — so no TTY, or `--json`, or a `__`-prefixed
     * internal command means we say nothing and behave exactly as gm did before
     * config existed: autodetect and carry on.
     */
    const gate = {
      hasConfig: await configExists(),
      isTty: process.stdin.isTTY === true && process.stdout.isTTY === true,
      isJson: actionCommand.opts()["json"] === true,
      commandName: actionCommand.name(),
    };
    if (shouldRunSetupWizard(gate)) await runSetupWizard({ firstRun: true });
  })
  /**
   * Keep the ten most recent sessions summarized — in the background, always.
   *
   * This runs in `postAction`, after the command has already written its output,
   * so `gm ls` still returns in ~60ms. The work itself is handed to a detached
   * child that outlives us (see services/auto-summarize.ts); we only decide, and
   * we tell the user on STDERR so `gm ls --json` stays machine-readable.
   *
   * The worker command is exempt, or it would spawn a copy of itself forever.
   */
  .hook("postAction", async (thisCommand, actionCommand) => {
    /**
     * `__`-prefixed commands are the internals gm spawns at itself, and none of
     * them may decide anything here — by prefix, not by a list that the next
     * hidden command has to remember to join. `__auto-summarize` would fork a
     * copy of itself; `__picker-rows` runs its own pass first; `__ask-send`
     * inherits fzf's env, so GIGAMANAGE_CHILD is unset and every question typed
     * into the chat pane would fork a summarize decision from inside fzf —
     * whose `notify` writes to the stderr fzf is painting. Same convention
     * `shouldRunSetupWizard` already uses.
     */
    if (actionCommand.name().startsWith("__")) return;

    // `ls` and `pick` run the pass themselves, BEFORE rendering, so they can
    // mark the rows they just kicked off with ◐. Running it again here would be
    // a wasted decision — and for `pick` a badly timed one: its action ends in
    // `resumeSession`, which waits on your harness, so this hook would not fire
    // until you quit Claude Code.
    if (actionCommand.name() === "ls" || actionCommand.name() === "pick") return;

    await maybeAutoSummarize({
      enabled: thisCommand.opts()["autoSummarize"] !== false,
      notify: (message) => process.stderr.write(`${dim(message)}\n`),
    });
  });

registerLs(program);
registerShow(program);
registerGrep(program);
registerAsk(program);
registerResume(program);
registerSummarize(program);
registerSetup(program);
registerIndex(program);
registerDoctor(program);
registerAutoSummarizeWorker(program);
registerPickerRows(program);
registerPreviewCard(program);
registerAskSend(program);
registerAskRun(program);
registerAskCancel(program);
registerPick(program); // Also the default action when `gm` is run bare.
registerOverlay(program);
registerTmux(program);
registerRun(program);
registerWatch(program);

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof GigamanageError) {
      process.stderr.write(`${red("error")} ${error.message}\n`);
      if (error.fix) process.stderr.write(`${dim("fix")}   ${error.fix}\n`);
      process.exit(error.exitCode);
    }
    process.stderr.write(`${red("error")} ${(error as Error).message}\n`);
    process.exit(1);
  }
}

void main();
