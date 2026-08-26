/**
 * The daemon-driven border painter: given a `WorkspaceSnapshot`, writes every
 * pane's `@gm_label` from the model, zero sensing. `gm daemon run` calls this
 * on every model "change" event; `snapshotLabel` (tmux-label.ts) does the
 * actual glyph/text formatting.
 */

import type { WorkspaceSnapshot } from "../core/workspace-types.js";
import { snapshotLabel } from "./tmux-label.js";

export async function paintFromSnapshot(
  snapshot: WorkspaceSnapshot,
  setLabel: (paneId: string, text: string) => Promise<void>,
): Promise<void> {
  await Promise.all(snapshot.panes.map((e) => setLabel(e.identity.paneId, snapshotLabel(e))));
}
