import { basename } from "node:path";
import { formatBytes } from "../core/bytes.js";
import type { GuardianPolicy, HostPressure, PaneEntry } from "../core/gmux-types.js";

export interface GuardianDecision {
  action: "broadcast" | "notify" | "log-only" | "none";
  culpritPaneId: string | null;
  culpritLabel: string;
  message: string;
}

/**
 * Pure policy state machine: pressure + policy + clock in, a decision out.
 * The ONE component that acts (types into agents via the caller), so it
 * carries no I/O of its own — decide() is a pure function of its inputs
 * plus the instance's own fire-history state (firedAt/belowSinceFire).
 */
export class Guardian {
  private firedAt: number | null = null;
  private belowSinceFire = false;

  constructor(private readonly opts: { policy: GuardianPolicy; threshold: number; cooldownSeconds: number }) {}

  decide(host: HostPressure, panes: PaneEntry[], now: number): GuardianDecision {
    const over = host.usedRatio >= this.opts.threshold;
    if (!over) {
      if (this.firedAt !== null) this.belowSinceFire = true;
      return this.none();
    }

    // In cooldown? Stay quiet unless pressure dropped and re-crossed since the
    // last fire (hysteresis), or the cooldown window has fully elapsed.
    if (this.firedAt !== null) {
      const elapsed = (now - this.firedAt) / 1000;
      const mayRefire = this.belowSinceFire || elapsed >= this.opts.cooldownSeconds;
      if (!mayRefire) return this.none();
    }

    const { culprit, label } = topConsumer(panes, host);
    const agents = panes.filter((p) => p.identity.harness && p.identity.sessionId);
    const pct = Math.round(host.usedRatio * 100);
    const message = `host memory ${pct}% — top consumer: ${label}; checkpoint your work and pause non-essential tasks.`;

    if (this.opts.policy === "off") {
      return { action: "log-only", culpritPaneId: culprit, culpritLabel: label, message };
    }
    if (this.opts.policy === "notify") {
      return this.fire("notify", culprit, label, message, now);
    }
    // policy === "auto"
    if (agents.length === 0) {
      return { action: "log-only", culpritPaneId: culprit, culpritLabel: label, message };
    }
    return this.fire("broadcast", culprit, label, message, now);
  }

  private fire(
    action: "broadcast" | "notify",
    culprit: string | null,
    label: string,
    message: string,
    now: number,
  ): GuardianDecision {
    this.firedAt = now;
    this.belowSinceFire = false;
    return { action, culpritPaneId: culprit, culpritLabel: label, message };
  }

  private none(): GuardianDecision {
    return { action: "none", culpritPaneId: null, culpritLabel: "", message: "" };
  }
}

function topConsumer(panes: PaneEntry[], host: HostPressure): { culprit: string | null; label: string } {
  let best: PaneEntry | null = null;
  for (const p of panes) {
    if (p.resources && (!best || p.resources.perPaneRss > best.resources!.perPaneRss)) best = p;
  }
  const bestRss = best?.resources?.perPaneRss ?? 0;
  if (!best || host.unattributed > bestRss) {
    return { culprit: null, label: "a source outside tracked panes" };
  }
  const name = best.identity.cwd ? basename(best.identity.cwd) : best.identity.command;
  // Shared with the cockpit's memory column so the same pane shows the same
  // figure in both places.
  return { culprit: best.identity.paneId, label: `window \`${name}\` (${formatBytes(bestRss)})` };
}
