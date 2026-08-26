/**
 * `gm ask` — ask questions about your sessions.
 *
 * Two shapes, one implementation:
 *
 *   gm ask                  a REPL. What ctrl-o in the picker opens.
 *   gm ask "<question>"     one-shot, for a shell or an agent.
 *   gm ask "<q>" --json     the same, parseable.
 *
 * The one-shot is not a convenience — non-negotiable #4 says every read command
 * supports `--json`, and an agent can only use what it can parse.
 */

import { createInterface } from "node:readline/promises";
import type { Command } from "commander";

import { GigamanageError, NoProviderError } from "../../core/errors.js";
import {
  SCHEMA_VERSION,
  type AskContext,
  type AskProvider,
  type AskTurn,
  type SessionView,
} from "../../core/types.js";
import {
  ASK_SESSION_LIMIT,
  buildAskContext,
  buildAskPrompt,
  defaultAskProvider,
} from "../../services/ask.js";
import { prunePaneLinks } from "../../services/pane-links.js";
import { listAllPanes, listPanes } from "../../services/tmux.js";
import { resolvePanesLive } from "../../services/tmux-resolve.js";
import { attachSummaries, loadRecords, loadViews } from "../../services/views.js";
import { bold, cyan, dim, jsonEnvelope, yellow } from "../format.js";
import { toFilters, type LsOptions } from "./ls.js";

export interface AskOptions extends LsOptions {
  /** Session the picker was highlighting when ctrl-o was pressed. */
  focus?: string;
  /** Ask across the agent sessions in this tmux window (the ctrl-g overlay passes it). */
  window?: string;
  json?: boolean;
}

/** How many sessions had a summary — the honest measure of how much gm knows. */
export function summarizedCount(context: AskContext): number {
  return context.sessions.filter((v) => v.summary !== null).length;
}

/**
 * Warn when the answer is going to be thin.
 *
 * Asking "what should I focus on?" against twenty un-summarized sessions gets
 * you a shrug, and a user who doesn't know why will read that as the feature
 * being useless rather than as the summaries not being written yet.
 */
export function thinContextNotice(context: AskContext): string | null {
  const total = context.sessions.length;
  if (total === 0) return "No sessions indexed. `gm doctor` will say why.";

  const summarized = summarizedCount(context);
  if (summarized === 0) {
    return "None of these sessions is summarized yet — answers will be thin. `gm summarize` writes them.";
  }
  if (summarized < total / 2) {
    return `Only ${summarized} of ${total} sessions are summarized — answers may be thin.`;
  }
  return null;
}

async function loadContext(options: AskOptions): Promise<AskContext> {
  if (options.window) {
    const views = await windowViews(options.window);
    return buildAskContext(views, options.focus ?? null, Math.max(views.length, 1));
  }
  const views = await loadViews(toFilters(options, ASK_SESSION_LIMIT));
  return buildAskContext(views, options.focus ?? null, Number(options.limit) || ASK_SESSION_LIMIT);
}

/**
 * The distinct agent sessions running in a tmux window, with their summaries.
 * Resolves every pane in the server (so a fresh pane can't claim a session
 * another window's pane owns), then keeps this window's.
 */
async function windowViews(windowId: string): Promise<SessionView[]> {
  const all = await listAllPanes();
  const links = await prunePaneLinks(all.map((p) => p.paneId));
  const records = await loadRecords();
  const windowPaneIds = new Set((await listPanes(windowId)).map((p) => p.paneId));
  const resolved = (await resolvePanesLive(all, records, links)).filter((r) =>
    windowPaneIds.has(r.pane.paneId),
  );

  const seen = new Set<string>();
  const unique = resolved
    .map((r) => r.record)
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .filter((r) => (seen.has(r.sessionId) ? false : (seen.add(r.sessionId), true)));
  return attachSummaries(unique);
}

/**
 * The provider for this run, or a typed error saying which kind of "no" it is.
 *
 * Three different answers, and they must stay three:
 *
 * - configured "none"   -> a decision to revisit (`gm setup`)
 * - configured, missing -> a binary to install, named by its own name
 * - present            -> go
 *
 * The availability check mirrors what `gm summarize` already does. Without it a
 * user who picked Codex and never installed it gets a raw `spawn codex ENOENT`
 * from deep inside the spawn, which is not an error that carries its fix.
 */
async function resolveProvider(): Promise<AskProvider> {
  const provider = await defaultAskProvider();
  if (!provider) throw new NoProviderError("`gm ask`");
  if (!(await provider.isAvailable())) {
    throw new GigamanageError(`Ask provider "${provider.name}" is not on your PATH.`, {
      fix: "Run `gm setup` to choose a provider that is installed.",
      exitCode: 6,
    });
  }
  return provider;
}

/**
 * Read one question, holding readline open for no longer than it takes to ask.
 *
 * The interface is created and closed per question, and that is NOT ceremony.
 * `readline/promises` drops any line that arrives while no `question()` is
 * pending: the model call between turns takes tens of seconds, and anything the
 * user typed during it — echoed to the terminal, so it looks accepted — would be
 * silently thrown away.
 *
 * With no interface open, those keystrokes stay in the tty buffer and are
 * delivered to the next `question()` instead of being lost. Same reason the
 * picker closes its readline before opening the chat, and the same trap that
 * made `gm setup` require a TTY.
 *
 * Returns null on ctrl-d, which rejects the promise rather than resolving it.
 */
