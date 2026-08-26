import { describe, expect, it } from "vitest";
import { WorkspaceModel } from "../src/services/workspace.js";
import { SemanticGate } from "../src/services/semantic-gate.js";
import { SemanticWorker, type LabelProvider } from "../src/services/semantic.js";
import type { PaneEntry, Observation } from "../src/core/workspace-types.js";

const mk = (id: string, active: boolean, state: PaneEntry["state"]): PaneEntry => ({
  identity: { paneId: id, windowId: "@1", active, harness: null, sessionId: null, cwd: "/x", command: "zsh", pid: 1 },
  state, semantics: null, resources: null, lastActivityTs: 0, ts: 0, gone: false,
});
const obs = (id: string): Observation => ({ paneId: id, kind: "terminal", ts: 0, tailLines: [id], lastActivityTs: 0 });

describe("semantic worker prioritization", () => {
  it("labels the active pane before a background one", async () => {
    const model = new WorkspaceModel();
    model.upsertIdentity(mk("%bg", false, "idle").identity);
    model.upsertIdentity(mk("%active", true, "working").identity);
    const order: string[] = [];
    const provider: LabelProvider = { label: async ({ paneId }) => { order.push(paneId); return { label: "x", card: "c" }; } };
    const w = new SemanticWorker(model, provider, new SemanticGate({ debounceMs: 0 }), 1);
    w.enqueue(mk("%bg", false, "idle"), obs("%bg"), 0);
    w.enqueue(mk("%active", true, "working"), obs("%active"), 0);
    await w.drain();
    expect(order[0]).toBe("%active");
  });
});
