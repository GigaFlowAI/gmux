import { describe, expect, it } from "vitest";

import {
  PANE_FORMAT,
  parsePaneLine,
  parsePanes,
  parseTmuxVersion,
  supportsDisplayPopup,
} from "../src/services/tmux.js";

describe("parsePaneLine", () => {
  it("parses a well-formed tab-separated line", () => {
    const pane = parsePaneLine("%3\t0\t0\t80\t24\t/home/me/repo\tclaude\t4242");
    expect(pane).toEqual({
      paneId: "%3",
      left: 0,
      top: 0,
      width: 80,
      height: 24,
      cwd: "/home/me/repo",
      command: "claude",
      pid: 4242,
    });
  });

  it("rejects lines with non-numeric geometry", () => {
    expect(parsePaneLine("%3\tx\t0\t80\t24\t/repo\tclaude\t42")).toBeNull();
  });

  it("rejects lines with too few fields", () => {
    expect(parsePaneLine("%3\t0\t0")).toBeNull();
  });
});

describe("parsePanes", () => {
  it("skips blank lines and keeps valid ones", () => {
    const out = "%1\t0\t0\t40\t20\t/a\tzsh\t11\n\n%2\t40\t0\t40\t20\t/b\tcodex\t22\n";
    expect(parsePanes(out).map((p) => p.paneId)).toEqual(["%1", "%2"]);
  });

  it("uses tab delimiters so paths with spaces survive", () => {
    const [pane] = parsePanes("%1\t0\t0\t40\t20\t/my repo/app\tnode\t33");
    expect(pane!.cwd).toBe("/my repo/app");
  });
});

describe("PANE_FORMAT", () => {
  it("requests tab-separated fields in the parsed order", () => {
    expect(PANE_FORMAT).toBe(
      "#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_pid}",
    );
  });
});

describe("version gate", () => {
  it("parses tmux -V output", () => {
    expect(parseTmuxVersion("tmux 3.3a\n")).toEqual({ raw: "tmux 3.3a", major: 3, minor: 3 });
  });
  it("gates display-popup at 3.2", () => {
    expect(supportsDisplayPopup(parseTmuxVersion("tmux 3.2"))).toBe(true);
    expect(supportsDisplayPopup(parseTmuxVersion("tmux 3.1c"))).toBe(false);
    expect(supportsDisplayPopup(parseTmuxVersion("tmux 4.0"))).toBe(true);
    expect(supportsDisplayPopup(null)).toBe(false);
  });
});
