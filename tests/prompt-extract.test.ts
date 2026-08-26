import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { extract } from "../src/services/prompt-extract.js";
import type { GridSnapshot } from "../src/core/mux-types.js";

function load(p: string): GridSnapshot {
  return JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")) as GridSnapshot;
}

describe("prompt extract", () => {
  // CAPTURE: replace with a live dump
  it("claude boxed composer is high confidence and strips placeholder", () => {
    const r = extract(load("./fixtures/grids/claude-code/boxed.json"));
    expect(r.extractor).toBe("claude-code");
    expect(r.confidence).toBe("high");
    expect(r.text).toBe("also fix the webhook");
    expect(r.clearKeys.includes("\x15")).toBe(true);
  });

  // CAPTURE: replace with a live dump
  it("codex prefers the caret line", () => {
    const r = extract(load("./fixtures/grids/codex/caret.json"));
    expect(r.extractor).toBe("codex");
    expect(r.text).toContain("webhook");
  });

  // CAPTURE: replace with a live dump
  it("shell strips a simple PS1", () => {
    const r = extract(load("./fixtures/grids/shell/ps1.json"));
    expect(r.extractor).toBe("shell");
    expect(r.confidence).toBe("low");
    expect(r.text).toBe("echo hi");
  });

  it("unknown TUI returns empty", () => {
    const r = extract({
      paneId: "p_x", cols: 4, rows: 1,
      lines: [{ text: "????", intensity: [1, 1, 1, 1] }],
      alternateScreen: true, foregroundCommand: "vim",
    });
    expect(r.text).toBe("");
    expect(r.extractor).toBe("empty");
  });
});
