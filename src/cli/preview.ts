/**
 * The preview pane — both halves of it.
 *
 * fzf has exactly ONE preview pane and cannot split it. So gm renders the card
 * and the chat into one command's output and owns the boundary itself: fzf does
 * not gain a pane, it gains a longer string.
 *
 * ```
 * ┌─ sessions ─────┬─ preview ──────────────────┐
 * │ > webshop  2h  │ 4998a936  webshop  2h ago  │
 * │   api      4h  │ WHERE IT LANDED …          │  ← formatCard, clipped
 * │   docs     1d  │ ── ask ────────────────────│  ← the divider
 * │                │ you                        │
 * │                │   why did this one fail?   │  ← the transcript
 * │                │ gm                         │
 * │                │   The run died in apply_…  │
 * └────────────────┴────────────────────────────┘
 * ```
 *
 * **No conversation ⇒ the card gets the whole pane, byte-identical to today.**
 * That is the deal, not a nicety: a picker run where nobody presses ctrl-o must
 * render exactly what it rendered before this file existed. It needs no flag and
 * no branch — a missing transcript reads as zero events, `splitPreview` hands the
 * card every row, and `formatPreview` returns `formatCard` and nothing else.
 *
 * **Nothing here calls a model, and nothing here may ever learn how.** The
 * preview command re-runs on every cursor move, so a model call in this file is
 * a model call per keystroke. The chat renders from the transcript file or it
 * does not render.
 *
 * **Colour is an accent, never the message.** The preview's stdout is a pipe,
 * not a tty, so `format.ts`'s gated `dim`/`cyan` are no-ops here and the CARD
 * stays monochrome, exactly as it shipped. The divider and the `you`/`gm`
 * speakers use the `paneCyan`/`paneBold` variants instead, which fzf renders
 * with `--ansi` — so the seam between card and chat pops in colour. But the
 * divider is still carried by GLYPHS and the speakers by LAYOUT, so `NO_COLOR`,
 * `TERM=dumb` or a colourless pane loses only the accent, never the structure.
 */

import { wrapText } from "../core/text.js";
import type { AskEvent, SessionView } from "../core/types.js";
import type { AskTranscript } from "../services/ask-transcript.js";
import { formatCard, indent, paneBold, paneCyan, paneDim } from "./format.js";

/** Row budget for one render. Sums to the pane height. */
export interface PreviewSplit {
  cardRows: number;
  dividerRows: 0 | 1;
  chatRows: number;
}

/** Below this the card is a fragment and the chat is unreadable. See COLLAPSED. */
const MIN_SPLIT = 15;
/** Enough card to be a card: label, meta, blank, a heading and two lines under it. */
const CARD_MIN = 6;
/** Enough chat to read as one: two speakers, two bodies, the blank between them. */
const CHAT_MIN = 8;
const DIVIDER_ROWS = 1;

/**
 * What we assume when fzf did not tell us the pane height.
 *
 * A guess rather than a refusal to split, deliberately: the chat auto-tails, so
 * an over-guess costs a little fzf scrolling, while refusing shows no chat at all
 * to someone who just asked for one.
 */
const ASSUMED_PANE_ROWS = 24;

/**
 * How the pane's rows are divided.
 *
 * `paneRows` arrives from `$FZF_PREVIEW_LINES` via a shell and a commander flag,
 * which makes it environment-controlled text. Treat it as hostile: anything
 * non-positive is the guess, and no arithmetic below may go negative or throw.
 */
export function splitPreview(paneRows: number, hasChat: boolean): PreviewSplit {
  const rows =
    Number.isFinite(paneRows) && paneRows > 0 ? Math.floor(paneRows) : ASSUMED_PANE_ROWS;

  // The empty state, and the whole of it. `cardRows` is the pane because there
  // is nothing to share it with.
  if (!hasChat) return { cardRows: rows, dividerRows: 0, chatRows: 0 };

  if (rows < MIN_SPLIT) {
    // COLLAPSED — the answer to "what about a 20-line terminal?", where the pane
    // is 14 rows and two 7-row halves are useless to everybody. The card drops to
    // `formatCard`'s first line (`bold(sessionLabel)`) and the chat takes the
    // rest: you still know which session "this" is, which is the entire point of
    // the focus model, and the chat stays readable. A better failure than an
    // 8-row card fragment.
    const chatRows = Math.max(0, rows - 1 - DIVIDER_ROWS);
    const dividerRows: 0 | 1 = chatRows > 0 ? 1 : 0;
    return { cardRows: rows - chatRows - dividerRows, dividerRows, chatRows };
  }

  const chatRows = Math.min(
    Math.max(Math.floor(rows / 2), CHAT_MIN),
    rows - DIVIDER_ROWS - CARD_MIN,
  );
  return { cardRows: rows - chatRows - DIVIDER_ROWS, dividerRows: 1, chatRows };
}

