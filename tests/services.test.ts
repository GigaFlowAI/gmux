import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm, utimes } from "node:fs/promises";
import { join } from "node:path";

import type {
  SessionRecord,
  SessionSummary,
  SessionView,
  SummaryFields,
  SummaryInput,
  SummaryProvider,
} from "../src/core/types.js";
import { AmbiguousSessionError, SessionNotFoundError } from "../src/core/errors.js";
import { hash, parseSince, relativeAge, shellQuote, truncate, wrapText } from "../src/core/text.js";
import { PROMPT_VERSION, buildPrompt, distill } from "../src/services/distill.js";
import { filterRecords, refreshIndex } from "../src/services/index-store.js";
import { resolveSession } from "../src/services/resolve.js";
import { batchPaths, searchSessions, snippetFrom } from "../src/services/search.js";
import { loadRecords } from "../src/services/views.js";
import { isStale, parseSummaryFields, readSummary, summarizeBatch } from "../src/services/summarize.js";
import { claudeLines, codexLines, tempHome, writeClaudeSession, writeCodexSession } from "./fixtures/build.js";
import { formatCard, formatLegend, formatMarkerKey, formatRow, formatRowLines } from "../src/cli/format.js";
import { buildFzfRecords, fzfArgs, listWidth, resolvePicked, selfCommand, supportsMultiline, type FzfSpec } from "../src/cli/picker.js";
import { pickerReloadArgs } from "../src/cli/commands/pick.js";
import { autoSummarizeRequested, toFilters } from "../src/cli/commands/ls.js";
import { Command } from "commander";

const CLAUDE_ID = "581cb3f8-7a1c-4dd0-a887-5f55f9184619";
const CODEX_ID = "019e9a77-740f-7903-942c-caab943b6101";

let home: string;
let cache: string;

beforeEach(async () => {
  home = await tempHome();
  cache = await tempHome();
  process.env.GIGAMANAGE_HOME = home;
  process.env.XDG_CACHE_HOME = cache;
});

afterEach(async () => {
  delete process.env.GIGAMANAGE_HOME;
  delete process.env.XDG_CACHE_HOME;
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

describe("text helpers", () => {
  it("renders compact relative ages", () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    expect(relativeAge("2026-07-10T10:00:00.000Z", now)).toBe("2h");
    expect(relativeAge("2026-07-07T12:00:00.000Z", now)).toBe("3d");
    expect(relativeAge("garbage", now)).toBe("?");
  });

  it("parses durations and dates for --since", () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    expect(parseSince("3d", now)).toBe("2026-07-07T12:00:00.000Z");
    expect(parseSince("2h", now)).toBe("2026-07-10T10:00:00.000Z");
    expect(parseSince("2026-07-01", now)).toBe("2026-07-01T00:00:00.000Z");
    expect(parseSince("soonish", now)).toBeNull();
  });

  it("truncates on a single line", () => {
    expect(truncate("a\n  b   c", 20)).toBe("a b c");
    expect(truncate("abcdef", 4)).toBe("abc…");
  });
});

describe("resolveSession", () => {
  const records = [
    record({ sessionId: "aaaa1111-1111-1111-1111-111111111111" }),
    record({ sessionId: "aaaa2222-2222-2222-2222-222222222222" }),
    record({ sessionId: "bbbb3333-3333-3333-3333-333333333333" }),
  ];

  it("resolves a unique prefix", () => {
    expect(resolveSession(records, "bbbb").sessionId).toBe("bbbb3333-3333-3333-3333-333333333333");
  });

  it("resolves a full id exactly", () => {
    expect(resolveSession(records, "aaaa1111-1111-1111-1111-111111111111").sessionId).toBe(
      "aaaa1111-1111-1111-1111-111111111111",
    );
  });

  it("refuses an ambiguous prefix rather than guessing", () => {
    expect(() => resolveSession(records, "aaaa")).toThrow(AmbiguousSessionError);
  });

  // `gm show`/`gm resume` look up with includeAutomated+includeSidechains, so an
  // id copied out of `gm ls --include-automated` actually opens.
  it("can resolve a session that `gm ls` hides by default", () => {
    const hidden = [
      record({ sessionId: "cccc4444-4444-4444-4444-444444444444", isAutomated: true }),
      record({ sessionId: "dddd5555-5555-5555-5555-555555555555", isSidechain: true }),
    ];
    const visible = filterRecords(hidden, { includeSidechains: true, includeAutomated: true });

    expect(resolveSession(visible, "cccc").isAutomated).toBe(true);
    expect(resolveSession(visible, "dddd").isSidechain).toBe(true);
  });

  it("reports an unknown id with a fix", () => {
    try {
      resolveSession(records, "zzzz");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionNotFoundError);
      expect((error as SessionNotFoundError).fix).toContain("gm ls");
    }
  });
});

