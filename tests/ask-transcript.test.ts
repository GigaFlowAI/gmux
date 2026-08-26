/**
 * The picker's chat thread, without the picker.
 *
 * Everything here is driven the way the fzf bindings drive it — `__ask-send`,
 * `__ask-run`, `__ask-cancel` against a real transcript in a temp cache — with
 * two things faked and nothing mocked:
 *
 * - **The model is a fake BINARY.** `node <script>` on `runProviderCommand`'s
 *   argv, via the `GIGAMANAGE_SUMMARY_CMD` seam. No model, no network, no money,
 *   deterministic (non-negotiable #2) — and it is the only way to get honest
 *   coverage of the things that actually break here: chunk boundaries, a
 *   provider that exits non-zero, a kill racing a live answer.
 * - **The listen port is an injected `notify`.** The policy is what these tests
 *   are for; the bytes need a socket and are out of scope for a unit test.
 *
 * No test forks a detached child: the fork is asserted as data
 * (`askChildSpawnOptions`) and through an injected spawner, exactly the way
 * `spawnWorker` is.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { askTranscriptDir, askTranscriptPath, cacheDir, configDir } from "../src/core/paths.js";
import type { AskEvent } from "../src/core/types.js";
import {
  ASK_MAX_REPLAY_TURNS,
  appendAskEvent,
  askChildSpawnOptions,
  askLockPath,
  closeAskTranscript,
  foldCompletedTurns,
  inFlightSeq,
  newAskRunId,
  nextSeq,
  openAskTranscript,
  parseTranscript,
  readAskLock,
  readAskTranscript,
  releaseAskLock,
  shouldRefresh,
  streamAnswer,
  sweepAskTranscripts,
} from "../src/services/ask-transcript.js";
import { shouldRunSetupWizard } from "../src/services/config.js";
import { ASK_CANCEL_COMMAND, cancelAskTurn } from "../src/cli/commands/__ask-cancel.js";
import { ASK_RUN_COMMAND, runAskTurn } from "../src/cli/commands/__ask-run.js";
import { ASK_SEND_COMMAND, sendAskQuestion } from "../src/cli/commands/__ask-send.js";
import { refreshRequest } from "../src/cli/commands/__ask-refresh.js";
import { tempHome } from "./fixtures/build.js";

let home: string;
let cache: string;
let bin: string;
let transcript: string;

/** A fake provider binary, on the seam `runProviderCommand` actually uses. */
async function fakeProvider(name: string, body: string): Promise<string> {
  const path = join(bin, `${name}.mjs`);
  await writeFile(path, body, "utf8");
  return `node ${path}`;
}

const buffersThenDumps = 'process.stdin.resume();process.stdout.write("the build broke in a1b2c3d4");';
const exitsNonZero = 'process.stderr.write("provider fell over");process.exit(3);';
const echoesChildFlag =
  'process.stdout.write("GIGAMANAGE_CHILD=" + (process.env.GIGAMANAGE_CHILD ?? "unset"));';
const splitsUtf8 =
  // "é" is two bytes; write them in separate stdout writes. Decoded across the
  // boundary this is `é`; concatenated with String(chunk) it is two `�`s.
  'process.stdout.write(Buffer.from([0xc3]));setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 20);';
const hangs = "setTimeout(() => {}, 60_000);";

beforeEach(async () => {
  home = await tempHome();
  cache = await tempHome();
  bin = await tempHome();
  process.env.GIGAMANAGE_HOME = home;
  process.env.XDG_CACHE_HOME = cache;
  transcript = askTranscriptPath(newAskRunId());
  await mkdir(askTranscriptDir(), { recursive: true });
});

afterEach(async () => {
  delete process.env.GIGAMANAGE_HOME;
  delete process.env.XDG_CACHE_HOME;
  delete process.env.GIGAMANAGE_SUMMARY_CMD;
  delete process.env.FZF_API_KEY;
  await rm(home, { recursive: true, force: true });
  await rm(cache, { recursive: true, force: true });
  await rm(bin, { recursive: true, force: true });
});

