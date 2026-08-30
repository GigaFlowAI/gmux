import { describe, expect, it } from "vitest";

import { wrapText } from "../src/core/text.js";
import type { SessionView, TmuxPane } from "../src/core/types.js";
import { cellLines, renderOverlay, type OverlayCell } from "../src/cli/overlay.js";

const NOW = new Date("2026-08-10T00:05:00.000Z");

interface ViewOverrides {
  updatedAt?: string;
  headline?: string;
  overview?: string;
  summary?: string;
  landed?: string;
  open?: string;
  nextStep?: string;
}

function view(over: ViewOverrides = {}): SessionView {
  return {
    record: {
      harness: "claude-code",
      sessionId: "abcdef12",
      filePath: "/f",
      cwd: "/repo",
      project: "webshop",
      gitBranch: null,
      startedAt: null,
      updatedAt: over.updatedAt ?? "2026-08-10T00:00:00.000Z",
      messageCount: 1,
      userPromptCount: 1,
      title: null,
      lastUserPrompt: "do the thing",
      recentUserPrompts: [],
      arcPrompts: [],
      filesTouched: [],
      prLinks: [],
      lastAssistantText: null,
      lastToolFailure: null,
      endedMidTask: false,
      isSidechain: false,
      isAutomated: false,
    },
    summary: {
      harness: "claude-code",
      sessionId: "abcdef12",
      sourceHash: "h",
      generatedAt: "2026-08-10T00:00:00.000Z",
      provider: "claude -p",
      headline: "retry fix landed",
      overview: "Making webhook retries reliable.",
      landed: "retry backoff added",
      open: "timestamp check still red",
      nextStep: "write the timestamp test",
      ...over,
    },
  };
}

function pane(over: Partial<TmuxPane>): TmuxPane {
  return { paneId: "%1", left: 0, top: 0, width: 40, height: 20, cwd: "/repo", command: "claude", pid: 100, ...over };
}