describe("filterRecords", () => {
  const records = [
    record({ sessionId: "1", project: "acme", gitBranch: "main", updatedAt: "2026-07-10T00:00:00.000Z" }),
    record({ sessionId: "2", project: "beta", gitBranch: "fix-auth", updatedAt: "2026-07-09T00:00:00.000Z" }),
    record({ sessionId: "3", project: "acme", gitBranch: "main", updatedAt: "2026-07-08T00:00:00.000Z", isSidechain: true }),
  ];

  it("hides sidechains unless asked", () => {
    expect(filterRecords(records, {}).map((r) => r.sessionId)).toEqual(["1", "2"]);
    expect(filterRecords(records, { includeSidechains: true }).map((r) => r.sessionId)).toEqual(["1", "2", "3"]);
  });

  it("hides automated runs, so the summarizer's own `claude -p` calls never show up", () => {
    const withAutomation = [
      ...records,
      record({ sessionId: "4", isAutomated: true, updatedAt: "2026-07-11T00:00:00.000Z" }),
    ];

    expect(filterRecords(withAutomation, {}).map((r) => r.sessionId)).toEqual(["1", "2"]);
    expect(filterRecords(withAutomation, { includeAutomated: true }).map((r) => r.sessionId)).toEqual([
      "4",
      "1",
      "2",
    ]);
  });

  it("filters by project, branch and recency, newest first", () => {
    expect(filterRecords(records, { project: "acme" }).map((r) => r.sessionId)).toEqual(["1"]);
    expect(filterRecords(records, { branch: "fix" }).map((r) => r.sessionId)).toEqual(["2"]);
    expect(filterRecords(records, { since: "2026-07-09T12:00:00.000Z" }).map((r) => r.sessionId)).toEqual(["1"]);
    expect(filterRecords(records, { limit: 1 }).map((r) => r.sessionId)).toEqual(["1"]);
  });
});

describe("the index", () => {
  it("indexes every harness on the machine", async () => {
    await writeClaudeSession(home, { slug: "-Users-dev-acme", sessionId: CLAUDE_ID, lines: claudeLines(CLAUDE_ID) });
    await writeCodexSession(home, { date: "2026-07-11", sessionId: CODEX_ID, lines: codexLines(CODEX_ID) });

    const result = await refreshIndex();

    expect(result.records).toHaveLength(2);
    expect(result.parsed).toBe(2);
    expect(new Set(result.records.map((r) => r.harness))).toEqual(new Set(["claude-code", "codex"]));
  });

  it("serves unchanged sessions from cache instead of re-parsing", async () => {
    await writeClaudeSession(home, { slug: "-Users-dev-acme", sessionId: CLAUDE_ID, lines: claudeLines(CLAUDE_ID) });

    expect((await refreshIndex()).parsed).toBe(1);

    const second = await refreshIndex();
    expect(second.parsed).toBe(0);
    expect(second.cached).toBe(1);
  });

  it("re-parses a session once its file changes", async () => {
    const path = await writeClaudeSession(home, {
      slug: "-Users-dev-acme",
      sessionId: CLAUDE_ID,
      lines: claudeLines(CLAUDE_ID),
    });
    await refreshIndex();

    // Same size, newer mtime: the cache key must still notice.
    const future = new Date(Date.now() + 60_000);
    await utimes(path, future, future);

    expect((await refreshIndex()).parsed).toBe(1);
  });

  it("survives a corrupt cache file", async () => {
    await writeClaudeSession(home, { slug: "-Users-dev-acme", sessionId: CLAUDE_ID, lines: claudeLines(CLAUDE_ID) });
    await refreshIndex();

    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(cache, "gigamanage"), { recursive: true });
    await writeFile(join(cache, "gigamanage", "index.json"), "{ not json", "utf8");

    const result = await refreshIndex();
    expect(result.records).toHaveLength(1);
  });
});

