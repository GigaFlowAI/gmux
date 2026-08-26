/**
 * `gm __ask-send` — what enter does in the picker's ask mode.
 *
 * ~170ms of work and then it is gone: take the lock, append the question,
 * fork the worker, tell the pane to repaint. It never calls a model. The model
 * call is `__ask-run`'s, in a detached grandchild, because a send that waited
 * for an answer would hold fzf's binding for twenty seconds.
 *
 * **Why the sender writes the question and not the worker.** The worker costs
 * ~170ms of Node startup before it could echo anything, and 170ms between your
 * enter and your own words appearing reads as dropped input. Two writers is the
 * price; `O_APPEND` plus the lock plus a seq-keyed fold is what makes it safe.
 *
 * **Read-your-writes.** The question is written and the fd closed BEFORE the
 * spawn. That ordering is a happens-before rather than a hope: spawn first and
 * the worker races the question it is supposed to answer.
 *
 * Hidden, and `__`-prefixed for three separate reasons — `shouldRunSetupWizard`
 * bails on `__` so this cannot block on a human prompt while fzf owns the
 * terminal, main.ts's `postAction` bails on `__` so typing a question does not
 * fork a summarize pass, and it is not a thing a person runs.
 */

import type { Command } from "commander";

import { NoProviderError } from "../../core/errors.js";
import {
  acquireAskLock,
  appendAskEvent,
  askRunIdOf,
  closeAskTranscript,
  nextSeq,
  openAskTranscript,
  readAskTranscript,
  releaseAskLock,
  spawnAskWorker,
  writeAskLockPid,
} from "../../services/ask-transcript.js";
import { readConfig, resolveAskCommand } from "../../services/config.js";
import { refreshNotifier } from "./__ask-refresh.js";
import { ASK_RUN_COMMAND } from "./__ask-run.js";
import { filterArgs } from "./pick.js";
import type { LsOptions } from "./ls.js";

/** The hidden command fzf's `enter` binding runs in ask mode. */
export const ASK_SEND_COMMAND = "__ask-send";

export interface AskSendOptions extends LsOptions {
  transcript: string;
  question: string;
  /**
   * The row highlighted at the instant enter fired — fzf re-substitutes `{1}`
   * per keypress, so this is "the focus at send time" with no state and no race.
   */
  focus?: string;
  /** fzf's `$FZF_PORT`. On the argv, not in the env: it is not a secret. */
  port?: string;
  now?: Date;
  /** Injected in tests, so no test forks a detached child. Returns the pid. */
  spawnWorker?: (args: readonly string[]) => number | undefined;
}

export type AskSendStatus = "sent" | "locked" | "empty" | "no-provider" | "spawn-failed";

/**
 * Append one question and hand it to a worker.
 *
 * Never throws: fzf owns the terminal, so there is nowhere for an error to go
 * but the transcript. Every "no" still repaints the pane — a key that appears
 * to do nothing is the bug this repo already refuses to ship.
 */
export async function sendAskQuestion(options: AskSendOptions): Promise<AskSendStatus> {
  const notify = refreshNotifier(options.port);
  const now = options.now ?? new Date();
  const question = options.question.trim();
  if (question === "") return "empty"; // Enter on an empty query. Nothing was asked.

  // The second enter appends nothing and refreshes a pane that already says
  // "still answering". Two workers interleaving chunks is the one thing that
  // makes the fold ambiguous, and it is the one thing this stops.
  if (!(await acquireAskLock(options.transcript, now))) {
    notify();
    return "locked";
  }

  const argv = resolveAskCommand(await readConfig());
  const existing = await readAskTranscript(options.transcript);
  const seq = nextSeq(existing.events);

  const fd = openAskTranscript(options.transcript);
  try {
    // `meta` has one writer and one reader: whoever `cat`s a transcript whose
    // answers look wrong. Written inside the open that creates the file.
    if (existing.events.length === 0) {
      appendAskEvent(fd, {
        t: "meta",
        runId: askRunIdOf(options.transcript),
        startedAt: now.toISOString(),
        // The argv, never the environment — that is where the api key lives.
        provider: argv ? argv.join(" ") : "(none)",
      });
    }
    appendAskEvent(fd, {
      t: "question",
      seq,
      at: now.toISOString(),
      // Focus is captured per question and lives in the record, not on the
      // worker's argv: the transcript is then self-describing, and there is one
      // source of truth for what the model was told.
      focus: options.focus?.trim() ? options.focus.trim() : null,
      text: question,
    });

    // Configured "none" means no model calls. The picker does not bind ctrl-o
    // without a provider, so reaching here means config changed under a live
    // picker — the question is still echoed, and the answer slot says why.
    if (!argv) {
      const failed = new NoProviderError("`gm ask`");
      appendAskEvent(fd, {
        t: "error",
        seq,
        at: now.toISOString(),
        message: failed.fix ? `${failed.message}\n${failed.fix}` : failed.message,
      });
      await releaseAskLock(options.transcript);
      notify();
      return "no-provider";
    }
  } finally {
    closeAskTranscript(fd);
  }

  const workerArgs = [
    ASK_RUN_COMMAND,
    "--transcript",
    options.transcript,
    "--seq",
    String(seq),
    ...(options.port ? ["--port", options.port] : []),
    // The same filters this picker was opened with. Without them the worker
    // re-derives its own window from defaults and `--focus` resolves to a
    // session that is not in it — the answer is then about a list nobody was
    // looking at, with no sign anything went wrong.
    ...filterArgs(options),
  ];

  const pid = (options.spawnWorker ?? spawnAskWorker)(workerArgs);
  if (pid === undefined) {
    await releaseAskLock(options.transcript);
    notify();
    return "spawn-failed";
  }
  await writeAskLockPid(options.transcript, pid, now);

  notify();
  return "sent";
}

export function registerAskSend(program: Command): void {
  program
    .command(ASK_SEND_COMMAND, { hidden: true })
    .description("internal: append a question and fork a worker (run by the picker's enter binding)")
    .requiredOption("--transcript <path>", "the picker's chat transcript")
    .requiredOption("--question <text>", "what was typed")
    .option("--focus <id>", "the session highlighted when enter fired")
    .option("--port <port>", "fzf's listen port, for the repaint")
    .option("--harness <id>", "only this harness")
    .option("-p, --project <name>", "only sessions whose project matches")
    .option("-b, --branch <name>", "only sessions whose git branch matches")
    .option("-s, --since <when>", "only sessions newer than this")
    .option("-n, --limit <count>", "how many recent sessions to consider")
    .option("--include-sidechains", "include subagent transcripts")
    .option("--include-automated", "include non-interactive runs")
    .action(async (options: AskSendOptions) => {
      await sendAskQuestion(options);
    });
}
