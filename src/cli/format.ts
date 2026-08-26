/**
 * Rendering.
 *
 * Colour is applied only when stdout is a TTY and NO_COLOR is unset, so piping
 * `gm ls` into another program — or into an agent — yields clean text.
 */

import { cell, relativeAge, truncate, wrapText } from "../core/text.js";
import type { SessionRecord, SessionSummary, SessionView } from "../core/types.js";

/** Colour is off unless the user leaves it on — a `NO_COLOR`/`dumb` opt-out we honour everywhere. */
const colorEnabled = (): boolean => !process.env.NO_COLOR && process.env.TERM !== "dumb";

const useColor = (): boolean => process.stdout.isTTY === true && colorEnabled();

const wrap = (code: string) => (text: string) => (useColor() ? `[${code}m${text}[0m` : text);

export const dim = wrap("2");
export const bold = wrap("1");
export const cyan = wrap("36");
export const yellow = wrap("33");
export const red = wrap("31");
export const green = wrap("32");

/**
 * Colour forced on for output we KNOW an ANSI renderer consumes, even off a TTY.
 *
 * The picker's preview command writes to a pipe, so `process.stdout.isTTY` is
 * false and `useColor()` above is too — yet fzf renders that pipe with `--ansi`.
 * These variants drop only the TTY test, so the pane can carry colour while
 * `NO_COLOR` and `TERM=dumb` still turn it off. Used solely by `preview.ts`; the
 * card and `gm ls`/`gm show` keep the gated `dim`/`cyan`/`bold` and stay clean
 * when piped into another program.
 */
const wrapForced = (code: string) => (text: string) =>
  colorEnabled() ? `[${code}m${text}[0m` : text;

export const paneCyan = wrapForced("36");
export const paneBold = wrapForced("1");
export const paneDim = wrapForced("2");

/** Marks a session that stopped mid-task — usually the one you want to resume. */
const MID_TASK = "⚠";
/**
 * Marks a row whose summary has not been written yet.
 *
 * One column, so a row that gains a summary does not shift the layout. It used
 * to be a dim `~`, which was invisible next to the yellow `⚠` — and now that
 * these rows are actively being summarized in the background, "pending" is a
 * state worth seeing.
 */
const NO_SUMMARY = "○";
/** Marks a row whose summary is being written right now, by the background worker. */
const IN_PROGRESS = "◐";

/**
 * Every marker a row can carry, and what it means — in the order the key lists
 * them.
 *
 * One table because there are two ways to explain these markers (`gm ls`'s
 * counted legend and the picker's static key) and one meaning. Spelled out at
 * each call site instead, "◐ means summarizing now" would live in three places
 * and drift in two of them.
 *
 * `matches` is the row-level truth each explanation counts; `counted` is whether
 * the `ls` legend bothers to tally it. Mid-task rows are not tallied: the flag is
 * the point, and the list itself shows you how many.
 */
interface Marker {
  icon: string;
  color: (text: string) => string;
  label: string;
  matches: (view: SessionView, inProgress: InProgress) => boolean;
  counted: boolean;
}

const MARKERS: readonly Marker[] = [
  {
    icon: MID_TASK,
    color: yellow,
    label: "ended mid-task",
    matches: (view) => view.record.endedMidTask === true,
    counted: false,
  },
  {
    icon: IN_PROGRESS,
    color: green,
    label: "summarizing now",
    matches: (view, inProgress) => !view.summary && inProgress.has(view.record.sessionId),
    counted: true,
  },
  {
    icon: NO_SUMMARY,
    color: cyan,
    label: "no summary yet",
    matches: (view, inProgress) => !view.summary && !inProgress.has(view.record.sessionId),
    counted: true,
  },
];

/** Wide enough to read as separate entries, narrow enough to hold one line. */
const KEY_GAP = "   ";

const keyEntry = (marker: Marker, label: string): string =>
  `${marker.color(marker.icon)} ${dim(label)}`;

/** "repo/branch", or just "repo" when the branch adds nothing. */
export function sessionLabel(record: SessionRecord): string {
  const project = record.project ?? "?";
  return record.gitBranch ? `${project}/${record.gitBranch}` : project;
}

