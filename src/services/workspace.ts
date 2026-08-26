import { EventEmitter } from "node:events";
import type {
  GuardianLogEntry, HostPressure, PaneEntry, PaneIdentity, PaneResources, PaneSemantics, PaneState, WorkspaceSnapshot,
} from "../core/workspace-types.js";

export class WorkspaceModel extends EventEmitter {
  private entries = new Map<string, PaneEntry>();
  private hostPressure: HostPressure | null = null;
  private guardianLog: GuardianLogEntry[] = [];
  private _version = 0;

  get version(): number { return this._version; }

  private bump(): void { this._version += 1; this.emit("change"); }

  upsertIdentity(id: PaneIdentity): void {
    const cur = this.entries.get(id.paneId);
    if (cur) {
      // Identity can drift (active flag, resolved harness); refresh it.
      cur.identity = id; cur.gone = false; this.bump(); return;
    }
    this.entries.set(id.paneId, {
      identity: id, state: "idle", semantics: null, resources: null, lastActivityTs: 0, ts: 0, gone: false,
    });
    this.bump();
  }

  applyState(paneId: string, state: PaneState, lastActivityTs: number, now: number): void {
    const e = this.entries.get(paneId);
    if (!e) return;
    if (e.state === state && e.lastActivityTs === lastActivityTs) return; // no observable change
    e.state = state; e.lastActivityTs = lastActivityTs; e.ts = now; this.bump();
  }

  applySemantics(paneId: string, semantics: PaneSemantics): void {
    const e = this.entries.get(paneId);
    if (!e) return;
    // Monotonicity guard: two concurrent label() jobs for one pane can resolve
    // out of order, so a stale result must never clobber a fresher one. Ignore
    // any write no newer than what we already hold — no apply, no version bump.
    if (e.semantics && e.semantics.updatedAt >= semantics.updatedAt) return;
    e.semantics = semantics; this.bump();
  }

  applyResources(paneId: string, resources: PaneResources): void {
    const e = this.entries.get(paneId);
    if (!e) return;
    e.resources = resources; this.bump();
  }

  setHostPressure(p: HostPressure): void { this.hostPressure = p; this.bump(); }

  logGuardian(entry: GuardianLogEntry): void {
    this.guardianLog.push(entry);
    if (this.guardianLog.length > 50) this.guardianLog = this.guardianLog.slice(-50);
    this.bump();
  }

  markGone(paneId: string): void {
    const e = this.entries.get(paneId);
    if (e && !e.gone) { e.gone = true; this.bump(); }
  }

  evictGone(): void {
    let changed = false;
    for (const [id, e] of this.entries) if (e.gone) { this.entries.delete(id); changed = true; }
    if (changed) this.bump();
  }

  snapshot(): WorkspaceSnapshot {
    const panes = [...this.entries.values()].filter((e) => !e.gone);
    return {
      version: this._version,
      updatedAt: Math.max(0, ...panes.map((e) => e.ts)),
      panes: panes.map((e) => ({ ...e })),
      hostPressure: this.hostPressure ? { ...this.hostPressure } : null,
      guardianLog: this.guardianLog.map((e) => ({ ...e })),
    };
  }
}