function write(events: readonly AskEvent[]): void {
  const fd = openAskTranscript(transcript);
  try {
    for (const event of events) appendAskEvent(fd, event);
  } finally {
    closeAskTranscript(fd);
  }
}

const question = (seq: number, text: string, focus: string | null = null): AskEvent => ({
  t: "question",
  seq,
  at: "2026-07-17T00:00:00.000Z",
  focus,
  text,
});
const chunk = (seq: number, text: string): AskEvent => ({ t: "chunk", seq, text });
const end = (seq: number): AskEvent => ({ t: "end", seq, at: "2026-07-17T00:00:01.000Z" });

describe("where the transcript lives", () => {
  it("is under the cache, in its own directory, never under config", () => {
    // The ephemeral-IPC category (AGENTS.md #1): typed text, but dead with the
    // picker that wrote it. Its own directory so the sweep cannot meet index.json.
    expect(askTranscriptDir()).toBe(join(cacheDir(), "ask"));
    expect(askTranscriptPath("48213-9f3a1c07")).toBe(join(cacheDir(), "ask", "48213-9f3a1c07.jsonl"));
    expect(askTranscriptPath("48213-9f3a1c07").startsWith(configDir())).toBe(false);
  });

  it("names the run by pid and random half, so the sweep needs no file reads", () => {
    expect(newAskRunId(48213)).toMatch(/^48213-[0-9a-f]{8}$/);
    expect(newAskRunId()).not.toBe(newAskRunId());
  });
});

describe("parseTranscript", () => {
  it("tolerates a torn final line", async () => {
    // The writer is appending as we read: the preview re-runs on every cursor
    // move and takes no lock. A half-written last line is NORMAL.
    write([question(1, "why did this fail?"), chunk(1, "because")]);
    // Half of a real append, exactly as a reader catches a multi-KB answer.
    const half = JSON.stringify(chunk(1, " the linker ran out of memory"));
    await writeFile(transcript, half.slice(0, half.length / 2), { flag: "a" });

    const parsed = parseTranscript(await readFile(transcript, "utf8"));
    expect(parsed.torn).toBe(true);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events.at(-1)).toEqual(chunk(1, "because"));
  });

  it("reports an intact file as untorn, and a missing one as the empty state", async () => {
    write([question(1, "q"), chunk(1, "a"), end(1)]);
    expect(parseTranscript(await readFile(transcript, "utf8")).torn).toBe(false);
    expect(await readAskTranscript(join(askTranscriptDir(), "never-written.jsonl"))).toEqual({
      events: [],
      torn: false,
    });
  });

  it("drops lines that are not events rather than guessing at them", () => {
    const parsed = parseTranscript('{"t":"question","seq":1,"at":"x","focus":null,"text":"q"}\n{"t":"nope"}\n42\n');
    expect(parsed.events).toHaveLength(1);
    expect(parsed.torn).toBe(false);
  });
});

