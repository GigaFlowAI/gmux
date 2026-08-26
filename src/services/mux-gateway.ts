import type {
  GmuxPane,
  GridSnapshot,
  SpawnOpts,
} from "../core/mux-types.js";
import { formatPaneId } from "../core/mux-types.js";

/**
 * Control-plane seam for the native mux. Replaces TmuxGateway on the sidecar
 * path. No selectLayout / swapPane — v1 tabs are groups, not tiled windows.
 */
export interface MuxGateway {
  listPanes(): Promise<GmuxPane[]>;
  send(paneId: string, keys: string): Promise<void>;
  spawn(opts: SpawnOpts): Promise<{ paneId: string; tabId: string }>;
  closePane(paneId: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  readGrid(paneId: string, rows?: number): Promise<GridSnapshot>;
  readLines(paneId: string, lines?: number): Promise<string>;
  newTab(name: string): Promise<string>;
  renameTab(tabId: string, name: string): Promise<void>;
  movePane(srcPane: string, dstTab: string): Promise<void>;
  breakPane(pane: string, name?: string): Promise<string>;
  /** Fast path: spawn from the client's focused pane shadow. Must not await extract. */
  peel(clientId: string): Promise<{ paneId: string; tabId: string }>;
}

/** In-memory MuxGateway for Vitest. Pane ids are `p_` + Crockford of `{0…n}`. */
export class FakeMuxGateway implements MuxGateway {
  readonly sent: Array<{ paneId: string; keys: string }> = [];
  readonly spawned: Array<{ paneId: string; tabId: string; opts: SpawnOpts }> = [];
  readonly closed: Array<{ kind: "pane" | "tab"; id: string }> = [];
  readonly createdTabs: Array<{ tabId: string; name: string }> = [];
  readonly renamed: Array<{ tabId: string; name: string }> = [];
  readonly moved: Array<{ srcPane: string; dstTab: string }> = [];
  readonly broken: Array<{ pane: string; tabId: string; name?: string }> = [];

  private panes: GmuxPane[] = [];
  private tabs = new Map<string, { name: string; paneIds: string[] }>();
  private grids = new Map<string, GridSnapshot>();
  private lineBuffers = new Map<string, string>();
  private clientFocus = new Map<string, string>();
  private nextPane = 1;
  private nextTab = 1;
  private nextPid = 10_000;
  /** When set, spawn({focus:true}) updates this client's focusedPaneId. */
  private thisClientId: string | null = null;

  setThisClient(clientId: string | null): void {
    this.thisClientId = clientId;
  }

  setClientFocus(clientId: string, paneId: string): void {
    this.clientFocus.set(clientId, paneId);
  }

  focusedPaneId(clientId: string): string | undefined {
    return this.clientFocus.get(clientId);
  }

  setGrid(paneId: string, grid: GridSnapshot): void {
    this.grids.set(paneId, grid);
  }

  setLines(paneId: string, text: string): void {
    this.lineBuffers.set(paneId, text);
  }

  private mintPaneId(): string {
    const n = this.nextPane++;
    const bytes = new Uint8Array(16);
    bytes[15] = n & 0xff;
    bytes[14] = (n >>> 8) & 0xff;
    return formatPaneId(bytes);
  }

  private mintTabId(): string {
    return `t_${this.nextTab++}`;
  }

  async listPanes(): Promise<GmuxPane[]> {
    return this.panes.map((p) => ({ ...p, argv: [...p.argv] }));
  }

  async send(paneId: string, keys: string): Promise<void> {
    this.sent.push({ paneId, keys });
  }

