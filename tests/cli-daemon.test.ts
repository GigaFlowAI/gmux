import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";
import { WorkspaceModel } from "../src/services/workspace.js";
import { runDaemonLoop } from "../src/cli/commands/daemon.js";

describe("runDaemonLoop", () => {
  it("ticks until aborted", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([{ paneId: "%1", left: 0, top: 0, width: 80, height: 24, cwd: "/x", command: "zsh", pid: 10, windowId: "@1", active: true }]);
    const model = new WorkspaceModel();
    const ac = new AbortController();
    let ticks = 0;
    const done = runDaemonLoop(
      { gateway: gw, model, now: () => 100_000, makeSensor: undefined },
      { tickMs: 1, signal: ac.signal, onTick: () => { if (++ticks >= 3) ac.abort(); } },
    );
    await done;
    expect(ticks).toBeGreaterThanOrEqual(3);
    expect(model.snapshot().panes).toHaveLength(1);
  });

  // Regression for the abort-listener leak: attaching a fresh `{ once: true }`
  // listener inside every iteration's wait only self-removes on the abort
  // path, so on the (far more common) plain-timeout path listeners piled up
  // on the long-lived signal — MaxListenersExceededWarning after ~10 ticks at
  // the default 1.5s tick. Runs well past that threshold and asserts the
  // listener count never exceeds the single listener `runDaemonLoop` attaches
  // once, and that it is removed again once the call resolves.
  it("keeps a single abort listener across many ticks, and cleans it up", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([]);
    const model = new WorkspaceModel();
    const ac = new AbortController();
    let ticks = 0;
    let maxListeners = 0;
    const done = runDaemonLoop(
      { gateway: gw, model, now: () => 0 },
      {
        tickMs: 1,
        signal: ac.signal,
        onTick: () => {
          maxListeners = Math.max(maxListeners, getEventListeners(ac.signal, "abort").length);
          if (++ticks >= 15) ac.abort();
        },
      },
    );
    await done;
    expect(ticks).toBeGreaterThanOrEqual(15);
    expect(maxListeners).toBe(1);
    expect(getEventListeners(ac.signal, "abort").length).toBe(0);
  });
});
