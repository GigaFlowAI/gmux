/**
 * Intel sidecar tick loop against `MuxGateway` (not tmux).
 *
 * Mux owns layout (tab/cwd/pid). This process patches `state` / `semantics` /
 * `resources` / `guardianLog` and resolved agent identity (`harness` /
 * `sessionId`) by `paneId` so mux `guardian.broadcast` can target agents.
 * `session.snapshot` is mux-assembled — there is no second snapshot socket on
 * `daemon.sock`.
 */

import type { Observation, PaneEntry, PaneIdentity } from "../core/gmux-types.js";
import { classifyState } from "../core/pane-state.js";
import type { Guardian } from "./guardian.js";
import type { MuxClient } from "./mux-client.js";
import type { MuxGateway } from "./mux-gateway.js";
import { PaneRegistry } from "./pane-registry.js";
import type { ResourceMonitor } from "./resources.js";
import { makeSensor as defaultMakeSensor, type Sensor } from "./sensors.js";
import type { SemanticWorker } from "./semantic.js";
import type { WorkspaceModel } from "./workspace.js";

export interface SidecarDaemonDeps {
  gateway: MuxGateway;
  model: WorkspaceModel;
  now: () => number;
  makeSensor?: (id: PaneIdentity, gw: MuxGateway) => Sensor;
  semantic?: SemanticWorker;
  resources?: ResourceMonitor;
  guardian?: Guardian;
  resolveAgents?: (present: PaneIdentity[]) => string[];
  /** When set (the live MuxClient), patches are pushed to mux by paneId. */
  report?: MuxClient["reportSemantics"];
  /** Intel → mux `guardian.broadcast` (mux filters to harness && sessionId). Never `pane.send_keys`. */
  broadcast?: (message: string) => Promise<void>;
}

export class SidecarDaemon {
  private registry: PaneRegistry;
  private sensors = new Map<string, Sensor>();
  private make: (id: PaneIdentity, gw: MuxGateway) => Sensor;

  constructor(private readonly deps: SidecarDaemonDeps) {
    this.registry = new PaneRegistry(deps.gateway);
    this.make = deps.makeSensor ?? defaultMakeSensor;
  }

  async tickOnce(): Promise<void> {
    const now = this.deps.now();
    let diff;
    try {
      diff = await this.registry.diff();
    } catch {
      return;
    }
    const { present, vanished } = diff;

    for (const id of vanished) {
      await this.sensors.get(id)?.teardown().catch(() => {});
      this.sensors.delete(id);
      this.deps.model.markGone(id);
    }

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
        /* a single sensor failure must never abort the whole tick */
      }
    }

    const enqueueSemantic = (byId: Map<string, PaneEntry>): void => {
      if (!this.deps.semantic) return;
      for (const { paneId, obs } of toEnqueue) {
        const entry = byId.get(paneId);
        if (entry) this.deps.semantic.enqueue(entry, obs, now);
      }
    };

    if (this.deps.resources) {
      try {
        const panePids = new Map(present.map((p) => [p.paneId, p.pid]));
        const { perPane, host } = await this.deps.resources.sample(panePids);
        for (const [paneId, res] of perPane) this.deps.model.applyResources(paneId, res);
        this.deps.model.setHostPressure(host);

        const snap = this.deps.model.snapshot();
        const byId = new Map(snap.panes.map((p) => [p.identity.paneId, p]));
        enqueueSemantic(byId);

        if (this.deps.guardian) {
          const agentIds = this.deps.resolveAgents?.(present)
            ?? present.filter((p) => p.harness && p.sessionId).map((p) => p.paneId);
          const agentIdSet = new Set(agentIds);
          const panes = snap.panes.map((p) => {
            if (!this.deps.resolveAgents || !agentIdSet.has(p.identity.paneId) || p.identity.harness) return p;
            return { ...p, identity: { ...p.identity, harness: "test-agent", sessionId: p.identity.paneId } };
          });
          await this.reportIdentity(panes);
          const decision = this.deps.guardian.decide(host, panes, now);
          if (decision.action !== "none") {
            if (decision.action === "broadcast") {
              await this.deps.broadcast?.(decision.message + "\n").catch(() => {});
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
        /* resource / guardian failures must never abort the tick */
      }
    } else if (this.deps.semantic) {
      const snap = this.deps.model.snapshot();
      enqueueSemantic(new Map(snap.panes.map((p) => [p.identity.paneId, p])));
    }

    this.deps.model.evictGone();
    await this.pushPatches();
  }

  private async reportIdentity(panes: PaneEntry[]): Promise<void> {
    const report = this.deps.report;
    if (!report) return;
    for (const pane of panes) {
      await report({
        paneId: pane.identity.paneId,
        harness: pane.identity.harness,
        sessionId: pane.identity.sessionId,
      }).catch(() => {});
    }
  }

  private async pushPatches(): Promise<void> {
    const report = this.deps.report;
    if (!report) return;
    const snap = this.deps.model.snapshot();
    for (const pane of snap.panes) {
      await report({
        paneId: pane.identity.paneId,
        state: pane.state,
        semantics: pane.semantics,
        resources: pane.resources,
        harness: pane.identity.harness,
        sessionId: pane.identity.sessionId,
      }).catch(() => {});
    }
    const first = snap.panes[0];
    if (first) {
      await report({
        paneId: first.identity.paneId,
        guardianLog: snap.guardianLog,
        hostPressure: snap.hostPressure,
      }).catch(() => {});
    }
  }
}
