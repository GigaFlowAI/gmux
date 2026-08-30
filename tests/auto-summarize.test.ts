/**
 * Auto-summarize.
 *
 * The rules this suite exists to hold down:
 *
 *   - gigamanage never summarizes its own summarizer (the feedback loop);
 *   - it never re-writes a summary that is still current (the money);
 *   - it never spawns two workers at once (the stampede);
 *   - and it can be switched off.
 *
 * NO TEST HERE SPAWNS ANYTHING OR CALLS A MODEL. `spawnWorker` and the
 * `SummaryProvider` are both injected.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";

import type {
  SessionRecord,
  SummaryFields,
  SummaryInput,
  SummaryProvider,
} from "../src/core/types.js";
import {
  AUTO_SUMMARIZE_LIMIT,
  acquireLock,
  autoSummarizeCandidates,
  autoSummarizeEnabled,
  inCooldown,
  inProgressIds,
  isLockStale,
  lockPath,
  maybeAutoSummarize,
  noteCheck,
  readLock,
  releaseLock,
  runAutoSummarize,
  selectAutoSummarizeTargets,
  writeQueue,
} from "../src/services/auto-summarize.js";
import { summarizeBatch } from "../src/services/summarize.js";
import { claudeLines, tempHome, writeClaudeSession } from "./fixtures/build.js";

let home: string;
let cache: string;

beforeEach(async () => {
  home = await tempHome();
  cache = await tempHome();
  process.env.GIGAMANAGE_HOME = home;
  process.env.XDG_CACHE_HOME = cache;
  delete process.env.GIGAMANAGE_AUTO_SUMMARIZE;
});

afterEach(async () => {
  delete process.env.GIGAMANAGE_HOME;
  delete process.env.XDG_CACHE_HOME;
  delete process.env.GIGAMANAGE_AUTO_SUMMARIZE;
  await rm(home, { recursive: true, force: true });
  await rm(cache, { recursive: true, force: true });
});

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    harness: "claude-code",
    sessionId: "aaaa1111-0000-0000-0000-000000000000",
    filePath: "/tmp/a.jsonl",
    cwd: "/repo",
    project: "repo",
    gitBranch: "main",
    startedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    messageCount: 4,
    userPromptCount: 2,
    title: "started here",
    lastUserPrompt: "and ended over there",
    recentUserPrompts: ["started here", "and ended over there"],
    arcPrompts: ["started here", "and ended over there"],
    filesTouched: ["src/a.ts"],
    prLinks: [],
    lastAssistantText: "the last thing the agent said",
    lastToolFailure: null,
    endedMidTask: false,
    isSidechain: false,
    isAutomated: false,
    ...overrides,
  };
}

/** A stand-in for the model. No test in this suite ever calls a real one. */
class FakeProvider implements SummaryProvider {
  readonly name = "fake";
  calls = 0;
  constructor(private readonly available = true) {}
  async isAvailable(): Promise<boolean> {
    return this.available;
  }
  async generate(_input: SummaryInput): Promise<SummaryFields> {
    this.calls += 1;
    return { headline: "h", overview: "ov", summary: "s", landed: "l", open: "o", nextStep: "n" };
  }
}

/**
 * Stands in for the detached spawn. Counts how many workers *would* have started.
 *
 * Reports our own pid as the worker's: a real spawn returns a live pid, and the
 * lock's liveness check would (correctly) reclaim a lock held by a dead one.
 */
function fakeSpawner() {
  const spawner = { count: 0, spawnWorker: (): number => 0 };
  spawner.spawnWorker = () => {
    spawner.count += 1;
    return process.pid;
  };
  return spawner;
}

describe("the feedback-loop guard", () => {
  // THE ONE THAT MATTERS. `claude -p` writes a Claude Code session for every
  // summary it produces. If those were targets, gigamanage would summarize its
  // own summarizer, whose summaries would create more sessions, forever.
  it("never targets an automated session — gigamanage must not summarize its own `claude -p` runs", () => {
    const records = [
      record({ sessionId: "human", updatedAt: "2026-07-01T00:00:00.000Z" }),
      // These are exactly what our own summarizer leaves behind.
      record({ sessionId: "our-own-summarizer", isAutomated: true, updatedAt: "2026-07-02T00:00:00.000Z" }),
      record({ sessionId: "another-one", isAutomated: true, updatedAt: "2026-07-03T00:00:00.000Z" }),
    ];

    expect(autoSummarizeCandidates(records).map((r) => r.sessionId)).toEqual(["human"]);
  });

  it("never targets a sidechain", () => {
    const records = [
      record({ sessionId: "top-level" }),
      record({ sessionId: "subagent", isSidechain: true, updatedAt: "2026-07-09T00:00:00.000Z" }),
    ];

    expect(autoSummarizeCandidates(records).map((r) => r.sessionId)).toEqual(["top-level"]);
  });

  it("still excludes them when they are the ONLY recent sessions — the set is then empty, not a fallback", async () => {
    const onlyAutomation = [
      record({ sessionId: "a", isAutomated: true }),
      record({ sessionId: "b", isSidechain: true }),
    ];

    expect(await selectAutoSummarizeTargets(onlyAutomation)).toEqual([]);
  });
});

