/**
 * Session picker.
 *
 * fzf is used when installed — it gives fuzzy matching and a live preview pane
 * for free. When it is absent we fall back to a numbered prompt rather than
 * failing: gigamanage must work on a machine with nothing but Node.
 *
 * Rows WRAP rather than being chopped at the right edge, in both modes. In fzf
 * that needs multi-line items: records are NUL-delimited (`--read0`) so a single
 * session can span several display lines and still be selected as one thing.
 * fzf gained multi-line display in 0.46, so older versions fall back to
 * single-line rows rather than rendering one session as several bogus entries.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";

import { shellQuote } from "../core/text.js";
import type { SessionView } from "../core/types.js";
import {
  formatMarkerKey,
  formatRow,
  formatRowLines,
  terminalWidth,
  type InProgress,
} from "./format.js";

/** Fraction of the terminal the list occupies; the rest is the preview pane. */
const LIST_FRACTION = 0.45;
/** fzf's own chrome: pointer, marker, border, padding. */
const FZF_CHROME = 6;
/** First fzf release with multi-line item display. */
const MULTILINE_FZF = [0, 46, 0];
/**
 * First fzf release exporting `$FZF_INPUT_STATE`, the split chat's mode oracle.
 *
 * Its own constant rather than `MULTILINE_FZF`: every other action the chat
 * bindings use is at or below 0.46, so the oracle alone sets this floor, and
 * riding on the multi-line gate would be accidental. `MULTILINE_FZF` is wrong
 * anyway — multi-line landed in 0.53 — and the day someone corrects it the chat
 * must not silently change tiers with it.
 */
const SPLIT_CHAT_FZF = [0, 59, 0];

export function hasFzf(): boolean {
  return spawnSync("which", ["fzf"], { stdio: "ignore" }).status === 0;
}