  async spawn(opts: SpawnOpts): Promise<{ paneId: string; tabId: string }> {
    let tabId: string;
    if (opts.tab?.mode === "existing") {
      tabId = opts.tab.tabId;
      if (!this.tabs.has(tabId)) {
        this.tabs.set(tabId, { name: tabId, paneIds: [] });
        this.createdTabs.push({ tabId, name: tabId });
      }
    } else {
      tabId = this.mintTabId();
      const name = opts.tab?.mode === "new" ? opts.tab.name : tabId;
      this.tabs.set(tabId, { name, paneIds: [] });
      this.createdTabs.push({ tabId, name });
    }

    const paneId = this.mintPaneId();
    const pane: GmuxPane = {
      paneId,
      tabId,
      workspaceId: "ws_test",
      cwd: opts.cwd,
      argv: [...opts.argv],
      pid: this.nextPid++,
      harness: null,
      sessionId: null,
      peelDepth: opts.peelDepth ?? 0,
      templateId: null,
    };
    this.panes.push(pane);
    this.tabs.get(tabId)!.paneIds.push(paneId);
    this.spawned.push({ paneId, tabId, opts });

    if (opts.focus === true && this.thisClientId !== null) {
      this.clientFocus.set(this.thisClientId, paneId);
    }

    return { paneId, tabId };
  }

  async closePane(paneId: string): Promise<void> {
    this.panes = this.panes.filter((p) => p.paneId !== paneId);
    for (const tab of this.tabs.values()) {
      tab.paneIds = tab.paneIds.filter((id) => id !== paneId);
    }
    this.closed.push({ kind: "pane", id: paneId });
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (tab) {
      for (const paneId of [...tab.paneIds]) {
        await this.closePane(paneId);
      }
      this.tabs.delete(tabId);
    }
    this.closed.push({ kind: "tab", id: tabId });
  }

  async readGrid(paneId: string, _rows?: number): Promise<GridSnapshot> {
    return (
      this.grids.get(paneId) ?? {
        paneId,
        cols: 80,
        rows: 24,
        lines: [],
        alternateScreen: false,
        foregroundCommand: "",
      }
    );
  }

  async readLines(paneId: string, _lines?: number): Promise<string> {
    return this.lineBuffers.get(paneId) ?? "";
  }

  async newTab(name: string): Promise<string> {
    const tabId = this.mintTabId();
    this.tabs.set(tabId, { name, paneIds: [] });
    this.createdTabs.push({ tabId, name });
    return tabId;
  }

  async renameTab(tabId: string, name: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (tab) tab.name = name;
    this.renamed.push({ tabId, name });
  }

  hasTab(tabId: string): boolean {
    return this.tabs.has(tabId);
  }

  async movePane(srcPane: string, dstTab: string): Promise<void> {
    const pane = this.panes.find((p) => p.paneId === srcPane);
    if (!pane) return;
    const dest = this.tabs.get(dstTab);
    if (!dest) return;
    const fromId = pane.tabId;
    if (fromId !== dstTab) {
      const from = this.tabs.get(fromId);
      if (from) {
        from.paneIds = from.paneIds.filter((id) => id !== srcPane);
        if (from.paneIds.length === 0) this.tabs.delete(fromId);
      }
    }
    if (!dest.paneIds.includes(srcPane)) dest.paneIds.push(srcPane);
    pane.tabId = dstTab;
    this.moved.push({ srcPane, dstTab });
  }

  async breakPane(pane: string, name?: string): Promise<string> {
    const tabId = await this.newTab(name ?? "broken");
    await this.movePane(pane, tabId);
    this.broken.push({ pane, tabId, name });
    return tabId;
  }

  /**
   * Spawn-from-shadow, `focus: false`. Peel is mux-local — it must not await
   * `prompt.extract` (a hung sidecar cannot block ctrl+t).
   */
  async peel(clientId: string): Promise<{ paneId: string; tabId: string }> {
    const parentId = this.clientFocus.get(clientId);
    const parent = parentId ? this.panes.find((p) => p.paneId === parentId) : undefined;
    if (!parent) {
      throw new Error(`no focused pane for client ${clientId}`);
    }
    return this.spawn({
      cwd: parent.cwd,
      argv: [...parent.argv],
      tab: { mode: "new", name: "new agent" },
      focus: false,
      peelDepth: parent.peelDepth + 1,
    });
  }
}
