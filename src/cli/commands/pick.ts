import { rm } from "node:fs/promises";

import type { Command } from "commander";

import { shellQuote } from "../../core/text.js";
import {
  askBrowseQueryPath,
  askLockPath,
  newAskTranscriptPath,
  readAskLock,
  sweepAskTranscripts,
} from "../../services/ask-transcript.js";
import { inProgressIds, isLockStale, maybeAutoSummarize } from "../../services/auto-summarize.js";
import { loadViews } from "../../services/views.js";
import { listWidth, pickSession, selfCommandHere, type ChatSpec, type PickRefresh } from "../picker.js";
import { dim } from "../format.js";
import { ASK_CANCEL_COMMAND } from "./__ask-cancel.js";
import { ASK_SEND_COMMAND } from "./__ask-send.js";
import { askAboutSessions, askIsAvailable } from "./ask.js";
import { resumeInNewWindow, resumeSession } from "./resume.js";
import { autoSummarizeRequested, toFilters, type LsOptions } from "./ls.js";

/** The hidden command fzf's ctrl-r binding runs. Not a thing a person runs. */
export const PICKER_ROWS_COMMAND = "__picker-rows";

export interface PickerRowsOptions extends LsOptions {
  /** The parent's measured list width. The reload child's own stdout is a pipe. */
  width?: string;
}

/**
 * The filter flags this picker was opened with, as argv.
 *
 * One copy, because every command the picker spawns must describe the *same*
 * window. A filter that drifts in one of several copies is the silent
 * wrong-window bug the `pickerAskArgs` comment below exists to warn about —
 * nothing errors, the answers are just about other sessions.
 *
 * Values are NOT quoted here — the caller joins and quotes, because argv and a
 * shell command string want different escaping.
 */
export function filterArgs(options: LsOptions): string[] {
  const args: string[] = [];

  if (options.harness) args.push("--harness", options.harness);
  if (options.project) args.push("-p", options.project);
  if (options.branch) args.push("-b", options.branch);
  if (options.since) args.push("-s", options.since);
  if (options.limit) args.push("-n", options.limit);
  if (options.includeSidechains === true) args.push("--include-sidechains");
  if (options.includeAutomated === true) args.push("--include-automated");

  return args;
}

/**
 * The argv behind ctrl-o, reproducing this picker's filter set for `gm ask`.
 *
 * Pure, and separate from `pickerReloadArgs` only because the two target
 * different commands — they carry the same filters for the same reason.
 *
 * THE FILTERS ARE THE POINT. `gm ask` builds its own window; left to its
 * defaults it takes the 20 most recent sessions across every project, which for
 * `gm pick -p webshop` (or any pick past the 20th row) does not contain the
 * session you are highlighting. `--focus` then finds nothing, resolves to null,
 * and the chat answers about sessions you were not looking at — with no sign
 * anything went wrong.
 *
 * `-n` is forwarded too: the window ask reasons over should be the list you are
 * looking at, not a shorter one it chose for itself.
 *
 * `--focus {1}` is NOT added here. fzf substitutes that token, so it is appended
 * unquoted by the picker; a shell-quoted `{1}` would arrive as a literal.
 */
export function pickerAskArgs(options: LsOptions): string[] {
  return ["ask", ...filterArgs(options)];
}

/**
 * The argv that reproduces this picker's filter set, for fzf's reload binding.
 *
 * Pure, so the thing a refresh actually runs is testable without spawning fzf.
 *
 * `--width` is passed explicitly: the reload child's stdout is a pipe, so it
 * cannot measure the terminal and would fall back to a default width, reflowing
 * every row on refresh. Only the parent, inside fzf, knows the real width.
 */
export function pickerReloadArgs(
  options: LsOptions,
  width: number,
  autoSummarize = true,
): string[] {
  const args = [PICKER_ROWS_COMMAND, "--width", String(width), ...filterArgs(options)];

  // The opt-out MUST cross the process boundary. ctrl-r forces a pass — it
  // bypasses the cooldown — so a dropped flag here would spend tokens the user
  // explicitly declined, with the one thing that might have throttled it
  // removed. Commander reads a root option after the subcommand name fine.
  if (!autoSummarize) args.push("--no-auto-summarize");

  return args;
}