describe("foldCompletedTurns", () => {
  it("keys by seq, not by file order", () => {
    // Interleaved on purpose: the fold's correctness must not depend on a lock
    // in another module.
    const turns = foldCompletedTurns([
      question(1, "first?"),
      question(2, "second?"),
      chunk(2, "two"),
      chunk(1, "one"),
      end(2),
      end(1),
    ]);
    expect(turns).toEqual([
      { question: "first?", answer: "one" },
      { question: "second?", answer: "two" },
    ]);
  });

  it("joins a turn's chunks in order", () => {
    expect(foldCompletedTurns([question(1, "q"), chunk(1, "a "), chunk(1, "b"), end(1)])).toEqual([
      { question: "q", answer: "a b" },
    ]);
  });

  it("promotes a turn only with an end record — in-flight, aborted and errored are dropped", () => {
    // A half-written answer in history is shown to the model as its own
    // completed statement of fact, and it will build on a sentence that stops
    // mid-clause. An aborted question with no answer has no slot in the prompt
    // at all, so it goes too — the human still sees it in the pane.
    const events: AskEvent[] = [
      question(1, "answered?"),
      chunk(1, "yes"),
      end(1),
      question(2, "aborted?"),
      chunk(2, "half a sen"),
      { t: "aborted", seq: 2, at: "2026-07-17T00:00:02.000Z" },
      question(3, "errored?"),
      { t: "error", seq: 3, at: "2026-07-17T00:00:03.000Z", message: "boom" },
      question(4, "in flight?"),
      chunk(4, "thinking"),
    ];
    expect(foldCompletedTurns(events)).toEqual([{ question: "answered?", answer: "yes" }]);
  });

  it("bounds replay at maxTurns, defaulting to 8", () => {
    const events: AskEvent[] = [];
    for (let seq = 1; seq <= 12; seq++) events.push(question(seq, `q${seq}`), chunk(seq, `a${seq}`), end(seq));

    const bounded = foldCompletedTurns(events);
    expect(bounded).toHaveLength(ASK_MAX_REPLAY_TURNS);
    expect(bounded[0]?.question).toBe("q5"); // A plain slice of the most recent.
    expect(foldCompletedTurns(events, { maxTurns: 2 })).toEqual([
      { question: "q11", answer: "a11" },
      { question: "q12", answer: "a12" },
    ]);
  });

  it("ignores meta, and an end with no question", () => {
    expect(
      foldCompletedTurns([
        { t: "meta", runId: "1-a", startedAt: "x", provider: "claude -p" },
        end(9),
        question(1, "q"),
        chunk(1, "a"),
        end(1),
      ]),
    ).toEqual([{ question: "q", answer: "a" }]);
  });
});

describe("seq bookkeeping", () => {
  it("allocates the next seq from the questions alone", () => {
    expect(nextSeq([])).toBe(1);
    expect(nextSeq([question(1, "a"), chunk(1, "x"), end(1), question(2, "b")])).toBe(3);
  });

  it("reports the in-flight turn, and nothing once it has settled", () => {
    expect(inFlightSeq([question(1, "a")])).toBe(1);
    expect(inFlightSeq([question(1, "a"), chunk(1, "x"), end(1)])).toBe(null);
    expect(inFlightSeq([question(1, "a"), end(1), question(2, "b")])).toBe(2);
    expect(inFlightSeq([])).toBe(null);
  });
});

describe("shouldRefresh", () => {
  it("passes the first chunk, throttles the burst, and never blocks the final", () => {
    expect(shouldRefresh({ lastAt: null, pending: true, final: false }, 1_000)).toBe(true);
    expect(shouldRefresh({ lastAt: 1_000, pending: true, final: false }, 1_100)).toBe(false);
    expect(shouldRefresh({ lastAt: 1_000, pending: true, final: false }, 1_150)).toBe(true);
    expect(shouldRefresh({ lastAt: 1_000, pending: false, final: false }, 9_999)).toBe(false);
    // The answer must never be stranded behind the throttle.
    expect(shouldRefresh({ lastAt: 1_000, pending: false, final: true }, 1_001)).toBe(true);
  });
});

