import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWorkViewPrompt,
  buildWorkViews,
  extractFragment,
  generateWorkView,
  isStale,
  readWorkView,
  workViewSourceHash,
  writeWorkView,
  type WorkView,
  type WorkViewProvider,
} from "../src/services/work-view.js";
import { distill } from "../src/services/distill.js";
import type { SessionRecord } from "../src/core/types.js";

const record: SessionRecord = {
  harness: "claude-code", sessionId: "s1", filePath: "/x.jsonl", cwd: "/w/shop",
  project: "shop", gitBranch: "main", startedAt: null, updatedAt: "2026-08-18T00:00:00Z",
  messageCount: 4, userPromptCount: 2, title: "start", lastUserPrompt: "ship it",
  recentUserPrompts: ["ship it"], arcPrompts: ["add auth", "ship it"], filesTouched: ["a.ts"],
  prLinks: [], lastAssistantText: "opened PR #7", lastToolFailure: null,
  endedMidTask: false, isSidechain: false, isAutomated: false,
};

describe("extractFragment", () => {
  it("strips a ```html fence", () => {
    expect(extractFragment("```html\n<svg><rect/></svg>\n```")).toBe("<svg><rect/></svg>");
  });
  it("accepts a bare fragment", () => {
    expect(extractFragment("  <div>hi</div>  ")).toBe("<div>hi</div>");
  });
  it("rejects text with no HTML tag", () => {
    expect(() => extractFragment("sorry, I cannot")).toThrow();
  });
});

describe("buildWorkViewPrompt", () => {
  it("asks for a self-contained HTML fragment and includes session evidence", () => {
    const p = buildWorkViewPrompt(distill(record));
    expect(p.toLowerCase()).toContain("html");
    expect(p).toContain("opened PR #7"); // final message flows in
    expect(p.toLowerCase()).toContain("no <script"); // forbids scripts / external refs
  });
});

describe("cache staleness", () => {
  it("is stale with no view, fresh when the source hash matches", () => {
    expect(isStale(null, record)).toBe(true);
    const view: WorkView = {
      harness: record.harness, sessionId: record.sessionId,
      sourceHash: workViewSourceHash(record), generatedAt: "t", provider: "p", html: "<i/>",
    };
    expect(isStale(view, record)).toBe(false);
    expect(isStale({ ...view, sourceHash: "different" }, record)).toBe(true);
  });
});

describe("read/write round-trip", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "gm-wv-")); process.env.XDG_CACHE_HOME = dir; });
  afterEach(() => { delete process.env.XDG_CACHE_HOME; });
  it("writes then reads the same view", async () => {
    const view: WorkView = {
      harness: record.harness, sessionId: record.sessionId,
      sourceHash: workViewSourceHash(record), generatedAt: "t", provider: "p", html: "<b>x</b>",
    };
    await writeWorkView(view);
    expect(await readWorkView(record)).toEqual(view);
  });
  it("returns null when the cache file is absent", async () => {
    expect(await readWorkView({ ...record, sessionId: "missing" })).toBeNull();
  });
});

class StubProvider implements WorkViewProvider {
  readonly name = "stub";
  constructor(private readonly reply: (sessionId: string) => string) {}
  async isAvailable() { return true; }
  async render(prompt: string) {
    return this.reply(prompt);
  }
}

describe("generateWorkView", () => {
  it("produces a cached-shaped view from the provider reply", async () => {
    const provider = new StubProvider(() => "<svg><rect/></svg>");
    const view = await generateWorkView(record, provider, () => new Date("2026-08-18T12:00:00Z"));
    expect(view.html).toBe("<svg><rect/></svg>");
    expect(view.provider).toBe("stub");
    expect(view.sourceHash).toBe(workViewSourceHash(record));
    expect(view.generatedAt).toBe("2026-08-18T12:00:00.000Z");
  });
});

describe("buildWorkViews", () => {
  beforeEach(async () => { const d = await mkdtemp(join(tmpdir(), "gm-wvb-")); process.env.XDG_CACHE_HOME = d; });
  afterEach(() => { delete process.env.XDG_CACHE_HOME; });

  const r2: SessionRecord = { ...record, sessionId: "s2" };

  it("generates a view per record and caches it", async () => {
    let calls = 0;
    const provider = new StubProvider(() => { calls++; return "<div>ok</div>"; });
    const first = await buildWorkViews([record, r2], provider);
    expect(first.views.size).toBe(2);
    expect(first.failed).toEqual([]);
    expect(calls).toBe(2);
    // second run is served entirely from cache — provider not called again
    const second = await buildWorkViews([record, r2], provider);
    expect(second.views.size).toBe(2);
    expect(calls).toBe(2);
  });

  it("collects a failing session without aborting the batch", async () => {
    const provider = new StubProvider((p) => (p.includes("s2") ? "no html here" : "<div>ok</div>"));
    // r2's distilled prompt won't contain "s2"; force a real failure via non-HTML for BOTH is wrong —
    // instead make the provider throw for r2 by sessionId is not visible in prompt, so reply non-HTML for all
    const bad = new StubProvider(() => "sorry");
    const res = await buildWorkViews([record, r2], bad);
    expect(res.views.size).toBe(0);
    expect(res.failed.map((f) => f.sessionId).sort()).toEqual(["s1", "s2"]);
    expect(res.failed[0]!.reason).toContain("no HTML");
  });
});