/**
 * The chat pane's shell commands, or undefined when it cannot be offered.
 *
 * **Built here and not in the picker**, which is the same call `askArgs` already
 * makes: opaque strings in, shell commands out. `pick.ts` owns the provider
 * question (`askIsAvailable`) and the transcript path, so it owns everything the
 * picker would otherwise have to learn — and the picker's import list stays free
 * of `node:fs`, of the lock's shape, and of a provider.
 *
 * **The path is allocated and NOTHING is created.** It has to exist as a string
 * before fzf starts, because it is baked into the preview command; the first
 * `__ask-send` creates the file as a side effect of opening it for append. A run
 * where nobody presses ctrl-o therefore never touches the disk, and a missing
 * file is exactly the empty state.
 *
 * `--port`, `--focus` and `--question` are NOT here: fzf substitutes `{1}` and
 * expands `$FZF_PORT`/`$FZF_QUERY`, and `shellQuote`'s allowed class contains
 * neither `$` nor `{`, so all three would arrive at the child as literal strings.
 * The picker appends them unquoted, after these.
 */
function pickerChatSpec(options: LsOptions, transcript: string): ChatSpec | undefined {
  const self = selfCommandHere();
  if (!self) return undefined;

  const command = (name: string, args: readonly string[]): string =>
    `${self} ${[name, "--transcript", transcript, ...args].map(shellQuote).join(" ")}`;

  return {
    transcript,
    // THE FILTERS ARE THE POINT, for the reason `pickerAskArgs` records: the
    // worker builds its own window, and a window built from defaults does not
    // contain the session you are pointing at — `--focus` then resolves to null
    // and the chat answers about a list you never asked about, looking normal the
    // whole time. Baked in at picker start, exactly as ctrl-r's are.
    sendCmd: command(ASK_SEND_COMMAND, filterArgs(options)),
    cancelCmd: command(ASK_CANCEL_COMMAND, []),
  };
}

/**
 * Everything the thread leaves on disk, gone when the picker is.
 *
 * **The group kill is here and not only in `__ask-cancel`** because accept and
 * abort never run the esc binding: quit the picker mid-answer and `claude -p`
 * would otherwise keep running, keep billing, and keep writing into a transcript
 * nobody will ever read. Measured — `kill -TERM <worker>` leaves the provider
 * orphaned and alive; only the group dies together.
 *
 * Never throws. A cleanup that fails must not become the way `gm pick` reports
 * that you picked a session.
 */
function closeChatThread(transcript: string): () => Promise<void> {
  return async () => {
    try {
      const lock = await readAskLock(transcript);
      // Liveness ANDed with age, exactly as `isLockStale` already does — a stale
      // lock's pid is either dead or recycled into some innocent process, and
      // signalling a stranger's group is the worst thing on this path.
      if (lock && lock.pid > 0 && !isLockStale(lock, new Date())) {
        try {
          process.kill(-lock.pid, "SIGTERM");
        } catch {
          // ESRCH: it finished on its own. Nothing to reap.
        }
      }
      await rm(transcript, { force: true });
      await rm(askLockPath(transcript), { force: true });
      await rm(askBrowseQueryPath(transcript), { force: true });
    } catch {
      // An orphan is a few KB of disposable cache and the sweep will get it.
    }
  };
}

/**
 * Load the list and start summaries for whatever needs them.
 *
 * Both the initial paint and a refresh go through here, so `r` in the numbered
 * fallback does what ctrl-r does in fzf rather than only re-rendering stale
 * rows. `force` is set for a refresh: a keypress is an explicit request.
 */
async function refresh(
  options: LsOptions,
  enabled: boolean,
  force: boolean,
  notify?: (message: string) => void,
): Promise<PickRefresh> {
  const views = await loadViews(toFilters(options, 50));
  const started = await maybeAutoSummarize({
    records: views.map((v) => v.record),
    enabled,
    force,
    ...(notify ? { notify } : {}),
  });

  return { views, inProgress: new Set([...(await inProgressIds()), ...started.targetIds]) };
}

