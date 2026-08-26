/**
 * The daemon tick loop: registry diff → attach/detach sensors → observe →
 * classify → write state to the model → evict gone panes.
 *
 * No LLM here (Phase 0) — `classifyState` is a pure heuristic over the raw
 * `Observation`. Sensors and the clock are injected so the whole loop can be
 * driven headlessly in tests, without a real tmux server.
 */

import type { Observation, PaneEntry, PaneIdentity } from "../core/workspace-types.js";
import { classifyState } from "../core/pane-state.js";
import type { TmuxGateway } from "./tmux-gateway.js";
import { PaneRegistry } from "./pane-registry.js";
import type { Guardian } from "./guardian.js";
import type { ResourceMonitor } from "./resources.js";
import { makeSensor as defaultMakeSensor, type Sensor } from "./sensors.js";
import type { SemanticWorker } from "./semantic.js";
import type { WorkspaceModel } from "./workspace.js";

export interface DaemonDeps {
  gateway: TmuxGateway;
  model: WorkspaceModel;
  now: () => number;
  makeSensor?: (id: PaneIdentity, gw: TmuxGateway) => Sensor;
  semantic?: SemanticWorker;
  resources?: ResourceMonitor;
  guardian?: Guardian;
  /**
   * Overrides which present panes count as "agent panes" for guardian
   * broadcast targeting. Defaults to panes the registry has resolved to a
   * harness + session (`harness && sessionId`). This override exists only
   * so tests can mark panes as agents without a full link fixture — real
   * callers should leave it unset.
   */
  resolveAgents?: (present: PaneIdentity[]) => string[];
}

export class Daemon {
  private registry: PaneRegistry;
  /** Long-lived per pane: created on appear, torn down on vanish. This is
   * what lets AgentSensor's lazy transcript-file resolution pay off over
   * the pane's whole lifetime instead of retrying from scratch each tick. */
  private sensors = new Map<string, Sensor>();
  private make: (id: PaneIdentity, gw: TmuxGateway) => Sensor;

  constructor(private readonly deps: DaemonDeps) {
    this.registry = new PaneRegistry(deps.gateway);
    this.make = deps.makeSensor ?? defaultMakeSensor;
  }

  async tickOnce(): Promise<void> {
    const now = this.deps.now();
    let diff;
    try {
      diff = await this.registry.diff();
    } catch {
      // tmux hiccup (e.g. listPanes throws): idle this tick, loop survives.
      return;
    }
    const { present, vanished } = diff;

    for (const id of vanished) {
      await this.sensors.get(id)?.teardown().catch(() => {});
      this.sensors.delete(id);
      this.deps.model.markGone(id);
    }

    // Collected here, enqueued after the loop against a single snapshot below
    // — looking each pane's just-applied entry up via `model.snapshot()`
    // *inside* this loop would take an O(n)-sized snapshot on every one of
    // its n iterations.
    const toEnqueue: { paneId: string; obs: Observation }[] = [];

    for (const id of present) {
      this.deps.model.upsertIdentity(id);
      let sensor = this.sensors.get(id.paneId);
      if (!sensor) {
        sensor = this.make(id, this.deps.gateway);
        this.sensors.set(id.paneId, sensor);
      }
      try {
        const obs = await sensor.observe(now);
        this.deps.model.applyState(id.paneId, classifyState(obs, now), obs.lastActivityTs, now);
        if (this.deps.semantic) toEnqueue.push({ paneId: id.paneId, obs });
      } catch {
        // A single sensor failure must never abort the whole tick.
      }
    }

    // Enqueue any collected observations against a snapshot taken exactly
    // once per tick, shared with the guardian's pane list below (when
    // resources are sampled this tick) instead of each taking its own O(n)
    // snapshot.
    const enqueueSemantic = (byId: Map<string, PaneEntry>): void => {
      if (!this.deps.semantic) return;
      for (const { paneId, obs } of toEnqueue) {
        const entry = byId.get(paneId);
        if (entry) this.deps.semantic.enqueue(entry, obs, now); // fire-and-forget, never awaited
      }
    };

    if (this.deps.resources) {
      try {
        const panePids = new Map(present.map((p) => [p.paneId, p.pid]));
        const { perPane, host } = await this.deps.resources.sample(panePids);
        for (const [paneId, res] of perPane) this.deps.model.applyResources(paneId, res);
        this.deps.model.setHostPressure(host);

        // The one `model.snapshot()` call for this tick — taken after
        // resources are applied so it (and the guardian below) sees this
        // tick's resource data, and reused via `byId` for the semantic
        // enqueue above instead of a second full pass.
        const snap = this.deps.model.snapshot();
        const byId = new Map(snap.panes.map((p) => [p.identity.paneId, p]));
        enqueueSemantic(byId);

        if (this.deps.guardian) {
          const agentIds = this.deps.resolveAgents?.(present)
            ?? present.filter((p) => p.harness && p.sessionId).map((p) => p.paneId);
          const agentIdSet = new Set(agentIds);
          // Guardian.decide treats a pane as an agent via identity.harness &&
          // identity.sessionId. `resolveAgents` is a test-only override, so
          // when it's set, patch those fields (decision purposes only, never
          // persisted to the model) so the guardian agrees with the override.
          const panes = snap.panes.map((p) => {
            if (!this.deps.resolveAgents || !agentIdSet.has(p.identity.paneId) || p.identity.harness) return p;
            return { ...p, identity: { ...p.identity, harness: "test-agent", sessionId: p.identity.paneId } };
          });
          const decision = this.deps.guardian.decide(host, panes, now);
          if (decision.action !== "none") {
            if (decision.action === "broadcast") {
              for (const id of agentIds) {
                await this.deps.gateway.send(id, decision.message + "\n").catch(() => {});
              }
            }
            this.deps.model.logGuardian({
              ts: now,
              pressure: host.usedRatio,
              culpritPaneId: decision.culpritPaneId,
              culpritLabel: decision.culpritLabel,
              action: decision.action,
              message: decision.message,
            });
          }
        }
      } catch {
        // Resource sampling / guardian failures must never abort the tick.
      }
    } else if (this.deps.semantic) {
      // No resource sampling this tick, so take the single snapshot here
      // instead — same timing as before this change, minus the redundant
      // per-pane snapshots.
      const snap = this.deps.model.snapshot();
      enqueueSemantic(new Map(snap.panes.map((p) => [p.identity.paneId, p])));
    }

    this.deps.model.evictGone();
  }
}