describe("streamAnswer", () => {
  async function run(providerCmd: string, signal?: AbortSignal): Promise<number[]> {
    const sizes: number[] = [];
    const fd = openAskTranscript(transcript);
    try {
      await streamAnswer({
        argv: providerCmd.split(" "),
        prompt: "why?",
        transcriptFd: fd,
        seq: 1,
        notify: () => sizes.push(statSync(transcript).size),
        signal: signal ?? new AbortController().signal,
        timeoutMs: 10_000,
      });
    } finally {
      closeAskTranscript(fd);
    }
    return sizes;
  }

  it("appends to the transcript BEFORE notifying", async () => {
    // Notify-then-write renders the previous chunk, forever one behind — and
    // with a provider that buffers, "one behind" is an empty pane.
    write([question(1, "why?")]);
    const before = statSync(transcript).size;
    const sizes = await run(await fakeProvider("buffers", buffersThenDumps));

    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes[0]).toBeGreaterThan(before);
    const { events } = await readAskTranscript(transcript);
    expect(foldCompletedTurns(events)).toEqual([
      { question: "why?", answer: "the build broke in a1b2c3d4" },
    ]);
  });

  it("does not mangle a character split across chunk boundaries", async () => {
    write([question(1, "why?")]);
    await run(await fakeProvider("split", splitsUtf8));

    const { events } = await readAskTranscript(transcript);
    expect(foldCompletedTurns(events)).toEqual([{ question: "why?", answer: "é" }]);
  });

  it("records a provider failure as an error event carrying its fix", async () => {
    // fzf owns the terminal: this error can only reach a human through the pane,
    // so non-negotiable #5's fix has to travel with it.
    write([question(1, "why?")]);
    await run(await fakeProvider("fails", exitsNonZero));

    const { events } = await readAskTranscript(transcript);
    const error = events.find((event) => event.t === "error");
    expect(error).toBeDefined();
    expect(error?.t === "error" && error.message).toContain("provider fell over");
    expect(error?.t === "error" && error.message).toContain("gm setup");
    expect(foldCompletedTurns(events)).toEqual([]);
  });

  it("writes nothing when cancelled — the aborted record is the canceller's", async () => {
    // A worker wedged badly enough to need SIGKILL cannot write anything, so a
    // pane stuck on "answering" forever would be the failure mode.
    write([question(1, "why?")]);
    const controller = new AbortController();
    const before = statSync(transcript).size;
    setTimeout(() => controller.abort(), 40);
    await run(await fakeProvider("hangs", hangs), controller.signal);

    expect(statSync(transcript).size).toBe(before);
  });
});

describe("the recursion guard", () => {
  it("keeps GIGAMANAGE_CHILD on the worker it forks", () => {
    // The worker is a `gm` that is about to make a model call — the definition
    // of a child. Its provider may shell back into `gm grep`, which must not
    // start a summarize pass of its own.
    const options = askChildSpawnOptions({ PATH: "/usr/bin", FZF_API_KEY: "secret" });
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe("ignore");
    expect(options.env?.["GIGAMANAGE_CHILD"]).toBe("1");
    expect(options.env?.["GIGAMANAGE_AUTO_SUMMARIZE"]).toBe("0");
    // The key rides the environment and only the environment: argv is
    // world-readable (`ps -ww -o args=`), another uid's env is not.
    expect(options.env?.["FZF_API_KEY"]).toBe("secret");
  });

  it("reaches the provider the worker actually runs", async () => {
    // The end of the chain, driven for real: the worker must not pass `env` to
    // `runProviderCommand`, or `childEnv()`'s marker is silently dropped and the
    // loop reopens. Nothing else in this file would notice.
    process.env.GIGAMANAGE_CHILD = "1";
    process.env.GIGAMANAGE_SUMMARY_CMD = await fakeProvider("echo-child", echoesChildFlag);
    write([question(1, "who are you?")]);
    try {
      await runAskTurn({ transcript, seq: "1", notify: () => {} });
    } finally {
      delete process.env.GIGAMANAGE_CHILD;
    }

    const { events } = await readAskTranscript(transcript);
    expect(foldCompletedTurns(events)).toEqual([
      { question: "who are you?", answer: "GIGAMANAGE_CHILD=1" },
    ]);
  });

  it("hides every ask command behind the `__` prefix the guards key on", () => {
    // main.ts's postAction bails on `__` so a typed question cannot fork a
    // summarize decision from inside fzf, and `shouldRunSetupWizard` bails on it
    // so none of them can block on a human prompt while fzf owns the terminal.
    for (const name of [ASK_SEND_COMMAND, ASK_RUN_COMMAND, ASK_CANCEL_COMMAND]) {
      expect(name.startsWith("__")).toBe(true);
      expect(shouldRunSetupWizard({ hasConfig: false, isTty: true, isJson: false, commandName: name })).toBe(
        false,
      );
    }
  });
});

