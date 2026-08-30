/**
 * The picker's chat pane.
 *
 * Every decision the pane rests on has a named pure function here, for the same
 * reason `fzfArgs` was split from the spawn: pressing a key needs a terminal, but
 * the thing that decides what the key DOES is data. There is no fzf in this file,
 * no model, no port and no terminal — and the two seams that matter are real:
 * the binding bodies are run under a REAL `/bin/sh`, because that is the failure
 * this design would otherwise ship, and the transcript is a REAL file, because a
 * torn read is the normal case and cannot be faked convincingly.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AskEvent, AskProvider, SessionRecord, SessionSummary, SessionView } from "../src/core/types.js";
import { PREVIEW_CARD_COMMAND } from "../src/cli/commands/__preview-card.js";
import { formatCard } from "../src/cli/format.js";
import {
  askDivider,
  formatChat,
  formatPreview,
  hasChatContent,
  splitPreview,
} from "../src/cli/preview.js";
import {
  chatBindings,
  enterAskActions,
  exitAskActions,
  fzfArgs,
  fzfSpawnEnv,
  sendActions,
  type AskModeSpec,
  type FzfSpec,
} from "../src/cli/picker.js";
import { askBrowseQueryPath, parseTranscript } from "../src/services/ask-transcript.js";

const run = promisify(execFile);

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "gigamanage-chat-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    harness: "claude-code",
    sessionId: "a1b2c3d4-0000-0000-0000-000000000000",
    filePath: "/tmp/a.jsonl",
    cwd: "/repo",
    project: "webshop",
    gitBranch: "main",
    startedAt: "2026-07-16T10:00:00.000Z",
    updatedAt: "2026-07-17T11:00:00.000Z",
    messageCount: 10,
    userPromptCount: 3,
    title: "webhook retries are flaky",
    lastUserPrompt: "fix the retry",
    recentUserPrompts: ["fix the retry"],
    arcPrompts: ["fix the retry"],
    filesTouched: ["src/retry.ts"],
    prLinks: [],
    lastAssistantText: "Done.",
    lastToolFailure: null,
    endedMidTask: false,
    isSidechain: false,
    isAutomated: false,
    ...overrides,
  };
}

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    harness: "claude-code",
    sessionId: "a1b2c3d4-0000-0000-0000-000000000000",
    sourceHash: "abc",
    generatedAt: "2026-07-17T11:00:00.000Z",
    provider: "fake",
    headline: "Retry logic half-applied; signature test still red",
    overview: "Adding backoff to the webhook retry; the signature test is still red.",
    landed: "Added backoff to the webhook sender.",
    open: "The signature test is failing.",
    nextStep: "Fix tests/signature.test.ts",
    ...overrides,
  };
}

const view = (): SessionView => ({ record: record(), summary: summary() });

const NOW = new Date("2026-07-17T12:00:00.000Z");
const transcriptOf = (events: readonly AskEvent[]) =>
  parseTranscript(events.map((e) => JSON.stringify(e)).join("\n"));

/**
 * The pane carries real ANSI now — fzf renders the preview with `--ansi`. Strip
 * it to assert on layout and display width, which the colour must not change.
 */
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Run `fn` with the pane's forced colour on or off, via the same env `format.ts`
 * reads (`NO_COLOR`/`TERM`), then restore. The pane is a pipe, so `isTTY` never
 * enables it — only the `NO_COLOR`/`dumb` opt-out the forced variants honour.
 */