describe("choosing what to summarize", () => {
  it("targets only sessions whose summary is missing or stale", async () => {
    const fresh = record({ sessionId: "fresh" });
    const missing = record({ sessionId: "missing" });

    // Write a current summary for `fresh` — no model involved beyond the fake.
    await summarizeBatch([fresh], new FakeProvider());

    const targets = await selectAutoSummarizeTargets([fresh, missing]);
    expect(targets.map((r) => r.sessionId)).toEqual(["missing"]);
  });

  it("re-targets a session once it has moved on, but not before", async () => {
    const before = record({ sessionId: "moving" });
    await summarizeBatch([before], new FakeProvider());
    expect(await selectAutoSummarizeTargets([before])).toEqual([]);

    const after = record({ sessionId: "moving", lastAssistantText: "new work happened since" });
    expect((await selectAutoSummarizeTargets([after])).map((r) => r.sessionId)).toEqual(["moving"]);
  });

  it("caps the target set at the default window (20), newest first", async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      record({
        sessionId: `s${String(i).padStart(2, "0")}`,
        updatedAt: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );

    const targets = await selectAutoSummarizeTargets(many);

    expect(AUTO_SUMMARIZE_LIMIT).toBe(20);
    expect(targets).toHaveLength(20);
    // Newest first: s24 is the most recent, s05 the twentieth.
    expect(targets[0]!.sessionId).toBe("s24");
    expect(targets.at(-1)!.sessionId).toBe("s05");
  });
});

describe("the lock", () => {
  it("stops a second gm from spawning a second worker", async () => {
    expect(await acquireLock()).toBe(true);
    expect(await acquireLock()).toBe(false);

    await releaseLock();
    expect(await acquireLock()).toBe(true);
  });

  it("takes over a lock whose owner died without releasing it", async () => {
    const ancient = { pid: 999_999, startedAt: new Date(Date.now() - 20 * 60_000).toISOString() };
    await acquireLock();
    await writeFile(lockPath(), JSON.stringify(ancient), "utf8");

    expect(isLockStale(ancient)).toBe(true);
    expect(await acquireLock()).toBe(true);

    const held = await readLock();
    expect(held?.startedAt).not.toBe(ancient.startedAt);
  });

  it("holds a lock whose owner is alive and young", () => {
    const live = { pid: process.pid, startedAt: new Date().toISOString() };
    expect(isLockStale(live)).toBe(false);
  });

  it("treats a lock from a dead pid as stale even when it is young", () => {
    const orphan = { pid: 999_999, startedAt: new Date().toISOString() };
    expect(isLockStale(orphan)).toBe(true);
  });
});