describe("distillation", () => {
  it("sends the model the session's arc, and never trusts the recorded title", () => {
    const prompt = buildPrompt(distill(record()));

    expect(prompt).toContain("and ended over there");
    expect(prompt).toContain("the last thing the agent said");
    // The stale title is included, but explicitly labelled as untrustworthy.
    expect(prompt).toContain("may be stale");
    expect(prompt).toContain("where the work ACTUALLY LANDED");
  });

  it("anchors the prompt with the original ask when the tail has lost it", () => {
    const prompt = buildPrompt(
      distill(
        record({
          arcPrompts: ["the original ask", "a middle turn"],
          recentUserPrompts: ["a recent turn", "the very last turn"],
        }),
      ),
    );

    expect(prompt).toContain("## The original ask");
    expect(prompt).toContain("the original ask");
    expect(prompt).toContain("a middle turn");
  });

  it("does not repeat turns the tail already carries", () => {
    // A short session: the sampler and the tail window hold the same turns.
    // Showing both would make the model read duplication as emphasis.
    // Title is overridden so it can't coincidentally collide with the turns
    // being deduped — the title line is always shown, regardless of dedup.
    const same = ["started here", "and ended over there"];
    const prompt = buildPrompt(
      distill(record({ title: "an unrelated recorded title", arcPrompts: same, recentUserPrompts: same })),
    );

    expect(prompt).not.toContain("## The original ask");
    expect(prompt).not.toContain("## How the work moved");
    expect(prompt.match(/started here/g)).toHaveLength(1);
  });

  it("hashes the distilled input so the cache key tracks the session's content", () => {
    const a = distill(record());
    const b = distill(record());
    const c = distill(record({ lastAssistantText: "something new happened" }));

    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });

  it("caps the file list so a huge refactor cannot dominate the prompt", () => {
    const many = Array.from({ length: 100 }, (_, i) => `src/file-${i}.ts`);
    expect(distill(record({ filesTouched: many })).filesTouched).toHaveLength(25);
  });
});

describe("summary parsing", () => {
  it("extracts JSON even when the model fences or prefaces it", () => {
    const fenced = '```json\n{"headline":"h","landed":"l","open":"o","nextStep":"n"}\n```';
    expect(parseSummaryFields(fenced, "test").headline).toBe("h");

    const prefaced = 'Sure! Here you go:\n{"headline":"h2","landed":"","open":"","nextStep":""}';
    expect(parseSummaryFields(prefaced, "test").headline).toBe("h2");
  });

  it("rejects a reply with no JSON, or no headline", () => {
    expect(() => parseSummaryFields("I could not do that", "test")).toThrow(/no JSON object/);
    expect(() => parseSummaryFields('{"landed":"l"}', "test")).toThrow(/no `headline`/);
  });

  it("reads the overview", () => {
    const raw = '{"headline":"h","overview":"the whole story","landed":"l","open":"o","nextStep":"n"}';
    expect(parseSummaryFields(raw, "test").overview).toBe("the whole story");
  });

  it("reads the summary drilldown", () => {
    const raw = '{"headline":"h","overview":"o","summary":"a paragraph or two of detail","landed":"l","open":"o","nextStep":"n"}';
    expect(parseSummaryFields(raw, "test").summary).toBe("a paragraph or two of detail");
  });

  it("survives a reply that omits the overview", () => {
    // headline is the only field a row cannot render without. A provider that
    // flubs one card field should not nuke an otherwise-useful summary — and
    // summaries written before `overview` existed simply lack the key.
    const fields = parseSummaryFields('{"headline":"h","landed":"l"}', "test");
    expect(fields.overview).toBe("");
    expect(fields.headline).toBe("h");
  });
});

/** A stand-in for the model. No test in this suite ever calls a real one. */
class FakeProvider implements SummaryProvider {
  readonly name = "fake";
  calls = 0;
  constructor(
    private readonly fields: SummaryFields = { headline: "h", overview: "ov", summary: "s", landed: "l", open: "o", nextStep: "n" },
  ) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async generate(_input: SummaryInput): Promise<SummaryFields> {
    this.calls += 1;
    return this.fields;
  }
}

describe("summaries", () => {
  it("writes a summary and reads it back", async () => {
    const provider = new FakeProvider();
    const target = record();

    const result = await summarizeBatch([target], provider);
    expect(result.generated).toBe(1);

    const summary = await readSummary(target);
    expect(summary?.headline).toBe("h");
    expect(summary?.provider).toBe("fake");
  });

  it("skips a session whose cached summary is still current", async () => {
    const provider = new FakeProvider();
    const target = record();

    await summarizeBatch([target], provider);
    const second = await summarizeBatch([target], provider);

    expect(second.generated).toBe(0);
    expect(second.skipped).toBe(1);
    expect(provider.calls).toBe(1);
  });

  it("regenerates once the session has moved on", async () => {
    const provider = new FakeProvider();
    const before = record();
    await summarizeBatch([before], provider);

    const after = record({ lastAssistantText: "new work happened since" });
    const summary = await readSummary(after);

    expect(isStale(summary, after)).toBe(true);

    const result = await summarizeBatch([after], provider);
    expect(result.generated).toBe(1);
  });

  it("collects failures instead of aborting the batch", async () => {
    const flaky: SummaryProvider = {
      name: "flaky",
      isAvailable: async () => true,
      generate: vi
        .fn<(input: SummaryInput) => Promise<SummaryFields>>()
        .mockRejectedValueOnce(new Error("model exploded"))
        .mockResolvedValue({ headline: "ok", overview: "", summary: "", landed: "", open: "", nextStep: "" }),
    };

    const result = await summarizeBatch([record({ sessionId: "a" }), record({ sessionId: "b" })], flaky);

    expect(result.failed).toHaveLength(1);
    expect(result.generated).toBe(1);
  });
});

