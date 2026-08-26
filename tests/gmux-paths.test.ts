import { describe, expect, it, beforeEach } from "vitest";
import { gmuxSocketPath, gmuxSnapshotPath, paneLogPath, workViewPath, workReportPath } from "../src/core/paths.js";
import { tmpdir } from "node:os";

describe("gmux paths", () => {
  beforeEach(() => { process.env.XDG_CACHE_HOME = "/tmp/xdgcache"; });
  it("socket, snapshot and pane logs live under the gmux cache", () => {
    expect(gmuxSocketPath()).toBe("/tmp/xdgcache/gmux/gmux/daemon.sock");
    expect(gmuxSnapshotPath()).toBe("/tmp/xdgcache/gmux/gmux/snapshot.json");
    expect(paneLogPath("%3")).toBe("/tmp/xdgcache/gmux/gmux/panes/pane-3.log");
  });
});

describe("work report paths", () => {
  it("work-view cache path is under the cache dir, keyed by harness+session, as JSON", () => {
    const p = workViewPath("claude-code", "abc123");
    expect(p).toContain("work-views");
    expect(p.endsWith("claude-code-abc123.json")).toBe(true);
  });
  it("report path is a single stable html file in the temp dir", () => {
    expect(workReportPath()).toBe(`${tmpdir()}/gmux-work-report.html`);
  });
});
