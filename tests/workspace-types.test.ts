import { describe, expect, it } from "vitest";
import { PANE_STATES, isPaneState } from "../src/core/workspace-types.js";

describe("gm-types", () => {
  it("enumerates the five pane states", () => {
    expect([...PANE_STATES]).toEqual(["working", "idle", "waiting", "error", "done"]);
  });
  it("isPaneState is a type guard over the enum", () => {
    expect(isPaneState("waiting")).toBe(true);
    expect(isPaneState("bogus")).toBe(false);
  });
});