describe("cellLines degradation ladder", () => {
  it("renders a placeholder when there is no agent", () => {
    const lines = cellLines({ pane: pane({}), view: null, refreshing: false }, 40, 20, NOW);
    expect(lines.join("\n")).toContain("no agent here");
  });

  it("title only when the cell is one row", () => {
    const lines = cellLines({ pane: pane({}), view: view(), refreshing: false }, 40, 1, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("webshop");
  });

  it("title + landed at small heights", () => {
    const lines = cellLines({ pane: pane({}), view: view(), refreshing: false }, 40, 3, NOW);
    const text = lines.join("\n");
    expect(text).toContain("webshop");
    expect(text).toContain("retry backoff added");
  });

  it("full card includes every section at full height", () => {
    const cell = { pane: pane({}), view: view({ summary: "A paragraph of detail." }), refreshing: false };
    const text = cellLines(cell, 40, 30, NOW).join("\n");
    expect(text).toContain("HEADLINE");
    expect(text).toContain("OVERVIEW");
    expect(text).toContain("SUMMARY");
    expect(text).toContain("RECENT WORK");
    expect(text).toContain("STILL OPEN");
    expect(text).toContain("NEXT STEP");
  });

  it("shows the mid-task flag", () => {
    const v = view();
    v.record.endedMidTask = true;
    const text = cellLines({ pane: pane({}), view: v, refreshing: false }, 40, 20, NOW).join("\n");
    expect(text).toContain("⚠");
  });

  it("shows when the summary last updated, and 'refreshing…' alongside it while in flight", () => {
    const stale = cellLines({ pane: pane({}), view: view(), refreshing: false }, 40, 20, NOW).join("\n");
    expect(stale).toContain("updated 5m ago");
    // While refreshing, still show how old the summary you're reading is.
    const busy = cellLines({ pane: pane({}), view: view(), refreshing: true }, 40, 20, NOW).join("\n");
    expect(busy).toContain("refreshing…");
    expect(busy).toContain("updated 5m ago");
  });

  it("positions every wrapped line of a section at the pane's content column, not the screen margin (regression)", () => {
    const longOverview =
      "This retry backoff change took several attempts before it actually worked reliably in real production traffic patterns.";
    const cell: OverlayCell = {
      pane: pane({ paneId: "%1", left: 21, top: 0, width: 20, height: 20 }),
      // Empty headline so the OVERVIEW section carries the wrapped body under test.
      view: view({ headline: "", overview: longOverview }),
      refreshing: false,
    };

    // renderOverlay draws a border and insets the card one cell, so content is
    // laid out at width-2 (18) and positioned at column left+2 (23); section()
    // then wraps at that interior width minus its 2-space indent (16).
    const wrappedOverview = wrapText(longOverview, 16);
    expect(wrappedOverview.length).toBeGreaterThanOrEqual(2);

    // Height budget: the interior card must not return more rows than it has.
    const interior = cellLines(cell, 18, 18, NOW);
    expect(interior.length).toBeLessThanOrEqual(18);
    // Every physical line is its own array entry: no embedded newlines.
    for (const line of interior) expect(line).not.toContain("\n");

    const out = renderOverlay([cell], NOW);
    // Content segments land at column 23 (left 21 + border + inset).
    const positioned = out.match(/\x1b\[\d+;23H[^\x1b]*/g) ?? [];
    expect(positioned.length).toBeGreaterThan(wrappedOverview.length);
    // Each wrapped physical line of the OVERALL body gets its own cursor move
    // at the content column (indent() prefixes two spaces).
    for (const wrappedLine of wrappedOverview) {
      expect(out).toContain(`;23H  ${wrappedLine}`);
    }
    // No positioned segment carries an embedded newline.
    for (const seg of positioned) expect(seg).not.toContain("\n");
    // Nothing from this pane leaked to the screen's left margin (column 1).
    expect(out).not.toMatch(/;1H/);
  });
});

describe("renderOverlay positioning", () => {
  it("draws each card inside a bordered box, content inset one cell", () => {
    const cells: OverlayCell[] = [
      { pane: pane({ paneId: "%1", left: 0, top: 0, width: 20, height: 10 }), view: view(), refreshing: false },
      { pane: pane({ paneId: "%2", left: 21, top: 0, width: 20, height: 10 }), view: null, refreshing: false },
    ];
    const out = renderOverlay(cells, NOW);
    expect(out.startsWith("\x1b[2J\x1b[H")).toBe(true);
    // First card's border top-left corner sits at row 1, col 1.
    expect(out).toContain("\x1b[1;1H┌");
    // Second card's border top-left corner at col 22 (left 21 + 1).
    expect(out).toContain("\x1b[1;22H┌");
    // Vertical edges are drawn between panes.
    expect(out).toContain("│");
    // Content is inset one cell inside the border (row 2, col 2 for the first).
    expect(out).toContain("\x1b[2;2H");
  });

  it("skips the border for a pane too small to frame", () => {
    const cell: OverlayCell = {
      pane: pane({ paneId: "%1", left: 0, top: 0, width: 2, height: 2 }),
      view: view(),
      refreshing: false,
    };
    const out = renderOverlay([cell], NOW);
    expect(out).not.toContain("┌");
    // Content painted at the pane origin instead.
    expect(out).toContain("\x1b[1;1H");
  });

  it("sanitizes control bytes in untrusted card text before positioning (regression)", () => {
    // Summary text is untrusted (model output, or a hostile transcript). A stray
    // ESC/CSI byte here must never reach the terminal — it would move the cursor
    // out of the pane's rectangle and desync the whole overlay.
    const hostile = "\x1b[31mred\x1b[0m and \x1b[2J";
    const cell: OverlayCell = {
      pane: pane({ paneId: "%1", left: 0, top: 0, width: 40, height: 20 }),
      view: view({ landed: hostile }),
      refreshing: false,
    };

    const out = renderOverlay([cell], NOW);

    // Strip the legitimate cursor-position prefixes renderOverlay itself emits...
    const withoutPositioning = out.replace(/\x1b\[\d+;\d+H/g, "");
    // ...and the leading full-screen clear/home sequence.
    const withoutClear = withoutPositioning.replace(/\x1b\[2J\x1b\[H/g, "");
    // Nothing else may carry an ESC byte.
    expect(withoutClear).not.toContain("\x1b");

    // The visible text may retain the plain letters, but never as a live escape.
    expect(out).not.toContain("\x1b[31m");
    // The only "\x1b[2J" is the legitimate leading screen clear — none embedded later.
    expect(out.split("\x1b[2J")).toHaveLength(2);
  });
});

describe("cellLines question mode (per-pane broadcast answers)", () => {
  it("appends 'asking…' beneath the summary, without swallowing it", () => {
    const cell = { pane: pane({}), view: view(), refreshing: false, asking: true, answer: null };
    const text = cellLines(cell, 40, 30, NOW).join("\n");
    expect(text).toContain("asking…");
    expect(text).toContain("RECENT WORK"); // the summary stays
  });

  it("appends this pane's own answer under the summary", () => {
    const cell = {
      pane: pane({}),
      view: view(),
      refreshing: false,
      asking: false,
      answer: "Blocked on the August 9 worker logs.",
    };
    const text = cellLines(cell, 40, 30, NOW).join("\n");
    expect(text).toContain("Blocked on the August 9 worker logs.");
    expect(text).toContain("HEADLINE"); // the summary is still there above it
    // The answer comes after the summary, not before it.
    expect(text.indexOf("HEADLINE")).toBeLessThan(text.indexOf("Blocked on the August 9"));
  });
});