describe("__ask-send", () => {
  it("appends meta and the question, then forks a worker that can already read it", async () => {
    process.env.GIGAMANAGE_SUMMARY_CMD = "claude -p --allowedTools Bash(gm grep:*)";
    let seenAtSpawn = "";
    let workerArgs: readonly string[] = [];

    const status = await sendAskQuestion({
      transcript,
      question: "  why did this one fail?  ",
      focus: "a1b2c3d4",
      spawnWorker: (args) => {
        // Read-your-writes: the question is on disk and the fd closed before the
        // worker exists. Spawn first and it races its own question.
        workerArgs = args;
        seenAtSpawn = readFileSync(transcript, "utf8");
        return 4321;
      },
    });

    expect(status).toBe("sent");
    expect(seenAtSpawn).toContain("why did this one fail?");
    expect(workerArgs).toEqual([ASK_RUN_COMMAND, "--transcript", transcript, "--seq", "1"]);

    const { events } = await readAskTranscript(transcript);
    expect(events[0]).toMatchObject({ t: "meta", provider: "claude -p --allowedTools Bash(gm grep:*)" });
    expect(events[1]).toMatchObject({ t: "question", seq: 1, focus: "a1b2c3d4", text: "why did this one fail?" });
    // The lock names the worker, because esc has to kill its group.
    expect(await readAskLock(transcript)).toMatchObject({ pid: 4321 });
  });

  it("records the provider argv and never the environment", async () => {
    // `meta.provider` is what a human reads when the answers look wrong. It is
    // also the argv that keeps gm's own ask session a `-p` run — flagged
    // automated, and so invisible in the picker that started it.
    process.env.FZF_API_KEY = "s3cret";
    process.env.GIGAMANAGE_SUMMARY_CMD = "claude -p";
    await sendAskQuestion({ transcript, question: "q", spawnWorker: () => 1 });

    const raw = await readFile(transcript, "utf8");
    expect(raw).toContain('"provider":"claude -p"');
    expect(raw).not.toContain("s3cret");
  });

  it("writes meta exactly once across a thread", async () => {
    process.env.GIGAMANAGE_SUMMARY_CMD = "claude -p";
    await sendAskQuestion({ transcript, question: "first", spawnWorker: () => 1 });
    write([chunk(1, "a"), end(1)]);
    await releaseAskLock(transcript); // What the worker does when its turn ends.
    await sendAskQuestion({ transcript, question: "second", spawnWorker: () => 2 });

    const { events } = await readAskTranscript(transcript);
    expect(events.filter((event) => event.t === "meta")).toHaveLength(1);
    expect(nextSeq(events)).toBe(3);
  });

  it("absorbs a second enter rather than letting two workers interleave", async () => {
    // `transform` returns immediately, so nothing stops you pressing enter
    // twice. Two workers appending chunks of different seqs is the one thing
    // that makes the fold ambiguous.
    process.env.GIGAMANAGE_SUMMARY_CMD = "claude -p";
    await sendAskQuestion({ transcript, question: "first", spawnWorker: () => 1 });
    const before = await readFile(transcript, "utf8");

    let spawned = false;
    const status = await sendAskQuestion({
      transcript,
      question: "second",
      spawnWorker: () => {
        spawned = true;
        return 2;
      },
    });

    expect(status).toBe("locked");
    expect(spawned).toBe(false);
    expect(await readFile(transcript, "utf8")).toBe(before);
  });

  it("echoes the question and says why when the user configured no provider", async () => {
    await mkdir(configDir(), { recursive: true });
    await writeFile(
      join(configDir(), "config.json"),
      JSON.stringify({ version: 1, provider: null, autoSummarize: false }),
      "utf8",
    );
    const status = await sendAskQuestion({ transcript, question: "why?", spawnWorker: () => 1 });

    expect(status).toBe("no-provider");
    const { events } = await readAskTranscript(transcript);
    expect(events.at(-1)).toMatchObject({ t: "error", seq: 1 });
    expect(events.at(-1)?.t === "error" && events.at(-1)).toBeTruthy();
    const error = events.at(-1);
    expect(error?.t === "error" && error.message).toContain("gm setup");
    // The lock is released: the turn is over, and the next enter must work.
    expect(await readAskLock(transcript)).toBe(null);
  });

  it("does nothing at all on an empty question", async () => {
    expect(await sendAskQuestion({ transcript, question: "   ", spawnWorker: () => 1 })).toBe("empty");
    expect(await readAskTranscript(transcript)).toEqual({ events: [], torn: false });
  });
});

