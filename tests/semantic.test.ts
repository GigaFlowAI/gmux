import { describe, expect, it, vi } from "vitest";
import { WorkspaceModel } from "../src/services/workspace.js";
import { SemanticGate } from "../src/services/semantic-gate.js";
import { SemanticWorker, type LabelProvider } from "../src/services/semantic.js";
import type { PaneEntry, Observation } from "../src/core/workspace-types.js";

const entry: PaneEntry = {
  identity: { paneId: "%1", windowId: "@1", active: true, harness: "claude-code", sessionId: "s", cwd: "/x/webshop", command: "node", pid: 1 },
  state: "working", semantics: null, resources: null, lastActivityTs: 0, ts: 0, gone: false,
};
const obs: Observation = { paneId: "%1", kind: "agent", ts: 0, tailLines: ["writing the checkout tests"], lastActivityTs: 0 };

describe("SemanticWorker", () => {
  it("writes a label into the model", async () => {
    const model = new WorkspaceModel();
    model.upsertIdentity(entry.identity);
    const provider: LabelProvider = { label: async () => ({ label: "writing checkout tests", card: "full card" }) };
    const w = new SemanticWorker(model, provider, new SemanticGate({ debounceMs: 0 }));
    w.enqueue(entry, obs, 0);
    await w.drain();
    expect(model.snapshot().panes[0]!.semantics!.label).toBe("writing checkout tests");
  });

  it("a hanging provider never blocks drain of other panes (decoupling invariant)", async () => {
    const model = new WorkspaceModel();
    model.upsertIdentity(entry.identity);
    model.upsertIdentity({ ...entry.identity, paneId: "%2" });
    let resolveHang: (() => void) | undefined;
    const provider: LabelProvider = {
      label: vi.fn(async ({ paneId }) => {
        if (paneId === "%1") { await new Promise<void>((r) => (resolveHang = r)); }
        return { label: "done", card: "c" };
      }),
    };
    const w = new SemanticWorker(model, provider, new SemanticGate({ debounceMs: 0 }), 2);
    w.enqueue(entry, obs, 0);
    w.enqueue({ ...entry, identity: { ...entry.identity, paneId: "%2" } }, { ...obs, paneId: "%2" }, 0);
    // %2 completes even while %1 hangs
    await vi.waitFor(() => expect(model.snapshot().panes.find((p) => p.identity.paneId === "%2")!.semantics?.label).toBe("done"));
    resolveHang?.();
  });
});