/** fzf's version as [major, minor, patch], or null if it cannot be determined. */
export function fzfVersion(): number[] | null {
  const probe = spawnSync("fzf", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0 || typeof probe.stdout !== "string") return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(probe.stdout);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Is `version` at least `want`, comparing component by component?
 *
 * A null version — `fzf --version` unreadable — is NOT enough. Every caller
 * gates a feature on this, and assuming a feature we cannot see makes fzf exit
 * non-zero at startup for exactly the people we could not probe.
 *
 * Missing components read as 0, so a want longer than the version still
 * decides: [0, 46] is not [0, 46, 1].
 */
export function atLeast(version: number[] | null, want: readonly number[]): boolean {
  if (!version) return false;
  for (let i = 0; i < want.length; i++) {
    const part = version[i] ?? 0;
    const need = want[i] ?? 0;
    if (part > need) return true;
    if (part < need) return false;
  }
  return true;
}

/** True when this fzf can display one item across several lines. */
export function supportsMultiline(version: number[] | null): boolean {
  return atLeast(version, MULTILINE_FZF);
}

/** True when this fzf can tell a binding which input mode it is in. */
export function supportsSplitChat(version: number[] | null): boolean {
  return atLeast(version, SPLIT_CHAT_FZF);
}

/**
 * Which ask experience this environment gets.
 *
 * The tiers below `split` are what shipped before it, and they are load-bearing
 * rather than politeness: an fzf flag leaked into a tier that does not
 * understand it does not degrade the picker, it deletes it — fzf exits non-zero
 * at startup, for exactly the people the fallback exists to protect and for
 * nobody else. Hence a named ladder with a truth table over it.
 */
export type AskTier =
  /** The chat under the card, in the preview pane. */
  | "split"
  /** Today's full-screen `execute` REPL: fzf suspends, the list comes back after. */
  | "execute"
  /** The numbered fallback's `a` key. No fzf to bind anything in. */
  | "prompt"
  /** No ask at all — the key is not bound and not advertised. */
  | "none";

export function askTier(input: {
  hasFzf: boolean;
  fzfVersion: number[] | null;
  askAvailable: boolean;
  selfCommand: string | null;
}): AskTier {
  // Nothing to ask with. A key that opens a chat which dies instantly is worse
  // than a key that isn't there.
  if (!input.askAvailable) return "none";

  // The numbered fallback calls back into this process, so it needs no way to
  // address this build — which is the whole reason it can be offered when
  // `selfCommand` is null.
  if (!input.hasFzf) return "prompt";

  // Every fzf tier runs `gm` through a shell, so an unaddressable build has no
  // command to bind.
  if (!input.selfCommand) return "none";

  // An unreadable version lands here too, because `atLeast(null, …)` is false:
  // degrading to the older UI is a worse UI, degrading to `split` is a broken
  // one.
  return supportsSplitChat(input.fzfVersion) ? "split" : "execute";
}

/** How wide the list column is inside fzf, once the preview pane is taken out. */
export function listWidth(width: number = terminalWidth()): number {
  return Math.max(32, Math.floor(width * LIST_FRACTION) - FZF_CHROME);
}

/**
 * The records fed to fzf, NUL-delimited.
 *
 * Each record is `<session-id>\t<display>`, where `<display>` may contain
 * newlines. fzf shows fields 2.. and hands field 1 to the preview command and
 * back to us on selection, so the id never appears on screen twice and the
 * mapping back to a session survives wrapping.
 */
export function buildFzfRecords(
  views: readonly SessionView[],
  multiline: boolean,
  width: number = listWidth(),
  now: Date = new Date(),
  inProgress: InProgress = new Set(),
): string {
  return views
    .map((view) => {
      const display = multiline
        ? formatRowLines(view, now, width, inProgress).join("\n")
        : formatRow(view, now, inProgress);
      return `${view.record.sessionId}\t${display}`;
    })
    .join("\0");
}

/** A freshly loaded list, and what the worker is writing as of that moment. */
export interface PickRefresh {
  views: readonly SessionView[];
  inProgress: InProgress;
}

export interface PickOptions {
  /** argv reproducing this filter set, for fzf's reload binding. */
  reloadArgs?: readonly string[];
  /**
   * Re-load for the no-fzf path, which has no subprocess to shell out to.
   *
   * Returns the markers as well as the rows: carrying the `inProgress` set from
   * open would re-render it stale, showing `○` for a row the worker has since
   * picked up.
   */
  reload?: () => Promise<PickRefresh>;
  /**
   * Look up a session id the picker did not open with.
   *
   * REQUIRED for ctrl-r to be useful. After a reload, fzf's list contains
   * sessions that did not exist when we built our id map, and those are exactly
   * the ones you refreshed in order to find.
   */
  resolve?: (id: string) => Promise<SessionView | null>;
  /** Rows the worker is writing right now, rendered `◐`. */
  inProgress?: InProgress;
  /**
   * argv reproducing this filter set for fzf's ctrl-o binding, or undefined
   * when ask is unavailable — which leaves the key unbound and unadvertised.
   *
   * Carries the filters for the same reason `reloadArgs` does: the child builds
   * its own window, and a window built from defaults may not contain the
   * session you are pointing at.
   */
  askArgs?: readonly string[];
  /**
   * Open the chat layer. `a` in the numbered fallback; ctrl-o in fzf does NOT
   * come through here — fzf runs its own `execute` binding against this build.
   *
   * A callback rather than a direct import, so the picker keeps knowing nothing
   * about providers.
   */
  ask?: () => Promise<void>;
  /**
   * The chat pane's opaque strings, or undefined when it cannot be offered.
   *
   * Used only on the `split` tier — every other tier ignores it — so a caller can
   * build it unconditionally and let the fzf version decide.
   *
   * Strings in, shell commands out, and that is the whole contract: the picker
   * never opens the transcript, never learns it is a file, never learns where it
   * lives, and never learns a provider exists. Exactly as `askArgs` already
   * works, and for the same reason.
   */
  chat?: ChatSpec;
  /**
   * Run when the picker is done with the terminal, however it ended.
   *
   * The thread's files, its lock and the worker's process group all have to go,
   * and NONE of that is the picker's to know — `rm` needs `node:fs`, the lock
   * name is a convention in a service, and the group kill needs the lock's shape.
   * `pick.ts` owns the transcript, so `pick.ts` owns the cleanup and the picker's
   * import list stays free of every one of them.
   */
  onClose?: () => Promise<void>;
}

/**
 * The session behind the id fzf handed back.
 *
 * Checks the list we opened with first, then falls back to a fresh lookup. That
 * fallback is what makes ctrl-r work: selecting a session that appeared *during*
 * the refresh would otherwise miss the map built at open and report "Nothing
 * selected" — refusing to resume the very session you refreshed to find.
 */
export async function resolvePicked(
  id: string,
  views: readonly SessionView[],
  resolve?: (id: string) => Promise<SessionView | null>,
): Promise<SessionView | null> {
  const known = views.find((v) => v.record.sessionId === id);
  if (known) return known;
  return resolve ? await resolve(id) : null;
}

/** Returns the chosen session, or null if the user cancelled. */
export async function pickSession(
  views: readonly SessionView[],
  options: PickOptions = {},
): Promise<SessionView | null> {
  if (views.length === 0) return null;
  return hasFzf() ? pickWithFzf(views, options) : pickWithPrompt(views, options);
}

/**
 * How to re-invoke *this* build, as a shell command string.
 *
 * fzf runs the preview and reload commands through a shell, and they must hit
 * this build — not whatever `gm` happens to be on PATH. During development
 * there may be no `gm` on PATH at all, and both would silently render nothing.
 *
 * `execArgv` MUST be forwarded, for the same reason `spawnWorker` forwards it:
 * under `npm run dev` the entry point is `src/cli/main.ts` and execArgv carries
 * tsx's loader flags. Drop them and the command becomes `node src/cli/main.ts`,
 * which Node 20 cannot run — so the preview pane and ctrl-r both die in
 * development while working perfectly from `dist/`. (Node 22 strips types
 * natively and hides this, which is exactly what makes it worth a comment.)
 *
 * Returns null when the entry point is unavailable, leaving callers to decide
 * on a fallback.
 */
export function selfCommand(
  execPath: string,
  execArgv: readonly string[],
  entry: string | undefined,
): string | null {
  if (!entry) return null;
  return [execPath, ...execArgv, entry].map(shellQuote).join(" ");
}

/** `selfCommand` for the running process. */
export function selfCommandHere(): string | null {
  return selfCommand(process.execPath, process.execArgv, process.argv[1]);
}

/**
 * The command fzf runs to fill its preview pane.
 *
 * **Constant for the whole picker run.** Every mutable thing lives in the
 * transcript file, which is what makes `refresh-preview` sufficient and
 * `change-preview` unnecessary — and why there is no reflow and therefore no
 * flicker.
 *
 * `${FZF_PREVIEW_LINES:-0}` — the `:-0` is load-bearing, and not because the
 * variable is plausibly unset (fzf has exported it to the preview process since
 * 0.18.0). The value is environment-controlled text and the parse must not
 * silently shift arguments: a bare `$FZF_PREVIEW_LINES` expanding to nothing
 * makes commander read the NEXT FLAG NAME as the pane height. `0` then means
 * "guess" to `splitPreview`, which is the honest answer.
 *
 * `__preview-card` is spelled literally for the same reason `show` is: picker.ts
 * imports no command module, and that is what keeps it knowing nothing about
 * providers (picker.ts:126-132 — the invariant holds by the import list, not by
 * the layer checker, which would pass `import { defaultAskProvider }` in
 * silence). tests/picker.test.ts pins the spelling against the real constant.
 */
function previewCommand(transcript?: string): string {
  const self = selfCommandHere() ?? "gm";
  if (!transcript) return `${self} show {1} --no-color`;
  return `${self} __preview-card {1} --chat ${shellQuote(transcript)} --pane-lines \${FZF_PREVIEW_LINES:-0}`;
}

/**
 * The shell command behind ctrl-r, or null when we cannot address this build.
 *
 * Without one the key is simply not bound and the header does not advertise it —
 * a key that does nothing is worse than a key that isn't there.
 */
function reloadCommand(reloadArgs: readonly string[] | undefined): string | null {
  const self = selfCommandHere();
  if (!self || !reloadArgs || reloadArgs.length === 0) return null;
  return `${self} ${reloadArgs.map(shellQuote).join(" ")}`;
}

/**
 * The command behind ctrl-o: open `gm ask` about the highlighted session.
 *
 * `askArgs` MUST carry the picker's filters and limit, for the same reason
 * `reloadArgs` does. Without them the child re-derives its own window from
 * defaults — the 20 most recent sessions across every project — and the session
 * you are highlighting is often not in it. `--focus` then silently resolves to
 * null and the chat answers about a list you never asked about, looking normal
 * the whole time.
 *
 * `{1}` is appended unquoted because fzf substitutes it: it is the session id
 * field, and quoting it would hand the child the literal string `{1}`.
 *
 * Null when this build cannot address itself, or when the caller says ask is
 * unavailable — and then the key is not bound and not advertised.
 */
function askCommand(askArgs: readonly string[] | undefined): string | null {
  const self = selfCommandHere();
  if (!self || !askArgs || askArgs.length === 0) return null;
  return `${self} ${askArgs.map(shellQuote).join(" ")} --focus {1}`;
}

/* ------------------------------------------------------------- the ask mode */

/**
 * Everything the chat tier needs, as opaque strings the picker never interprets.
 *
 * Built by `pick.ts`, which owns the transcript and the provider question. The
 * picker interpolates these into shell strings and does nothing else with them.
 */
export interface ChatSpec {
  /** Baked into the preview command and the send/cancel commands. Never opened here. */
  transcript: string;
  /** Full shell command for `enter` in ask mode, minus the appended `--port`. */
  sendCmd: string;
  /** Full shell command for `esc` in ask mode, minus the appended `--port`. */
  cancelCmd: string;
}

/**
 * `ChatSpec` plus the two headers the mode toggle swaps between.
 *
 * The headers are not in `ChatSpec` because `pick.ts` cannot know them: the
 * browse header depends on whether `ctrl-r` got bound at all, which is `fzfArgs`'
 * decision and nobody else's. esc must restore the EXACT header the picker
 * started with, so it has to be handed the one that was actually set.
 */
export interface AskModeSpec extends ChatSpec {
  browseHeader: string;
  askHeader: string;
}

/** The browse prompt. Swapping it is not cosmetic — see `sendActions`. */
const BROWSE_PROMPT = "session > ";
const ASK_PROMPT = "ask > ";

/**
 * The ask header lists exactly the two keys ask mode rebinds, and `ctrl-r` is
 * absent because ask mode `unbind`s it rather than leaving it live and
 * unadvertised. Both headers keep the marker legend on line 2 — it must survive
 * both modes.
 */
const ASK_KEYS = ["enter: send", "esc: back"];

/** Two lines: what the keys do, then what the row markers mean. fzf renders an
 *  embedded newline as a second header line, and processes the key's colours
 *  regardless of --ansi (see `man fzf` on --header). */
function headerFor(keys: readonly string[]): string {
  return `${keys.filter((k) => k !== "").join("   ")}\n${formatMarkerKey()}`;
}

/**
 * Where the browse query is parked while ask mode owns the query line.
 *
 * A sibling of the transcript, not a state directory: it inherits the
 * transcript's `<pid>-<rand8>` uniqueness for free, so two concurrent pickers
 * cannot collide, and it lands in the cleanup and sweep paths that already exist
 * with no new concept.
 *
 * The suffix is spelled here AND in `askBrowseQueryPath` (services/ask-transcript.ts),
 * which is what deletes and sweeps it — the picker may not import a service. A
 * drift between the two is silent (esc restores nothing), so tests/picker.test.ts
 * pins them equal.
 */
function browseQueryPath(transcript: string): string {
  return `${transcript}.browseq`;
}

/**
 * The ctrl-o transform body: browse → ask.
 *
 * **POSIX `[ … ]` and `if … fi`, no `[[ ]]` and no braces.** fzf runs child
 * commands with `$SHELL -c`, not `sh -c` (`man fzf` says so twice, lines
 * 1400-1402 and 2133-2135). Reproduced: `/bin/dash -c '[[ x = x ]]'` is
 * `[[: not found`, which makes ctrl-o a DEAD KEY with no error anywhere. The
 * `--with-shell 'sh -c'` on the arg list and these bodies are one fix, not two —
 * csh cannot parse `if …; then` either, so the bodies alone are not sufficient
 * and `--with-shell` alone leaves a bash-ism that is simply wrong.
 *
 * **`!= disabled`, never `= enabled`.** The oracle is TERNARY — `man fzf`:1462,
 * *"Current input state (enabled, disabled, hidden)"* — and `--no-input` yields
 * `hidden`. A ctrl-o guarded on `= enabled` is silently inert under `--no-input`.
 * Every spelling here treats `hidden` as browse, which is the fail-safe
 * direction.
 *
 * **No `else`, because a transform that emits nothing is a no-op** — verified:
 * ctrl-o twice does not double-enter or crash.
 */
export function enterAskActions(spec: AskModeSpec): string {
  const actions = [
    "disable-search",
    "clear-query",
    // ctrl-r `reload`s the FULL list while `disable-search` is active, so the
    // frozen browse filter — the thing we keep on purpose, so the rows under the
    // cursor do not move when you press ctrl-o — evaporates mid-thread and cannot
    // be restored until esc. Unadvertised AND destructive is exactly what
    // `unbind` is for.
    "unbind(ctrl-r)",
    `change-prompt(${ASK_PROMPT})`,
    `change-header(${spec.askHeader})`,
  ].join("+");

  return [
    `if [ "$FZF_INPUT_STATE" != disabled ]; then`,
    // The browse query is parked in a file because ask mode needs the query line
    // back. `disable-search` freezes the list where the browse query left it, and
    // it must stay there.
    `printf '%s' "$FZF_QUERY" > ${shellQuote(browseQueryPath(spec.transcript))}`,
    `echo "${actions}"`,
    "fi",
  ].join("\n");
}

/**
 * The esc transform body: ask → browse, and abort in browse mode.
 *
 * The exact inverse of `enterAskActions`, which is why the two are split: for
 * every stateful action there, the undo is here. Two independent
 * `askModeBindings`/`browseModeBindings` could not be tested for that, and the
 * bug they invite is asymmetry — ask fires `disable-search`, browse forgets
 * `enable-search`, and the filter is dead with no error anywhere.
 */
export function exitAskActions(spec: AskModeSpec): string {
  const actions = [
    // BEFORE `transform-query`, or the restored query never re-triggers the
    // search and the list stays frozen behind a filter you can see.
    "enable-search",
    "rebind(ctrl-r)",
    // `transform-query(cat file)`, not `change-query($(cat …))`: the browse query
    // is text a human typed and sidestepping the quoting is free here.
    `transform-query(cat ${shellQuote(browseQueryPath(spec.transcript))})`,
    `change-prompt(${BROWSE_PROMPT})`,
    `change-header(${spec.browseHeader})`,
  ].join("+");

  return [
    `if [ "$FZF_INPUT_STATE" = disabled ]; then`,
    // `>/dev/null 2>&1` is not tidiness. Verified: a child that inherits fzf's
    // stdout blocks fzf until EOF EVEN WHEN BACKGROUNDED with `&` —
    // `transform(sleep 3 & echo …)` froze fzf for 3s, the redirected form was
    // instantly responsive.
    `${spec.cancelCmd} --port "$FZF_PORT" >/dev/null 2>&1`,
    `echo "${actions}"`,
    "else",
    "echo abort",
    "fi",
  ].join("\n");
}

/**
 * The enter transform body.
 *
 * **Enter means two things, and that is the sharpest edge in this design.** In
 * browse mode it resumes a session, replacing your terminal. In ask mode it
 * sends. A misfire is not cosmetic: enter that resumes when you meant send drops
 * you into someone else's harness and the picker is gone. That is why the prompt
 * changes, why the header changes, and why the oracle is fzf's own state rather
 * than a file that can go stale.
 *
 * **`rebind` cannot give enter a new meaning** — it only restores a binding after
 * `unbind` — so enter is bound ONCE, to a transform that branches.
 *
 * `--port "$FZF_PORT"`, `--focus {1}` and `--question "$FZF_QUERY"` are appended
 * HERE rather than built into `sendCmd`, and never routed through `shellQuote`:
 * its allowed class is `/^[A-Za-z0-9_./:@-]+$/`, so `$FZF_PORT` would be
 * single-quoted and the child would receive the literal string — every
 * `refresh-preview` would then silently miss.
 *
 * `{1}`, not `$FZF_CURRENT_ITEM`: the latter is 0.73.0, and on that exact version
 * a NUL-containing item does not degrade gracefully — it breaks the preview and
 * every other child command outright (fixed in 0.73.1). We use `--read0`.
 * `{1}` is also what makes the focus model free: fzf re-substitutes it every time
 * the binding fires, so this is already "the focus at send time", with no state
 * and no race.
 */
export function sendActions(spec: AskModeSpec): string {
  return [
    `if [ "$FZF_INPUT_STATE" = disabled ]; then`,
    // Otherwise enter on an empty ask line sends a blank question.
    `if [ -n "$FZF_QUERY" ]; then`,
    `${spec.sendCmd} --port "$FZF_PORT" --focus {1} --question "$FZF_QUERY" >/dev/null 2>&1`,
    "fi",
    `echo "clear-query"`,
    "else",
    "echo accept",
    "fi",
  ].join("\n");
}

/**
 * The three bindings the mode toggle is made of.
 *
 * `transform:` and not `transform(…)`: the colon form takes the rest of the
 * argument, and every body below contains parentheses.
 *
 * **Mode is not stored anywhere.** fzf already tracks it, and a mode file would
 * be a second source of truth that can disagree with the first.
 */
export function chatBindings(spec: AskModeSpec): string[] {
  return [
    `--bind=ctrl-o:transform:${enterAskActions(spec)}`,
    `--bind=enter:transform:${sendActions(spec)}`,
    `--bind=esc:transform:${exitAskActions(spec)}`,
  ];
}

/**
 * fzf's environment.
 *
 * **`FZF_DEFAULT_OPTS` is stripped, and that is a correctness fix rather than
 * hygiene.** fzf reads it from the environment, and picker.ts used to spawn with
 * no `env` at all — so a user with `FZF_DEFAULT_OPTS=--disabled` handed us a
 * picker whose `$FZF_INPUT_STATE` is `disabled` at the very first frame: the
 * bindings believe they are already in ask mode, enter never resumes, and ctrl-o
 * cannot get you back. gm builds its full arg set anyway, and a user `--bind`
 * colliding with ours is the same class of problem.
 *
 * **The api key rides here and NOWHERE else.** `--listen` is an
 * arbitrary-command-execution surface — verified against a plain localhost
 * `--listen` on 0.74, `POST execute-silent(touch pwned)` returned HTTP 200 and
 * created the file — and `FZF_API_KEY` turns an unauthenticated POST into a 401.
 * It must never reach an argv: measured, `ps -ww -o args=` prints another user's
 * argv, while `ps e` on their environment needs their uid. So argv is strictly
 * worse than the env here, which is the opposite of the usual instinct. Honestly:
 * this raises the bar against a different-user or non-local attacker and does
 * NOT stop a same-uid one, who can read fzf's environment and POST as us. The
 * only real boundary there is a unix socket, whose 0.66.0 floor is out of reach
 * under a 0.59 gate. Known and accepted.
 */
export function fzfSpawnEnv(
  env: NodeJS.ProcessEnv = process.env,
  apiKey: string | null = null,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  delete clean["FZF_DEFAULT_OPTS"];
  delete clean["FZF_DEFAULT_OPTS_FILE"];
  if (apiKey) clean["FZF_API_KEY"] = apiKey;
  return clean;
}

/** 32 random bytes, minted per picker run. Never on an argv — see `fzfSpawnEnv`. */
function newApiKey(): string {
  return randomBytes(32).toString("base64");
}

/**
 * Everything the fzf arg set is built from.
 *
 * An options object rather than positionals because the chat tier adds a
 * transcript and two more commands to this list, and eight positionals read as
 * `fzfArgs(true, "p", null, null, "split", …)` at every call site.
 */
export interface FzfSpec {
  multiline: boolean;
  preview: string;
  /** The already-built shell command, or null when ctrl-r cannot be offered. */
  reloadCmd: string | null;
  /** The `execute()` REPL behind ctrl-o, or null when ask cannot be offered. */
  askCmd: string | null;
  tier: AskTier;
  /** Required iff `tier === "split"`. Absent, the split tier degrades to browse. */
  chat?: ChatSpec;
}

/**
 * Everything we hand fzf on the command line.
 *
 * Split out from the spawn so it is testable: pressing a key needs a terminal,
 * but the args that decide what the key *does* are just data.
 */
export function fzfArgs(spec: FzfSpec): string[] {
  const { multiline, preview, reloadCmd, tier } = spec;
  // **A half-bound ask mode must never ship.** `split` with no `chat` has no
  // transcript to write and no commands to run, so enter would send into the void
  // and esc could not get you out — strictly worse than the REPL it replaced.
  // Fall back to the whole browse-only arg set instead, the same null-guard
  // `reloadCommand` takes.
  const chat = tier === "split" ? spec.chat : undefined;
  // The tiers with no ctrl-o inside fzf must not get one however `askCmd` was
  // built. Half a binding is not a degraded picker, it is a broken one.
  const askCmd = tier === "execute" ? spec.askCmd : null;

  // A key that does nothing is worse than a key that isn't there, so the header
  // advertises exactly what got bound.
  const keys = [
    "enter: resume",
    reloadCmd ? "ctrl-r: refresh" : "",
    chat || askCmd ? "ctrl-o: ask" : "",
    "ctrl-c: cancel",
  ]
    .filter((k) => k !== "")
    .join("   ");
  const browseHeader = headerFor([keys]);

  const args = [
    "--ansi",
    "--delimiter=\t",
    "--with-nth=2..",
    "--height=90%",
    "--layout=reverse",
    "--border",
    "--prompt=session > ",
    "--preview",
    preview,
    "--preview-window=right,55%,wrap",
    "--header",
    browseHeader,
  ];

  // ctrl-r replaces the list with a fresh one, and kicks off summaries for
  // whatever needs them. `reload` feeds on the command's stdout, so the binding
  // is just "print the records again" — see commands/picker-rows.ts.
  if (reloadCmd) args.push(`--bind=ctrl-r:reload(${reloadCmd})`);

  // ctrl-o, not shift-f: fzf's query line eats plain letters, so `F` types an F
  // rather than firing a binding. alt-a — the obvious "ask" mnemonic — is worse
  // than useless on macOS, where Terminal and iTerm2 both send an accented
  // character on Option by default. ctrl-s/ctrl-q are flow control. ctrl-o is
  // unbound in fzf and safe everywhere.
  //
  // `execute` suspends fzf and hands the child the terminal, restoring the list
  // when it exits — so you can ask, read, and be back in the picker with your
  // query and position intact.
  if (askCmd) args.push(`--bind=ctrl-o:execute(${askCmd})`);

  // The split tier: ctrl-o becomes a MODE, not a launch. The list stays, and the
  // answer arrives under the card while you keep arrowing around.
  if (chat) {
    args.push(
      // fzf runs children with `$SHELL -c`. Under `SHELL=/bin/dash` a bash-only
      // body makes ctrl-o a dead key; under `SHELL=/bin/tcsh` the enter transform
      // emits nothing, a transform that emits nothing is a no-op, and enter stops
      // resuming sessions AT ALL — the picker is bricked for csh users, by a
      // regression we would have introduced. `--with-shell` is the only fix that
      // covers every login shell, and at 0.51.0 it is free under a 0.59 floor.
      "--with-shell",
      "sh -c",
      // The answer arrives with no keypress, and `refresh-preview` over the listen
      // port is the only thing that can deliver it. No argument: fzf picks the
      // port and exports `$FZF_PORT` to its children, so nothing in gm needs to
      // know it. It is also an ACE surface — see `fzfSpawnEnv` for the key.
      "--listen",
      ...chatBindings({ ...chat, browseHeader, askHeader: headerFor(ASK_KEYS) }),
    );
  }

  if (multiline) {
    // Items are NUL-delimited, so a record may contain newlines; --print0 keeps
    // the selection unambiguous on the way back out.
    args.push("--read0", "--print0", "--highlight-line");
  }

  return args;
}

async function pickWithFzf(
  views: readonly SessionView[],
  options: PickOptions = {},
): Promise<SessionView | null> {
  const version = fzfVersion();
  const multiline = supportsMultiline(version);
  const records = buildFzfRecords(views, multiline, listWidth(), new Date(), options.inProgress);
  // `askArgs` is the picker's only word on whether ask would answer — it is set
  // exactly when the caller found a provider — which is what keeps this file
  // knowing nothing about providers.
  const tier = askTier({
    hasFzf: true,
    fzfVersion: version,
    askAvailable: (options.askArgs?.length ?? 0) > 0,
    selfCommand: selfCommandHere(),
  });
  // The caller may hand us a chat at any version; only this tier can render one.
  const chat = tier === "split" ? options.chat : undefined;

  const args = fzfArgs({
    multiline,
    preview: previewCommand(chat?.transcript),
    reloadCmd: reloadCommand(options.reloadArgs),
    askCmd: askCommand(options.askArgs),
    tier,
    ...(chat ? { chat } : {}),
  });

  // Only the chat tier opens a port, so only it mints a key.
  const apiKey = chat ? newApiKey() : null;

  // `finally` covers every way the picker ends on its own, INCLUDING ctrl-c
  // inside fzf: fzf exits, the promise resolves, we clean up. The signal handlers
  // cover the other case — the shell killing `gm` — and are registered only when
  // there is something to close, so a picker with no chat keeps today's exact
  // signal behaviour (no handler, no survival, no change).
  let closed = false;
  const cleanup = async (): Promise<void> => {
    if (closed) return; // `finally` and a signal can both get here.
    closed = true;
    await options.onClose?.();
  };
  const onSignal = (): void => {
    void cleanup().finally(() => process.exit(130));
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  if (options.onClose) for (const signal of signals) process.on(signal, onSignal);

  try {
    const selected = await new Promise<string | null>((resolve) => {
      const child = spawn("fzf", args, {
        stdio: ["pipe", "pipe", "inherit"],
        // NOT the inherited environment: a user's `FZF_DEFAULT_OPTS=--disabled`
        // would brick the mode oracle before the first frame. See `fzfSpawnEnv`.
        env: fzfSpawnEnv(process.env, apiKey),
      });

      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.on("error", () => resolve(null));
      child.on("close", () => {
        const picked = stdout.replace(/\0+$/, "").trim();
        resolve(picked === "" ? null : picked);
      });

      child.stdin.write(records);
      child.stdin.end();
    });

    if (!selected) return null;
    const id = selected.split("\t")[0]!.trim();
    // NOT a map built at open: ctrl-r may have introduced this session since.
    return await resolvePicked(id, views, options.resolve);
  } finally {
    if (options.onClose) for (const signal of signals) process.off(signal, onSignal);
    await cleanup();
  }
}

/**
 * The no-fzf fallback: a numbered list at a readline prompt.
 *
 * Control keys are not interceptable here, so the bindings are spelled as
 * letters — `r` for refresh, `a` for ask — the way a numbered prompt can
 * express them.
 */
async function pickWithPrompt(
  views: readonly SessionView[],
  options: PickOptions = {},
): Promise<SessionView | null> {
  // Wrap here too: the numbered fallback is a list you have to read, so chopping
  // the description defeats the point just as badly as it does in fzf.
  const width = Math.max(40, terminalWidth() - 5);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const { reload, ask } = options;
  let current = views;
  let inProgress = options.inProgress;

  try {
    for (;;) {
      const shown = current.slice(0, 30);
      for (const [i, view] of shown.entries()) {
        const [first = "", ...rest] = formatRowLines(view, new Date(), width, inProgress);
        process.stdout.write(`${String(i + 1).padStart(3)}. ${first}\n`);
        for (const line of rest) process.stdout.write(`     ${line}\n`);
      }
      // The same static key fzf gets. This path re-renders on `r` and could
      // afford `formatLegend`'s counts, but "the picker's key" should not read
      // differently depending on what happens to be on your PATH.
      process.stdout.write(`\n${formatMarkerKey()}\n`);
      process.stdout.write("\n(install fzf for fuzzy search and previews: brew install fzf)\n");

      const hint = [
        "number",
        reload ? "r to refresh" : "",
        ask ? "a to ask" : "",
        "or blank to cancel",
      ]
        .filter((part) => part !== "")
        .join(", ");
      const answer = (await rl.question(`\nresume which? [${hint}] `)).trim();

      if (reload && answer.toLowerCase() === "r") {
        ({ views: current, inProgress } = await reload());
        process.stdout.write("\n");
        continue;
      }

      if (ask && answer.toLowerCase() === "a") {
        // The readline interface is ours and holds stdin; the chat layer opens
        // its own. Close first or the two race for every keystroke and the
        // conversation eats the picker's input.
        rl.close();
        await ask();
        return pickWithPrompt(current, { ...options, ...(inProgress ? { inProgress } : {}) });
      }

      const choice = Number.parseInt(answer, 10);
      if (!Number.isFinite(choice) || choice < 1 || choice > shown.length) return null;
      return shown[choice - 1] ?? null;
    }
  } finally {
    rl.close();
  }
}
