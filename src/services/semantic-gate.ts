import { hammingDistance, simhash64 } from "../core/fingerprint.js";
import type { Observation } from "../core/workspace-types.js";

interface Last { fingerprint: string; ts: number; }

export class SemanticGate {
  private last = new Map<string, Last>();
  private readonly distance: number;
  private readonly debounceMs: number;

  constructor(opts: { distance?: number; debounceMs?: number } = {}) {
    this.distance = opts.distance ?? 8;
    this.debounceMs = opts.debounceMs ?? 4000;
  }

  private fp(obs: Observation): string { return simhash64(obs.tailLines.join("\n")); }

  shouldSummarize(paneId: string, obs: Observation, now: number): boolean {
    const prev = this.last.get(paneId);
    if (!prev) return true;
    if (now - prev.ts < this.debounceMs) return false;
    return hammingDistance(this.fp(obs), prev.fingerprint) > this.distance;
  }

  noteQueued(paneId: string, obs: Observation, now: number): void {
    this.last.set(paneId, { fingerprint: this.fp(obs), ts: now });
  }
}
