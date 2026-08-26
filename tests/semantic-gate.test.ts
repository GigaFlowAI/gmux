import { describe, expect, it } from "vitest";
import { SemanticGate } from "../src/services/semantic-gate.js";
import type { Observation } from "../src/core/workspace-types.js";

const obs = (lines: string[], ts: number): Observation => ({ paneId: "%1", kind: "terminal", ts, tailLines: lines, lastActivityTs: ts });

describe("SemanticGate", () => {
  it("fires on first observation", () => {
    const g = new SemanticGate();
    expect(g.shouldSummarize("%1", obs(["hello"], 0), 0)).toBe(true);
  });
  it("does not re-fire within the debounce window for tiny changes", () => {
    const g = new SemanticGate({ debounceMs: 4000 });
    const first = obs(["compiling module a"], 0);
    expect(g.shouldSummarize("%1", first, 0)).toBe(true);
    g.noteQueued("%1", first, 0);
    expect(g.shouldSummarize("%1", obs(["compiling module a."], 1000), 1000)).toBe(false);
  });
  it("fires again after a large change past the debounce window", () => {
    const g = new SemanticGate({ debounceMs: 4000, distance: 8 });
    const first = obs(["compiling"], 0);
    g.shouldSummarize("%1", first, 0); g.noteQueued("%1", first, 0);
    const big = obs(["running the full end to end test suite now against staging"], 5000);
    expect(g.shouldSummarize("%1", big, 5000)).toBe(true);
  });
});