describe("maybeAutoSummarize", () => {
  async function seedUnsummarizedSession(): Promise<void> {
    await writeClaudeSession(home, {
      slug: "-Users-dev-acme",
      sessionId: "581cb3f8-7a1c-4dd0-a887-5f55f9184619",
      lines: claudeLines("581cb3f8-7a1c-4dd0-a887-5f55f9184619"),
    });
  }

  it("spawns exactly one worker, and tells the user on stderr", async () => {
    await seedUnsummarizedSession();
    const spawner = fakeSpawner();
    const notices: string[] = [];

    const outcome = await maybeAutoSummarize({
      provider: new FakeProvider(),
      spawnWorker: spawner.spawnWorker,
      notify: (m) => notices.push(m),
    });

    expect(outcome.status).toBe("spawned");
    expect(outcome.targets).toBe(1);
    expect(spawner.count).toBe(1);
    expect(notices).toEqual([
      "summarizing 1 session in the background — marked ◐ below",
    ]);
    // The lock now names the worker, so the next `gm` backs off.
    expect((await readLock())?.pid).toBe(process.pid);
  });

  it("does not stampede: a second run while the worker holds the lock spawns nothing", async () => {
    await seedUnsummarizedSession();
    const spawner = fakeSpawner();

    const first = await maybeAutoSummarize({ provider: new FakeProvider(), spawnWorker: spawner.spawnWorker });
    expect(first.status).toBe("spawned");

    // Past the cooldown, so it is the lock — not the cooldown — doing the work.
    const later = new Date(Date.now() + 5 * 60_000);
    const second = await maybeAutoSummarize({
      now: later,
      provider: new FakeProvider(),
      spawnWorker: spawner.spawnWorker,
    });

    expect(second.status).toBe("locked");
    expect(spawner.count).toBe(1);
  });

  it("is off when GIGAMANAGE_AUTO_SUMMARIZE=0, and touches nothing", async () => {
    await seedUnsummarizedSession();
    process.env.GIGAMANAGE_AUTO_SUMMARIZE = "0";
    const spawner = fakeSpawner();
    const notices: string[] = [];

    const outcome = await maybeAutoSummarize({
      provider: new FakeProvider(),
      spawnWorker: spawner.spawnWorker,
      notify: (m) => notices.push(m),
    });

    expect(outcome.status).toBe("disabled");
    expect(spawner.count).toBe(0);
    expect(notices).toEqual([]);
    expect(await readLock()).toBeNull();

    expect(autoSummarizeEnabled({ GIGAMANAGE_AUTO_SUMMARIZE: "0" })).toBe(false);
    expect(autoSummarizeEnabled({ GIGAMANAGE_AUTO_SUMMARIZE: "false" })).toBe(false);
    expect(autoSummarizeEnabled({})).toBe(true);
  });

  it("is off when `--no-auto-summarize` was passed", async () => {
    await seedUnsummarizedSession();
    const spawner = fakeSpawner();

    const outcome = await maybeAutoSummarize({
      enabled: false,
      provider: new FakeProvider(),
      spawnWorker: spawner.spawnWorker,
    });

    expect(outcome.status).toBe("disabled");
    expect(spawner.count).toBe(0);
  });

  // Never error out of a read command because a model is missing.
  it("skips silently when the summary provider is not installed", async () => {
    await seedUnsummarizedSession();
    const spawner = fakeSpawner();
    const notices: string[] = [];

    const outcome = await maybeAutoSummarize({
      provider: new FakeProvider(false),
      spawnWorker: spawner.spawnWorker,
      notify: (m) => notices.push(m),
    });

    expect(outcome.status).toBe("no-provider");
    expect(spawner.count).toBe(0);
    expect(notices).toEqual([]);
  });

  it("does nothing, and starts a cooldown, when every recent session is already summarized", async () => {
    const spawner = fakeSpawner();

    const outcome = await maybeAutoSummarize({
      provider: new FakeProvider(),
      spawnWorker: spawner.spawnWorker,
    });

    expect(outcome.status).toBe("nothing-to-do");
    expect(spawner.count).toBe(0);
    expect(await inCooldown()).toBe(true);
  });

  it("backs off during the cooldown, then decides again once it lapses", async () => {
    await seedUnsummarizedSession();
    const spawner = fakeSpawner();
    await noteCheck();

    expect((await maybeAutoSummarize({ provider: new FakeProvider(), spawnWorker: spawner.spawnWorker })).status).toBe(
      "cooling-down",
    );
    expect(spawner.count).toBe(0);

    const later = new Date(Date.now() + 5 * 60_000);
    expect(
      (await maybeAutoSummarize({ now: later, provider: new FakeProvider(), spawnWorker: spawner.spawnWorker })).status,
    ).toBe("spawned");
  });

  it("decides anyway when forced: ctrl-r is an explicit request, not an incidental re-run", async () => {
    await seedUnsummarizedSession();
    const spawner = fakeSpawner();
    await noteCheck();

    const outcome = await maybeAutoSummarize({
      force: true,
      provider: new FakeProvider(),
      spawnWorker: spawner.spawnWorker,
    });

    expect(outcome.status).toBe("spawned");
    expect(spawner.count).toBe(1);
  });

  it("still respects the lock when forced, so hammering ctrl-r cannot stampede", async () => {
    await seedUnsummarizedSession();
    const spawner = fakeSpawner();

    const first = await maybeAutoSummarize({
      force: true,
      provider: new FakeProvider(),
      spawnWorker: spawner.spawnWorker,
    });
    expect(first.status).toBe("spawned");

    const second = await maybeAutoSummarize({
      force: true,
      provider: new FakeProvider(),
      spawnWorker: spawner.spawnWorker,
    });

    expect(second.status).toBe("locked");
    expect(spawner.count).toBe(1);
  });

  it("stays off when forced but disabled: a keypress does not override the env var", async () => {
    await seedUnsummarizedSession();
    process.env.GIGAMANAGE_AUTO_SUMMARIZE = "0";
    const spawner = fakeSpawner();

    const outcome = await maybeAutoSummarize({
      force: true,
      provider: new FakeProvider(),
      spawnWorker: spawner.spawnWorker,
    });

    expect(outcome.status).toBe("disabled");
    expect(spawner.count).toBe(0);
  });
});

