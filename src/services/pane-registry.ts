/**
 * Diffs the live tmux pane set into durable `PaneIdentity` records, resolving
 * each pane's harness/session, and reports which panes appeared or vanished
 * since the last diff.
 */

import type { PaneLink, SessionRecord, TmuxPane } from "../core/types.js";
import type { PaneIdentity } from "../core/gmux-types.js";
import { cachedRecords } from "./index-store.js";
import { prunePaneLinks, readPaneLinks } from "./pane-links.js";
import { resolvePanesLive } from "./tmux-resolve.js";
import type { TmuxGateway } from "./tmux-gateway.js";

export interface RegistryDiff {
  present: PaneIdentity[];
  appeared: string[];
  vanished: string[];
}

export type ResolveFn = (
  panes: TmuxPane[],
  records: SessionRecord[],
  links: PaneLink[],
) => Promise<Array<{ pane: TmuxPane; record: SessionRecord | null }>>;

export class PaneRegistry {
  private known = new Set<string>();

  constructor(
    private readonly gateway: TmuxGateway,
    private readonly resolve: ResolveFn = resolvePanesLive,
  ) {}

  async diff(): Promise<RegistryDiff> {
    const panes = await this.gateway.listPanes();
    const liveIds = panes.map((p) => p.paneId);
    const links = await prunePaneLinks(liveIds).catch(() => readPaneLinks());
    const records = await cachedRecords().catch(() => [] as SessionRecord[]);
    const resolved = await this.resolve(panes, records, links);

    const present: PaneIdentity[] = resolved.map(({ pane, record }) => ({
      paneId: pane.paneId,
      windowId: pane.windowId,
      active: pane.active,
      harness: record?.harness ?? null,
      sessionId: record?.sessionId ?? null,
      cwd: pane.cwd,
      command: pane.command,
      pid: pane.pid,
    }));

    const liveSet = new Set(liveIds);
    const appeared = liveIds.filter((id) => !this.known.has(id));
    const vanished = [...this.known].filter((id) => !liveSet.has(id));
    this.known = liveSet;
    return { present, appeared, vanished };
  }
}
