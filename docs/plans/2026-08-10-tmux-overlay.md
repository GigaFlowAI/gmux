# The tmux peek overlay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tmux integration layer to gigamanage so `ctrl+g` covers every pane, in place, with its own summary card — and dismisses on any key.

**Architecture:** A new tmux integration layer consumes the existing session/summary engine. `services/` gains the tmux I/O, the pane→session resolver, and the pane-link store; `cli/` gains the overlay renderer, the `gm overlay`/`gm run`/`gm tmux` commands, and the picker bridge. Nothing in the existing adapters, summarizer, or index changes shape. If tmux is absent, none of it loads and `gm` behaves exactly as before.

**Tech Stack:** TypeScript (ESM, NodeNext — imports end in `.js`), commander, vitest. tmux ≥ 3.2 at runtime only.

## Global Constraints

- **Layer rule:** `core ← adapters ← services ← cli`. Imports point left or sideways, never right. `scripts/check-layers.mjs` enforces it in `npm test`/CI. tmux I/O, the resolver, and the pane-link store live in `services`; everything user-facing lives in `cli`.
- **ESM import paths** end in `.js` even for `.ts` files (e.g. `import { cacheDir } from "../core/paths.js"`).
- **Read-only on session files.** gigamanage owns only its cache/config. The overlay never writes to, splits, or restarts a live pane's process.
- **No model calls in render paths.** The overlay renders from the index/summary cache; refresh is delegated to the existing detached `auto-summarize` worker, never run inline.
- **Colour is gated.** Reuse `format.ts` helpers; do not introduce raw ANSI colour in a way that breaks `NO_COLOR`/`TERM=dumb`. The overlay is monochrome in v1 (structure by layout, not colour).
- **Tests never touch the real home dir.** `tests/setup.ts` points `XDG_CACHE_HOME`/`XDG_CONFIG_HOME` at throwaway temp dirs; tests that need the harness tree set `GIGAMANAGE_HOME`. No test spawns a detached child or a real model — assert spawn intent as data and inject spawners.
- **Run after each task:** `npm run check` (layers + types + vitest) must be green before the task's commit.
- **tmux runtime floor:** `display-popup` needs tmux ≥ 3.2. `supportsDisplayPopup` is the single source of that truth.

---

## File Structure

**New:**
- `src/services/pane-links.ts` — the `pane_id → session` link store (read/write/prune).
- `src/services/tmux-resolve.ts` — pure pane→session resolution (explicit link, else cwd+recency).
- `src/services/tmux.ts` — thin `tmux` binary wrappers + pure parsers (pane list, version).
- `src/cli/overlay.ts` — pure rendering: cards drawn into pane rectangles with absolute positioning.
- `src/cli/commands/overlay.ts` — the `gm overlay <window>` command (glue: read → resolve → paint → wait for key).
- `src/cli/commands/run.ts` — `gm run <harness> [args…]`, records the exact link.
- `src/cli/commands/tmux.ts` — `gm tmux install|uninstall`, manages the `~/.tmux.conf` block.
- Test files mirror each under `tests/`.

**Modified:**
- `src/core/types.ts` — add `TmuxPane`, `PaneLink`.
- `src/core/paths.ts` — add `paneLinksPath()`.
- `src/adapters/types.ts` — add `processNames` and `launchCommand` to `HarnessAdapter`.
- `src/adapters/claude-code.ts`, `src/adapters/codex.ts` — implement the two new fields.
- `src/cli/commands/resume.ts` — add `resumeInNewWindow` + `newWindowArgv`.
- `src/cli/commands/pick.ts` — add hidden `--resume-in-window` flag.
- `src/cli/commands/doctor.ts` — add the tmux-version check.
- `src/cli/main.ts` — register `overlay`, `run`, `tmux`.

---

## Task 1: Pane-link store + core types

**Files:**
- Modify: `src/core/types.ts` (add `TmuxPane`, `PaneLink`)
- Modify: `src/core/paths.ts` (add `paneLinksPath()`)
- Create: `src/services/pane-links.ts`
- Test: `tests/pane-links.test.ts`

**Interfaces:**
- Produces: `interface TmuxPane { paneId: string; left: number; top: number; width: number; height: number; cwd: string; command: string }`; `interface PaneLink { paneId: string; harness: HarnessId; sessionId: string }`; `paneLinksPath(): string`; `readPaneLinks(): Promise<PaneLink[]>`; `writePaneLink(link: PaneLink): Promise<void>`; `prunePaneLinks(livePaneIds: Iterable<string>): Promise<PaneLink[]>`; `linkForPane(links: readonly PaneLink[], paneId: string): PaneLink | null`.

- [ ] **Step 1: Add the core types**

In `src/core/types.ts`, after `SessionRef`, add:

```ts
/**
 * One tmux pane as gigamanage sees it: geometry plus enough to resolve it to a
 * session. `command` is `pane_current_command` (the foreground process, e.g.
 * "claude", "codex", "node", "zsh") — a weak signal, since a node-based harness
 * often shows as "node"; the cwd carries most of the resolution.
 */
export interface TmuxPane {
  paneId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  cwd: string;
  command: string;
}

/**
 * An exact pane→session link recorded by `gm run`. Ephemeral runtime state: a
 * `paneId` means nothing once the tmux server dies, so this lives in the cache
 * and is pruned to the live pane set on every read of the overlay.
 */
export interface PaneLink {
  paneId: string;
  harness: HarnessId;
  sessionId: string;
}
```

- [ ] **Step 2: Add the cache path**

In `src/core/paths.ts`, after `summaryPath`, add:

```ts
/**
 * The pane→session links written by `gm run`. Cache, not config: keyed by tmux
 * pane ids that die with the server, disposable, regenerated by living in the
 * tool. Worst case of deleting it: a pane falls back to the cwd heuristic.
 */
export function paneLinksPath(): string {
  return join(cacheDir(), "pane-links.json");
}
```

- [ ] **Step 3: Write the failing test**