const WHERE_WIDTH = 28;
/** Never squeeze the description below this, however narrow the terminal. */
const MIN_TEXT_WIDTH = 24;

/** The description shown for a session: summary first, and never blank. */
function rowText(view: SessionView): string {
  const { record, summary } = view;
  return summary?.headline ?? record.title ?? record.lastUserPrompt ?? "(no content)";
}

/**
 * Rows whose summary the background worker is writing at this moment.
 * Empty set = nothing in flight.
 */
export type InProgress = ReadonlySet<string>;
const NONE: InProgress = new Set<string>();

/** The fixed-width columns before the description, coloured and plain. */
function rowPrefix(
  view: SessionView,
  now: Date,
  inProgress: InProgress = NONE,
): { colored: string; width: number } {
  const { record, summary } = view;
  const id = record.sessionId.slice(0, 8);
  const age = cell(relativeAge(record.updatedAt, now), 4);
  const where = cell(sessionLabel(record), WHERE_WIDTH);
  const flag = record.endedMidTask ? yellow(MID_TASK) : " ";
  const mark = summary
    ? " "
    : inProgress.has(record.sessionId)
      ? green(IN_PROGRESS)
      : cyan(NO_SUMMARY);

  return {
    colored: `${dim(id)} ${dim(age)} ${flag}${mark} ${cyan(where)} `,
    // Measured from the plain text: colour codes take no screen columns.
    width: id.length + 1 + age.length + 1 + 2 + 1 + where.length + 1,
  };
}

/**
 * One row, on exactly one line.
 *
 * Used by the picker, where a session must occupy a single line — fzf maps lines
 * back to session ids, so a wrapped row would break selection.
 */
export function formatRow(
  view: SessionView,
  now: Date = new Date(),
  inProgress: InProgress = NONE,
): string {
  return `${rowPrefix(view, now, inProgress).colored}${truncate(rowText(view), 72)}`;
}

/**
 * One row of `gm ls`, wrapped to the terminal so the whole description is
 * readable rather than chopped off at the right edge. Continuation lines are
 * indented to sit under the description column.
 *
 * Pass `width: Infinity` when the output is not a terminal: piped output should
 * be one line per session, so `gm ls | grep` behaves.
 */
export function formatRowLines(
  view: SessionView,
  now: Date = new Date(),
  width: number = terminalWidth(),
  inProgress: InProgress = NONE,
): string[] {
  const prefix = rowPrefix(view, now, inProgress);
  const text = rowText(view);

  if (!Number.isFinite(width)) {
    return [`${prefix.colored}${text}`]; // Piped: one line, nothing lost.
  }

  const available = width - prefix.width;

  // On a terminal too narrow to hold the columns AND a readable description,
  // giving the description a sliver of a column would just overflow anyway.
  // Drop it onto its own indented lines instead.
  if (available < MIN_TEXT_WIDTH) {
    const indent = "  ";
    return [
      prefix.colored.trimEnd(),
      ...wrapText(text, Math.max(MIN_TEXT_WIDTH, width - indent.length)).map(
        (line) => `${indent}${line}`,
      ),
    ];
  }

  const [first = "", ...rest] = wrapText(text, available);
  const indent = " ".repeat(prefix.width);

  return [`${prefix.colored}${first}`, ...rest.map((line) => `${indent}${dim(line)}`)];
}

/**
 * The key under the list. Only mentions markers that actually appear, so a fully
 * summarized list carries no footer at all.
 */
export function formatLegend(
  views: readonly SessionView[],
  inProgress: InProgress = NONE,
): string {
  return MARKERS.flatMap((marker) => {
    const on = views.filter((view) => marker.matches(view, inProgress)).length;
    if (on === 0) return [];
    return [keyEntry(marker, marker.counted ? `${marker.label} (${on})` : marker.label)];
  }).join(KEY_GAP);
}

