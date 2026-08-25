import { describe, expect, it } from "vitest";
import { formatPaneId, parsePaneId } from "../src/core/mux-types.js";

describe("pane ids", () => {
  it("round-trips 16-byte ULID as p_ + Crockford", () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
    const id = formatPaneId(bytes);
    expect(id.startsWith("p_")).toBe(true);
    expect(parsePaneId(id)).toEqual(bytes);
  });
  it("rejects a tmux %N id", () => {
    expect(() => parsePaneId("%3")).toThrow(/p_/);
  });
});
