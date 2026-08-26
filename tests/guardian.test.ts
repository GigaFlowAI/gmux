import { describe, expect, it } from "vitest";
import { Guardian } from "../src/services/guardian.js";
import type { HostPressure, PaneEntry } from "../src/core/gmux-types.js";

const host = (used: number): HostPressure => ({ usedRatio: used, unattributed: 0, ts: 0 });
const agent = (paneId: string, rss: number): PaneEntry => ({
  identity: { paneId, windowId: "@1", active: false, harness: "claude-code", sessionId: "s", cwd: "/x/webshop-build", command: "node", pid: 1 },
  state: "working", semantics: null, resources: { perPaneRss: rss, ts: 0 }, lastActivityTs: 0, ts: 0, gone: false,
});
const shell = (paneId: string): PaneEntry => ({ ...agent(paneId, 0), identity: { ...agent(paneId, 0).identity, harness: null, sessionId: null } });

describe("Guardian", () => {
  it("broadcasts over threshold with an agent target, naming the culprit", () => {
    const g = new Guardian({ policy: "auto", threshold: 0.9, cooldownSeconds: 300 });
    const d = g.decide(host(0.92), [agent("%1", 4_200_000_000)], 0);
    expect(d.action).toBe("broadcast");
    expect(d.culpritPaneId).toBe("%1");
    expect(d.message).toContain("webshop-build");
  });
  it("stays quiet during cooldown", () => {
    const g = new Guardian({ policy: "auto", threshold: 0.9, cooldownSeconds: 300 });
    g.decide(host(0.95), [agent("%1", 1)], 0);
    const again = g.decide(host(0.95), [agent("%1", 1)], 60_000); // 60s < 300s
    expect(again.action).toBe("none");
  });
  it("re-fires after pressure drops and re-crosses", () => {
    const g = new Guardian({ policy: "auto", threshold: 0.9, cooldownSeconds: 300 });
    g.decide(host(0.95), [agent("%1", 1)], 0);
    g.decide(host(0.5), [agent("%1", 1)], 10_000);   // dropped below
    const refire = g.decide(host(0.95), [agent("%1", 1)], 20_000);
    expect(refire.action).toBe("broadcast");
  });
  it("logs only when there are no agent panes", () => {
    const g = new Guardian({ policy: "auto", threshold: 0.9, cooldownSeconds: 300 });
    const d = g.decide(host(0.95), [shell("%1")], 0);
    expect(d.action).toBe("log-only");
  });
  it("notify policy never broadcasts", () => {
    const g = new Guardian({ policy: "notify", threshold: 0.9, cooldownSeconds: 300 });
    expect(g.decide(host(0.95), [agent("%1", 1)], 0).action).toBe("notify");
  });
  it("off policy only logs", () => {
    const g = new Guardian({ policy: "off", threshold: 0.9, cooldownSeconds: 300 });
    expect(g.decide(host(0.95), [agent("%1", 1)], 0).action).toBe("log-only");
  });
});