/**
 * The key for a LIVE list: every marker, always, and never a count.
 *
 * The picker renders the same markers `gm ls` does, so it needs the same
 * explanation — but not `formatLegend`. fzf sets `--header` once, at spawn:
 * `ctrl-r` reloads the item list and leaves the header untouched. Counts baked
 * in there freeze at open and are wrong after the first refresh, and a key
 * listing "only the markers present" goes stale the moment a refresh brings in
 * one that wasn't. ctrl-r is precisely when both change.
 *
 * So: nothing here depends on the list. A stale key is worse than a fixed one —
 * absent an explanation you go looking, given a wrong one you don't. The cost is
 * one line naming `○` on a list that has none.
 */
export function formatMarkerKey(): string {
  return MARKERS.map((marker) => keyEntry(marker, marker.label)).join(KEY_GAP);
}

/** Terminal width, or a sane default when we cannot tell. */
export function terminalWidth(): number {
  return process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 100;
}

/** The detail card shown by `gm show` and in the picker's preview pane. */
export function formatCard(view: SessionView, now: Date = new Date()): string {
  const { record, summary } = view;
  const lines: string[] = [];

  lines.push(
    bold(sessionLabel(record)),
    dim(`${record.harness} · ${record.sessionId} · ${relativeAge(record.updatedAt, now)} ago`),
  );
  lines.push("");

  if (summary) {
    // Widening zoom: the headline names the work, the overview frames it, the
    // summary reorients you. `headline` is the one field parsing guarantees, so
    // it stands in for the overview when that is empty.
    lines.push(bold("HEADLINE"), indent(summary.headline), "");
    if (summary.overview) lines.push(bold("OVERVIEW"), indent(summary.overview), "");
    if (summary.summary) lines.push(bold("SUMMARY"), indent(summary.summary), "");
    if (summary.landed) lines.push(bold("RECENT WORK"), indent(summary.landed), "");
    if (summary.open) lines.push(bold("STILL OPEN"), indent(summary.open), "");
    if (summary.nextStep) lines.push(bold("NEXT STEP"), indent(green(summary.nextStep)), "");
  } else {
    lines.push(
      dim("No summary yet."),
      dim(`Run: gm summarize ${record.sessionId.slice(0, 8)}`),
      "",
    );
    if (record.title) lines.push(bold("TITLE (recorded at session start)"), indent(record.title), "");
  }

  if (record.lastUserPrompt) {
    lines.push(bold("LAST THING YOU SAID"), indent(`"${truncate(record.lastUserPrompt, 240)}"`), "");
  }

  if (record.filesTouched.length > 0) {
    const shown = record.filesTouched.slice(0, 6);
    const extra = record.filesTouched.length - shown.length;
    lines.push(
      bold("FILES TOUCHED"),
      ...shown.map((f) => `  ${f}`),
      ...(extra > 0 ? [dim(`  … and ${extra} more`)] : []),
      "",
    );
  }

  if (record.prLinks.length > 0) {
    const shown = record.prLinks.slice(0, 8);
    const extra = record.prLinks.length - shown.length;
    lines.push(
      bold("PULL REQUESTS"),
      ...shown.map((pr) => `  #${pr.number}  ${pr.url}`),
      ...(extra > 0 ? [dim(`  … and ${extra} more`)] : []),
      "",
    );
  }

  const facts: string[] = [`${record.messageCount} messages`, `${record.userPromptCount} prompts`];
  if (record.endedMidTask) facts.push(yellow("ended mid-task"));
  if (record.lastToolFailure) facts.push(red("last command failed"));
  lines.push(dim(facts.join("  ·  ")));

  if (record.cwd) lines.push(dim(record.cwd));

  return lines.join("\n");
}

/**
 * Two spaces under a heading — the card's only body indent.
 *
 * Exported for the preview's chat half, whose speaker bodies sit under `you` and
 * `gm` exactly as the card's text sits under `WHERE IT LANDED`. Both halves share
 * one pane, so a second indent idiom would show up as two columns that almost
 * line up.
 */
export function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/** Stable JSON envelope. Everything machine-readable goes through here. */
export function jsonEnvelope<T>(schemaVersion: number, data: T): string {
  return JSON.stringify({ schemaVersion, data }, null, 2);
}