/**
 * `"── ask "` is 7 display columns, so the rendered rule is exactly `width`.
 *
 * Labelled because `format.ts`'s idiom is named sections (`WHERE IT LANDED`,
 * `NEXT STEP`) and an anonymous rule would be the only unnamed boundary on
 * screen. `paneCyan` — gm's own accent, the `gm` speaker's colour — so the seam
 * between the monochrome card and the chat is the one line that pops, which is
 * the whole reason it is coloured rather than dim. `paneCyan` not `cyan`: the
 * pane is a pipe, so the gated `cyan` is a no-op here; `paneCyan` drops only the
 * TTY test and still honours `NO_COLOR`. The unicode needs no ASCII fallback —
 * `format.ts` already ships `⚠ ○ ◐ ·` unconditionally.
 */
const DIVIDER_LABEL = "── ask ";

/** `Math.max(0, …)`: `String.repeat` throws RangeError on a negative count, and
 *  the width came from the environment. A narrow pane must not crash the pane.
 *  The colour is zero display columns, so the rule is still exactly `width`. */
export function askDivider(width: number): string {
  const fill = Number.isFinite(width) ? Math.floor(width) - DIVIDER_LABEL.length : 0;
  return paneCyan(`${DIVIDER_LABEL}${"─".repeat(Math.max(0, fill))}`);
}

/**
 * Is there a conversation at all?
 *
 * A question is the only thing that makes one. `meta` alone is a transcript the
 * sender created and nothing more, and it must still render the empty state —
 * otherwise a `no-provider` send would put a divider over an empty half.
 */
export function hasChatContent(transcript: AskTranscript | null): boolean {
  return transcript !== null && transcript.events.some((event) => event.t === "question");
}

/** What became of one question, folded out of the event log by `seq`. */
interface Settled {
  t: "end" | "aborted" | "error";
  message?: string;
}

type Question = Extract<AskEvent, { t: "question" }>;

function foldBySeq(events: readonly AskEvent[]): {
  questions: Question[];
  chunks: Map<number, string[]>;
  settled: Map<number, Settled>;
} {
  const questions: Question[] = [];
  const chunks = new Map<number, string[]>();
  const settled = new Map<number, Settled>();

  for (const event of events) {
    switch (event.t) {
      case "question":
        questions.push(event);
        break;
      case "chunk": {
        const existing = chunks.get(event.seq);
        if (existing) existing.push(event.text);
        else chunks.set(event.seq, [event.text]);
        break;
      }
      case "end":
      case "aborted":
        settled.set(event.seq, { t: event.t });
        break;
      case "error":
        settled.set(event.seq, { t: "error", message: event.message });
        break;
      default:
        break;
    }
  }

  // Keyed by `seq`, never file order — the same rule `foldCompletedTurns` folds
  // by, and for the same reason: correctness here must not depend on a lock in
  // another module.
  questions.sort((a, b) => a.seq - b.seq);
  return { questions, chunks, settled };
}

/** Elapsed whole seconds since a question landed. Computed at render time and
 *  never stored — a number written into the transcript is stale on arrival. */
function elapsedSeconds(at: string, now: Date): number {
  const started = Date.parse(at);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((now.getTime() - started) / 1000));
}

/**
 * The answer slot, in every state a turn can be in.
 *
 * The in-flight render is specified rather than implied because it IS the UX for
 * most of a turn's life: the provider buffers, so `thinking… 14s` is what the
 * pane says for ~9–20s and the answer then lands in one paint.
 */
function answerText(seq: number, question: Question, folded: ReturnType<typeof foldBySeq>, now: Date): string {
  const partial = (folded.chunks.get(seq) ?? []).join("").trim();
  const settled = folded.settled.get(seq);

  if (!settled) {
    return partial === ""
      ? `thinking… ${elapsedSeconds(question.at, now)}s   (esc to cancel)`
      : partial;
  }
  if (settled.t === "error") return settled.message ?? "the answer failed";
  if (settled.t === "aborted") {
    // The human still SEES an aborted turn here; only the model's view loses it
    // (`foldCompletedTurns` drops it, so "ok but briefly" after an esc has no
    // antecedent — which beats telling the model it failed and being apologized
    // at instead of answered).
    return partial === "" ? "(cancelled)" : `${partial}\n(cancelled)`;
  }
  return partial;
}