function withColor<T>(on: boolean, fn: () => T): T {
  const savedNoColor = process.env.NO_COLOR;
  const savedTerm = process.env.TERM;
  if (on) {
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";
  } else {
    process.env.NO_COLOR = "1";
  }
  try {
    return fn();
  } finally {
    if (savedNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = savedNoColor;
    if (savedTerm === undefined) delete process.env.TERM;
    else process.env.TERM = savedTerm;
  }
}
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";

const askSpec = (overrides: Partial<AskModeSpec> = {}): AskModeSpec => ({
  transcript: "/cache/ask/1-abcd.jsonl",
  sendCmd: "gm __ask-send --transcript /cache/ask/1-abcd.jsonl",
  cancelCmd: "gm __ask-cancel --transcript /cache/ask/1-abcd.jsonl",
  browseHeader: "enter: resume   ctrl-r: refresh   ctrl-o: ask   ctrl-c: cancel\nkey",
  askHeader: "enter: send   esc: back\nkey",
  ...overrides,
});

/* ------------------------------------------------------------ the empty state */

describe("the empty state", () => {
  /**
   * ★ Decision 4, and it is not negotiable: no conversation ⇒ the card gets the
   * whole pane, exactly as today. Not "contains the card". IDENTICAL — a
   * trailing divider or a blank tail is a regression for every person who never
   * presses ctrl-o, which is most of them.
   */
  it("renders the card byte-for-byte, and nothing else", () => {
    expect(formatPreview(view(), null, splitPreview(40, false), 80, NOW)).toBe(
      formatCard(view(), NOW),
    );
  });

  it("is what a missing transcript reads as, with no flag and no branch", () => {
    // ENOENT is a STATE. `readAskTranscript` hands back zero events, which is
    // indistinguishable from a run where nobody ever asked.
    const empty = transcriptOf([]);
    expect(hasChatContent(empty)).toBe(false);
    expect(formatPreview(view(), empty, splitPreview(40, false), 80, NOW)).toBe(
      formatCard(view(), NOW),
    );
  });

  it("survives a transcript that only has a meta record", () => {
    // `__ask-send` writes `meta` inside the open that creates the file. A
    // `no-provider` send would otherwise put a divider over an empty half.
    const meta = transcriptOf([
      { t: "meta", runId: "1-abcd", startedAt: NOW.toISOString(), provider: "claude -p" },
    ]);
    expect(hasChatContent(meta)).toBe(false);
    expect(formatPreview(view(), meta, splitPreview(40, true), 80, NOW)).toBe(formatCard(view(), NOW));
  });
});

/* --------------------------------------------------------------- the geometry */

describe("splitPreview", () => {
  it("gives the card the whole pane when there is no chat", () => {
    expect(splitPreview(40, false)).toEqual({ cardRows: 40, dividerRows: 0, chatRows: 0 });
  });

  it("splits a roomy pane about in half, and the rows sum to the pane", () => {
    const split = splitPreview(40, true);
    expect(split).toEqual({ cardRows: 19, dividerRows: 1, chatRows: 20 });
    expect(split.cardRows + split.dividerRows + split.chatRows).toBe(40);
  });

  it("keeps the card at CARD_MIN at the split floor", () => {
    expect(splitPreview(15, true)).toEqual({ cardRows: 6, dividerRows: 1, chatRows: 8 });
  });

  it("collapses the card to its identity strip below 15 rows", () => {
    // A 20-line terminal is a 14-row pane, and two 7-row halves are useless. The
    // card keeps `bold(sessionLabel)`, so "this" still has a referent.
    expect(splitPreview(14, true)).toEqual({ cardRows: 1, dividerRows: 1, chatRows: 12 });
  });

  it("guesses rather than refusing to split when fzf did not say", () => {
    // `${FZF_PREVIEW_LINES:-0}`. The chat auto-tails, so an over-guess costs a
    // little scrolling while a refusal shows no chat at all to someone who just
    // asked for one.
    expect(splitPreview(0, true)).toEqual(splitPreview(24, true));
  });

  it("does not throw or go negative on hostile input", () => {
    // Both are strings from the environment before they are numbers.
    for (const rows of [0, -1, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const split = splitPreview(rows, true);
      expect(split.cardRows).toBeGreaterThanOrEqual(0);
      expect(split.chatRows).toBeGreaterThanOrEqual(0);
    }
    expect(splitPreview(1, true).chatRows).toBe(0);
  });
});

describe("askDivider", () => {
  it("renders exactly the pane's width, colour aside", () => {
    // `"── ask "` is 7 display columns, so the constant is 7 and the rule is
    // `width`. An earlier draft said `w - 11` and rendered 4 columns short. The
    // colour is zero display columns, so this holds with it on or off.
    const bare = stripAnsi(askDivider(48));
    expect(bare).toHaveLength(48);
    expect(bare.startsWith("── ask ")).toBe(true);
  });

  it("paints the rule cyan, so the split is obvious in the pane", () => {
    // The card is monochrome; the divider is the one line that pops, which is
    // the whole point of colouring it. fzf renders the pane with `--ansi`.
    withColor(true, () => {
      const divider = askDivider(48);
      expect(divider).toContain(CYAN);
      expect(divider).toContain("── ask ");
    });
  });

  it("honours NO_COLOR — the glyph rule stands on its own", () => {
    // The divider is carried by GLYPHS, so losing the accent loses nothing
    // structural. A user who opts out of colour still gets the seam.
    withColor(false, () => {
      const divider = askDivider(48);
      expect(divider).not.toContain("\x1b");
      expect(divider).toHaveLength(48);
    });
  });

  it("does not throw at a width narrower than its own label", () => {
    // `String.repeat` throws RangeError on a negative count, and the width came
    // from the environment. A narrow pane must not crash the pane.
    for (const width of [0, 1, 5, -3, Number.NaN]) {
      expect(() => askDivider(width)).not.toThrow();
    }
  });
});

/* ------------------------------------------------------------------ the chat */

describe("formatChat", () => {
  const thread: AskEvent[] = [
    { t: "question", seq: 1, at: "2026-07-17T11:59:00.000Z", focus: "a1b2c3d4", text: "why did this fail?" },
    { t: "chunk", seq: 1, text: "The run died in apply_patch." },
    { t: "end", seq: 1, at: "2026-07-17T11:59:20.000Z" },
  ];

  it("puts the speaker above an indented body, so layout carries it with colour off", () => {
    const chat = withColor(false, () => formatChat(transcriptOf(thread), 20, 60, NOW));
    expect(chat).toContain("you");
    expect(chat).toContain("  why did this fail?");
    expect(chat).toContain("gm");
    expect(chat).toContain("  The run died in apply_patch.");
  });

  it("lights up the speaker labels: `you` bold, `gm` cyan", () => {
    // The colour makes the chat half read as its own thing under the card. It is
    // an accent on top of the layout, which already distinguishes them alone.
    const chat = withColor(true, () => formatChat(transcriptOf(thread), 20, 60, NOW));
    expect(chat).toContain(`${BOLD}you`);
    expect(chat).toContain(`${CYAN}gm`);
    // The bodies are never coloured — only the speaker labels are.
    expect(chat).toContain("  The run died in apply_patch.");
  });

  it("renders thinking… with a live count while a turn is in flight", () => {
    // The provider buffers, so this is the UX for most of a turn's life. The
    // count is computed here, at render time — never stored, or it would be
    // stale the instant it was written.
    const inFlight = transcriptOf([
      { t: "question", seq: 1, at: "2026-07-17T11:59:46.000Z", focus: "a1b2c3d4", text: "why?" },
    ]);
    // The gap is a single space by the time it renders: the body goes through
    // `wrapText`, which collapses runs of whitespace. Asserted as it renders,
    // not as it is written.
    expect(formatChat(inFlight, 20, 60, NOW)).toContain("thinking… 14s");
    expect(formatChat(inFlight, 20, 60, NOW)).toContain("(esc to cancel)");
  });

  it("renders an error where the answer would have gone, fix and all", () => {
    // fzf owns the terminal, so a mid-answer failure cannot reach it.
    // Non-negotiable #5 does not stop applying because the surface is a pane.
    const failed = transcriptOf([
      { t: "question", seq: 1, at: "2026-07-17T11:59:00.000Z", focus: null, text: "why?" },
      { t: "error", seq: 1, at: "2026-07-17T11:59:02.000Z", message: "timed out\nfix: try again" },
    ]);
    expect(formatChat(failed, 20, 60, NOW)).toContain("timed out");
    expect(formatChat(failed, 20, 60, NOW)).toContain("fix: try again");
  });

  it("still shows the human an aborted turn, though the model's view drops it", () => {
    const aborted = transcriptOf([
      { t: "question", seq: 1, at: "2026-07-17T11:59:00.000Z", focus: null, text: "why?" },
      { t: "aborted", seq: 1, at: "2026-07-17T11:59:02.000Z" },
    ]);
    expect(formatChat(aborted, 20, 60, NOW)).toContain("(cancelled)");
  });

  it("auto-tails: new text at the bottom, old text slides up", () => {
    // This is what makes it read as a chat rather than a document, and it means
    // the common case needs no scrolling at all.
    const long: AskEvent[] = [];
    for (let seq = 1; seq <= 6; seq++) {
      long.push({ t: "question", seq, at: "2026-07-17T11:00:00.000Z", focus: null, text: `q${seq}` });
      long.push({ t: "chunk", seq, text: `a${seq}` });
      long.push({ t: "end", seq, at: "2026-07-17T11:00:01.000Z" });
    }
    const chat = formatChat(transcriptOf(long), 5, 60, NOW);
    expect(chat.split("\n")).toHaveLength(5);
    expect(chat).toContain("a6");
    expect(chat).not.toContain("q1");
  });

  it("folds by seq, never by file order", () => {
    // Chunks are contiguous in practice because the lock guarantees one writer.
    // Folding by position would make this depend on a lock in another module.
    const shuffled = transcriptOf([
      { t: "end", seq: 1, at: "2026-07-17T11:59:20.000Z" },
      { t: "question", seq: 2, at: "2026-07-17T11:59:30.000Z", focus: null, text: "second" },
      { t: "chunk", seq: 1, text: "first answer" },
      { t: "question", seq: 1, at: "2026-07-17T11:59:00.000Z", focus: null, text: "first" },
      { t: "chunk", seq: 2, text: "second answer" },
      { t: "end", seq: 2, at: "2026-07-17T11:59:40.000Z" },
    ]);
    const chat = formatChat(shuffled, 40, 60, NOW);
    expect(chat.indexOf("first")).toBeLessThan(chat.indexOf("second"));
    expect(chat).toContain("first answer");
    expect(chat).toContain("second answer");
  });
});

describe("the `· re:` suffix", () => {
  const q = (seq: number, focus: string | null): AskEvent => ({
    t: "question",
    seq,
    at: "2026-07-17T11:59:00.000Z",
    focus,
    text: `q${seq}`,
  });

  /**
   * It marks the CHANGE, which is the only moment it carries information.
   * Stamping every question with the same id when focus never moved is noise on
   * the half of the pane with the least room for it.
   */
  it("appears on the first question and on every focus change, and nowhere else", () => {
    const chat = formatChat(transcriptOf([q(1, "aaaa1111"), q(2, "aaaa1111"), q(3, "bbbb2222")]), 60, 60, NOW);
    const marked = chat.split("\n").filter((line) => line.includes("· re:"));

    expect(marked).toHaveLength(2);
    expect(marked[0]).toContain("re: aaaa1111"); // first: nothing to differ from
    expect(marked[1]).toContain("re: bbbb2222"); // changed
  });

  it("says nothing when there is no focus to name", () => {
    // `buildAskContext` only claims focus on a session that made the window, so
    // a focus that scrolled out resolves to null rather than lying.
    expect(formatChat(transcriptOf([q(1, null)]), 20, 60, NOW)).not.toContain("re:");
  });
});

/* ---------------------------------------------------------------- the split */

describe("formatPreview with a conversation", () => {
  const chatting = transcriptOf([
    { t: "question", seq: 1, at: "2026-07-17T11:59:00.000Z", focus: "a1b2c3d4", text: "why did this fail?" },
    { t: "chunk", seq: 1, text: "The run died in apply_patch." },
    { t: "end", seq: 1, at: "2026-07-17T11:59:20.000Z" },
  ]);

  it("puts the card on top and the chat underneath, divided", () => {
    const split = splitPreview(40, true);
    const lines = formatPreview(view(), chatting, split, 60, NOW).split("\n");
    const divider = lines.findIndex((line) => stripAnsi(line).startsWith("── ask"));

    expect(divider).toBe(split.cardRows);
    expect(lines.slice(0, divider).join("\n")).toContain("RECENT WORK");
    expect(lines.slice(divider + 1).join("\n")).toContain("The run died in apply_patch.");
  });

  it("clips the card at the divider rather than letting it push the chat off", () => {
    // Measured: `formatCard` renders 23–83 rows against a 14–41 row pane, so it
    // already overflows the FULL pane at every realistic size. The card was
    // clipped before this pane existed; the divider just moves where.
    const split = splitPreview(20, true);
    const lines = formatPreview(view(), chatting, split, 60, NOW).split("\n");

    // The card is 9 rows of a 23-row card: clipped, and the divider is exactly
    // where the budget said it would be rather than shoved off the bottom.
    expect(lines.findIndex((l) => stripAnsi(l).startsWith("── ask"))).toBe(split.cardRows);
    // A short thread does not pad — the pane's remainder is just empty. The
    // budget is a ceiling, not a quota.
    expect(lines.length).toBeLessThanOrEqual(split.cardRows + 1 + split.chatRows);
  });

  it("keeps the card's identity strip in the collapse regime", () => {
    // A 14-row pane. You still know which session "this" is, which is the entire
    // point of the focus model.
    const lines = formatPreview(view(), chatting, splitPreview(14, true), 60, NOW).split("\n");
    expect(lines[0]).toContain("webshop/main");
    expect(stripAnsi(lines[1] ?? "")).toMatch(/^── ask/);
  });

  /**
   * ★ The hard correctness constraint, as an assertion.
   *
   * The preview command re-runs on EVERY cursor move. A model call in the render
   * path is one model call per keystroke — the single most expensive mistake
   * available in this design, and it would look like nothing but a slow pane.
   */
  it("renders a whole conversation with a provider that records ZERO asks", () => {
    class FakeAskProvider implements AskProvider {
      readonly name = "fake";
      asks = 0;
      async isAvailable(): Promise<boolean> {
        return true;
      }
      async ask(prompt: string): Promise<string> {
        this.asks++;
        return `never: ${prompt}`;
      }
    }
    const provider = new FakeAskProvider();

    for (let i = 0; i < 25; i++) {
      formatPreview(view(), chatting, splitPreview(40, true), 60, NOW);
    }
    expect(provider.asks).toBe(0);
  });
});

/* ---------------------------------------------------- the bodies, under `sh` */

/**
 * ★ Every binding body runs under a REAL `/bin/sh`, not bash.
 *
 * fzf runs child commands with `$SHELL -c`, not `sh -c` (`man fzf` twice over).
 * An earlier draft's bodies were `[[ ]]`, and `/bin/dash -c '[[ x = x ]]'` is
 * `[[: not found` — under `SHELL=/bin/dash` that makes ctrl-o a DEAD KEY, and
 * under tcsh the enter transform emits nothing, a transform that emits nothing
 * is a no-op, and enter stops resuming sessions at all. No error anywhere, in
 * either case. So: run them, do not eyeball them.
 */
describe("the binding bodies under /bin/sh", () => {
  /** What fzf would hand the body, for each documented value of the oracle. */
  const emit = async (body: string, state: string, query = ""): Promise<string> => {
    const { stdout } = await run("/bin/sh", ["-c", body], {
      env: { ...process.env, FZF_INPUT_STATE: state, FZF_QUERY: query, FZF_PORT: "1234" },
    });
    return stdout.trim();
  };

  /** Harmless stand-ins: `sh` will really run these. */
  const spec = (transcript: string): AskModeSpec =>
    askSpec({ transcript, sendCmd: "true", cancelCmd: "true" });

  it("ctrl-o enters ask mode from browse", async () => {
    const out = await emit(enterAskActions(spec(join(dir, "o1.jsonl"))), "enabled");
    expect(out).toContain("disable-search");
    expect(out).toContain("unbind(ctrl-r)");
    expect(out).toContain("change-prompt(ask > )");
  });

  it("ctrl-o in ask mode emits nothing, which fzf reads as a no-op", async () => {
    // Verified against fzf: ctrl-o twice does not double-enter or crash. This is
    // why the body needs no `else`.
    expect(await emit(enterAskActions(spec(join(dir, "o2.jsonl"))), "disabled")).toBe("");
  });

  it("enter resumes in browse mode and sends in ask mode", async () => {
    const s = spec(join(dir, "e1.jsonl"));
    expect(await emit(sendActions(s), "enabled")).toBe("accept");
    expect(await emit(sendActions(s), "disabled", "why?")).toBe("clear-query");
  });

  it("enter on an empty ask line clears rather than sending a blank question", async () => {
    expect(await emit(sendActions(spec(join(dir, "e2.jsonl"))), "disabled", "")).toBe("clear-query");
  });

  it("esc aborts in browse mode and returns to browse in ask mode", async () => {
    const s = spec(join(dir, "x1.jsonl"));
    expect(await emit(exitAskActions(s), "enabled")).toBe("abort");
    const back = await emit(exitAskActions(s), "disabled");
    expect(back).toContain("enable-search");
    expect(back).toContain("rebind(ctrl-r)");
    expect(back).toContain("change-prompt(session > )");
  });

  it("parks the browse query in a file and restores it verbatim", async () => {
    // The rows under the cursor must not move when you press ctrl-o, and the
    // query is a human's text: `)` and spaces must survive the round trip.
    const transcript = join(dir, "q1.jsonl");
    const query = "web (shop) 'x'";
    await emit(enterAskActions(spec(transcript)), "enabled", query);

    const parked = await run("/bin/sh", ["-c", `cat ${JSON.stringify(askBrowseQueryPath(transcript))}`]);
    expect(parked.stdout).toBe(query);
    expect(await emit(exitAskActions(spec(transcript)), "disabled")).toContain("transform-query(cat ");
  });

  it("carries no bash-ism any POSIX shell would reject", async () => {
    // `[[ ]]`, `{ …; }` and `function` are the three the earlier draft used.
    for (const body of chatBindings(spec(join(dir, "p1.jsonl")))) {
      expect(body).not.toContain("[[");
      expect(body).not.toMatch(/\bfunction\b/);
    }
  });
});

/**
 * ★ The oracle is TERNARY, and an earlier draft's binary reading made ctrl-o a
 * dead key. `man fzf`:1462 — "Current input state (enabled, disabled, hidden)".
 * `--no-input` yields `hidden`, and `hidden` must behave as BROWSE everywhere:
 * that is the fail-safe direction, and a ctrl-o guarded on `= enabled` is
 * silently inert under it.
 */
describe("the ternary oracle", () => {
  const emit = async (body: string, state: string): Promise<string> => {
    const { stdout } = await run("/bin/sh", ["-c", body], {
      env: { ...process.env, FZF_INPUT_STATE: state, FZF_QUERY: "q", FZF_PORT: "1234" },
    });
    return stdout.trim();
  };
  const s = () => askSpec({ transcript: join(dir, "t1.jsonl"), sendCmd: "true", cancelCmd: "true" });

  it("treats `hidden` as browse in all three bindings", async () => {
    expect(await emit(enterAskActions(s()), "hidden")).toContain("disable-search");
    expect(await emit(sendActions(s()), "hidden")).toBe("accept");
    expect(await emit(exitAskActions(s()), "hidden")).toBe("abort");
  });

  it("agrees with `enabled` on every one of them", async () => {
    // `!= disabled` on ctrl-o, `= disabled` on enter/esc: two spellings, one
    // meaning, and neither may ever read `hidden` as ask mode.
    for (const body of [enterAskActions(s()), sendActions(s()), exitAskActions(s())]) {
      expect(await emit(body, "hidden")).toBe(await emit(body, "enabled"));
    }
  });

  it("means ask mode on `disabled`, and only there", async () => {
    expect(await emit(enterAskActions(s()), "disabled")).toBe("");
    expect(await emit(sendActions(s()), "disabled")).toBe("clear-query");
    expect(await emit(exitAskActions(s()), "disabled")).toContain("enable-search");
  });
});

/**
 * ★ enter and exit are INVERSES.
 *
 * They are split into two functions specifically so this can be asserted. Two
 * independent `askModeBindings`/`browseModeBindings` could not be tested for it,
 * and the bug they invite is asymmetry: ask fires `disable-search`, browse
 * forgets `enable-search`, and the filter is dead with no error anywhere.
 */
describe("the mode toggle is reversible", () => {
  const PAIRS: ReadonlyArray<readonly [string, string]> = [
    ["disable-search", "enable-search"],
    ["unbind(ctrl-r)", "rebind(ctrl-r)"],
    ["change-prompt(ask > )", "change-prompt(session > )"],
    ["change-header(enter: send", "change-header(enter: resume"],
  ];

  it.each(PAIRS)("undoes %s with %s", (doing, undoing) => {
    const spec = askSpec();
    expect(enterAskActions(spec)).toContain(doing);
    expect(exitAskActions(spec)).toContain(undoing);
    expect(enterAskActions(spec)).not.toContain(undoing);
  });

  it("restores the exact header the picker started with", () => {
    // Not a reconstruction: the browse header depends on whether ctrl-r got
    // bound at all, which is `fzfArgs`' decision and nobody else's.
    const spec = askSpec({ browseHeader: "enter: resume   ctrl-c: cancel\nkey" });
    expect(exitAskActions(spec)).toContain("change-header(enter: resume   ctrl-c: cancel\nkey)");
  });

  it("restores the query with transform-query, not change-query", () => {
    // Sidesteps quoting hell when the browse query contains `)` or spaces, and
    // `enable-search` comes FIRST or the restored query never re-filters.
    const exit = exitAskActions(askSpec());
    expect(exit.indexOf("enable-search")).toBeLessThan(exit.indexOf("transform-query"));
    expect(exit).not.toContain("change-query");
  });
});

/* ------------------------------------------------------------- the arg set */

describe("the split tier's fzf arguments", () => {
  const chat = { transcript: "/cache/ask/1-abcd.jsonl", sendCmd: "gm __ask-send", cancelCmd: "gm __ask-cancel" };
  const spec = (overrides: Partial<FzfSpec> = {}): FzfSpec => ({
    multiline: true,
    preview: "gm __preview-card {1} --chat /cache/ask/1-abcd.jsonl",
    reloadCmd: "gm __picker-rows --width 44",
    askCmd: "gm ask --focus {1}",
    tier: "split",
    chat,
    ...overrides,
  });

  it("carries --with-shell, because fzf runs children under $SHELL", () => {
    const args = fzfArgs(spec());
    expect(args).toContain("--with-shell");
    expect(args[args.indexOf("--with-shell") + 1]).toBe("sh -c");
  });

  it("opens a listen port with no argument, so fzf picks it", () => {
    // Nothing in gm needs to know the port: fzf exports `$FZF_PORT` to children.
    const args = fzfArgs(spec());
    expect(args).toContain("--listen");
    expect(args.join(" ")).not.toMatch(/--listen[= ]\d/);
  });

  it("makes ctrl-o a mode rather than a launch", () => {
    // The whole point: `execute` suspends fzf and takes the session away, which
    // is exactly backwards — you pressed ctrl-o BECAUSE you were looking at it.
    const args = fzfArgs(spec()).join("\n");
    expect(args).toContain("--bind=ctrl-o:transform:");
    expect(args).not.toContain("ctrl-o:execute(");
  });

  it("binds enter and esc once each, to a transform that branches", () => {
    // `rebind` cannot give enter a new meaning — it only restores a binding.
    const binds = fzfArgs(spec()).filter((a) => a.startsWith("--bind="));
    expect(binds.filter((b) => b.startsWith("--bind=enter:"))).toHaveLength(1);
    expect(binds.filter((b) => b.startsWith("--bind=esc:"))).toHaveLength(1);
  });

  it("keeps ctrl-r advertised in browse and unbound in ask", () => {
    const args = fzfArgs(spec()).join("\n");
    expect(args).toContain("--bind=ctrl-r:reload(");
    expect(args).toContain("unbind(ctrl-r)");
    expect(args).toContain("ctrl-r: refresh"); // browse header
    expect(args).toContain("change-header(enter: send   esc: back"); // ask header: no ctrl-r
  });

  /**
   * A half-bound ask mode must never ship. Enter that sends into the void and
   * esc that cannot get you out is strictly worse than the REPL it replaced.
   */
  it("degrades to browse-only when the split tier arrives with no chat", () => {
    const args = fzfArgs(spec({ chat: undefined })).join("\n");
    expect(args).not.toContain("ctrl-o");
    expect(args).not.toContain("--listen");
    expect(args).not.toContain("--with-shell");
  });

  it("never binds a plain letter", () => {
    expect(fzfArgs(spec()).join(" ")).not.toMatch(/--bind=[A-Za-z]:/);
  });

  it("substitutes {1} rather than $FZF_CURRENT_ITEM", () => {
    // `$FZF_CURRENT_ITEM` is 0.73.0, and on that exact version a NUL-containing
    // item breaks the preview and every other child command outright. We use
    // --read0. `{1}` is also what makes the focus model free.
    const args = fzfArgs(spec()).join("\n");
    expect(args).toContain("--focus {1}");
    expect(args).not.toContain("FZF_CURRENT_ITEM");
  });

  it("appends --port unquoted, so the child gets the number and not the string", () => {
    // `shellQuote`'s class has no `$`, so a routed `$FZF_PORT` would arrive
    // literal and every refresh-preview would silently miss.
    expect(fzfArgs(spec()).join("\n")).toContain('--port "$FZF_PORT"');
  });

  it("redirects the send and cancel children away from fzf's stdout", () => {
    // Verified: a child inheriting fzf's stdout blocks fzf until EOF even when
    // backgrounded with `&`.
    const args = fzfArgs(spec()).join("\n");
    expect(args).toContain("gm __ask-send --port \"$FZF_PORT\" --focus {1} --question \"$FZF_QUERY\" >/dev/null 2>&1");
    expect(args).toContain('gm __ask-cancel --port "$FZF_PORT" >/dev/null 2>&1');
  });
});

/* ------------------------------------------------------------ the two seams */

describe("the fzf spawn's environment", () => {
  /**
   * picker.ts spawned fzf with no `env` at all, so the user's opts were
   * inherited — and `FZF_DEFAULT_OPTS=--disabled` makes `$FZF_INPUT_STATE`
   * `disabled` at the START event: the picker believes it is in ask mode from the
   * first frame, enter never resumes, and ctrl-o cannot get you back.
   */
  it("strips FZF_DEFAULT_OPTS, which would otherwise brick the mode oracle", () => {
    const env = fzfSpawnEnv({ PATH: "/bin", FZF_DEFAULT_OPTS: "--disabled", FZF_DEFAULT_OPTS_FILE: "/o" });
    expect(env["FZF_DEFAULT_OPTS"]).toBeUndefined();
    expect(env["FZF_DEFAULT_OPTS_FILE"]).toBeUndefined();
    expect(env["PATH"]).toBe("/bin"); // and nothing else is taken away
  });

  it("carries the api key in the environment", () => {
    expect(fzfSpawnEnv({}, "sekrit")["FZF_API_KEY"]).toBe("sekrit");
  });

  it("mints no key when no port is opened", () => {
    expect(fzfSpawnEnv({})["FZF_API_KEY"]).toBeUndefined();
  });

  /**
   * Argv is world-readable — measured, `ps -ww -o args=` prints another user's
   * argv — while `ps e` on their environment needs their uid. So argv is
   * STRICTLY WORSE than the env here, which is the opposite of the usual
   * instinct and is how an earlier draft defeated its own mitigation.
   */
  it("keeps the key out of every argv", () => {
    const key = "DI+aQPstHKos3Yf4ReWk8EZ1DFz+ORkpiFnCeoHdeeE=";
    const args = fzfArgs({
      multiline: true,
      preview: "gm __preview-card {1}",
      reloadCmd: "gm __picker-rows",
      askCmd: null,
      tier: "split",
      chat: { transcript: "/cache/ask/1-abcd.jsonl", sendCmd: "gm __ask-send", cancelCmd: "gm __ask-cancel" },
    });
    expect(args.join("\n")).not.toContain(key);
    expect(args.join("\n")).not.toContain("FZF_API_KEY");
  });
});

describe("the conventions two modules spell twice", () => {
  it("agrees on the .browseq sibling", () => {
    // The picker may not import a service, so the suffix lives in both. A drift
    // is silent: esc restores an empty query and the browse filter is gone.
    const transcript = "/cache/ask/1-abcd.jsonl";
    expect(exitAskActions(askSpec({ transcript }))).toContain(askBrowseQueryPath(transcript));
    expect(enterAskActions(askSpec({ transcript }))).toContain(askBrowseQueryPath(transcript));
  });

  it("agrees on the preview command's name", () => {
    // picker.ts spells `__preview-card` literally, for the same reason it spells
    // `show` literally: it imports no command module, and that is what keeps it
    // knowing nothing about providers.
    expect(PREVIEW_CARD_COMMAND).toBe("__preview-card");
  });
});

/* ------------------------------------------------------------- a torn read */

describe("the reader is unsynchronized with the writer", () => {
  /**
   * ★ A torn final line is NORMAL, not an error. The preview re-runs on every
   * cursor move — unsynchronized with the worker by construction — and an answer
   * is a multi-KB line whose append a reader can catch half-written.
   */
  it("renders everything before a half-written tail", async () => {
    const path = join(dir, "torn.jsonl");
    const whole = [
      JSON.stringify({ t: "question", seq: 1, at: "2026-07-17T11:59:00.000Z", focus: null, text: "why?" }),
      JSON.stringify({ t: "chunk", seq: 1, text: "because the patch failed" }),
      JSON.stringify({ t: "end", seq: 1, at: "2026-07-17T11:59:20.000Z" }),
    ].join("\n");
    // The worker is mid-append on a multi-KB answer as we read.
    await writeFile(path, `${whole}\n{"t":"chunk","seq":2,"text":"half a`, "utf8");

    const parsed = parseTranscript(await (await import("node:fs/promises")).readFile(path, "utf8"));
    expect(parsed.torn).toBe(true);
    // A dropped tail costs one refresh; everything before it is still true.
    expect(formatChat(parsed, 20, 60, NOW)).toContain("because the patch failed");
  });
});
