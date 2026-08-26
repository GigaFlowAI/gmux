/**
 * `gm __ask-run` — the detached worker that answers one question.
 *
 * It is spawned by `__ask-send`, holds the lock its sender took, writes into the
 * transcript and exits. Its stdio is `ignore`d and fzf owns the terminal, so it
 * says nothing to anyone: the transcript is its only output, errors included.
 *
 * **It rebuilds the conversation from the file.** `gm ask`'s REPL kept its turns
 * in a closure; a fan of one-shot workers has no closure to keep them in. That
 * difference is the whole design, and none of it reaches `buildAskPrompt`, which
 * still takes a plain `AskTurn[]`.
 *
 * **The heartbeat is why the pane is not a frozen rectangle.** The provider
 * buffers — one write at the end, ~9–20s later — so without a timer nothing
 * repaints for the length of the think and the picker looks wedged. The worker
 * only makes the pane re-render; the pane does its own `thinking… Ns`
 * arithmetic, so the transcript never holds a number that is stale the instant
 * it is written.
 */

import type { Command } from "commander";

import { NoProviderError } from "../../core/errors.js";
import { ASK_SESSION_LIMIT, buildAskContext, buildAskPrompt } from "../../services/ask.js";
import {
  ASK_HEARTBEAT_MS,
  appendAskEvent,
  closeAskTranscript,
  foldCompletedTurns,
  openAskTranscript,
  readAskTranscript,
  releaseAskLock,
  streamAnswer,
} from "../../services/ask-transcript.js";
import { readConfig, resolveAskCommand } from "../../services/config.js";
import { loadViews } from "../../services/views.js";
import { refreshNotifier } from "./__ask-refresh.js";
import { toFilters, type LsOptions } from "./ls.js";

/** The hidden command `__ask-send` forks. Not a thing a person runs. */
export const ASK_RUN_COMMAND = "__ask-run";

export interface AskRunOptions extends LsOptions {
  transcript: string;
  seq: string;
  port?: string;
  /** Injected in tests. Defaults to the fzf POST, or to nothing without a port. */
  notify?: () => void;
  /** Injected in tests. In production this is aborted by SIGTERM. */
  signal?: AbortSignal;
}

export type AskRunStatus = "answered" | "aborted" | "no-question" | "no-provider";

/**
 * Answer the question at `seq`.
 *
 * Never throws: a worker that dies loudly dies into `/dev/null`. Whatever
 * happens, the turn ends in the transcript with an `end` or an `error` — except
 * on cancellation, where the record is the canceller's to write, so that a
 * wedged worker cannot leave the pane stuck on "answering".
 */
export async function runAskTurn(options: AskRunOptions): Promise<AskRunStatus> {
  const seq = Number.parseInt(options.seq, 10);
  const notify = options.notify ?? refreshNotifier(options.port);

  const { events } = await readAskTranscript(options.transcript);
  const question = events.find((event) => event.t === "question" && event.seq === seq);
  const settled = events.some(
    (event) => (event.t === "end" || event.t === "aborted" || event.t === "error") && event.seq === seq,
  );
  if (!question || question.t !== "question" || settled) {
    // Nothing to answer: a stale respawn, or a turn that was cancelled before we
    // started. Drop the lock so the next enter is not locked out by a ghost.
    await releaseAskLock(options.transcript);
    return "no-question";
  }

  const argv = resolveAskCommand(await readConfig());
  const fd = openAskTranscript(options.transcript);

  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  // Cancellation arrives as a signal to our process GROUP: `__ask-cancel` kills
  // the group because killing us alone would orphan the provider, which would
  // keep running, keep billing and keep nobody informed. Aborting propagates
  // that down to `runProviderCommand`'s child.
  const onSignal = (): void => controller.abort();
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // The only timer in the design, and it lives exactly as long as the request.
  const heartbeat = setInterval(notify, ASK_HEARTBEAT_MS);

  try {
    if (!argv) {
      const failed = new NoProviderError("`gm ask`");
      appendAskEvent(fd, {
        t: "error",
        seq,
        at: new Date().toISOString(),
        message: failed.fix ? `${failed.message}\n${failed.fix}` : failed.message,
      });
      notify();
      return "no-provider";
    }

    const limit = Number(options.limit) || ASK_SESSION_LIMIT;
    const views = await loadViews(toFilters(options, ASK_SESSION_LIMIT));
    const context = buildAskContext(views, question.focus, limit);
    // Completed turns only. The question we are about to answer has no `end`
    // record, so it cannot replay itself into its own prompt.
    const turns = foldCompletedTurns(events);

    await streamAnswer({
      // The provider argv is exactly what bare `gm ask` uses, `-p` and all —
      // which is what keeps this call's own session flagged automated, and so
      // out of the picker that started it.
      argv,
      prompt: buildAskPrompt(context, turns, question.text),
      transcriptFd: fd,
      seq,
      notify,
      signal,
    });
    return signal.aborted ? "aborted" : "answered";
  } catch {
    return "aborted";
  } finally {
    clearInterval(heartbeat);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    closeAskTranscript(fd);
    // On cancellation the lock is the canceller's to remove — it may already
    // have handed the transcript to a newer turn, and releasing that turn's lock
    // would let a third writer in.
    if (!signal.aborted) await releaseAskLock(options.transcript);
  }
}

export function registerAskRun(program: Command): void {
  program
    .command(ASK_RUN_COMMAND, { hidden: true })
    .description("internal: answer one question into a transcript (run detached by gm itself)")
    .requiredOption("--transcript <path>", "the picker's chat transcript")
    .requiredOption("--seq <n>", "which question to answer")
    .option("--port <port>", "fzf's listen port, for the repaint")
    .option("--harness <id>", "only this harness")
    .option("-p, --project <name>", "only sessions whose project matches")
    .option("-b, --branch <name>", "only sessions whose git branch matches")
    .option("-s, --since <when>", "only sessions newer than this")
    .option("-n, --limit <count>", "how many recent sessions to consider")
    .option("--include-sidechains", "include subagent transcripts")
    .option("--include-automated", "include non-interactive runs")
    .action(async (options: AskRunOptions) => {
      await runAskTurn(options);
    });
}