describe("searching for awkward queries", () => {
  // A bare positional pattern starting with "-" is parsed by ripgrep as an option.
  it("finds a query that begins with a dash instead of erroring", async () => {
    const path = await writeClaudeSession(home, {
      slug: "-Users-dev-acme",
      sessionId: CLAUDE_ID,
      lines: [
        {
          type: "user",
          sessionId: CLAUDE_ID,
          cwd: "/Users/dev/acme",
          timestamp: "2026-07-10T10:00:00.000Z",
          message: { role: "user", content: "pass --fixed-strings to it" },
        },
      ],
    });
    const records = await loadRecords({});
    const target = records.find((r) => r.filePath === path)!;

    const hits = await searchSessions({ records: [target], query: "--fixed-strings" });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.matchCount).toBeGreaterThan(0);
  });
});

describe("search argv batching", () => {
  // Passing every session path to ripgrep at once blows ARG_MAX once a user has
  // a few thousand sessions — exactly the user this tool is built for.
  it("splits paths into batches that fit inside argv", () => {
    const paths = Array.from({ length: 500 }, (_, i) => `/Users/dev/.claude/projects/p/${"x".repeat(60)}-${i}.jsonl`);
    const batches = batchPaths(paths, 1000);

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const bytes = batch.reduce((n, p) => n + Buffer.byteLength(p) + 1, 0);
      expect(bytes).toBeLessThanOrEqual(1000);
    }
    // Every path must still be searched — batching may not drop any.
    expect(batches.flat()).toEqual(paths);
  });

  it("never drops a path that is itself larger than the cap", () => {
    const huge = "/".padEnd(5000, "x");
    expect(batchPaths([huge], 100).flat()).toEqual([huge]);
  });

  it("returns nothing for no paths", () => {
    expect(batchPaths([], 1000)).toEqual([]);
  });
});

describe("search snippets", () => {
  it("shows a window around the match, not the whole JSONL line", () => {
    const line = `{"type":"user","message":{"content":"${"x".repeat(200)} needle ${"y".repeat(200)}"}}`;
    const snippet = snippetFrom(line, "needle");

    expect(snippet).toContain("needle");
    expect(snippet!.length).toBeLessThanOrEqual(90);
  });
});

