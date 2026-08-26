import type { Observation, PaneState } from "./workspace-types.js";

/** ms of quiet after which a pane is no longer "working". */
export const WORKING_WINDOW_MS = 10_000;

/** Pure heuristic: latest observation → triage state. Deterministic; no I/O. */
export function classifyState(obs: Observation, now: number): PaneState {
  if (obs.sawError) return "error";
  if (obs.ended) return "done";
  if (obs.awaitingInput) return "waiting";
  if (now - obs.lastActivityTs < WORKING_WINDOW_MS) return "working";
  return "idle";
}