Create `tests/pane-links.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { rm } from "node:fs/promises";

import { paneLinksPath } from "../src/core/paths.js";
import {
  linkForPane,
  prunePaneLinks,
  readPaneLinks,
  writePaneLink,
} from "../src/services/pane-links.js";

describe("pane-links store", () => {
  beforeEach(async () => {
    await rm(paneLinksPath(), { force: true });
  });

  it("round-trips a written link", async () => {
    await writePaneLink({ paneId: "%1", harness: "claude-code", sessionId: "abc" });
    expect(await readPaneLinks()).toEqual([
      { paneId: "%1", harness: "claude-code", sessionId: "abc" },
    ]);
  });

  it("replaces a pane's link rather than duplicating it", async () => {
    await writePaneLink({ paneId: "%1", harness: "claude-code", sessionId: "old" });
    await writePaneLink({ paneId: "%1", harness: "claude-code", sessionId: "new" });
    const links = await readPaneLinks();
    expect(links).toHaveLength(1);
    expect(links[0]!.sessionId).toBe("new");
  });

  it("prunes links whose pane is no longer live", async () => {
    await writePaneLink({ paneId: "%1", harness: "codex", sessionId: "a" });
    await writePaneLink({ paneId: "%2", harness: "codex", sessionId: "b" });
    const kept = await prunePaneLinks(["%2"]);
    expect(kept.map((l) => l.paneId)).toEqual(["%2"]);
    expect((await readPaneLinks()).map((l) => l.paneId)).toEqual(["%2"]);
  });

  it("treats a missing or corrupt file as no links", async () => {
    expect(await readPaneLinks()).toEqual([]);
    expect(linkForPane([], "%9")).toBeNull();
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `npx vitest run tests/pane-links.test.ts`
Expected: FAIL — `src/services/pane-links.js` does not exist.

- [ ] **Step 5: Implement the store**

Create `src/services/pane-links.ts`:

```ts
/**
 * The pane→session links `gm run` records, so the overlay maps a live pane to
 * the exact session it launched rather than guessing. Cache, disposable, pruned
 * to the live pane set on every overlay render.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";

import { cacheDir, paneLinksPath } from "../core/paths.js";
import type { PaneLink } from "../core/types.js";

function isPaneLink(value: unknown): value is PaneLink {
  const link = value as PaneLink;
  return (
    !!link &&
    typeof link.paneId === "string" &&
    typeof link.harness === "string" &&
    typeof link.sessionId === "string"
  );
}

export async function readPaneLinks(): Promise<PaneLink[]> {
  try {
    const parsed = JSON.parse(await readFile(paneLinksPath(), "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isPaneLink) : [];
  } catch {
    return [];
  }
}

async function persist(links: readonly PaneLink[]): Promise<void> {
  await mkdir(cacheDir(), { recursive: true });
  await writeFile(paneLinksPath(), JSON.stringify(links), "utf8");
}

export async function writePaneLink(link: PaneLink): Promise<void> {
  const links = (await readPaneLinks()).filter((l) => l.paneId !== link.paneId);
  links.push(link);
  await persist(links);
}

export async function prunePaneLinks(livePaneIds: Iterable<string>): Promise<PaneLink[]> {
  const live = new Set(livePaneIds);
  const kept = (await readPaneLinks()).filter((l) => live.has(l.paneId));
  await persist(kept);
  return kept;
}

export function linkForPane(links: readonly PaneLink[], paneId: string): PaneLink | null {
  return links.find((l) => l.paneId === paneId) ?? null;
}
```

- [ ] **Step 6: Run the test and the full check**

Run: `npx vitest run tests/pane-links.test.ts` → PASS
Run: `npm run check` → green (layers, types, all tests)

- [ ] **Step 7: Commit**

```bash
git add src/core/types.ts src/core/paths.ts src/services/pane-links.ts tests/pane-links.test.ts
git commit -m "feat(tmux): pane-link store and core tmux types"
```

---

## Task 2: Pane→session resolver

**Files:**
- Modify: `src/adapters/types.ts` (add `processNames`)
- Modify: `src/adapters/claude-code.ts`, `src/adapters/codex.ts` (implement it)
- Create: `src/services/tmux-resolve.ts`
- Test: `tests/tmux-resolve.test.ts`

**Interfaces:**
- Consumes: `TmuxPane`, `PaneLink`, `SessionRecord`; `linkForPane` (Task 1); `allAdapters()`.
- Produces: `HarnessAdapter.processNames: readonly string[]`; `harnessForCommand(command: string): HarnessId | null`; `resolvePaneToRecord(pane, records, links): SessionRecord | null`; `interface ResolvedPane { pane: TmuxPane; record: SessionRecord | null }`; `resolvePanes(panes, records, links): ResolvedPane[]`.

- [ ] **Step 1: Add `processNames` to the adapter seam**

In `src/adapters/types.ts`, inside `HarnessAdapter`, after `displayName`, add:

```ts
  /**
   * Distinctive `pane_current_command` names that mean "this harness". Used only
   * to *prefer* a harness when resolving a pane; matching is a hint, never a
   * gate, because a node-based harness often shows as "node". List only names
   * that unambiguously identify this harness — omit "node".
   */
  readonly processNames: readonly string[];
```

- [ ] **Step 2: Implement it in both adapters**

In `src/adapters/claude-code.ts`, add to the class body (near `id`/`displayName`):

```ts
  readonly processNames = ["claude"] as const;
```

In `src/adapters/codex.ts`, add:

```ts
  readonly processNames = ["codex"] as const;
```

- [ ] **Step 3: Write the failing test**

Create `tests/tmux-resolve.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { PaneLink, SessionRecord, TmuxPane } from "../src/core/types.js";
import { harnessForCommand, resolvePaneToRecord } from "../src/services/tmux-resolve.js";

function record(over: Partial<SessionRecord>): SessionRecord {
  return {
    harness: "claude-code",
    sessionId: "s",
    filePath: "/f",
    cwd: "/repo",
    project: "repo",
    gitBranch: null,
    startedAt: null,
    updatedAt: "2026-08-10T00:00:00.000Z",
    messageCount: 1,
    userPromptCount: 1,
    title: null,
    lastUserPrompt: null,
    recentUserPrompts: [],
    arcPrompts: [],
    filesTouched: [],
    prLinks: [],
    lastAssistantText: null,
    lastToolFailure: null,
    endedMidTask: false,
    isSidechain: false,
    isAutomated: false,
    ...over,
  };
}

function pane(over: Partial<TmuxPane>): TmuxPane {
  return { paneId: "%1", left: 0, top: 0, width: 40, height: 20, cwd: "/repo", command: "claude", ...over };
}

describe("harnessForCommand", () => {
  it("maps a distinctive command to its harness", () => {
    expect(harnessForCommand("claude")).toBe("claude-code");
    expect(harnessForCommand("codex")).toBe("codex");
  });
  it("returns null for a non-distinctive command", () => {
    expect(harnessForCommand("node")).toBeNull();
    expect(harnessForCommand("zsh")).toBeNull();
  });
});

