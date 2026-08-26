import { describe, expect, it } from "vitest";

import type { SessionRecord, SessionSummary } from "../src/core/types.js";
import { liveIntelHandlers } from "../src/services/mux-client.js";
import {
  CONTEXT_PACK_BUDGET_MS,
  CONTEXT_PACK_MAX_BYTES,
  buildContextPack,
  chooseSubmitBody,
  packFromParams,
  serializePack,
  serializeSeedAndHeadline,
  turnsFromRecord,
  withPackDeadline,
} from "../src/services/context-pack.js";

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    harness: "claude-code",
    sessionId: "sess-1",
    filePath: "/tmp/a.jsonl",
    cwd: "/repo",
    project: "repo",
    gitBranch: "main",
    startedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    messageCount: 4,
    userPromptCount: 2,
    title: "stale title",
    lastUserPrompt: "last prompt",
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

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    harness: "claude-code",
    sessionId: "sess-1",
    sourceHash: "abc",
    generatedAt: "2026-07-01T00:00:00.000Z",
    provider: "fake",
    headline: "wiring checkout",
    overview: "The session landed the checkout flow and tests are going green.",
    landed: "checkout wired",
    open: "one flaky test",
    nextStep: "fix the flake",
    ...overrides,
  };
}

describe("context pack", () => {
  it("does not import readJsonl", async () => {
    const src = await import("node:fs/promises").then(async () =>
      (await import("node:fs/promises")).readFile(
        new URL("../src/services/context-pack.ts", import.meta.url),
        "utf8",
      ),
    );
    expect(src).not.toMatch(/readJsonl/);
  });

  it("caps at 4096 and keeps the seed", () => {
    const pack = buildContextPack({
      seed: "x".repeat(600),
      parentHeadline: "h",
      parentOverview: "o".repeat(3000),
      recentTurns: [
        { role: "human", text: "a".repeat(2000) },
        { role: "assistant", text: "b".repeat(2000) },
      ],
      parentPaneId: "p_1",
    });
    expect(Buffer.byteLength(serializePack(pack), "utf8")).toBeLessThanOrEqual(4096);
    expect(pack.seed.length).toBeGreaterThanOrEqual(512);
  });

  it("cites the 12-prompt ring and uses the last 3 humans plus an 800-char assistant clip", () => {
    const prompts = Array.from({ length: 12 }, (_, i) => `turn-${i + 1}`);
    const turns = turnsFromRecord(
      record({
        recentUserPrompts: prompts,
        lastAssistantText: "z".repeat(1500),
      }),
    );
    expect(turns.filter((t) => t.role === "human").map((t) => t.text)).toEqual([
      "turn-10",
      "turn-11",
      "turn-12",
    ]);
    const assistant = turns.filter((t) => t.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.text).toHaveLength(800);
  });

  it("does not run humanText() on Codex prompts", () => {
    const raw = "<system-reminder>be careful</system-reminder>\nfix the webhook";
    const turns = turnsFromRecord(
      record({
        harness: "codex",
        recentUserPrompts: [raw],
      }),
    );
    expect(turns[0]).toEqual({ role: "human", text: raw });
  });

  it("drops oldest human, then clips assistant, then overview, then headline", () => {
    const pack = buildContextPack({
      parentPaneId: "p_1",
      seed: "task seed here",
      parentHeadline: "keep-or-drop-headline",
      parentOverview: "O".repeat(4500),
      recentTurns: [
        { role: "human", text: "oldest-human-" + "a".repeat(1800) },
        { role: "human", text: "newest-human" },
        { role: "assistant", text: "b".repeat(800) },
      ],
    });
    const text = serializePack(pack);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(CONTEXT_PACK_MAX_BYTES);
    expect(text).toContain("task seed here");
    expect(text).not.toContain("oldest-human-");
    expect(pack.recentTurns.some((t) => t.role === "assistant" && t.text.length === 800)).toBe(false);
    expect(pack.parentOverview).toBeNull();
  });

  it("never clips the seed below 512 bytes", () => {
    const pack = buildContextPack({
      parentPaneId: "p_1",
      seed: "s".repeat(600),
      parentHeadline: "h".repeat(2000),
      parentOverview: "o".repeat(2000),
      recentTurns: [{ role: "human", text: "u".repeat(2000) }],
    });
    expect(Buffer.byteLength(pack.seed, "utf8")).toBeGreaterThanOrEqual(512);
    expect(pack.seed.startsWith("s")).toBe(true);
  });

  it("clips a huge seed to 2048 and skips the rest", () => {
    const pack = buildContextPack({
      parentPaneId: "p_1",
      seed: "S".repeat(5000),
      parentHeadline: "headline-must-drop",
      parentOverview: "overview-must-drop",
      recentTurns: [
        { role: "human", text: "human-must-drop" },
        { role: "assistant", text: "assistant-must-drop" },
      ],
    });
    expect(Buffer.byteLength(pack.seed, "utf8")).toBe(2048);
    expect(pack.parentHeadline).toBeNull();
    expect(pack.parentOverview).toBeNull();
    expect(pack.recentTurns).toEqual([]);
    const text = serializePack(pack);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(CONTEXT_PACK_MAX_BYTES);
    expect(text).not.toContain("headline-must-drop");
    expect(text).not.toContain("human-must-drop");
  });

  it("gathers cached summary headline/overview without reading jsonl", async () => {
    const rec = record({
      harness: "codex",
      sessionId: "codex-1",
      recentUserPrompts: ["one", "two", "three", "four"],
      lastAssistantText: "assistant tail",
    });
    const pack = await packFromParams(
      {
        parentPaneId: "p_1",
        seed: "also fix the webhook",
        harness: "codex",
        sessionId: "codex-1",
        semantics: { label: "stale label", card: "stale card" },
      },
      {
        records: async () => [rec],
        readSummary: async () => summary({ harness: "codex", sessionId: "codex-1" }),
      },
    );
    expect(pack.parentHeadline).toBe("wiring checkout");
    expect(pack.parentOverview).toContain("checkout flow");
    expect(pack.recentTurns.filter((t) => t.role === "human").map((t) => t.text)).toEqual([
      "two",
      "three",
      "four",
    ]);
    expect(pack.recentTurns.some((t) => t.role === "assistant" && t.text === "assistant tail")).toBe(
      true,
    );
  });

  it("falls back to semantics.label when no cached summary exists", async () => {
    const pack = await packFromParams(
      {
        parentPaneId: "p_2",
        seed: "seed",
        semantics: { label: "from semantics", card: "card from semantics" },
      },
      { records: async () => [], readSummary: async () => null },
    );
    expect(pack.parentHeadline).toBe("from semantics");
    expect(pack.parentOverview).toBe("card from semantics");
    expect(pack.recentTurns).toEqual([]);
  });

  it("drops the pack when the parent was not cleared", () => {
    expect(
      chooseSubmitBody({
        parentCleared: false,
        packText: "FULL PACK",
        seed: "also fix the webhook",
        headline: "wiring checkout",
      }),
    ).toBeNull();
  });

  it("submits seed plus headline when the pack misses the budget", () => {
    const body = chooseSubmitBody({
      parentCleared: true,
      packText: null,
      seed: "also fix the webhook",
      headline: "wiring checkout",
    });
    expect(body).toBe(serializeSeedAndHeadline("also fix the webhook", "wiring checkout"));
    expect(body).toContain("also fix the webhook");
    expect(body).toContain("wiring checkout");
    expect(body).not.toContain("Overview:");
  });

  it("does not use a late pack after the 500 ms budget", async () => {
    expect(CONTEXT_PACK_BUDGET_MS).toBe(500);
    let settledLate = false;
    const late = new Promise<string>((resolve) => {
      setTimeout(() => {
        settledLate = true;
        resolve("LATE PACK");
      }, 800);
    });
    const result = await withPackDeadline(late, () => "SEED+HEADLINE");
    expect(result).toBe("SEED+HEADLINE");
    await late;
    expect(settledLate).toBe(true);
    expect(result).toBe("SEED+HEADLINE");
  });

  it("live context.pack returns serialized text from cached sources", async () => {
    const rec = record({ recentUserPrompts: ["alpha", "beta", "gamma"] });
    const handlers = liveIntelHandlers({
      packLookup: {
        records: async () => [rec],
        readSummary: async () => summary(),
      },
    });
    const result = (await handlers["context.pack"]!({
      parentPaneId: "p_1",
      seed: "peel seed",
      harness: rec.harness,
      sessionId: rec.sessionId,
    })) as { text: string; seed: string; parentHeadline: string | null };
    expect(result.seed).toBe("peel seed");
    expect(result.parentHeadline).toBe("wiring checkout");
    expect(result.text).toContain("peel seed");
    expect(result.text).toContain("gamma");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(CONTEXT_PACK_MAX_BYTES);
  });
});
