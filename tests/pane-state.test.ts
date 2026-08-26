import { describe, expect, it } from "vitest";
import { classifyState } from "../src/core/pane-state.js";
import type { Observation } from "../src/core/workspace-types.js";

const base: Observation = { paneId: "%1", kind: "agent", ts: 1000, tailLines: [], lastActivityTs: 1000 };

describe("classifyState", () => {
  it("error beats everything", () => {
    expect(classifyState({ ...base, sawError: true, awaitingInput: true }, 1000)).toBe("error");
  });
  it("ended → done", () => {
    expect(classifyState({ ...base, ended: true }, 1000)).toBe("done");
  });
  it("awaiting input → waiting", () => {
    expect(classifyState({ ...base, awaitingInput: true }, 1000)).toBe("waiting");
  });
  it("recent activity → working", () => {
    expect(classifyState({ ...base, lastActivityTs: 100_000 }, 105_000)).toBe("working");
  });
  it("quiet for a while → idle", () => {
    expect(classifyState({ ...base, lastActivityTs: 100_000 }, 200_000)).toBe("idle");
  });
});
