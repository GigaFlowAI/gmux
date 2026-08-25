import { describe, expect, it } from "vitest";
import { isMuxControlCommand } from "../src/cli/commands/spawn.js";

describe("mux commands skip postAction auto-summarize", () => {
  it("skips spawn, snapshot, attach, and panes subcommands", () => {
    expect(isMuxControlCommand("spawn")).toBe(true);
    expect(isMuxControlCommand("snapshot")).toBe(true);
    expect(isMuxControlCommand("attach")).toBe(true);
    expect(isMuxControlCommand("ls", "panes")).toBe(true);
    expect(isMuxControlCommand("ls")).toBe(false);
    expect(isMuxControlCommand("show")).toBe(false);
  });
});