describe("resolvePaneToRecord", () => {
  const links: PaneLink[] = [{ paneId: "%1", harness: "codex", sessionId: "exact" }];

  it("prefers an explicit link over the heuristic", () => {
    const records = [record({ sessionId: "exact", harness: "codex", cwd: "/other" }), record({ sessionId: "newer", cwd: "/repo" })];
    expect(resolvePaneToRecord(pane({}), records, links)!.sessionId).toBe("exact");
  });

  it("falls back to the newest session in the pane's cwd", () => {
    const records = [
      record({ sessionId: "old", cwd: "/repo", updatedAt: "2026-08-01T00:00:00.000Z" }),
      record({ sessionId: "new", cwd: "/repo", updatedAt: "2026-08-09T00:00:00.000Z" }),
      record({ sessionId: "elsewhere", cwd: "/other", updatedAt: "2026-08-10T00:00:00.000Z" }),
    ];
    expect(resolvePaneToRecord(pane({ paneId: "%2" }), records, [])!.sessionId).toBe("new");
  });

  it("prefers the harness the command points to when the cwd is shared", () => {
    const records = [
      record({ sessionId: "cc", harness: "claude-code", cwd: "/repo", updatedAt: "2026-08-01T00:00:00.000Z" }),
      record({ sessionId: "cx", harness: "codex", cwd: "/repo", updatedAt: "2026-08-09T00:00:00.000Z" }),
    ];
    expect(resolvePaneToRecord(pane({ paneId: "%2", command: "claude" }), records, [])!.sessionId).toBe("cc");
  });

  it("returns null when nothing matches the cwd", () => {
    const records = [record({ cwd: "/other" })];
    expect(resolvePaneToRecord(pane({ paneId: "%2", cwd: "/nope" }), records, [])).toBeNull();
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `npx vitest run tests/tmux-resolve.test.ts`
Expected: FAIL — `src/services/tmux-resolve.js` does not exist.

- [ ] **Step 5: Implement the resolver**

Create `src/services/tmux-resolve.ts`:

```ts
/**
 * Map a live tmux pane to the session it is running. Hybrid: an exact `gm run`
 * link wins; otherwise the newest transcript in the pane's cwd, preferring the
 * harness the foreground command points to. No match is a normal case (a plain
 * shell), rendered as a placeholder — never an error.
 */

import { allAdapters } from "../adapters/registry.js";
import type { HarnessId, PaneLink, SessionRecord, TmuxPane } from "../core/types.js";
import { linkForPane } from "./pane-links.js";

/** The harness a `pane_current_command` distinctively names, or null. */
export function harnessForCommand(command: string): HarnessId | null {
  const cmd = command.trim().toLowerCase();
  for (const adapter of allAdapters()) {
    if (adapter.processNames.some((name) => name.toLowerCase() === cmd)) return adapter.id;
  }
  return null;
}

export function resolvePaneToRecord(
  pane: TmuxPane,
  records: readonly SessionRecord[],
  links: readonly PaneLink[],
): SessionRecord | null {
  const link = linkForPane(links, pane.paneId);
  if (link) {
    const exact = records.find(
      (r) => r.harness === link.harness && r.sessionId === link.sessionId,
    );
    if (exact) return exact;
    // Link points at a session the index hasn't caught up to yet — fall through
    // to the heuristic rather than showing nothing.
  }

  const inCwd = records.filter((r) => r.cwd !== null && r.cwd === pane.cwd);
  if (inCwd.length === 0) return null;

  const harness = harnessForCommand(pane.command);
  const preferred = harness ? inCwd.filter((r) => r.harness === harness) : [];
  const pool = preferred.length > 0 ? preferred : inCwd;

  return [...pool].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

export interface ResolvedPane {
  pane: TmuxPane;
  record: SessionRecord | null;
}

export function resolvePanes(
  panes: readonly TmuxPane[],
  records: readonly SessionRecord[],
  links: readonly PaneLink[],
): ResolvedPane[] {
  return panes.map((pane) => ({ pane, record: resolvePaneToRecord(pane, records, links) }));
}
```

- [ ] **Step 6: Run the test and the full check**

Run: `npx vitest run tests/tmux-resolve.test.ts` → PASS
Run: `npm run check` → green.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/types.ts src/adapters/claude-code.ts src/adapters/codex.ts src/services/tmux-resolve.ts tests/tmux-resolve.test.ts
git commit -m "feat(tmux): hybrid pane->session resolver"
```

---

## Task 3: tmux I/O service (parsers + version)

**Files:**
- Create: `src/services/tmux.ts`
- Test: `tests/tmux.test.ts`

**Interfaces:**
- Consumes: `TmuxPane` (Task 1).
- Produces: `PANE_FORMAT: string`; `parsePaneLine(line: string): TmuxPane | null`; `parsePanes(output: string): TmuxPane[]`; `listPanes(windowId: string): Promise<TmuxPane[]>`; `interface TmuxVersion { raw: string; major: number; minor: number }`; `parseTmuxVersion(raw: string): TmuxVersion | null`; `supportsDisplayPopup(v: TmuxVersion | null): boolean`; `tmuxVersion(): Promise<TmuxVersion | null>`.

- [ ] **Step 1: Write the failing test**

Create `tests/tmux.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  PANE_FORMAT,
  parsePaneLine,
  parsePanes,
  parseTmuxVersion,
  supportsDisplayPopup,
} from "../src/services/tmux.js";

describe("parsePaneLine", () => {
  it("parses a well-formed tab-separated line", () => {
    const pane = parsePaneLine("%3\t0\t0\t80\t24\t/home/me/repo\tclaude");
    expect(pane).toEqual({
      paneId: "%3",
      left: 0,
      top: 0,
      width: 80,
      height: 24,
      cwd: "/home/me/repo",
      command: "claude",
    });
  });

  it("rejects lines with non-numeric geometry", () => {
    expect(parsePaneLine("%3\tx\t0\t80\t24\t/repo\tclaude")).toBeNull();
  });

  it("rejects lines with too few fields", () => {
    expect(parsePaneLine("%3\t0\t0")).toBeNull();
  });
});

describe("parsePanes", () => {
  it("skips blank lines and keeps valid ones", () => {
    const out = "%1\t0\t0\t40\t20\t/a\tzsh\n\n%2\t40\t0\t40\t20\t/b\tcodex\n";
    expect(parsePanes(out).map((p) => p.paneId)).toEqual(["%1", "%2"]);
  });

  it("uses tab delimiters so paths with spaces survive", () => {
    const [pane] = parsePanes("%1\t0\t0\t40\t20\t/my repo/app\tnode");
    expect(pane!.cwd).toBe("/my repo/app");
  });
});

describe("PANE_FORMAT", () => {
  it("requests tab-separated fields in the parsed order", () => {
    expect(PANE_FORMAT).toBe(
      "#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{pane_current_path}\t#{pane_current_command}",
    );
  });
});

describe("version gate", () => {
  it("parses tmux -V output", () => {
    expect(parseTmuxVersion("tmux 3.3a\n")).toEqual({ raw: "tmux 3.3a", major: 3, minor: 3 });
  });
  it("gates display-popup at 3.2", () => {
    expect(supportsDisplayPopup(parseTmuxVersion("tmux 3.2"))).toBe(true);
    expect(supportsDisplayPopup(parseTmuxVersion("tmux 3.1c"))).toBe(false);
    expect(supportsDisplayPopup(parseTmuxVersion("tmux 4.0"))).toBe(true);
    expect(supportsDisplayPopup(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/tmux.test.ts`
Expected: FAIL — `src/services/tmux.js` does not exist.

- [ ] **Step 3: Implement the service**

Create `src/services/tmux.ts`:

```ts
/**
 * The narrow surface where gigamanage shells out to `tmux`. The parsers are pure
 * (and tested); the two `run` wrappers are thin shells over documented tmux
 * flags, guarded at the edges by the `gm doctor` version check.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { TmuxPane } from "../core/types.js";

const run = promisify(execFile);

/** Tab-separated so a cwd with spaces cannot be mis-split. */
export const PANE_FORMAT =
  "#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{pane_current_path}\t#{pane_current_command}";

export function parsePaneLine(line: string): TmuxPane | null {
  const parts = line.split("\t");
  if (parts.length < 7) return null;
  const [paneId, left, top, width, height, cwd, command] = parts;
  const nums = [left, top, width, height].map((n) => Number(n));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return {
    paneId: paneId!,
    left: nums[0]!,
    top: nums[1]!,
    width: nums[2]!,
    height: nums[3]!,
    cwd: cwd!,
    command: command!,
  };
}

export function parsePanes(output: string): TmuxPane[] {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map(parsePaneLine)
    .filter((pane): pane is TmuxPane => pane !== null);
}

export async function listPanes(windowId: string): Promise<TmuxPane[]> {
  const { stdout } = await run("tmux", ["list-panes", "-t", windowId, "-F", PANE_FORMAT]);
  return parsePanes(stdout);
}

export interface TmuxVersion {
  raw: string;
  major: number;
  minor: number;
}

export function parseTmuxVersion(raw: string): TmuxVersion | null {
  const match = raw.match(/(\d+)\.(\d+)/);
  if (!match) return null;
  return { raw: raw.trim(), major: Number(match[1]), minor: Number(match[2]) };
}

/** display-popup landed in tmux 3.2. */
export function supportsDisplayPopup(version: TmuxVersion | null): boolean {
  if (!version) return false;
  return version.major > 3 || (version.major === 3 && version.minor >= 2);
}

export async function tmuxVersion(): Promise<TmuxVersion | null> {
  try {
    const { stdout } = await run("tmux", ["-V"]);
    return parseTmuxVersion(stdout);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test and the full check**

Run: `npx vitest run tests/tmux.test.ts` → PASS
Run: `npm run check` → green.

- [ ] **Step 5: Commit**

```bash
git add src/services/tmux.ts tests/tmux.test.ts
git commit -m "feat(tmux): tmux pane-list and version wrappers"
```

---

## Task 4: Overlay rendering (pure)

**Files:**
- Create: `src/cli/overlay.ts`
- Test: `tests/overlay.test.ts`

**Interfaces:**
- Consumes: `TmuxPane`, `SessionView` (core); `sessionLabel`, `indent` (format.ts); `relativeAge`, `truncate`, `wrapText` (core/text).
- Produces: `interface OverlayCell { pane: TmuxPane; view: SessionView | null; refreshing: boolean }`; `cellLines(cell: OverlayCell, width: number, height: number, now: Date): string[]`; `renderOverlay(cells: readonly OverlayCell[], now?: Date): string`.

Note on the card: the overlay draws a *compact* sibling of `formatCard` — same `SessionSummary` fields and section names, but sized to a pane rectangle with a degradation ladder (full → title+landed → title-only → placeholder). It shares the data and the section vocabulary with `formatCard`, not its exact line assembly, because the full card's files/PRs/facts footer does not belong in a small cell. Monochrome in v1.

- [ ] **Step 1: Write the failing test**

Create `tests/overlay.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { SessionView, TmuxPane } from "../src/core/types.js";
import { cellLines, renderOverlay, type OverlayCell } from "../src/cli/overlay.js";

const NOW = new Date("2026-08-10T00:05:00.000Z");

interface ViewOverrides {
  updatedAt?: string;
  headline?: string;
  overview?: string;
  landed?: string;
  open?: string;
  nextStep?: string;
}

function view(over: ViewOverrides = {}): SessionView {
  return {
    record: {
      harness: "claude-code",
      sessionId: "abcdef12",
      filePath: "/f",
      cwd: "/repo",
      project: "webshop",
      gitBranch: null,
      startedAt: null,
      updatedAt: over.updatedAt ?? "2026-08-10T00:00:00.000Z",
      messageCount: 1,
      userPromptCount: 1,
      title: null,
      lastUserPrompt: "do the thing",
      recentUserPrompts: [],
      arcPrompts: [],
      filesTouched: [],
      prLinks: [],
      lastAssistantText: null,
      lastToolFailure: null,
      endedMidTask: false,
      isSidechain: false,
      isAutomated: false,
    },
    summary: {
      harness: "claude-code",
      sessionId: "abcdef12",
      sourceHash: "h",
      generatedAt: "2026-08-10T00:00:00.000Z",
      provider: "claude -p",
      headline: "retry fix landed",
      overview: "Making webhook retries reliable.",
      landed: "retry backoff added",
      open: "timestamp check still red",
      nextStep: "write the timestamp test",
      ...over,
    },
  };
}

function pane(over: Partial<TmuxPane>): TmuxPane {
  return { paneId: "%1", left: 0, top: 0, width: 40, height: 20, cwd: "/repo", command: "claude", ...over };
}

describe("cellLines degradation ladder", () => {
  it("renders a placeholder when there is no agent", () => {
    const lines = cellLines({ pane: pane({}), view: null, refreshing: false }, 40, 20, NOW);
    expect(lines.join("\n")).toContain("no agent here");
  });

  it("title only when the cell is one row", () => {
    const lines = cellLines({ pane: pane({}), view: view(), refreshing: false }, 40, 1, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("webshop");
  });

  it("title + landed at small heights", () => {
    const lines = cellLines({ pane: pane({}), view: view(), refreshing: false }, 40, 3, NOW);
    const text = lines.join("\n");
    expect(text).toContain("webshop");
    expect(text).toContain("retry backoff added");
  });

  it("full card includes every section at full height", () => {
    const text = cellLines({ pane: pane({}), view: view(), refreshing: false }, 40, 20, NOW).join("\n");
    expect(text).toContain("OVERALL");
    expect(text).toContain("RECENT WORK");
    expect(text).toContain("STILL OPEN");
    expect(text).toContain("NEXT STEP");
  });

  it("shows the mid-task flag", () => {
    const v = view();
    v.record.endedMidTask = true;
    const text = cellLines({ pane: pane({}), view: v, refreshing: false }, 40, 20, NOW).join("\n");
    expect(text).toContain("⚠");
  });

  it("shows a freshness age, or 'refreshing…' while a refresh is in flight", () => {
    const stale = cellLines({ pane: pane({}), view: view(), refreshing: false }, 40, 20, NOW).join("\n");
    expect(stale).toContain("5m ago");
    const busy = cellLines({ pane: pane({}), view: view(), refreshing: true }, 40, 20, NOW).join("\n");
    expect(busy).toContain("refreshing");
  });
});

describe("renderOverlay positioning", () => {
  it("clears the screen and positions each card at its pane origin", () => {
    const cells: OverlayCell[] = [
      { pane: pane({ paneId: "%1", left: 0, top: 0, width: 20, height: 10 }), view: view(), refreshing: false },
      { pane: pane({ paneId: "%2", left: 21, top: 0, width: 20, height: 10 }), view: null, refreshing: false },
    ];
    const out = renderOverlay(cells, NOW);
    expect(out.startsWith("[2J[H")).toBe(true);
    // First card's first line sits at row 1, col 1.
    expect(out).toContain("[1;1H");
    // Second card starts at col 22 (left 21 + 1).
    expect(out).toContain("[1;22H");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/overlay.test.ts`
Expected: FAIL — `src/cli/overlay.js` does not exist.

- [ ] **Step 3: Implement the renderer**

Create `src/cli/overlay.ts`:

```ts
/**
 * Draw every pane's summary card in place. Pure: given resolved cells and the
 * clock, produce one string of ANSI cursor moves that paints a full-screen
 * overlay. The command layer supplies the cells and the terminal; nothing here
 * reads tmux, stdin, or the clock on its own.
 *
 * A compact sibling of `formatCard`: same summary fields and section names,
 * sized to a rectangle with a degradation ladder — full card, then title +
 * what-landed, then just the title, then a muted placeholder for a pane with no
 * agent. Monochrome: the structure is carried by layout, so it survives a pane
 * that cannot render colour.
 */

import { relativeAge, truncate, wrapText } from "../core/text.js";
import type { SessionView, TmuxPane } from "../core/types.js";
import { indent, sessionLabel } from "./format.js";

export interface OverlayCell {
  pane: TmuxPane;
  /** null when the pane runs no resolvable agent. */
  view: SessionView | null;
  /** True while a background refresh for this session is in flight. */
  refreshing: boolean;
}

const CLEAR = "[2J[H";

function freshnessLine(cell: OverlayCell, now: Date): string {
  if (cell.refreshing) return "refreshing…";
  const summary = cell.view?.summary;
  if (!summary) return "no summary yet";
  return `${relativeAge(summary.generatedAt, now)} ago`;
}

function section(label: string, body: string, width: number): string[] {
  if (!body) return [];
  return [label, indent(wrapText(body, Math.max(1, width - 2)).join("\n")), ""];
}

function placeholder(cell: OverlayCell, width: number, height: number): string[] {
  const lines = ["· no agent here ·"];
  if (height > 1) lines.push(truncate(cell.pane.command, width));
  return lines.slice(0, Math.max(1, height));
}

export function cellLines(cell: OverlayCell, width: number, height: number, now: Date): string[] {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));

  if (!cell.view) return placeholder(cell, w, h);

  const { record, summary } = cell.view;
  const title = truncate(sessionLabel(record), w);
  if (h <= 1) return [title];

  const fresh = freshnessLine(cell, now);
  const landed = summary?.landed || summary?.headline || record.lastUserPrompt || "";

  if (h <= 4) {
    const lines = [title];
    if (h >= 3) lines.push(...wrapText(landed, w).slice(0, h - 2));
    lines.push(fresh);
    return lines.slice(0, h);
  }

  const body: string[] = [title];
  if (record.endedMidTask) body.push("⚠ ended mid-task");
  body.push(fresh, "");

  if (summary) {
    body.push(...section("OVERALL", summary.overview || summary.headline, w));
    body.push(...section("RECENT WORK", summary.landed, w));
    body.push(...section("STILL OPEN", summary.open, w));
    body.push(...section("NEXT STEP", summary.nextStep, w));
  } else {
    body.push("no summary yet — gm summarize " + record.sessionId.slice(0, 8));
  }

  return body.slice(0, h);
}

/** Clip one line to `width` display columns (no wrapping — the card already wrapped). */
function clip(line: string, width: number): string {
  return line.length > width ? line.slice(0, width) : line;
}

export function renderOverlay(cells: readonly OverlayCell[], now: Date = new Date()): string {
  const out: string[] = [CLEAR];
  for (const cell of cells) {
    const { left, top, width, height } = cell.pane;
    const lines = cellLines(cell, width, height, now);
    lines.forEach((line, i) => {
      const row = top + i + 1;
      const col = left + 1;
      out.push(`[${row};${col}H${clip(line, width)}`);
    });
  }
  return out.join("");
}
```

- [ ] **Step 4: Run the test and the full check**

Run: `npx vitest run tests/overlay.test.ts` → PASS
Run: `npm run check` → green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/overlay.ts tests/overlay.test.ts
git commit -m "feat(tmux): compact in-place overlay card renderer"
```

---

## Task 5: The `gm overlay <window>` command

**Files:**
- Create: `src/cli/commands/overlay.ts`
- Modify: `src/cli/main.ts` (register it)
- Test: `tests/overlay-command.test.ts`

**Interfaces:**
- Consumes: `listPanes` (Task 3); `prunePaneLinks` (Task 1); `resolvePanes` (Task 2); `renderOverlay`, `OverlayCell` (Task 4); `loadRecords`, `attachSummaries` (services/views); `maybeAutoSummarize`, `inProgressIds` (services/auto-summarize).
- Produces: `buildCells(resolved, views, refreshingIds): OverlayCell[]`; `registerOverlay(program: Command): void`.

Rationale for the split: `buildCells` is the one piece worth testing (pairing resolved panes with their summaries and the in-flight set); the paint/keypress/refresh loop is thin glue over Node stdin and is verified by hand.

- [ ] **Step 1: Write the failing test**

Create `tests/overlay-command.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { SessionView, TmuxPane } from "../src/core/types.js";
import type { ResolvedPane } from "../src/services/tmux-resolve.js";
import { buildCells } from "../src/cli/commands/overlay.js";

function pane(id: string, cwd: string): TmuxPane {
  return { paneId: id, left: 0, top: 0, width: 40, height: 20, cwd, command: "claude" };
}

function viewFor(sessionId: string): SessionView {
  return {
    record: {
      harness: "claude-code", sessionId, filePath: "/f", cwd: "/repo", project: "repo",
      gitBranch: null, startedAt: null, updatedAt: "2026-08-10T00:00:00.000Z", messageCount: 1,
      userPromptCount: 1, title: null, lastUserPrompt: null, recentUserPrompts: [], arcPrompts: [],
      filesTouched: [], prLinks: [], lastAssistantText: null, lastToolFailure: null,
      endedMidTask: false, isSidechain: false, isAutomated: false,
    },
    summary: null,
  };
}

describe("buildCells", () => {
  it("pairs each resolved pane with its view and marks in-flight refreshes", () => {
    const resolved: ResolvedPane[] = [
      { pane: pane("%1", "/repo"), record: viewFor("s1").record },
      { pane: pane("%2", "/plain"), record: null },
    ];
    const views = [viewFor("s1")];
    const cells = buildCells(resolved, views, new Set(["s1"]));

    expect(cells).toHaveLength(2);
    expect(cells[0]!.view?.record.sessionId).toBe("s1");
    expect(cells[0]!.refreshing).toBe(true);
    expect(cells[1]!.view).toBeNull();
    expect(cells[1]!.refreshing).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/overlay-command.test.ts`
Expected: FAIL — `src/cli/commands/overlay.js` does not exist.

- [ ] **Step 3: Implement the command**

Create `src/cli/commands/overlay.ts`:

```ts
import type { Command } from "commander";

import type { SessionView } from "../../core/types.js";
import { inProgressIds, maybeAutoSummarize } from "../../services/auto-summarize.js";
import { prunePaneLinks } from "../../services/pane-links.js";
import { listPanes, tmuxVersion, supportsDisplayPopup } from "../../services/tmux.js";
import { resolvePanes, type ResolvedPane } from "../../services/tmux-resolve.js";
import { attachSummaries, loadRecords } from "../../services/views.js";
import { renderOverlay, type OverlayCell } from "../overlay.js";

/** How often the overlay repaints while it waits, to fold in landed refreshes. */
const REPAINT_MS = 1000;

/**
 * Pair each resolved pane with its summary view and the in-flight refresh set.
 * Pure, so the pairing is tested without a terminal.
 */
export function buildCells(
  resolved: readonly ResolvedPane[],
  views: readonly SessionView[],
  refreshingIds: ReadonlySet<string>,
): OverlayCell[] {
  const bySession = new Map(views.map((v) => [v.record.sessionId, v]));
  return resolved.map(({ pane, record }) => ({
    pane,
    view: record ? bySession.get(record.sessionId) ?? { record, summary: null } : null,
    refreshing: record ? refreshingIds.has(record.sessionId) : false,
  }));
}

async function frame(windowId: string): Promise<string> {
  const panes = await listPanes(windowId);
  const links = await prunePaneLinks(panes.map((p) => p.paneId));
  const records = await loadRecords();
  const resolved = resolvePanes(panes, records, links);
  const resolvedRecords = resolved.map((r) => r.record).filter((r): r is NonNullable<typeof r> => r !== null);
  const views = await attachSummaries(resolvedRecords);
  const refreshing = await inProgressIds();
  return renderOverlay(buildCells(resolved, views, refreshing));
}

async function runOverlay(windowId: string): Promise<void> {
  const version = await tmuxVersion();
  if (!supportsDisplayPopup(version)) {
    process.stderr.write("gm overlay needs tmux >= 3.2. Run `gm doctor`.\n");
    process.exit(1);
  }

  // Kick stale cards to refresh in the background; they repaint as they land.
  // Force skips the cooldown — a keypress is an explicit request — and the lock
  // still prevents a stampede.
  const records = await loadRecords();
  await maybeAutoSummarize({ records, force: true });

  process.stdout.write(await frame(windowId));

  const timer = setInterval(() => {
    void frame(windowId).then((f) => process.stdout.write(f)).catch(() => {});
  }, REPAINT_MS);

  await new Promise<void>((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.once("data", () => resolve());
  });

  clearInterval(timer);
  process.stdout.write("[2J[H"); // Leave a clean screen as the popup closes.
  process.exit(0);
}

export function registerOverlay(program: Command): void {
  program
    .command("overlay <window>")
    .description("draw every pane's summary in place (used by the tmux ctrl-g binding)")
    .action(async (windowId: string) => {
      await runOverlay(windowId);
    });
}
```

- [ ] **Step 4: Register it in main.ts**

In `src/cli/main.ts`, add the import beside the other command imports:

```ts
import { registerOverlay } from "./commands/overlay.js";
```

and register it beside `registerPick(program);`:

```ts
registerOverlay(program);
```

- [ ] **Step 5: Run the test and the full check**

Run: `npx vitest run tests/overlay-command.test.ts` → PASS
Run: `npm run check` → green.

- [ ] **Step 6: Manual verification**

Build and drive it against a real tmux window (needs tmux ≥ 3.2):

```bash
npm run build
# In a tmux session with a couple of panes (at least one in a repo you have
# recent sessions for), from any pane:
tmux display-popup -w 100% -h 100% -B -E "node $(pwd)/dist/cli/main.js overlay $(tmux display-message -p '#{window_id}')"
```

Expected: each pane's rectangle shows its summary card (or "no agent here" for a plain shell); any key closes the popup; the underlying panes are untouched.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/overlay.ts src/cli/main.ts tests/overlay-command.test.ts
git commit -m "feat(tmux): gm overlay command paints and dismisses on any key"
```

---

## Task 6: `gm run <harness> [args…]` — exact mapping

**Files:**
- Modify: `src/adapters/types.ts` (add `launchCommand`)
- Modify: `src/adapters/claude-code.ts`, `src/adapters/codex.ts`
- Create: `src/cli/commands/run.ts`
- Modify: `src/cli/main.ts` (register it)
- Test: `tests/run-command.test.ts`

**Interfaces:**
- Consumes: `allAdapters`, `adapterById` (registry); `writePaneLink` (Task 1); `HarnessAdapter`.
- Produces: `HarnessAdapter.launchCommand: string`; `resolveHarnessArg(arg: string): HarnessAdapter | null`; `pickNewSession(before: readonly SessionRef[], after: readonly SessionRef[]): SessionRef | null`; `registerRun(program: Command): void`.

Deviation from the spec's "exec, no wrapper lingering": a harness only reveals its session id *after* it starts, and `exec` would replace this process before we could read it. So `gm run` spawns the harness as a child with inherited stdio (interactively identical) and lingers as a thin parent solely to capture the new session id and write the link. Documented here so it is a decision, not a surprise.

- [ ] **Step 1: Add `launchCommand` to the adapter seam**

In `src/adapters/types.ts`, after `processNames`, add:

```ts
  /** The binary `gm run` launches for this harness, e.g. "claude" or "codex". */
  readonly launchCommand: string;
```

In `src/adapters/claude-code.ts`:

```ts
  readonly launchCommand = "claude";
```

In `src/adapters/codex.ts`:

```ts
  readonly launchCommand = "codex";
```

- [ ] **Step 2: Write the failing test**

Create `tests/run-command.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { SessionRef } from "../src/core/types.js";
import { pickNewSession, resolveHarnessArg } from "../src/cli/commands/run.js";

function ref(sessionId: string, mtimeMs: number): SessionRef {
  return { harness: "claude-code", sessionId, filePath: `/${sessionId}`, mtimeMs, size: 1 };
}

describe("resolveHarnessArg", () => {
  it("matches a harness by its id", () => {
    expect(resolveHarnessArg("claude-code")?.id).toBe("claude-code");
  });
  it("matches a harness by a process name alias", () => {
    expect(resolveHarnessArg("claude")?.id).toBe("claude-code");
    expect(resolveHarnessArg("codex")?.id).toBe("codex");
  });
  it("returns null for an unknown harness", () => {
    expect(resolveHarnessArg("emacs")).toBeNull();
  });
});

describe("pickNewSession", () => {
  it("prefers a session id absent before launch", () => {
    const before = [ref("old", 100)];
    const after = [ref("old", 100), ref("fresh", 200)];
    expect(pickNewSession(before, after)?.sessionId).toBe("fresh");
  });
  it("falls back to the newest by mtime when no id is new", () => {
    const before = [ref("a", 100), ref("b", 100)];
    const after = [ref("a", 100), ref("b", 300)];
    expect(pickNewSession(before, after)?.sessionId).toBe("b");
  });
  it("returns null when there is nothing to pick", () => {
    expect(pickNewSession([], [])).toBeNull();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/run-command.test.ts`
Expected: FAIL — `src/cli/commands/run.js` does not exist.

- [ ] **Step 4: Implement the command**

Create `src/cli/commands/run.ts`:

```ts
import { spawn } from "node:child_process";

import type { Command } from "commander";

import { adapterById, allAdapters } from "../../adapters/registry.js";
import type { HarnessAdapter } from "../../adapters/types.js";
import type { SessionRef } from "../../core/types.js";
import { writePaneLink } from "../../services/pane-links.js";
import { dim } from "../format.js";

/** How long to watch for the harness's freshly-written session file. */
const DETECT_WINDOW_MS = 8000;
const DETECT_POLL_MS = 500;

/** Match `gm run <arg>` to a harness by id or by a process-name alias. */
export function resolveHarnessArg(arg: string): HarnessAdapter | null {
  const needle = arg.trim().toLowerCase();
  return (
    adapterById(needle) ??
    allAdapters().find((a) => a.processNames.some((n) => n.toLowerCase() === needle)) ??
    null
  );
}

/** The session the harness just started: a new id if there is one, else the newest by mtime. */
export function pickNewSession(
  before: readonly SessionRef[],
  after: readonly SessionRef[],
): SessionRef | null {
  const seen = new Set(before.map((r) => r.sessionId));
  const fresh = after.filter((r) => !seen.has(r.sessionId));
  const pool = fresh.length > 0 ? fresh : after;
  return [...pool].sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null;
}

async function captureLink(adapter: HarnessAdapter, paneId: string, before: SessionRef[]): Promise<void> {
  const deadline = Date.now() + DETECT_WINDOW_MS;
  const beforeIds = new Set(before.map((r) => r.sessionId));
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, DETECT_POLL_MS));
    try {
      const after = await adapter.listSessions();
      const hasNew = after.some((r) => !beforeIds.has(r.sessionId));
      if (!hasNew) continue;
      const picked = pickNewSession(before, after);
      if (picked) {
        await writePaneLink({ paneId, harness: adapter.id, sessionId: picked.sessionId });
        return;
      }
    } catch {
      // The harness may not have written its dir yet; keep watching.
    }
  }
}

export function registerRun(program: Command): void {
  program
    .command("run <harness> [args...]")
    .description("launch an agent and record which pane it runs in, for exact overlay mapping")
    .allowUnknownOption(true)
    .action(async (harness: string, args: string[] = []) => {
      const adapter = resolveHarnessArg(harness);
      if (!adapter) {
        process.stderr.write(
          `error  unknown harness "${harness}". Known: ${allAdapters().map((a) => a.id).join(", ")}\n`,
        );
        process.exit(2);
      }

      const paneId = process.env.TMUX_PANE;
      const before = paneId ? await adapter.listSessions().catch(() => []) : [];

      // The wrapper lingers only to capture the session id; stdio is inherited,
      // so the pane is the agent for all interactive purposes.
      const child = spawn(adapter.launchCommand, args, { stdio: "inherit" });

      if (paneId) {
        process.stderr.write(`${dim(`gm: linking pane ${paneId} to this ${adapter.displayName} session`)}\n`);
        void captureLink(adapter, paneId, before);
      }

      child.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          process.stderr.write(`error  "${adapter.launchCommand}" is not on your PATH.\n`);
          process.exit(6);
        }
        process.stderr.write(`error  ${error.message}\n`);
        process.exit(1);
      });
      child.on("close", (code) => process.exit(code ?? 0));
    });
}
```

- [ ] **Step 5: Register it in main.ts**

Add the import and the `registerRun(program);` line beside the others in `src/cli/main.ts`.

- [ ] **Step 6: Run the test and the full check**

Run: `npx vitest run tests/run-command.test.ts` → PASS
Run: `npm run check` → green.

- [ ] **Step 7: Manual verification**

```bash
npm run build
# In a tmux pane, in a repo:
node "$(pwd)/dist/cli/main.js" run claude
# Interact briefly, then peek the overlay from Task 5 — this pane should now
# resolve to the exact session, even if another session shares the cwd.
```

- [ ] **Step 8: Commit**

```bash
git add src/adapters/types.ts src/adapters/claude-code.ts src/adapters/codex.ts src/cli/commands/run.ts src/cli/main.ts tests/run-command.test.ts
git commit -m "feat(tmux): gm run records an exact pane->session link"
```

---

## Task 7: Picker bridge — resume into a new tmux window

**Files:**
- Modify: `src/cli/commands/resume.ts` (add `newWindowArgv`, `resumeInNewWindow`)
- Modify: `src/cli/commands/pick.ts` (hidden `--resume-in-window` flag)
- Test: `tests/resume-in-window.test.ts`

**Interfaces:**
- Consumes: `adapterById` (registry); `ResumeCommand` (adapters/types); `SessionRecord`.
- Produces: `newWindowArgv(resume: ResumeCommand): string[]`; `resumeInNewWindow(record: SessionRecord): Promise<void>`; a hidden `--resume-in-window` option on `gm pick`.

- [ ] **Step 1: Write the failing test**

Create `tests/resume-in-window.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { newWindowArgv } from "../src/cli/commands/resume.js";

describe("newWindowArgv", () => {
  it("builds a tmux new-window invocation in the session's cwd", () => {
    expect(
      newWindowArgv({ command: "claude", args: ["--resume", "abc"], cwd: "/my repo/app" }),
    ).toEqual(["new-window", "-c", "/my repo/app", "--", "claude", "--resume", "abc"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/resume-in-window.test.ts`
Expected: FAIL — `newWindowArgv` is not exported from `resume.js`.

- [ ] **Step 3: Implement in resume.ts**

In `src/cli/commands/resume.ts`, add these imports at the top (join the existing ones):

```ts
import { execFile } from "node:child_process";
import { adapterById } from "../../adapters/registry.js";
import type { ResumeCommand } from "../../adapters/types.js";
```

Then add, after `resumeSession`:

```ts
/**
 * The tmux argv that opens the resume command in a new window in the current
 * session. Args are passed after `--` so nothing has to be shell-escaped — tmux
 * runs the vector directly. Pure, so the shape is tested without spawning tmux.
 */
export function newWindowArgv(resume: ResumeCommand): string[] {
  return ["new-window", "-c", resume.cwd, "--", resume.command, ...resume.args];
}

/**
 * Resume a session in a NEW tmux window instead of replacing this process.
 *
 * Used only by the picker bridge (`gm pick --resume-in-window`), which runs
 * inside a `display-popup`: exec'ing the harness there would trap it in the
 * ephemeral popup, gone the moment it exits. A new window is a persistent pane.
 */
export async function resumeInNewWindow(record: SessionRecord): Promise<void> {
  const adapter = adapterById(record.harness);
  if (!adapter) {
    throw new GigamanageError(`No adapter is registered for harness "${record.harness}".`, {
      fix: "Run `gm index --rebuild`.",
    });
  }
  const argv = newWindowArgv(adapter.resumeCommand(record));
  await new Promise<void>((resolve, reject) => {
    execFile("tmux", argv, (error) => (error ? reject(error) : resolve()));
  });
}
```

- [ ] **Step 4: Wire the flag into pick.ts**

In `src/cli/commands/pick.ts`, import `resumeInNewWindow` alongside `resumeSession`:

```ts
import { resumeInNewWindow, resumeSession } from "./resume.js";
```

Add the hidden option to the `pick` command definition (after `--include-automated`):

```ts
    .option("--resume-in-window", "resume the choice in a new tmux window (used by the tmux ctrl-shift-g binding)")
```

Replace the final `await resumeSession(chosen.record);` with:

```ts
      if (options.resumeInWindow === true && process.env.TMUX) {
        await resumeInNewWindow(chosen.record);
        return;
      }
      await resumeSession(chosen.record);
```

And extend the `LsOptions` usage: the action's `options` is typed `LsOptions` — add the field to the `LsOptions` interface in `src/cli/commands/ls.ts` (find `export interface LsOptions`) with:

```ts
  resumeInWindow?: boolean;
```

- [ ] **Step 5: Run the test and the full check**

Run: `npx vitest run tests/resume-in-window.test.ts` → PASS
Run: `npm run check` → green.

- [ ] **Step 6: Manual verification**

```bash
npm run build
# Inside tmux:
tmux display-popup -w 80% -h 80% -E "node $(pwd)/dist/cli/main.js pick --resume-in-window"
# Pick a session and hit enter — it should open in a NEW tmux window, not vanish
# with the popup.
```

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/resume.ts src/cli/commands/pick.ts src/cli/commands/ls.ts tests/resume-in-window.test.ts
git commit -m "feat(tmux): picker bridge resumes into a new tmux window"
```

---

## Task 8: `gm tmux install` / `uninstall`

**Files:**
- Create: `src/cli/commands/tmux.ts`
- Modify: `src/cli/main.ts` (register it)
- Test: `tests/tmux-install.test.ts`

**Interfaces:**
- Produces: `BLOCK_START`, `BLOCK_END` constants; `bindingsBlock(): string`; `upsertBlock(existing: string, block: string): string`; `removeBlock(existing: string): string`; `registerTmux(program: Command): void`.

- [ ] **Step 1: Write the failing test**

Create `tests/tmux-install.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  BLOCK_END,
  BLOCK_START,
  bindingsBlock,
  removeBlock,
  upsertBlock,
} from "../src/cli/commands/tmux.js";

describe("tmux.conf block management", () => {
  it("appends the block when absent, preserving existing config", () => {
    const out = upsertBlock("set -g mouse on\n", bindingsBlock());
    expect(out).toContain("set -g mouse on");
    expect(out).toContain(BLOCK_START);
    expect(out).toContain("gm overlay");
    expect(out).toContain(BLOCK_END);
  });

  it("replaces an existing block in place rather than duplicating it", () => {
    const first = upsertBlock("", bindingsBlock());
    const second = upsertBlock(first, "# >>> gigamanage >>>\nbind -n C-g none\n# <<< gigamanage <<<");
    expect(second.match(/>>> gigamanage >>>/g)).toHaveLength(1);
    expect(second).toContain("bind -n C-g none");
    expect(second).not.toContain("gm overlay");
  });

  it("removes exactly the block and nothing else", () => {
    const withBlock = upsertBlock("set -g mouse on\n", bindingsBlock());
    const cleaned = removeBlock(withBlock);
    expect(cleaned).toContain("set -g mouse on");
    expect(cleaned).not.toContain("gigamanage");
  });

  it("bindings reference the overlay and the picker bridge", () => {
    const block = bindingsBlock();
    expect(block).toContain("display-popup");
    expect(block).toContain("gm overlay #{window_id}");
    expect(block).toContain("gm pick --resume-in-window");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/tmux-install.test.ts`
Expected: FAIL — `src/cli/commands/tmux.js` does not exist.

- [ ] **Step 3: Implement the command**

Create `src/cli/commands/tmux.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";

import { dim, green } from "../format.js";

export const BLOCK_START = "# >>> gigamanage >>>";
export const BLOCK_END = "# <<< gigamanage <<<";

/**
 * The bindings gm manages. `ctrl+g` peeks the overlay full-screen; `ctrl+shift+g`
 * opens the history picker, whose Enter resumes into a new window.
 */
export function bindingsBlock(): string {
  return [
    BLOCK_START,
    "# Peek every pane's summary in place; any key dismisses.",
    "bind -n C-g display-popup -w 100% -h 100% -x 0 -y 0 -B -E 'gm overlay #{window_id}'",
    "# Browse session history; Enter resumes into a new window.",
    "bind -n C-S-g display-popup -w 80% -h 80% -E 'gm pick --resume-in-window'",
    BLOCK_END,
  ].join("\n");
}

function blockRegion(text: string): { start: number; end: number } | null {
  const start = text.indexOf(BLOCK_START);
  if (start === -1) return null;
  const endMarker = text.indexOf(BLOCK_END, start);
  if (endMarker === -1) return null;
  return { start, end: endMarker + BLOCK_END.length };
}

export function upsertBlock(existing: string, block: string): string {
  const region = blockRegion(existing);
  if (!region) {
    const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    return `${existing}${sep}${block}\n`;
  }
  return existing.slice(0, region.start) + block + existing.slice(region.end);
}

export function removeBlock(existing: string): string {
  const region = blockRegion(existing);
  if (!region) return existing;
  let before = existing.slice(0, region.start);
  let after = existing.slice(region.end);
  if (before.endsWith("\n")) before = before.slice(0, -1);
  if (after.startsWith("\n")) after = after.slice(1);
  return before + (before && after ? "\n" : "") + after;
}

function confPath(): string {
  return join(homedir(), ".tmux.conf");
}

async function readConf(): Promise<string> {
  try {
    return await readFile(confPath(), "utf8");
  } catch {
    return "";
  }
}

export function registerTmux(program: Command): void {
  const tmux = program.command("tmux").description("manage gigamanage's tmux key bindings");

  tmux
    .command("install")
    .description("add the gm overlay/picker key bindings to ~/.tmux.conf")
    .action(async () => {
      await writeFile(confPath(), upsertBlock(await readConf(), bindingsBlock()), "utf8");
      process.stdout.write(`${green("installed")} bindings in ${confPath()}\n`);
      process.stdout.write(
        `${dim("reload with `tmux source-file ~/.tmux.conf`; then ctrl-g peeks, ctrl-shift-g browses")}\n`,
      );
    });

  tmux
    .command("uninstall")
    .description("remove the gigamanage block from ~/.tmux.conf")
    .action(async () => {
      await writeFile(confPath(), removeBlock(await readConf()), "utf8");
      process.stdout.write(`${green("removed")} the gigamanage block from ${confPath()}\n`);
    });
}
```

- [ ] **Step 4: Register it in main.ts**

Add the import and `registerTmux(program);` beside the others in `src/cli/main.ts`.

- [ ] **Step 5: Run the test and the full check**

Run: `npx vitest run tests/tmux-install.test.ts` → PASS
Run: `npm run check` → green.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/tmux.ts src/cli/main.ts tests/tmux-install.test.ts
git commit -m "feat(tmux): gm tmux install/uninstall manages the key bindings"
```

---

## Task 9: `gm doctor` tmux check

**Files:**
- Modify: `src/cli/commands/doctor.ts`
- Test: extend `tests/services.test.ts` is not appropriate; add `tests/doctor-tmux.test.ts` covering the pure gate only (already tested in Task 3). This task is wiring — verified by running `gm doctor`.

**Interfaces:**
- Consumes: `tmuxVersion`, `supportsDisplayPopup` (Task 3).

- [ ] **Step 1: Add the check to doctor.ts**

In `src/cli/commands/doctor.ts`, add the import:

```ts
import { supportsDisplayPopup, tmuxVersion } from "../../services/tmux.js";
```

After the `fzf` check block (the `checks.push({ name: "fzf (fuzzy picker)" … })`), add:

```ts
      const tmuxV = await tmuxVersion();
      const tmuxOk = supportsDisplayPopup(tmuxV);
      checks.push({
        name: "tmux (peek overlay)",
        ok: tmuxOk,
        optional: true,
        detail: tmuxV
          ? tmuxOk
            ? `${tmuxV.raw} — \`ctrl+g\` overlay available`
            : `${tmuxV.raw} — too old; the overlay needs tmux >= 3.2`
          : "not found — the tmux overlay (`gm tmux install`) is unavailable",
        ...(tmuxOk
          ? {}
          : { fix: tmuxV ? "Upgrade tmux to 3.2 or newer." : "brew install tmux, then `gm tmux install`." }),
      });
```

- [ ] **Step 2: Verify types and the suite still pass**

Run: `npm run check` → green (no new test needed; the gate logic is covered by `tests/tmux.test.ts`).

- [ ] **Step 3: Manual verification**

```bash
npm run build
node "$(pwd)/dist/cli/main.js" doctor
```

Expected: a "tmux (peek overlay)" line reporting your tmux version and whether the overlay is available.

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/doctor.ts
git commit -m "feat(tmux): doctor reports tmux overlay availability"
```

---

## Final integration check

- [ ] **Run the full suite and layer check:** `npm run check` → green.
- [ ] **Build:** `npm run build` → no errors.
- [ ] **End-to-end in tmux:** `gm tmux install`, reload tmux, open 2–3 panes (one `gm run claude` in a repo, one plain shell), press `ctrl+g` → each pane shows its card / placeholder in place; any key restores. Press `ctrl+shift+g` → picker opens; Enter opens the chosen session in a new window.
- [ ] **Docs:** update `README.md` with a short "tmux overlay" section (`gm tmux install`, the two shortcuts, `gm run`) and note the tmux ≥ 3.2 requirement beside the fzf/ripgrep companions. Commit.
- [ ] **Open the PR** off branch `tmux-peek-overlay` (never merge to `main` directly).