describe("__ask-run", () => {
  it("replays completed turns and answers the one it was given", async () => {
    process.env.GIGAMANAGE_SUMMARY_CMD = await fakeProvider("buffers2", buffersThenDumps);
    write([question(1, "first?"), chunk(1, "one"), end(1), question(2, "and this?")]);

    expect(await runAskTurn({ transcript, seq: "2", notify: () => {} })).toBe("answered");
    const { events } = await readAskTranscript(transcript);
    expect(foldCompletedTurns(events)).toEqual([
      { question: "first?", answer: "one" },
      { question: "and this?", answer: "the build broke in a1b2c3d4" },
    ]);
  });

  it("drops the lock and writes nothing when its question is already settled", async () => {
    // A stale respawn must not answer twice, and must not leave the next enter
    // locked out by a ghost.
    process.env.GIGAMANAGE_SUMMARY_CMD = await fakeProvider("unused", buffersThenDumps);
    write([question(1, "q"), chunk(1, "a"), end(1)]);
    await writeFile(askLockPath(transcript), JSON.stringify({ pid: 0, startedAt: new Date().toISOString() }));

    expect(await runAskTurn({ transcript, seq: "1", notify: () => {} })).toBe("no-question");
    expect(await readAskLock(transcript)).toBe(null);
  });

  it("releases the lock when the answer lands", async () => {
    process.env.GIGAMANAGE_SUMMARY_CMD = await fakeProvider("buffers3", buffersThenDumps);
    write([question(1, "q")]);
    await writeFile(askLockPath(transcript), JSON.stringify({ pid: 0, startedAt: new Date().toISOString() }));

    await runAskTurn({ transcript, seq: "1", notify: () => {} });
    expect(await readAskLock(transcript)).toBe(null);
  });
});