/**
 * The bare `gm` command: pick a recent session, then resume it.
 * This is the whole point of the tool — everything else is in service of it.
 *
 * Registered as commander's *default* command rather than as options on the root
 * program. Hanging `-n`/`-p` off the root would shadow the identically-named
 * flags on `gm ls`, so `gm ls -n 8` would silently ignore the 8.
 */
export function registerPick(program: Command): void {
  program
    .command("pick", { isDefault: true })
    .description("pick a recent session and resume it (this is what bare `gm` does)")
    .option("--harness <id>", "only this harness")
    .option("-p, --project <name>", "only sessions whose project matches")
    .option("-b, --branch <name>", "only sessions whose git branch matches")
    .option("-s, --since <when>", "only sessions newer than this (3d, 12h, 2w)")
    .option("-n, --limit <count>", "how many sessions to offer", "50")
    .option("--include-sidechains", "include subagent transcripts")
    .option("--include-automated", "include non-interactive runs (claude -p, codex exec)")
    .option("--resume-in-window", "resume the choice in a new tmux window (used by the tmux ctrl-shift-g binding)")
    .action(async (options: LsOptions, command: Command) => {
      const enabled = autoSummarizeRequested(command);

      // Kick the pass off over the sessions we are about to offer, exactly as
      // `ls` does — the postAction hook cannot serve the picker, because our
      // action ends in `resumeSession`, which waits on your harness. That hook
      // fires when you quit Claude Code, not when the list is drawn.
      //
      // The notice goes to stderr, which fzf does not capture, so it prints
      // before the picker paints rather than on top of it.
      const opened = await refresh(options, enabled, false, (message) =>
        process.stderr.write(`${dim(message)}\n`),
      );

      if (opened.views.length === 0) {
        process.stdout.write(
          `${dim("No sessions found. If you expected some, run `gm doctor`.")}\n`,
        );
        return;
      }

      // Ask is offered only when it would actually answer. Advertising ctrl-o to
      // someone who chose "no model calls" — or who never installed what they
      // chose — binds a key that opens a chat which dies instantly, and fzf
      // repaints the list over the explanation before it can be read. That is
      // the "key that does nothing" this file already refuses to offer.
      const canAsk = await askIsAvailable();

      // Reap transcripts left behind by pickers that were `kill -9`d. The
      // parent's job, not the picker's, and it runs before we open so a live
      // pane's file is never the one being read while we consider removing it.
      await sweepAskTranscripts();

      // Allocated whatever the fzf version is: only the `split` tier renders a
      // chat, and it is the picker that knows which tier this is. A tier that
      // ignores this never creates the file, so the cleanup below removes
      // nothing and costs nothing.
      const transcript = newAskTranscriptPath();
      const chat = canAsk ? pickerChatSpec(options, transcript) : undefined;

      const chosen = await pickSession(opened.views, {
        inProgress: opened.inProgress,
        reloadArgs: pickerReloadArgs(options, listWidth(), enabled),
        ...(canAsk ? { askArgs: pickerAskArgs(options) } : {}),
        ...(chat ? { chat, onClose: closeChatThread(transcript) } : {}),
        // `a` in the numbered fallback. fzf's ctrl-o does NOT come through here:
        // it runs its own `execute` binding against this build, so the chat gets
        // a clean terminal instead of one fzf is painting.
        ...(canAsk ? { ask: () => askAboutSessions(options) } : {}),
        // `r` in the numbered fallback: forced, like the ctrl-r it stands in for.
        reload: () => refresh(options, enabled, true),
        // ctrl-r can surface a session that did not exist when we opened. Look
        // it up the way `gm resume <id>` does — naming a session explicitly
        // means you want it, even if the list filters would now hide it.
        resolve: async (id) => {
          const fresh = await loadViews({ includeSidechains: true, includeAutomated: true });
          return fresh.find((v) => v.record.sessionId === id) ?? null;
        },
      });
      if (!chosen) {
        process.stdout.write(`${dim("Nothing selected.")}\n`);
        return;
      }
      if (options.resumeInWindow === true && process.env.TMUX) {
        await resumeInNewWindow(chosen.record);
        return;
      }
      await resumeSession(chosen.record);
    });
}
