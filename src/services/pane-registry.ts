/**
 * Diffs the live tmux pane set into durable `PaneIdentity` records, resolving
 * each pane's harness/session, and reports which panes appeared or vanished
 * since the last diff.
 */

import type { GmuxPane } from "../core/mux-types.js";
import type { PaneLink, SessionRecord, TmuxPane } from "../core/types.js";
import type { PaneIdentity } from "../core/gmux-types.js";
import { cachedRecords } from "./index-store.js";
import { prunePaneLinks, readPaneLinks } from "./pane-links.js";
import type { MuxGateway } from "./mux-gateway.js";
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

function isGmuxPane(pane: TmuxPane | GmuxPane): pane is GmuxPane {
  return "argv" in pane && "tabId" in pane;
}

export class PaneRegistry {
  private known = new Set<string>();

  constructor(
    private readonly gateway: TmuxGateway | MuxGateway,
    private readonly resolve: ResolveFn = resolvePanesLive,
  ) {}

  async diff(): Promise<RegistryDiff> {
    const panes = await this.gateway.listPanes();
    if (panes.length > 0 && isGmuxPane(panes[0]!)) {
      return this.diffMux(panes as GmuxPane[]);
    }
    return this.diffTmux(panes as TmuxPane[]);
  }

  private finish(present: PaneIdentity[], liveIds: string[]): RegistryDiff {
    const liveSet = new Set(liveIds);
    const appeared = liveIds.filter((id) => !this.known.has(id));
    const vanished = [...this.known].filter((id) => !liveSet.has(id));
    this.known = liveSet;
    return { present, appeared, vanished };
  }

  private async diffMux(panes: GmuxPane[]): Promise<RegistryDiff> {
    const liveIds = panes.map((p) => p.paneId);
    const links = await prunePaneLinks(liveIds).catch(() => readPaneLinks());
    const byPane = new Map(links.map((l) => [l.paneId, l]));
    const present: PaneIdentity[] = panes.map((pane) => {
      const link = byPane.get(pane.paneId);
      return {
        paneId: pane.paneId,
        windowId: null,
        active: false,
        harness: link?.harness ?? pane.harness,
        sessionId: link?.sessionId ?? pane.sessionId,
        cwd: pane.cwd,
        command: pane.argv[0] ?? "",
        pid: pane.pid,
        tabId: pane.tabId,
        workspaceId: pane.workspaceId,
        peelDepth: pane.peelDepth,
        templateId: pane.templateId,
      };
    });
    return this.finish(present, liveIds);
  }

  private async diffTmux(panes: TmuxPane[]): Promise<RegistryDiff> {
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
    return this.finish(present, liveIds);
  }
}
