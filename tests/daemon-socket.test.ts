// tests/daemon-socket.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "node:net";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { WorkspaceModel } from "../src/services/workspace.js";
import { ModelServer } from "../src/services/daemon-socket.js";

let server: ModelServer | undefined;
afterEach(async () => { await server?.stop(); });

describe("ModelServer", () => {
  it("streams a snapshot on change and writes the snapshot file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-"));
    const sock = join(dir, "d.sock");
    const snap = join(dir, "snap.json");
    const model = new WorkspaceModel();
    server = new ModelServer(model, sock, snap);
    await server.start();

    const got = new Promise<string>((resolve) => {
      const c = connect(sock, () => {
        model.upsertIdentity({ paneId: "%1", windowId: "@1", active: true, harness: null, sessionId: null, cwd: "/x", command: "zsh", pid: 1 });
      });
      let buf = "";
      c.on("data", (d) => {
        buf += d.toString();
        // Two NDJSON lines can arrive: the initial on-connect snapshot (empty
        // panes) and the on-change broadcast (with the pane), possibly
        // coalesced into the same "data" event. Resolve with the first
        // complete line that actually carries pane data.
        for (const l of buf.split("\n")) {
          if (l.length === 0) continue;
          const parsed: { panes: unknown[] } = JSON.parse(l);
          if (parsed.panes.length > 0) { resolve(l); c.end(); return; }
        }
      });
    });
    const line = await got;
    expect(JSON.parse(line.trim()).panes[0].identity.paneId).toBe("%1");
    // snapshot file also written
    expect(JSON.parse(readFileSync(snap, "utf8")).panes[0].identity.paneId).toBe("%1");
  });

  it("survives a burst of synchronous changes without an unhandled rejection, and the snapshot file reflects the final state", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const dir = mkdtempSync(join(tmpdir(), "gm-"));
      const sock = join(dir, "d.sock");
      const snap = join(dir, "snap.json");
      const model = new WorkspaceModel();
      server = new ModelServer(model, sock, snap);
      await server.start();

      const PANE_COUNT = 20;
      for (let i = 0; i < PANE_COUNT; i++) {
        model.upsertIdentity({
          paneId: `%${i}`, windowId: "@1", active: true, harness: null, sessionId: null,
          cwd: "/x", command: "zsh", pid: i,
        });
      }

      // Writes are real fs I/O (libuv threadpool), not just microtasks — poll
      // until the serialized write chain has caught up to the final state.
      const deadline = Date.now() + 2000;
      let written: { panes: unknown[] } = { panes: [] };
      for (;;) {
        try {
          written = JSON.parse(readFileSync(snap, "utf8"));
        } catch {
          // ignore transient read-during-rename
        }
        if (written.panes.length === PANE_COUNT) break;
        if (Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(unhandled).toEqual([]);
      expect(Array.isArray(written.panes)).toBe(true);
      expect(written.panes.length).toBe(PANE_COUNT);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