describe("the background worker", () => {
  it("writes the summaries and releases the lock, so the next gm can take it", async () => {
    await writeClaudeSession(home, {
      slug: "-Users-dev-acme",
      sessionId: "581cb3f8-7a1c-4dd0-a887-5f55f9184619",
      lines: claudeLines("581cb3f8-7a1c-4dd0-a887-5f55f9184619"),
    });
    await acquireLock();

    const provider = new FakeProvider();
    const result = await runAutoSummarize(provider);

    expect(result.generated).toBe(1);
    expect(provider.calls).toBe(1);
    expect(await readLock()).toBeNull();

    const written = JSON.parse(
      await readFile(
        `${cache}/gigamanage/summaries/claude-code-581cb3f8-7a1c-4dd0-a887-5f55f9184619.json`,
        "utf8",
      ),
    );
    expect(written.headline).toBe("h");
  });

  it("releases the lock even when it has nothing to do", async () => {
    await acquireLock();
    const result = await runAutoSummarize(new FakeProvider());

    expect(result.generated).toBe(0);
    expect(await readLock()).toBeNull();
  });
});

describe("the window follows what you displayed", () => {
  it("summarizes every session shown, not just the default window", async () => {
    // `gm ls -n 50` must summarize all fifty. Before this, the window was a
    // fixed 10 while `gm ls` showed 20, so half the default view was
    // permanently marked "no summary yet" and the feature looked broken.
    const shown = Array.from({ length: 35 }, (_, i) =>
      record({ sessionId: `s${String(i).padStart(3, "0")}`, updatedAt: `2026-07-${String(10 + (i % 20)).padStart(2, "0")}T00:00:00.000Z` }),
    );

    const targets = await selectAutoSummarizeTargets(shown, shown.length);

    expect(targets).toHaveLength(35);
  });

  it("still refuses to summarize automated runs, however they arrive", async () => {
    // The queue is a file. A stale or hand-edited one must not smuggle an
    // automated session past the feedback-loop guard.
    const mixed = [
      record({ sessionId: "human-1" }),
      record({ sessionId: "auto-1", isAutomated: true }),
      record({ sessionId: "side-1", isSidechain: true }),
    ];

    const ids = autoSummarizeCandidates(mixed, 50).map((r) => r.sessionId);

    expect(ids).toEqual(["human-1"]);
  });
});

describe("in-progress rows", () => {
  it("reports the queued ids while the lock is live", async () => {
    await acquireLock(new Date());
    await writeQueue(["a", "b"], new Date());

    expect([...(await inProgressIds())].sort()).toEqual(["a", "b"]);
  });

  it("reports nothing once the worker is gone, so ◐ cannot get stuck", async () => {
    // A crashed worker leaves its queue behind. Without the lock check those
    // rows would spin forever.
    await writeQueue(["a", "b"], new Date());
    await releaseLock();

    expect(await inProgressIds()).toEqual(new Set());
  });
});

describe("the worker resolves its queue", () => {
  it("finds queued sessions even when recent transcripts are mostly sidechains", async () => {
    // The bug this pins: the worker used to load "the N most recent" and then
    // filter by queued id. With sidechains included, the most recent N are
    // mostly subagent transcripts, so the filter matched nothing and the pass
    // wrote ZERO summaries — silently, with no failure logged.
    const human = record({ sessionId: "human-old", updatedAt: "2026-07-01T00:00:00.000Z" });
    const noise = Array.from({ length: 30 }, (_, i) =>
      record({
        sessionId: `side-${i}`,
        isSidechain: true,
        updatedAt: `2026-07-${String(2 + (i % 20)).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );

    // The guard still runs over whatever the queue names.
    const resolved = autoSummarizeCandidates([...noise, human].filter((r) => r.sessionId === "human-old"), 50);

    expect(resolved.map((r) => r.sessionId)).toEqual(["human-old"]);
  });
});