/**
 * `you` / `gm`, with the body indented under it.
 *
 * Legible with colour off, which the pane requires: the speaker sits on its own
 * line above an indented body, so the LAYOUT distinguishes them and the colour
 * only accelerates it. `paneBold` is the section-heading idiom; `paneCyan` is
 * already gm's own colour (the `where` column, the `○` marker) — the forced
 * variants, because the pane is a pipe and the gated ones would be no-ops here.
 */
function speaker(head: string, body: string, width: number): string[] {
  const wrapped = body
    .split("\n")
    .flatMap((line) => wrapText(line, Math.max(1, Math.floor(width) - 2)));
  return [head, ...indent(wrapped.join("\n")).split("\n")];
}

/**
 * The `· re:` suffix marks a CHANGE of focus, and nothing else.
 *
 * Focus re-points per question, so a thread of five questions can span five
 * sessions and an answer rendered under a cursor that has since moved reads as
 * being about the wrong one. But stamping every question with the same id when
 * focus never moved is noise on the half of the pane with least room for it. The
 * change is the only moment it carries information — plus the first question,
 * which has nothing to differ from and everything to establish.
 */
function questionHead(question: Question, previousFocus: string | null, first: boolean): string {
  const focus = question.focus;
  if (!focus || (!first && focus === previousFocus)) return paneBold("you");
  return `${paneBold("you")} ${paneDim(`· re: ${focus.slice(0, 8)}`)}`;
}

/**
 * The chat half: the last `rows` wrapped rows of the thread.
 *
 * **Auto-tail.** New text appears at the bottom, old text slides up. That is what
 * makes it read as a chat rather than a document, it composes with the refresh
 * loop for free, and it means the common case needs no scrolling at all. There is
 * deliberately no scroll: fzf's own `shift-up` scrolls the WHOLE preview, which
 * in split mode drags the card off the top and reveals nothing, because there is
 * only one pane. If you hit the ceiling, `cat` the transcript.
 *
 * `now` is a parameter so the `thinking… Ns` count is testable without a clock.
 */
export function formatChat(
  transcript: AskTranscript,
  rows: number,
  width: number,
  now: Date = new Date(),
): string {
  const folded = foldBySeq(transcript.events);
  const lines: string[] = [];
  let previousFocus: string | null = null;

  for (const [index, question] of folded.questions.entries()) {
    if (index > 0) lines.push("");
    lines.push(...speaker(questionHead(question, previousFocus, index === 0), question.text, width));
    lines.push("");
    lines.push(...speaker(paneCyan("gm"), answerText(question.seq, question, folded, now), width));
    previousFocus = question.focus;
  }

  const budget = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 0;
  return lines.slice(-budget || lines.length).join("\n");
}

/**
 * The card, clipped at the divider, counted in DISPLAY rows.
 *
 * `--preview-window=…,wrap` breaks a card line at the pane's right edge, and
 * `formatCard` emits lines up to 647 columns — so a divider placed after
 * `cardRows` *logical* lines would be shoved off the pane it exists to split.
 * Breaking at the same column fzf would gives the same picture and puts the
 * divider where we said it goes.
 *
 * The card is clipped and not rewritten: measured, it renders 23–83 rows against
 * a 14–41 row pane, so it already overflows the FULL pane by 1.2x–6x at every
 * realistic size. The split does not break the card; the card was already
 * clipped, and fixing that is `gm show`'s bug, not this pane's.
 */
function clipToRows(lines: readonly string[], rows: number, width: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (out.length >= rows) break;
    for (const piece of hardWrap(line, width)) {
      if (out.length >= rows) break;
      out.push(piece);
    }
  }
  return out;
}

function hardWrap(line: string, width: number): string[] {
  const w = Math.floor(width);
  if (!Number.isFinite(w) || w <= 0 || line.length <= w) return [line];
  const pieces: string[] = [];
  for (let i = 0; i < line.length; i += w) pieces.push(line.slice(i, i + w));
  return pieces;
}

/**
 * One preview command's whole output: the card, and the chat if there is one.
 *
 * **The empty state returns `formatCard` and NOTHING else** — not "the card plus
 * an empty tail", not "the card with a trailing divider". Byte-identical, because
 * that is what decision 4 promises to everyone who never presses ctrl-o.
 */
export function formatPreview(
  view: SessionView,
  transcript: AskTranscript | null,
  split: PreviewSplit,
  width: number,
  now: Date = new Date(),
): string {
  const card = formatCard(view, now);
  if (transcript === null || split.chatRows <= 0 || !hasChatContent(transcript)) return card;

  return [
    ...clipToRows(card.split("\n"), split.cardRows, width),
    askDivider(width),
    formatChat(transcript, split.chatRows, width, now),
  ].join("\n");
}