describe("the CLI version", () => {
  // v0.1.1 shipped reporting "0.1.0" because the version was hardcoded in
  // main.ts. The CLI must report what package.json actually says.
  it("matches package.json rather than a hardcoded string", async () => {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const source = await readFile(new URL("../src/cli/main.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/\.version\(["']\d+\.\d+\.\d+["']\)/);
    expect(source).toContain(".version(version)");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("wrapText", () => {
  it("wraps on word boundaries", () => {
    expect(wrapText("the quick brown fox jumps", 10)).toEqual(["the quick", "brown fox", "jumps"]);
  });

  it("hard-splits a word too long to fit, rather than overflowing", () => {
    // Overflowing the terminal is the bug this exists to prevent.
    expect(wrapText("/a/very/long/unbreakable/path", 10)).toEqual([
      "/a/very/lo",
      "ng/unbreak",
      "able/path",
    ]);
  });

  it("returns the whole string when width is infinite (piped output)", () => {
    const long = "a ".repeat(200).trim();
    expect(wrapText(long, Number.POSITIVE_INFINITY)).toEqual([long]);
  });

  it("always returns at least one line", () => {
    expect(wrapText("", 10)).toEqual([""]);
    expect(wrapText("   ", 10)).toEqual([""]);
  });

  it("collapses newlines so a multi-line summary cannot break the layout", () => {
    expect(wrapText("one\n\ntwo", 20)).toEqual(["one two"]);
  });
});

describe("gm ls row wrapping", () => {
  const view = {
    record: record({
      sessionId: "abcd1234-0000-0000-0000-000000000000",
      project: "webshop",
      gitBranch: "fix-auth",
    }),
    summary: {
      harness: "claude-code",
      sessionId: "abcd1234-0000-0000-0000-000000000000",
      sourceHash: "h",
      generatedAt: "2026-07-14T00:00:00.000Z",
      provider: "fake",
      headline:
        "Owner-scoping check now passes for admin traces, but the RLS policy for shared orgs still rejects replayed events and test_admin_shared is red",
      overview: "",
      landed: "",
      open: "",
      nextStep: "",
    },
  };
  const now = new Date("2026-07-14T01:00:00.000Z");
  const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

  it("shows the whole description instead of truncating it", () => {
    const lines = formatRowLines(view, now, 100);
    const text = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join(" ");

    expect(lines.length).toBeGreaterThan(1);
    expect(text).toContain("test_admin_shared is red"); // the tail used to be cut off
  });

  it("never emits a line wider than the terminal", () => {
    for (const width of [60, 80, 100, 120, 200]) {
      for (const line of formatRowLines(view, now, width)) {
        expect(visible(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("stays on one line, in full, when piped", () => {
    const lines = formatRowLines(view, now, Number.POSITIVE_INFINITY);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("test_admin_shared is red");
  });

  it("keeps the picker's row on exactly one line", () => {
    // fzf maps lines back to session ids; a wrapped row would break selection.
    expect(formatRow(view, now)).not.toContain("\n");
  });
});

/** A summary to render. `record()` above supplies the session it belongs to. */
function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    harness: "claude-code",
    sessionId: "aaaa1111-0000-0000-0000-000000000000",
    sourceHash: "abc123",
    generatedAt: "2026-07-01T00:00:00.000Z",
    provider: "test",
    headline: "migrating retries to the new queue",
    overview: "Started as a flaky-retry bug, became a queue migration.",
    summary: "What began as a flaky-retry investigation turned into moving retries onto the queue backend; the timestamp assertion was deferred.",
    landed: "Ported the retry logic to the queue consumer.",
    open: "The timestamp check was never written.",
    nextStep: "Write the timestamp assertion in webhook.test.ts",
    ...overrides,
  };
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("the detail card", () => {
  const plain = (view: SessionView) => stripAnsi(formatCard(view, new Date("2026-07-01T00:00:00.000Z")));

  it("widens from headline to overview to summary, then the latest work", () => {
    const card = plain({ record: record(), summary: summary() });

    expect(card).toContain("HEADLINE");
    expect(card).toContain("migrating retries to the new queue");
    expect(card).toContain("OVERVIEW");
    expect(card).toContain("Started as a flaky-retry bug, became a queue migration.");
    expect(card).toContain("SUMMARY");
    expect(card).toContain("RECENT WORK");
    expect(card).toContain("Ported the retry logic to the queue consumer.");
    expect(card).toContain("STILL OPEN");
    expect(card).toContain("NEXT STEP");
    // Widening zoom, then the latest work: headline → overview → summary → recent.
    expect(card.indexOf("HEADLINE")).toBeLessThan(card.indexOf("OVERVIEW"));
    expect(card.indexOf("OVERVIEW")).toBeLessThan(card.indexOf("SUMMARY"));
    expect(card.indexOf("SUMMARY")).toBeLessThan(card.indexOf("RECENT WORK"));
  });

  it("always shows the headline, and omits an empty overview", () => {
    const card = plain({ record: record(), summary: summary({ overview: "" }) });

    expect(card).toContain("HEADLINE");
    expect(card).toContain("migrating retries to the new queue");
    expect(card).not.toContain("OVERVIEW");
  });

  it("renders a summary written before `overview`/`summary` existed", () => {
    // The real on-disk legacy shape: readSummary() JSON.parses without
    // re-validating, so the keys are absent and the fields are `undefined` —
    // not "". The card must survive that, not just an empty string.
    const legacy = summary();
    delete (legacy as Partial<SessionSummary>).overview;
    delete (legacy as Partial<SessionSummary>).summary;

    const card = plain({ record: record(), summary: legacy });

    expect(card).toContain("HEADLINE");
    expect(card).toContain("migrating retries to the new queue");
    expect(card).not.toContain("OVERVIEW");
    expect(card).not.toContain("SUMMARY");
  });

  it("never prints the headline as if it were the latest work", () => {
    // The headline says what the work IS. Under a RECENT WORK heading that is
    // a lie, so the section is omitted instead.
    const card = plain({ record: record(), summary: summary({ landed: "" }) });

    expect(card).not.toContain("RECENT WORK");
  });

  it("omits the sections a summary left empty", () => {
    const card = plain({ record: record(), summary: summary({ open: "", nextStep: "" }) });

    expect(card).not.toContain("STILL OPEN");
    expect(card).not.toContain("NEXT STEP");
  });

  it("tells you how to summarize a session that has none", () => {
    const card = plain({ record: record(), summary: null });

    expect(card).toContain("No summary yet.");
    expect(card).toContain("gm summarize aaaa1111");
    expect(card).toContain("TITLE (recorded at session start)");
  });
});

describe("the fzf picker", () => {
  const view = (id: string, headline: string) => ({
    record: record({ sessionId: id, project: "webshop" }),
    summary: {
      harness: "claude-code",
      sessionId: id,
      sourceHash: "h",
      generatedAt: "2026-07-14T00:00:00.000Z",
      provider: "fake",
      headline,
      overview: "",
      landed: "",
      open: "",
      nextStep: "",
    },
  });
  const long = "Owner-scoping now passes for admin traces but the RLS policy for shared orgs still rejects replays";

  it("wraps rows into multi-line records when fzf supports it", () => {
    const records = buildFzfRecords([view("aaaa1111-x", long)], true, 50);

    // NUL separates sessions; newlines are now *inside* one session's record.
    expect(records).toContain("\n");
    expect(records.split("\0")).toHaveLength(1);
    // The id stays field 1 so fzf can hand it to --preview and back to us.
    expect(records.startsWith("aaaa1111-x\t")).toBe(true);
  });

  it("keeps one line per session on an fzf too old for multi-line items", () => {
    // Otherwise one session would render as several bogus selectable entries.
    const records = buildFzfRecords([view("aaaa1111-x", long)], false, 50);

    expect(records).not.toContain("\n");
  });

  it("separates sessions with NUL, so a wrapped row is still one selection", () => {
    const records = buildFzfRecords([view("aaaa1111-x", long), view("bbbb2222-y", long)], true, 50);

    expect(records.split("\0")).toHaveLength(2);
  });

  it("knows which fzf versions can display multi-line items", () => {
    expect(supportsMultiline([0, 74, 0])).toBe(true); // multi-line landed in 0.46
    expect(supportsMultiline([0, 46, 0])).toBe(true);
    expect(supportsMultiline([0, 45, 9])).toBe(false);
    expect(supportsMultiline(null)).toBe(false);
  });

  it("sizes the list column to the space left by the preview pane", () => {
    expect(listWidth(200)).toBeGreaterThan(listWidth(100));
    expect(listWidth(40)).toBeGreaterThanOrEqual(32); // never collapses to nothing
  });

  it("marks rows the worker is writing right now, so ctrl-r visibly did something", () => {
    // Without this the picker can kick off a pass with no sign it did.
    const bare = (id: string) => ({ record: record({ sessionId: id, project: "webshop" }), summary: null });
    const records = buildFzfRecords(
      [bare("aaaa1111-x"), bare("bbbb2222-y")],
      false,
      80,
      new Date("2026-07-14T00:00:00.000Z"),
      new Set(["aaaa1111-x"]),
    );
    const [first = "", second = ""] = records.split("\0");

    expect(first).toContain("◐"); // in flight
    expect(second).toContain("○"); // queued, nothing running
  });
});

describe("shell quoting", () => {
  it("leaves a safe path alone", () => {
    expect(shellQuote("/Users/dev/webshop")).toBe("/Users/dev/webshop");
  });

  it("quotes a path with a space, so it cannot split into two arguments", () => {
    expect(shellQuote("/Users/dev/my repo")).toBe("'/Users/dev/my repo'");
  });

  it("escapes an embedded single quote", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("the summary cache key", () => {
  it("covers the prompt version, so tightening the prompt regenerates old summaries", () => {
    // Without this, a prompt edit is invisible: every session already on disk
    // keeps its old summary until its transcript happens to change, which for
    // a finished session is never.
    const input = distill(record());
    expect(typeof PROMPT_VERSION).toBe("number");
    expect(input.promptVersion).toBe(PROMPT_VERSION);

    const { hash: _ignored, ...hashed } = input;
    expect(input.hash).toBe(hash(JSON.stringify(hashed)));
    expect(input.hash).not.toBe(hash(JSON.stringify({ ...hashed, promptVersion: 999 })));
  });

  it("still changes when the session changes", () => {
    expect(distill(record({ lastAssistantText: "one" })).hash).not.toBe(
      distill(record({ lastAssistantText: "two" })).hash,
    );
  });
});

describe("the summary prompt", () => {
  it("asks for a headline that fits the row it has to live in", () => {
    // The row truncates at 72 chars. Asking for 80 invites an overflow that
    // renders as a cut-off sentence.
    const prompt = buildPrompt(distill(record()));

    expect(prompt).toContain("60 chars");
    expect(prompt).not.toContain("80 chars");
  });

  it("asks for the three widening tiers: headline, overview, summary", () => {
    const prompt = buildPrompt(distill(record()));

    expect(prompt).toContain('"headline"');
    expect(prompt).toContain('"overview"');
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain("widening zoom");
  });
});

describe("the picker's reload command", () => {
  it("reproduces the filters the picker opened with", () => {
    // A refresh that quietly widens or narrows the list is worse than no
    // refresh: you would not know it happened.
    const args = pickerReloadArgs({ project: "webshop", branch: "main", since: "3d", limit: "50" }, 44);

    expect(args).toEqual([
      "__picker-rows", "--width", "44", "-p", "webshop", "-b", "main", "-s", "3d", "-n", "50",
    ]);
  });

  it("passes the boolean filters through as flags", () => {
    const args = pickerReloadArgs({ includeSidechains: true, includeAutomated: true }, 44);

    expect(args).toContain("--include-sidechains");
    expect(args).toContain("--include-automated");
  });

  it("omits what was not asked for", () => {
    expect(pickerReloadArgs({}, 44)).toEqual(["__picker-rows", "--width", "44"]);
  });

  it("quotes a project name with a space, so the fzf binding survives it", () => {
    const command = pickerReloadArgs({ project: "my repo" }, 44).map(shellQuote).join(" ");

    expect(command).toContain("'my repo'");
  });

  it("round-trips through toFilters unchanged", () => {
    // Freeze the clock: `toFilters` turns `since: "3d"` into a timestamp relative
    // to now, so two calls that straddle a tick would differ by a second.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T00:00:00.000Z"));
    try {
      // The real invariant: reload must filter identically to open.
      const options = { project: "webshop", since: "3d", limit: "50", includeAutomated: true };
      const args = pickerReloadArgs(options, 44);
      const parsed = {
        project: args[args.indexOf("-p") + 1],
        since: args[args.indexOf("-s") + 1],
        limit: args[args.indexOf("-n") + 1],
        includeAutomated: args.includes("--include-automated"),
      };

      expect(toFilters(parsed, 50)).toEqual(toFilters(options, 50));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the picker's fzf arguments", () => {
  const preview = "node gm show {1} --no-color";
  /** The browse half of the spec. Ask is `tests/ask-fallbacks.test.ts`'s subject. */
  const spec = (overrides: Partial<FzfSpec> = {}): FzfSpec => ({
    multiline: true,
    preview,
    reloadCmd: "node gm __picker-rows --width 44",
    askCmd: null,
    tier: "none",
    ...overrides,
  });

  it("binds ctrl-r to reload, and says so in the header", () => {
    const args = fzfArgs(spec());

    expect(args).toContain("--bind=ctrl-r:reload(node gm __picker-rows --width 44)");
    expect(args[args.indexOf("--header") + 1]).toContain("ctrl-r: refresh");
  });

  it("explains the row markers in the header, under the keys", () => {
    const args = fzfArgs(spec());
    const [keys = "", key = ""] = (args[args.indexOf("--header") + 1] ?? "").split("\n");

    expect(keys).toContain("enter: resume");
    expect(key).toBe(formatMarkerKey());
  });

  it("offers no ctrl-r when there is no reload command, and does not advertise it", () => {
    // A key that does nothing is worse than a key that isn't there.
    const args = fzfArgs(spec({ reloadCmd: null }));

    expect(args.some((a) => a.startsWith("--bind=ctrl-r"))).toBe(false);
    expect(args[args.indexOf("--header") + 1]).not.toContain("ctrl-r");
  });

  it("keeps --read0 and --print0 together, so a refreshed multi-line row is still one selection", () => {
    const args = fzfArgs(spec({ reloadCmd: "node gm __picker-rows" }));

    expect(args).toContain("--read0");
    expect(args).toContain("--print0");
  });

  it("drops the multi-line flags on an fzf too old for them", () => {
    const args = fzfArgs(spec({ multiline: false, reloadCmd: "node gm __picker-rows" }));

    expect(args).not.toContain("--read0");
    expect(args).toContain("--bind=ctrl-r:reload(node gm __picker-rows)"); // refresh still works
  });
});

describe("the picker's icon key", () => {
  /**
   * The key without its colours.
   *
   * The count assertion below is about digits, and an SGR code is made of them
   * (`\e[33m`). Asserting on the raw string would pass only because vitest's
   * stdout is not a TTY — i.e. it would be testing "no colour", not "no counts",
   * and would start failing the day these tests ran on a terminal.
   */
  const plain = (text: string): string => text.replaceAll(/\u001b\[[0-9;]*m/g, "");

  it("explains every marker, so no glyph on a row is unexplained", () => {
    const key = formatMarkerKey();

    for (const [icon, meaning] of [
      ["⚠", "ended mid-task"],
      ["◐", "summarizing now"],
      ["○", "no summary yet"],
    ]) {
      expect(key).toContain(icon);
      expect(key).toContain(meaning);
    }
  });

  it("carries no counts", () => {
    // fzf sets --header once, at spawn: ctrl-r replaces the list and leaves the
    // header alone. A count here would be frozen at open and wrong after the
    // first refresh — which is exactly when it changes.
    expect(plain(formatMarkerKey())).not.toMatch(/\d/);
  });

  it("stays on one line, so it costs the list a single row", () => {
    expect(formatMarkerKey()).not.toContain("\n");
  });

  it("says the same thing as the ls legend, minus the counts", () => {
    // Two renderings of one fact; they must not drift.
    const views = [
      { record: record({ sessionId: "a", endedMidTask: true }), summary: null },
      { record: record({ sessionId: "b" }), summary: null },
    ];
    const legend = formatLegend(views, new Set(["b"]));

    for (const meaning of ["ended mid-task", "summarizing now", "no summary yet"]) {
      expect(legend).toContain(meaning);
      expect(formatMarkerKey()).toContain(meaning);
    }
  });
});

describe("the picker's opt-out", () => {
  it("forwards --no-auto-summarize to the reload child, so ctrl-r honors it", () => {
    // ctrl-r FORCES a pass — it bypasses the cooldown — so a dropped flag here
    // would spend tokens the user explicitly declined, with the one thing that
    // might have throttled it removed.
    expect(pickerReloadArgs({}, 44, false)).toContain("--no-auto-summarize");
  });

  it("says nothing when auto-summarize is on, which is the default", () => {
    expect(pickerReloadArgs({}, 44, true)).not.toContain("--no-auto-summarize");
    expect(pickerReloadArgs({}, 44)).not.toContain("--no-auto-summarize");
  });

  it("reads the flag off the ROOT program, where it is declared", () => {
    // `--no-auto-summarize` is a root option. Commander does not copy root
    // options into a subcommand's own opts(), so reading `options.autoSummarize`
    // in the action yields undefined forever and the flag silently does nothing.
    // A fresh program per parse: commander keeps option state on the instance,
    // so reusing one would carry the first parse's flag into the second.
    const run = (argv: string[]): boolean => {
      let seen = true;
      const program = new Command();
      program.name("gm").exitOverride().option("--no-auto-summarize", "x");
      program
        .command("probe")
        .exitOverride()
        .action((_o, command: Command) => {
          seen = autoSummarizeRequested(command);
        });
      program.parse(["node", "gm", ...argv]);
      return seen;
    };

    expect(run(["--no-auto-summarize", "probe"])).toBe(false);
    expect(run(["probe"])).toBe(true);
    // The reload child receives it AFTER the subcommand name; commander is fine
    // with that, and pickerReloadArgs relies on it.
    expect(run(["probe", "--no-auto-summarize"])).toBe(false);
  });
});

describe("resolving what the picker selected", () => {
  const view = (id: string) => ({ record: record({ sessionId: id }), summary: null });

  it("resolves a session that ctrl-r added after the picker opened", async () => {
    // THE refresh use case: you leave the picker open while an agent works,
    // press ctrl-r, and pick the session it just created. The id fzf hands back
    // is not in the list we opened with, so a lookup against that stale set
    // returns null and the picker says "Nothing selected" — refusing to resume
    // the very session you refreshed in order to find.
    const opened = [view("old-1")];
    const fresh = view("brand-new");

    const picked = await resolvePicked("brand-new", opened, async (id) =>
      id === "brand-new" ? fresh : null,
    );

    expect(picked?.record.sessionId).toBe("brand-new");
  });

  it("uses the already-loaded view when the id was there all along", async () => {
    let called = false;
    const opened = [view("old-1")];

    const picked = await resolvePicked("old-1", opened, async () => {
      called = true;
      return null;
    });

    expect(picked?.record.sessionId).toBe("old-1");
    expect(called).toBe(false); // no reason to re-read the store
  });

  it("gives up rather than guessing when the id resolves to nothing", async () => {
    expect(await resolvePicked("ghost", [view("old-1")], async () => null)).toBeNull();
    expect(await resolvePicked("ghost", [view("old-1")])).toBeNull();
  });
});

describe("re-invoking this build for fzf", () => {
  it("forwards execArgv, so ctrl-r and the preview work under `npm run dev`", () => {
    // Under tsx the entry is a .ts file and execArgv carries the loader flags.
    // Drop them and the command is `node src/cli/main.ts`, which Node 20 cannot
    // run — the preview pane and ctrl-r die in development but work from dist/.
    // Node 22 strips types natively and hides this, so pin it.
    const command = selfCommand(
      "/usr/bin/node",
      ["--import", "/repo/node_modules/tsx/dist/loader.mjs"],
      "/repo/src/cli/main.ts",
    );

    expect(command).toBe(
      "/usr/bin/node --import /repo/node_modules/tsx/dist/loader.mjs /repo/src/cli/main.ts",
    );
  });

  it("stays plain when there are no runner flags, as from dist/", () => {
    expect(selfCommand("/usr/bin/node", [], "/repo/dist/cli/main.js")).toBe(
      "/usr/bin/node /repo/dist/cli/main.js",
    );
  });

  it("quotes a path with a space", () => {
    expect(selfCommand("/usr/bin/node", [], "/my repo/dist/cli/main.js")).toBe(
      "/usr/bin/node '/my repo/dist/cli/main.js'",
    );
  });

  it("gives up when there is no entry point rather than guessing", () => {
    expect(selfCommand("/usr/bin/node", [], undefined)).toBeNull();
  });
});