describe("__ask-cancel", () => {
  it("kills the worker's GROUP, records the abort and frees the lock", async () => {
    // `kill -TERM <pid>` leaves the provider orphaned, alive and billing while
    // the pane flips back to browse. The negative pid is the whole point.
    write([question(1, "why?"), chunk(1, "half a sen")]);
    // Our own pid, because it has to be a LIVE one: cancel refuses to signal a
    // stale lock, whose pid is either dead or recycled into some innocent
    // process. `kill` is injected, so nothing here signals anything real.
    await writeFile(
      askLockPath(transcript),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    const signalled: Array<[number, string]> = [];
    const status = await cancelAskTurn({
      transcript,
      graceMs: 0,
      kill: (pid, signal) => {
        signalled.push([pid, signal]);
        if (signal === "SIGTERM") return;
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      },
    });

    expect(status).toBe("cancelled");
    expect(signalled[0]).toEqual([process.pid, "SIGTERM"]);
    const { events } = await readAskTranscript(transcript);
    expect(events.at(-1)).toMatchObject({ t: "aborted", seq: 1 });
    expect(await readAskLock(transcript)).toBe(null);
    // The model never sees the turn it never finished.
    expect(foldCompletedTurns(events)).toEqual([]);
  });

  it("is silent and cheap when nothing is in flight — esc is also how you leave", async () => {
    write([question(1, "q"), chunk(1, "a"), end(1)]);
    const before = await readFile(transcript, "utf8");

    let signalled = false;
    expect(
      await cancelAskTurn({
        transcript,
        kill: () => {
          signalled = true;
        },
      }),
    ).toBe("idle");
    expect(signalled).toBe(false);
    expect(await readFile(transcript, "utf8")).toBe(before);
  });

  it("does not signal a stale lock's pid — it may have been recycled", async () => {
    write([question(1, "q")]);
    await writeFile(
      askLockPath(transcript),
      JSON.stringify({ pid: 9999, startedAt: new Date(Date.now() - 60 * 60_000).toISOString() }),
    );

    let signalled = false;
    const status = await cancelAskTurn({
      transcript,
      kill: () => {
        signalled = true;
      },
    });

    expect(signalled).toBe(false);
    expect(status).toBe("cancelled"); // The dangling question still gets its record.
  });
});

describe("sweepAskTranscripts", () => {
  it("reaps a dead picker's transcript, lock and browse query", async () => {
    const dead = askTranscriptPath("999999-deadbeef");
    await writeFile(dead, `${JSON.stringify(question(1, "q"))}\n`, "utf8");
    await writeFile(`${dead}.lock`, "{}", "utf8");
    await writeFile(`${dead}.browseq`, "web", "utf8");

    expect(await sweepAskTranscripts()).toEqual([dead]);
    await expect(readFile(dead, "utf8")).rejects.toThrow();
    await expect(readFile(`${dead}.lock`, "utf8")).rejects.toThrow();
    await expect(readFile(`${dead}.browseq`, "utf8")).rejects.toThrow();
  });

  it("reaps a browse query whose picker died before the first question", async () => {
    // ctrl-o writes `.browseq` and only `enter` writes the `.jsonl`. Kill the
    // picker in between — as a crash or a `kill -9` does — and this is all that
    // is left. A sweep keyed on the transcript cannot see it, so it accumulated
    // one file per killed picker, forever.
    const dead = askTranscriptPath("999998-0rphaned");
    await writeFile(`${dead}.browseq`, "webshop", "utf8");

    expect(await sweepAskTranscripts()).toEqual([dead]);
    await expect(readFile(`${dead}.browseq`, "utf8")).rejects.toThrow();
  });

  it("never removes a live pid's browse query either", async () => {
    // The mirror of the above: that pane is mid-ask, and eating its saved query
    // means esc hands back an empty filter instead of the list they had.
    const mine = askTranscriptPath(`${process.pid}-cafe0001`);
    await writeFile(`${mine}.browseq`, "webshop", "utf8");

    expect(await sweepAskTranscripts(new Date(Date.now() + 60 * 60_000))).toEqual([]);
    expect(await readFile(`${mine}.browseq`, "utf8")).toBe("webshop");
  });

  it("never removes a live pid's transcript — that is another pane", async () => {
    const mine = askTranscriptPath(`${process.pid}-cafe0000`);
    await writeFile(mine, `${JSON.stringify(question(1, "q"))}\n`, "utf8");

    // Old enough that a sweep keyed on mtime alone would eat it. The pid in the
    // name is the PICKER's, and a picker left open for an hour is ordinary.
    expect(await sweepAskTranscripts(new Date(Date.now() + 60 * 60_000))).toEqual([]);
    expect(await readFile(mine, "utf8")).toContain("\"q\"");
  });

  it("survives a directory that was never created", async () => {
    await rm(askTranscriptDir(), { recursive: true, force: true });
    expect(await sweepAskTranscripts()).toEqual([]);
  });
});

describe("refreshRequest", () => {
  it("is the POST fzf documents, with the key in a header and never in a url", () => {
    expect(refreshRequest(54132, "DI+aQPstHKos=")).toEqual({
      url: "http://127.0.0.1:54132",
      method: "POST",
      headers: { "x-api-key": "DI+aQPstHKos=" },
      body: "refresh-preview",
    });
  });
});
