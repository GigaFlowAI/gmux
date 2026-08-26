import { describe, expect, it, vi } from "vitest";
import { WorkspaceModel } from "../src/services/workspace.js";
import type { PaneIdentity } from "../src/core/workspace-types.js";

const ident: PaneIdentity = {
  paneId: "%1", windowId: "@1", active: true, harness: null, sessionId: null, cwd: "/x", command: "zsh", pid: 10,
};

describe("WorkspaceModel", () => {
  it("bumps version and emits on state change", () => {
    const m = new WorkspaceModel();
    const onChange = vi.fn();
    m.on("change", onChange);
    m.upsertIdentity(ident);
    m.applyState("%1", "working", 1000, 1000);
    expect(m.version).toBeGreaterThan(0);
    expect(onChange).toHaveBeenCalled();
    expect(m.snapshot().panes[0]!.state).toBe("working");
  });
  it("does not emit when state is unchanged", () => {
    const m = new WorkspaceModel();
    m.upsertIdentity(ident);
    m.applyState("%1", "working", 1000, 1000);
    const v = m.version;
    const onChange = vi.fn();
    m.on("change", onChange);
    m.applyState("%1", "working", 1000, 2000); // same state, same activity
    expect(m.version).toBe(v);
    expect(onChange).not.toHaveBeenCalled();
  });
  it("evicts gone panes", () => {
    const m = new WorkspaceModel();
    m.upsertIdentity(ident);
    m.markGone("%1");
    m.evictGone();
    expect(m.snapshot().panes).toHaveLength(0);
  });
  it("emits on activity-only change (state same, lastActivityTs different)", () => {
    const m = new WorkspaceModel();
    m.upsertIdentity(ident);
    m.applyState("%1", "working", 1000, 1000);
    const v = m.version;
    const onChange = vi.fn();
    m.on("change", onChange);
    m.applyState("%1", "working", 2000, 2000); // same state, different activity
    expect(m.version).toBeGreaterThan(v);
    expect(onChange).toHaveBeenCalled();
  });
  it("applySemantics writes semantics and bumps/emits", () => {
    const m = new WorkspaceModel();
    m.upsertIdentity(ident);
    const v = m.version;
    const onChange = vi.fn();
    m.on("change", onChange);
    const sem = { label: "test", card: null, fingerprint: "abc", updatedAt: 1000, stale: false };
    m.applySemantics("%1", sem);
    expect(m.version).toBeGreaterThan(v);
    expect(onChange).toHaveBeenCalled();
    expect(m.snapshot().panes[0]!.semantics).toEqual(sem);
  });
  it("applySemantics ignores an older updatedAt (monotonicity guard)", () => {
    const m = new WorkspaceModel();
    m.upsertIdentity(ident);
    const newer = { label: "newer", card: null, fingerprint: "new", updatedAt: 2000, stale: false };
    m.applySemantics("%1", newer);
    const v = m.version;
    const onChange = vi.fn();
    m.on("change", onChange);
    const older = { label: "older", card: null, fingerprint: "old", updatedAt: 1000, stale: false };
    m.applySemantics("%1", older); // out-of-order stale result
    expect(m.version).toBe(v);
    expect(onChange).not.toHaveBeenCalled();
    expect(m.snapshot().panes[0]!.semantics).toEqual(newer);
  });
  it("applyResources writes resources and bumps/emits", () => {
    const m = new WorkspaceModel();
    m.upsertIdentity(ident);
    const v = m.version;
    const onChange = vi.fn();
    m.on("change", onChange);
    const res = { perPaneRss: 42000, ts: 1000 };
    m.applyResources("%1", res);
    expect(m.version).toBeGreaterThan(v);
    expect(onChange).toHaveBeenCalled();
    expect(m.snapshot().panes[0]!.resources).toEqual(res);
  });
  it("setHostPressure sets it and bumps/emits; snapshot reflects it", () => {
    const m = new WorkspaceModel();
    const v = m.version;
    const onChange = vi.fn();
    m.on("change", onChange);
    const pressure = { usedRatio: 0.8, unattributed: 1000, ts: 1000 };
    m.setHostPressure(pressure);
    expect(m.version).toBeGreaterThan(v);
    expect(onChange).toHaveBeenCalled();
    expect(m.snapshot().hostPressure).toEqual(pressure);
  });
  it("logGuardian caps at exactly 50 entries", () => {
    const m = new WorkspaceModel();
    for (let i = 0; i < 60; i++) {
      m.logGuardian({ ts: i, pressure: 0.8, culpritPaneId: null, culpritLabel: "unknown", action: "log-only", message: `entry ${i}` });
    }
    const snap = m.snapshot();
    expect(snap.guardianLog).toHaveLength(50);
    // Verify that retained entries are the most recent 50 (entries 10-59)
    expect(snap.guardianLog[0]!.message).toBe("entry 10");
    expect(snap.guardianLog[49]!.message).toBe("entry 59");
  });
  it("snapshot().guardianLog is a copy; mutating it does not affect the model", () => {
    const m = new WorkspaceModel();
    m.logGuardian({ ts: 1, pressure: 0.8, culpritPaneId: null, culpritLabel: "unknown", action: "log-only", message: "test" });
    const snap1 = m.snapshot();
    snap1.guardianLog[0]!.message = "mutated";
    const snap2 = m.snapshot();
    expect(snap2.guardianLog[0]!.message).toBe("test");
  });
  it("markGone bumps only once when called twice on the same pane", () => {
    const m = new WorkspaceModel();
    m.upsertIdentity(ident);
    const onChange = vi.fn();
    m.on("change", onChange);
    m.markGone("%1");
    expect(onChange).toHaveBeenCalledTimes(1);
    onChange.mockClear();
    m.markGone("%1");
    expect(onChange).not.toHaveBeenCalled();
  });
  it("snapshot() returns defensive copies; mutating pane state does not affect model", () => {
    const m = new WorkspaceModel();
    m.upsertIdentity(ident);
    m.applyState("%1", "working", 1000, 1000);
    const snap1 = m.snapshot();
    snap1.panes[0]!.state = "idle";
    const snap2 = m.snapshot();
    expect(snap2.panes[0]!.state).toBe("working");
  });
  it("snapshot() returns copy of hostPressure; mutating it does not affect model", () => {
    const m = new WorkspaceModel();
    const pressure = { usedRatio: 0.8, unattributed: 1000, ts: 1000 };
    m.setHostPressure(pressure);
    const snap1 = m.snapshot();
    if (snap1.hostPressure) snap1.hostPressure.usedRatio = 0.2;
    const snap2 = m.snapshot();
    expect(snap2.hostPressure?.usedRatio).toBe(0.8);
  });
  it("updatedAt is computed from non-gone panes only", () => {
    const m = new WorkspaceModel();
    m.upsertIdentity(ident);
    m.applyState("%1", "working", 1000, 1000);
    const snap1 = m.snapshot();
    expect(snap1.updatedAt).toBe(1000);
    m.markGone("%1");
    const snap2 = m.snapshot();
    expect(snap2.updatedAt).toBe(0); // No non-gone panes
  });
});