async function readQuestion(): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`\n${cyan("?")} `)).trim();
  } catch {
    return null; // ctrl-d. An exit, not an error.
  } finally {
    rl.close();
  }
}

/**
 * The REPL.
 *
 * Turns accumulate in memory and are replayed into each prompt, because the
 * providers we call are one-shot — see services/ask.ts. Blank line or ctrl-d
 * exits, which is what returns you to the picker when fzf spawned us.
 */
async function repl(context: AskContext, provider: AskProvider): Promise<void> {
  const turns: AskTurn[] = [];

  const notice = thinContextNotice(context);
  process.stdout.write(
    `\n${bold("gm ask")} ${dim(
      `— ${context.sessions.length} recent session${context.sessions.length === 1 ? "" : "s"} loaded, ${summarizedCount(context)} summarized · ${provider.name}`,
    )}\n`,
  );
  if (notice) process.stdout.write(`${yellow(notice)}\n`);
  process.stdout.write(`${dim("Ask anything. Blank line or ctrl-d to go back.")}\n`);

  for (;;) {
    const question = await readQuestion();
    if (question === null || question === "") return;

    process.stdout.write(`${dim("  thinking…")}`);
    let answer: string;
    try {
      answer = await provider.ask(buildAskPrompt(context, turns, question));
    } catch (error) {
      // A failed turn must not end the conversation: the next question may be
      // cheaper, or the provider may just have been slow once.
      process.stdout.write(`\r\x1b[K${yellow((error as Error).message)}\n`);
      continue;
    }
    process.stdout.write("\r\x1b[K");
    process.stdout.write(`${answer}\n`);
    turns.push({ question, answer });
  }
}

/**
 * Open the chat layer from inside the picker's numbered fallback.
 *
 * Never throws. The picker is mid-flow and the user is going straight back to
 * the list — a missing provider is a line of advice, not a crash that loses the
 * list they were reading.
 */
export async function askAboutSessions(options: AskOptions): Promise<void> {
  try {
    const provider = await resolveProvider();
    await repl(await loadContext(options), provider);
  } catch (error) {
    const fix = error instanceof GigamanageError ? error.fix : undefined;
    process.stdout.write(`\n${yellow((error as Error).message)}\n`);
    if (fix) process.stdout.write(`${dim(fix)}\n`);
  }
}

/**
 * Whether `gm ask` would work right now.
 *
 * The picker asks before advertising ctrl-o. A key that opens a chat which
 * immediately dies — and, under fzf, gets repainted over before you can read
 * why — is exactly the "key that does nothing" this codebase already refuses to
 * offer for ctrl-r.
 */
export async function askIsAvailable(): Promise<boolean> {
  const provider = await defaultAskProvider();
  return provider !== null && (await provider.isAvailable());
}

export function registerAsk(program: Command): void {
  program
    .command("ask [question]")
    .description("ask about your recent sessions — what landed, what to pick up next")
    .option("--focus <id>", "the session you're looking at (the picker passes this)")
    .option("--window <id>", "ask across the agent sessions in this tmux window (the ctrl-g overlay passes it)")
    .option("--harness <id>", "only this harness")
    .option("-p, --project <name>", "only sessions whose project matches")
    .option("-b, --branch <name>", "only sessions whose git branch matches")
    .option("-s, --since <when>", "only sessions newer than this (3d, 12h, 2w)")
    .option("-n, --limit <count>", "how many recent sessions to consider", String(ASK_SESSION_LIMIT))
    // These two exist because the picker forwards them: ctrl-o reproduces the
    // filter set the list was opened with, and an option the child does not
    // declare is one commander rejects outright — so `gm pick --include-automated`
    // would bind a ctrl-o that dies on "unknown option".
    .option("--include-sidechains", "include subagent transcripts")
    .option("--include-automated", "include non-interactive runs (claude -p, codex exec)")
    .option("--json", "emit JSON for scripts and agents")
    .action(async (question: string | undefined, options: AskOptions) => {
      const context = await loadContext(options);
      const provider = await resolveProvider();

      if (!question) {
        if (options.json) {
          // A REPL cannot emit an envelope. Failing loudly beats handing an
          // agent an interactive process that looks like a hang.
          throw new GigamanageError("`gm ask --json` needs a question.", {
            fix: 'Pass one: gm ask "what should I pick up?" --json',
            exitCode: 2,
          });
        }
        await repl(context, provider);
        return;
      }

      const answer = await provider.ask(buildAskPrompt(context, [], question));

      if (options.json) {
        process.stdout.write(
          `${jsonEnvelope(SCHEMA_VERSION, {
            answer,
            provider: provider.name,
            sessionCount: context.sessions.length,
            summarizedCount: summarizedCount(context),
          })}\n`,
        );
        return;
      }

      const notice = thinContextNotice(context);
      if (notice) process.stderr.write(`${yellow(notice)}\n`);
      process.stdout.write(`${answer}\n`);
    });
}
