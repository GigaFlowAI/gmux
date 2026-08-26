import type { HarnessId } from "./types.js";

/** The five triage-critical pane states, ordered least→most attention-worthy for display. */
export const PANE_STATES = ["working", "idle", "waiting", "error", "done"] as const;
export type PaneState = (typeof PANE_STATES)[number];

export function isPaneState(value: string): value is PaneState {
  return (PANE_STATES as readonly string[]).includes(value);
}

/** A uniform reading from a sensor, regardless of source. */
export interface Observation {
  paneId: string;
  kind: "agent" | "terminal";
  /** ms epoch when this observation was taken. */
  ts: number;
  /** Latest slice of lines (new transcript lines, or pipe-pane/capture tail). */
  tailLines: string[];
  /** ms epoch of the last content change seen for this pane (0 if never). */
  lastActivityTs: number;
  /** True when the agent transcript's final turn awaits human input (agent panes only). */
  awaitingInput?: boolean;
  /** True when the latest slice shows a tool/command failure. */
  sawError?: boolean;
  /** True when the agent transcript indicates the task ended/finished. */
  ended?: boolean;
}

/** The human-readable "what it's doing" layer. */
export interface PaneSemantics {
  label: string;
  card: string | null;
  /** SimHash of the source text the label was written from. */
  fingerprint: string;
  updatedAt: number;
  stale: boolean;
}

/** Per-pane memory attribution. */
export interface PaneResources {
  /** Subtree RSS sum in bytes. Reliable for ranking, not exact totals. */
  perPaneRss: number;
  ts: number;
}

/** Durable identity of a pane in the workspace. */
export interface PaneIdentity {
  paneId: string;
  windowId: string | null;
  active: boolean;
  harness: HarnessId | null;
  sessionId: string | null;
  cwd: string;
  command: string;
  pid: number;
}

/** One pane's complete state in the model. */
export interface PaneEntry {
  identity: PaneIdentity;
  state: PaneState;
  semantics: PaneSemantics | null;
  resources: PaneResources | null;
  /** ms epoch of last observed activity. */
  lastActivityTs: number;
  /** ms epoch of last update to this entry. */
  ts: number;
  /** Marked true when the pane vanished; evicted next tick. */
  gone: boolean;
}

/** Host-level memory pressure — the guardian's trigger. Not the sum of panes. */
export interface HostPressure {
  /** Used fraction 0..1 (excludes reclaimable cache where the OS distinguishes). */
  usedRatio: number;
  /** Bytes not attributed to any tracked pane subtree. */
  unattributed: number;
  ts: number;
}

/** One guardian action, logged to the model. */
export interface GuardianLogEntry {
  ts: number;
  /** Host used fraction at fire time. */
  pressure: number;
  culpritPaneId: string | null;
  /** Human label of the top consumer, or "source outside tracked panes". */
  culpritLabel: string;
  action: "broadcast" | "notify" | "log-only";
  message: string;
}

/** Guardian autonomy policy. */
export type GuardianPolicy = "off" | "notify" | "auto";

/** The gmux config block, persisted under GmConfig. */
export interface GmuxConfig {
  guardianPolicy: GuardianPolicy;
  /** Host used fraction that trips the guardian, 0..1. */
  memoryThreshold: number;
  /** Minimum seconds between guardian fires. */
  cooldownSeconds: number;
  /** Daemon tick interval in ms. */
  tickMs: number;
}

/** The serializable model handed to surfaces over the socket / snapshot file. */
export interface WorkspaceSnapshot {
  version: number;
  updatedAt: number;
  panes: PaneEntry[];
  hostPressure: HostPressure | null;
  guardianLog: GuardianLogEntry[];
}

/** Defaults for a fresh install. */
export const DEFAULT_GMUX_CONFIG: GmuxConfig = {
  guardianPolicy: "auto",
  memoryThreshold: 0.9,
  cooldownSeconds: 300,
  tickMs: 1500,
};
