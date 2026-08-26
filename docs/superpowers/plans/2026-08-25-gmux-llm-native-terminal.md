# gmux LLM-Native Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace gmux's tmux overlay with a PTY-owning multiplexer: Rust `gmuxd` holds terminals, the existing TypeScript daemon is the intel sidecar, and `gmux attach` is a TUI client with a sidebar funnel, `ctrl+t` peel, promptable tab grouping, a memory guardian, and idle workspace templates.

**Architecture:** Split runtime from intelligence. `gmuxd` owns PTYs, VTE grids, compact-line scrollback, tab grouping, keymap, shadow buffers, and two sockets (NDJSON control + binary frames). The existing `gmux daemon --sidecar` patches semantics onto mux panes and never sits on the `ctrl+t` fast path. v1 shows one PTY at a time; the sidebar is the multiplexer. Tabs are named groups, not tiles.

**Tech Stack:** TypeScript ESM (Node ≥ 20, Commander, Vitest) for intelligence; Rust (current stable, tokio, portable-pty, vte, ratatui, crossterm) for `gmuxd`. Unix domain sockets. No new npm runtime dependencies. `cargo test` is a separate CI job from `npm test`.

**Spec:** `/Users/jamesgao/Projects/side/gigamanage/docs/superpowers/specs/2026-08-25-gmux-llm-native-terminal-design.md`

## Global Constraints

- **Layer rule (CI-enforced by `scripts/check-layers.mjs`):** imports only flow `core ← adapters ← services ← cli`. `crates/` is outside `src/` and is exempt. Every new TS file must obey the rule; `npm run check:layers` runs inside `npm test`.
- **ESM:** `"type": "module"`. Relative imports use explicit `.js` extensions from `.ts` source.
- **TypeScript:** `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`. Indexing yields `T | undefined`.
- **Read-only on harness dirs.** Never write `~/.claude` or `~/.codex`. gmux owns `~/.cache/gmux` and `~/.config/gmux` only.
- **No test calls a real model.** Inject fakes. No test reads the real home directory (`GMUX_HOME` / XDG redirects already in `tests/setup.ts`).
- **Every new read command supports `--json`** on `SCHEMA_VERSION` (stays **1**). Organize plans use a separate `OrganizePlan.schemaVersion`.
- **Every error carries a `fix`** (`src/core/errors.ts`).
- **Recursion:** spawned processes set `GMUX_CHILD=1` via `childEnv()`. Peel depth ≥ 2 is `peel_bounded`.
- **`CONFIG_VERSION` stays 1.** Additive optional `agentHarness`. Do not bump; `parseConfig` rejects `version > CONFIG_VERSION`.
- **`TmuxGateway` stays in-tree** for existing tests. It is not a runtime flag. No `gmux.backend`.
- **Fast path survives the slow path.** `ctrl+t` spawn is mux-local. A hung sidecar cannot block peel.
- **Never paint over the PTY.** Funnel state is client-local.
- **Never intercept `/` in `pty` mode.** Mux intercepts only `ctrl+t`, `ctrl+g`, `ctrl+q`.
- **v1 visual model:** single focused PTY + sidebar rows. No in-tab splits, no `select-layout`.
- **Work on a feature branch, never `main`.** Each task below is one independently mergeable PR from the spec. Land through a PR.
- **Test commands:** `npm test` = layers + vitest. `npm run check` = layers + types + vitest. Mux: `cargo test -p gmuxd` from repo root. Single TS file: `npx vitest run tests/<file>.test.ts`.
- **Product name is gmux.** Binary stays `gmux`. Native server binary is `gmuxd`.

---

## File Structure

New and modified files. Each file has one responsibility. `crates/` is the mux; `src/` stays the intelligence sidecar.

**core/ (pure, no I/O):**
- `src/core/mux-types.ts` *(new)* — `GmuxPane`, `GridSnapshot`, `GridLine`, `SpawnOpts`, `ToolStart`, `ExtractResult`, `ContextPack`, caller-class union, ULID pane-id helpers.
- `src/core/gmux-types.ts` *(modify)* — additive `tabId` / `workspaceId` / `peelDepth` / `toolStarts` on existing types. Do not rename `PaneIdentity.paneId`.
- `src/core/organize-types.ts` *(modify, Task 8)* — v1 four-op union + `OrganizePlan.schemaVersion`. Drop `select-layout` / `swap-pane` from the live planner.
- `src/core/paths.ts` *(modify)* — `muxSocketPath()`, `muxLockPath()`, `muxFramesSocketPath(clientId)`, `intelTokenPath()`. Leave `gmuxSocketPath()` = `daemon.sock`.
- `src/core/template-types.ts` *(new, Task 12)* — template catalog types.
- `src/core/types.ts` — **do not bump** `SCHEMA_VERSION` or `CONFIG_VERSION`. Additive optional `agentHarness?: ProviderChoice` on `GmConfig`.

**services/:**
- `src/services/mux-gateway.ts` *(new)* — `MuxGateway` interface + `FakeMuxGateway`.
- `src/services/mux-client.ts` *(new, Task 5)* — NDJSON client to `mux.sock` (intel caller class).
- `src/services/prompt-extract.ts` *(new, Task 9)* — grid extractors.
- `src/services/context-pack.ts` *(new, Task 10)* — 4 KiB pack, no `readJsonl`.
- `src/services/templates.ts` *(new, Task 12)* — match loop, idle spawn.
- `src/services/daemon.ts` *(modify, Task 5)* — `gateway: MuxGateway` on the sidecar path; hang-the-sidecar peel test.
- `src/services/sensors.ts` *(modify, Task 5/12)* — `TerminalSensor` via `readGrid`; `Observation.toolStarts`.
- `src/services/organize.ts` *(modify, Task 8)* — drop `select-layout`; apply via `MuxGateway`.
- `src/services/guardian.ts` *(modify, Task 11)* — culprit label pane/tab, not `window`.
- `src/services/config.ts` *(modify, Task 9)* — parse optional `agentHarness` without bumping version.

**cli/:**
- `src/cli/commands/attach.ts` *(new, Task 2)* — spawn-or-connect `gmuxd`; later the TUI.
- `src/cli/commands/peel.ts` *(new, Task 9)* — `gmux peel --json`.
- `src/cli/commands/daemon.ts` *(modify)* — `--sidecar`, status prints mux vs intel independently.
- `src/cli/main.ts` *(modify)* — register attach/peel; hide cockpit/overlay in Task 13.
- `src/cli/commands/setup.ts` *(modify, Task 13)* — `agentHarness` question; tmux uninstall offer.
- `src/cli/commands/tmux.ts` *(modify, Task 13)* — deprecation.
- `src/cli/commands/doctor.ts` *(modify, Task 13)* — mux/intel checks.

**crates/mux/ (Rust, `gmuxd`):**
- `Cargo.toml` (workspace member), `crates/mux/Cargo.toml`, `src/main.rs`, `src/lib.rs`.
- Modules land per task: `lock`, `peer`, `protocol`, `session`, `pane`, `shadow`, `peel` (Task 2); `grid` (Task 3); `frames`, `tui` (Task 4); `keymap`, `sidebar` (Tasks 6–8).

**tests/:**
- `tests/mux-types.test.ts`, `tests/mux-gateway.test.ts`, `tests/prompt-extract.test.ts`, `tests/context-pack.test.ts`, `tests/templates.test.ts`, plus existing daemon/organize/guardian files extended.
- `tests/fixtures/grids/{claude-code,codex,shell}/` captured grids (Task 9).
- `crates/mux/tests/frame_hex.rs` (Task 4).

**Do not create:** a `gmux.backend` flag, a tiling compositor, herdr bindings, worktree-on-peel.

---

### Task 1: Mux types and `MuxGateway` seam

**Files:**
- Create: `src/core/mux-types.ts`
- Create: `src/services/mux-gateway.ts`
- Modify: `src/core/gmux-types.ts` (additive fields only)
- Modify: `src/core/paths.ts` (`muxSocketPath`, `muxLockPath`, `muxFramesSocketPath`, `intelTokenPath`)
- Modify: `src/core/types.ts` (`PaneLink` comment: pane ids become `p_<ulid>` in the live lane; do not change the type)
- Test: `tests/mux-types.test.ts`, `tests/mux-gateway.test.ts`, extend `tests/gmux-paths.test.ts`

**Interfaces:**
- Consumes: existing `PaneState`, `HarnessId`
- Produces: `GmuxPane`, `GridSnapshot`, `GridLine`, `SpawnOpts`, `ToolStart`, `MuxGateway`, `FakeMuxGateway`, path helpers below

- [ ] **Step 1: Write the failing path tests**

```ts
// tests/gmux-paths.test.ts — add
import { muxSocketPath, muxLockPath, muxFramesSocketPath, intelTokenPath, gmuxSocketPath } from "../src/core/paths.js";

it("keeps daemon.sock for leftover tmux clients and puts mux.sock beside it", () => {
  expect(gmuxSocketPath().endsWith("daemon.sock")).toBe(true);
  expect(muxSocketPath().endsWith("mux.sock")).toBe(true);
  expect(muxLockPath().endsWith("mux.lock")).toBe(true);
  expect(intelTokenPath().endsWith("intel.token")).toBe(true);
  expect(muxFramesSocketPath("c_1").endsWith("mux.frames.c_1.sock")).toBe(true);
  expect(muxSocketPath()).not.toBe(gmuxSocketPath());
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/gmux-paths.test.ts -t "keeps daemon.sock"`
Expected: FAIL — `muxSocketPath` is not exported.

- [ ] **Step 3: Add path helpers**

In `src/core/paths.ts`, next to `gmuxSocketPath()`:

```ts
export function muxSocketPath(): string {
  return join(gmuxDir(), "mux.sock");
}
export function muxLockPath(): string {
  return join(gmuxDir(), "mux.lock");
}
export function intelTokenPath(): string {
  return join(gmuxDir(), "intel.token");
}
export function muxFramesSocketPath(clientId: string): string {
  return join(gmuxDir(), `mux.frames.${clientId}.sock`);
}
```

Leave `gmuxSocketPath()` returning `daemon.sock`.

- [ ] **Step 4: Write failing mux-types tests**

```ts
// tests/mux-types.test.ts
import { describe, expect, it } from "vitest";
import { formatPaneId, parsePaneId } from "../src/core/mux-types.js";

describe("pane ids", () => {
  it("round-trips 16-byte ULID as p_ + Crockford", () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
    const id = formatPaneId(bytes);
    expect(id.startsWith("p_")).toBe(true);
    expect(parsePaneId(id)).toEqual(bytes);
  });
  it("rejects a tmux %N id", () => {
    expect(() => parsePaneId("%3")).toThrow(/p_/);
  });
});
```

- [ ] **Step 5: Implement `src/core/mux-types.ts`**

```ts
import type { HarnessId } from "./types.js";

export type CallerClass = "tui" | "intel" | "pane" | "cli";

export interface GmuxPane {
  paneId: string;       // p_ + Crockford Base32 of 16 ULID bytes
  tabId: string;
  workspaceId: string;
  cwd: string;
  argv: string[];
  pid: number;
  harness: HarnessId | null;
  sessionId: string | null;
  peelDepth: number;    // 0 for user-spawned
  templateId: string | null;
}

export interface GridLine {
  text: string;
  intensity: number[];  // DIM→0, BOLD→2, else 1; length === text length
}

export interface GridSnapshot {
  paneId: string;
  cols: number;
  rows: number;
  lines: GridLine[];
  alternateScreen: boolean;
  foregroundCommand: string;
}

export interface SpawnOpts {
  cwd: string;
  argv: string[];
  env?: Record<string, string>;
  tab?: { mode: "new"; name: string } | { mode: "existing"; tabId: string };
  /** default false. When true, sets THIS client's focusedPaneId only. */
  focus?: boolean;
  peelDepth?: number;
}

export interface ToolStart {
  callId: string;
  command: string;
  paneId: string;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function encodeCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >> bits) & 31];
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

export function decodeCrockford(s: string): Uint8Array {
  const map = new Map([...CROCKFORD].map((c, i) => [c, i]));
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase()) {
    const v = map.get(ch);
    if (v === undefined) throw new Error("invalid crockford");
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 255);
    }
  }
  return Uint8Array.from(out);
}

export function formatPaneId(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error("pane id is 16 ULID bytes");
  return "p_" + encodeCrockford(bytes);
}
export function parsePaneId(id: string): Uint8Array {
  if (!id.startsWith("p_")) throw new Error("pane id must start with p_");
  const bytes = decodeCrockford(id.slice(2));
  if (bytes.length !== 16) throw new Error("pane id must decode to 16 bytes");
  return bytes;
}
```

- [ ] **Step 6: Additive fields on `Observation` / `PaneIdentity`**

In `src/core/gmux-types.ts`, add optional fields only:

```ts
export interface Observation {
  // existing fields unchanged
  toolStarts?: ToolStart[];
}

export interface PaneIdentity {
  // existing fields unchanged
  tabId?: string;
  workspaceId?: string;
  peelDepth?: number;
}
```

Import `ToolStart` from `./mux-types.js`. Existing tests that construct `Observation` must still typecheck (optional field).

- [ ] **Step 7: Write failing `MuxGateway` tests**

```ts
// tests/mux-gateway.test.ts
import { describe, expect, it } from "vitest";
import { FakeMuxGateway } from "../src/services/mux-gateway.js";

describe("FakeMuxGateway", () => {
  it("spawn with focus:false does not change thisClient.focusedPaneId", async () => {
    const gw = new FakeMuxGateway();
    const parent = await gw.spawn({ cwd: "/tmp", argv: ["zsh"], tab: { mode: "new", name: "main" }, focus: true });
    gw.setClientFocus("c1", parent.paneId);
    const child = await gw.spawn({
      cwd: "/tmp",
      argv: ["zsh"],
      tab: { mode: "new", name: "new agent" },
      focus: false,
    });
    expect(gw.focusedPaneId("c1")).toBe(parent.paneId);
    expect(child.paneId).not.toBe(parent.paneId);
    expect(child.tabId).not.toBe(parent.tabId);
  });

  it("has no selectLayout or swapPane", () => {
    const gw = new FakeMuxGateway();
    expect("selectLayout" in gw).toBe(false);
    expect("swapPane" in gw).toBe(false);
  });
});
```

- [ ] **Step 8: Implement `MuxGateway` + `FakeMuxGateway`**

`src/services/mux-gateway.ts` — copy the interface from the spec §1 exactly:

```ts
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
}
```

`FakeMuxGateway` in the same file (or `tests/fixtures/fake-mux-gateway.ts` if you want it next to `fake-gateway.ts` — if so, `tests/` importing `src/services` is the existing pattern; keep the class exported from `mux-gateway.ts` so daemon tests inject it). Record `sent`, `spawned`, `closed`. Generate pane ids with an incrementing counter formatted via `formatPaneId` of 16 bytes `{0,0,…,n}`.

- [ ] **Step 9: Run tests and typecheck**

Run: `npx vitest run tests/mux-types.test.ts tests/mux-gateway.test.ts tests/gmux-paths.test.ts && npm run check:layers && npm run check:types`
Expected: PASS. Existing tests still pass: `npm test`.

- [ ] **Step 10: Commit on a branch**

```bash
git checkout -b feat/mux-gateway-types
git add src/core/mux-types.ts src/core/gmux-types.ts src/core/paths.ts src/core/types.ts src/services/mux-gateway.ts tests/mux-types.test.ts tests/mux-gateway.test.ts tests/gmux-paths.test.ts
git commit -m "feat(gmux): add MuxGateway and durable pane identity types"
```

---

### Task 2: Headless `gmuxd` (spawn, detach, control socket, lock)

**Files:**
- Create: `Cargo.toml` (workspace), `crates/mux/Cargo.toml`, `crates/mux/src/lib.rs`, `crates/mux/src/main.rs`
- Create: `crates/mux/src/lock.rs`, `peer.rs`, `protocol.rs`, `session.rs`, `pane.rs`, `shadow.rs`, `peel.rs`
- Create: `crates/mux/tests/lock.rs`, `peel_without_intel.rs`, `pid_class.rs`
- Modify: `src/cli/commands/attach.ts` *(new command: connect/spawn only, no TUI yet)*, `src/cli/main.ts`
- Modify: `src/cli/commands/daemon.ts` — `status` later; this task adds `gmux spawn` / `gmux panes ls` / `gmux snapshot` talking NDJSON
- Test: `npx vitest` unchanged except new CLI `--help` if you add a unit for argv; mux via `cargo test -p gmuxd`

**Interfaces:**
- Consumes: Task 1 path helpers (document the on-disk names: `mux.sock`, `mux.lock`). TS `MuxGateway` is **not** wired yet.
- Produces: running `gmuxd` binary; methods `ping`, `session.snapshot`, `pane.list`, `pane.spawn`, `pane.send_keys`, `pane.close`, `events.subscribe`, `peel` (mux-local shadow); per-client `focusedPaneId`; peer-pid classify

NDJSON request: `{"id":"1","method":"ping","params":{}}`. Reply: `{"id":"1","result":{"ok":true}}` or `{"id":"1","error":{"code":"...","message":"...","fix":"..."}}`.

- [ ] **Step 1: Write the failing lock test (Rust)**

`crates/mux/tests/lock.rs`:

```rust
#[test]
fn second_process_connects_does_not_spawn() {
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("mux.lock");
    let a = gmuxd::lock::acquire(&lock).unwrap();
    let b = gmuxd::lock::acquire(&lock);
    assert!(matches!(b, Err(gmuxd::lock::LockError::Held { .. })));
    drop(a);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p gmuxd --test lock`
Expected: FAIL — package `gmuxd` unknown.

- [ ] **Step 3: Scaffold the crate**

Root `Cargo.toml`:

```toml
[workspace]
members = ["crates/mux"]
resolver = "2"
```

`crates/mux/Cargo.toml`: name `gmuxd`, edition 2024 or current stable. Deps: `tokio` (full), `portable-pty`, `serde`, `serde_json`, `thiserror`, `ulid`, `libc`. Dev-deps: `tempfile`.

`crates/mux/src/lib.rs` `pub mod lock;` etc. `main.rs` starts tokio runtime, acquires lock, binds `mux.sock` mode 0o600.

- [ ] **Step 4: Implement lock + bind**

`lock.rs`: `O_EXCL` create of `mux.lock` containing `{"muxPid":N,"intelPid":null,"startedAt":"..."}`. If lock exists and pid is alive (`kill(pid, 0)`), return `Held`. If stale (pid dead), take over.

Unix socket bind in the gmux dir. Tests pass a temp dir via `GMUX_CACHE` or an explicit `Paths` struct — do not read the real `~/.cache/gmux` in tests.

- [ ] **Step 5: Write failing peel-without-intel test**

`crates/mux/tests/peel_without_intel.rs`:

```rust
#[tokio::test]
async fn peel_spawns_from_shadow_without_intel() {
    let h = harness::start().await; // test helper: gmuxd in-process, temp dir
    let parent = h.spawn_shell("/tmp").await;
    h.set_client_focus("c1", &parent.pane_id);
    h.write_input(&parent.pane_id, b"also fix the webhook").await;
    let t0 = std::time::Instant::now();
    let child = h.peel("c1").await.unwrap();
    assert!(t0.elapsed() < std::time::Duration::from_millis(50));
    assert_ne!(h.focused("c1"), child.pane_id);
    assert_eq!(h.focused("c1"), parent.pane_id);
    assert_ne!(child.tab_id, parent.tab_id);
}
```

- [ ] **Step 6: Implement session/pane/shadow/peel**

- `session.rs`: `Session { workspaces: HashMap<WorkspaceId, Workspace> }`. Workspace has tabs; tab has pane ids. **No global focused pane.** `Client { id, focused_pane_id, cols, rows }`.
- `pane.rs`: `portable-pty` pair, child argv, cwd, `peel_depth`, shadow `String`.
- `shadow.rs`: append printables; Backspace/Ctrl+H/W/U; reset on Enter/`\x03`. Ignore CSI/mouse.
- `peel.rs`: seed = shadow (or empty); `spawn` new tab, `argv` = cached harness or `$SHELL`, `focus: false` for this client; return immediately. **Do not** call intel.

Default empty-session bootstrap is **not** this task's TUI attach; expose `pane.spawn` only. A helper `session.ensure_workspace(cwd)` can wait for Task 4.

- [ ] **Step 7: Peer pid classification tests**

`crates/mux/tests/pid_class.rs`: table-driven on a pure function `classify(peer_pid, pane_pids: &[PidTree], has_token, env_pane_id) -> Result<CallerClass, Error>`.

Rules (spec §11):
1. `peer_pid` matches intel sidecar pid **and** token ok → `intel`.
2. `peer_pid` is in a pane process tree → `pane`. Missing/mismatch `GMUX_PANE_ID` → `permission_denied`, **never** `cli`.
3. Else same-uid → `cli`.
4. TUI identifies via `client.attach` hello, not pid.

macOS: `LOCAL_PEERPID` (`0x002` / `sys/un.h`); Linux: `SO_PEERCRED`. Put the getsockopt behind `peer.rs` with `#[cfg]`.

- [ ] **Step 8: NDJSON server**

One connection = one BufReader lines. Parse JSON. Dispatch. Intel connections are bidirectional stubs this task: accept `hello`, ignore inbound requests other than replies (full bidirectional lands Task 5). Events: write `{"event":"pane.created","body":{...}}\n` to subscribers.

Inject into every spawned process: `GMUX_SOCKET_PATH`, `GMUX_PANE_ID`, `GMUX_TAB_ID`, `GMUX_WORKSPACE_ID`.

- [ ] **Step 9: CLI `gmux spawn` / `gmux panes ls` / `gmux snapshot`**

New file `src/cli/commands/spawn.ts` (or `attach.ts` with subcommands). Spawn `gmuxd` if lock free (dev: `target/debug/gmuxd`). Speak NDJSON. `--json` on list/snapshot.

Do **not** implement ratatui. `gmux attach` may be a stub that prints `fix: this build is headless — Task 4`.

- [ ] **Step 10: Run**

Run: `cargo test -p gmuxd && npm run check`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git checkout -b feat/gmuxd-headless
git add Cargo.toml crates/mux src/cli/commands/attach.ts src/cli/commands/spawn.ts src/cli/main.ts
git commit -m "feat(mux): headless gmuxd with spawn, singleton lock, and NDJSON control socket"
```

---

### Task 3: VTE grid + compact scrollback + `pane.read`

**Files:**
- Create: `crates/mux/src/grid.rs`
- Modify: `crates/mux/src/pane.rs` (feed PTY bytes into vte)
- Test: `crates/mux/tests/grid.rs` (recorded ANSI fixtures)

**Interfaces:**
- Consumes: Task 2 pane PTY master
- Produces: `readGrid(paneId, rows?) -> GridSnapshot`; `readLines(paneId, n?) -> String`; intensity DIM→0, BOLD→2, else 1

- [ ] **Step 1: Write failing ANSI fixture test**

```rust
#[test]
fn dim_is_intensity_0_bold_is_2() {
    let mut g = gmuxd::grid::Grid::new(4, 1);
    g.feed(b"\x1b[2mdim\x1b[0m\x1b[1mB");
    let snap = g.snapshot("p_TEST", "zsh");
    assert_eq!(snap.lines[0].text.chars().next(), Some('d'));
    assert_eq!(snap.lines[0].intensity[0], 0);
    // last cell bold
    assert_eq!(*snap.lines[0].intensity.last().unwrap(), 2);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p gmuxd --test grid`
Expected: FAIL — `grid` module missing.

- [ ] **Step 3: Implement grid**

Use `vte::Parser` + a `Perform` that writes a visible `cols×rows` cell buffer (grapheme, fg, bg, attrs) and a **compact-line** scrollback (`Vec<String>`, cap 10_000). On LF while not in alternate screen, push the completed line text (not cells) onto scrollback.

`GridSnapshot.lines` is the visible rows (or last `rows` requested). `intensity[i]` parallel to `text` chars (not bytes). Inverse/RGB ignored for extract.

- [ ] **Step 4: Wire `pane.read` / `readGrid` on the control socket**

Method `pane.read` params `{ paneId, source: "grid"|"lines", lines?: n }` returns JSON matching `GridSnapshot` or `{ text }`.

- [ ] **Step 5: Run**

Run: `cargo test -p gmuxd`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git checkout -b feat/gmuxd-vte-grid
git add crates/mux
git commit -m "feat(mux): VTE grid parser and compact-line scrollback"
```

---

### Task 4: Full-bleed attach TUI + data plane

**Files:**
- Create: `crates/mux/src/frames.rs`, `crates/mux/src/tui.rs`
- Create: `crates/mux/tests/frame_hex.rs`
- Modify: `src/cli/commands/attach.ts` — exec TUI / `gmuxd attach`
- Test: `cargo test -p gmuxd --test frame_hex`

**Interfaces:**
- Consumes: Task 2 session, Task 3 grid
- Produces: `client.attach`; `mux.frames.<id>.sock`; closed little-endian frame packet; `Input`/`Resize`/`FrameAck`/`Mouse`; empty attach bootstrap; `ctrl+q` detach; skip-if-behind

- [ ] **Step 1: Write the annotated hex fixture (failing)**

`crates/mux/tests/frame_hex.rs` — a 2×1 **full** frame, two cells `"A"` (fg default) and `"B"`:

```rust
#[test]
fn full_frame_2x1_is_length_prefixed_le() {
    let bytes = gmuxd::frames::encode_full(
        /*cols*/ 2, /*rows*/ 1, /*seq*/ 1,
        /*pane ulid 16 bytes*/ &[0u8; 16],
        &[cell("A"), cell("B")],
    );
    // u32le length, then type=1, kind=0, cols=2, rows=1, seq=1, pane_id, nrects=1, rect, cells
    assert_eq!(&bytes[4..6], &[1u8, 0u8]); // type, kind — after length
    let nrects = u32::from_le_bytes(bytes[4+1+1+2+2+4+16..].try_into().unwrap()[..4].try_into().unwrap());
    // Prefer parsing with the same decoder rather than magic offsets in comments only.
    let f = gmuxd::frames::decode(&bytes).unwrap();
    assert_eq!(f.kind, gmuxd::frames::Kind::Full);
    assert_eq!(f.nrects, 1);
    assert_eq!(f.cols, 2);
    assert_eq!(f.rows, 1);
}
```

Packet layout is the spec §1 data plane. `glen` 0..8. All multi-byte little-endian. `pane_id` is raw 16 ULID bytes.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p gmuxd --test frame_hex`
Expected: FAIL — `frames` missing.

- [ ] **Step 3: Implement encoder/decoder + skip-if-behind**

If `seq - last_ack > 1`, drop pending dirty rects, next frame `kind = full`. Never unbounded dirty backlog. Stream **this client's focused pane only**.

- [ ] **Step 4: Empty attach bootstrap**

On `client.attach` with empty session:
1. `workspaceId` = `ws_` + 12-char hex of SHA-256(git root or cwd)
2. tab `main`
3. `spawn({ argv: [$SHELL], cwd, tab: existing main, focus: true })` — sets **this** client's focus
4. open `mux.frames.<clientId>.sock` mode 0o600

- [ ] **Step 5: ratatui full-bleed (no sidebar yet)**

Content region = full terminal. PTY winsize = terminal size. `ctrl+q` detaches (does not SIGHUP). SIGWINCH → `Resize` for this client. Mouse in content region forwarded only if the pane requested mouse tracking (stub: off until Task 6).

Two attaches: each has its own `focusedPaneId` and frame socket.

- [ ] **Step 6: Run**

Run: `cargo test -p gmuxd && npm run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git checkout -b feat/gmux-attach-tui
git add crates/mux src/cli/commands/attach.ts
git commit -m "feat(mux): gmux attach TUI with private frame socket"
```

---

### Task 5: Intelligence sidecar on mux (not tmux)

**Files:**
- Modify: `src/services/daemon.ts`, `src/cli/commands/daemon.ts`
- Create: `src/services/mux-client.ts`
- Modify: `src/services/sensors.ts` (`TerminalSensor` uses `readGrid`; drop `startPipe` on this path)
- Modify: `src/services/pane-registry.ts` (list via `MuxGateway`)
- Test: `tests/daemon.test.ts`, `tests/daemon-wiring.test.ts`, new `tests/mux-client.test.ts`

**Interfaces:**
- Consumes: `MuxGateway` (Task 1 fake in tests; Task 2 socket in integration), `readGrid` (Task 3)
- Produces: intel `hello` with token; bidirectional RPC (`prompt.extract` stub, `context.pack` stub, `organize.plan` stub, `classify.intent` stub — real impl later tasks); `session.snapshot` mux-assembled; `gmux daemon status` prints mux vs intel; hang-sidecar + peel still spawns

Method ownership (implement the table in `mux-client.ts` comments and in `protocol.rs`):

| Method | Owner |
|---|---|
| `ping`, `pane.spawn`, `pane.close`, `tab.close`, `peel` (fast), `pane.send_keys`, `pane.list`, `session.snapshot`, `client.attach` | mux |
| `prompt.extract`, `context.pack`, `organize.plan`, `classify.intent` | intel (mux originates, intel replies on `id`) |
| `pane.report_semantics` | intel → mux |

Deadlines: extract 20 ms, pack 500 ms, `classify.intent` 30_000 (`CLASSIFY_TIMEOUT_MS` in `src/services/ask-router.ts`), `organize.plan` 120_000 (`ORGANIZE_TIMEOUT_MS` in `src/services/organize.ts`).

- [ ] **Step 1: Write failing sidecar status test**

```ts
// tests/cli-daemon.test.ts — add
it("status prints mux and intel independently", async () => {
  // with a fake lock { muxPid: 1, intelPid: null }
  const out = renderStatus({ mux: { up: true, pid: 1 }, intel: { up: false, pid: null } });
  expect(out).toMatch(/mux: up \(pid 1\)/);
  expect(out).toMatch(/intel: down/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/cli-daemon.test.ts -t "status prints mux"`
Expected: FAIL.

- [ ] **Step 3: `mux-client.ts` NDJSON + bidirectional**

Fake in tests: a loopback pair. Real: connect `muxSocketPath()`, send `hello` `{ class: "intel", token }`. Token file mode 0o600 minted by gmuxd.

- [ ] **Step 4: Switch DaemonDeps gateway type on the sidecar path**

```ts
export interface DaemonDeps {
  gateway: MuxGateway; // sidecar
  // ...
}
```

Keep a second constructor path or a wrapper **only if** existing tmux daemon tests would otherwise break. Spec: `TmuxGateway` unused by the new daemon, kept for old tests. Split: `src/services/daemon.ts` stays tmux for `gmux daemon` without `--sidecar`; `--sidecar` uses `SidecarDaemon` in `src/services/sidecar-daemon.ts` that takes `MuxGateway`. Do **not** introduce `gmux.backend`.

`TerminalSensor` for sidecar: `readGrid` → `tailLines` from `lines[].text`; no `startPipe`.

- [ ] **Step 5: Hang-the-sidecar peel test**

Reuse Task 2's `peel_without_intel` (already cargo). Add a TS test that FakeMuxGateway.peel does not await a hanging extract mock:

```ts
it("peel does not await extract", async () => {
  const gw = new FakeMuxGateway();
  const extract = new Promise(() => {}); // never resolves
  const parent = await gw.spawn({ cwd: "/t", argv: ["zsh"], focus: true });
  gw.setClientFocus("c1", parent.paneId);
  const started = Date.now();
  await gw.peel("c1"); // must not take extract
  expect(Date.now() - started).toBeLessThan(50);
  void extract;
});
```

Implement `FakeMuxGateway.peel` as spawn-from-shadow, focus unchanged.

- [ ] **Step 6: Authority merge**

Mux owns layout + identity. Intel patches `state` / `semantics` / `resources` / `guardianLog` by `paneId`. `session.snapshot` is mux-assembled (mux layout, intel patches). No second snapshot socket on `daemon.sock`.

Mux-only glyphs when intel down: `{working, idle}` from PTY byte activity using `WORKING_WINDOW_MS` (10_000). `waiting`/`error`/`done` freeze last known.

- [ ] **Step 7: Run**

Run: `npx vitest run tests/cli-daemon.test.ts tests/daemon.test.ts tests/mux-gateway.test.ts && cargo test -p gmuxd && npm run check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git checkout -b feat/intel-sidecar-on-mux
git add src/services/daemon.ts src/services/sidecar-daemon.ts src/services/mux-client.ts src/services/sensors.ts src/cli/commands/daemon.ts tests
git commit -m "feat(daemon): intel sidecar patches mux panes"
```

---

### Task 6: Native sidebar chrome (glance, all panes)

**Files:**
- Create: `crates/mux/src/sidebar.rs`, `crates/mux/src/keymap.rs`
- Modify: `crates/mux/src/tui.rs`
- Test: `crates/mux/src/sidebar.rs` unit tests (pure layout → lines)

**Interfaces:**
- Consumes: `session.snapshot` (Task 5)
- Produces: 40-col sidebar + one PTY; click-to-focus; `ctrl+g` from `pty` → `sidebar`; mouse hit-test; lists **all** panes, agents first (`harness != null`), then templates, then idle shells; guardian log pin

Glyphs (keep in sync with `src/cli/tmux-label.ts` `stateGlyph`): `●` working · `◔` waiting · `✗` error · `✓` done · `○` idle.

- [ ] **Step 1: Write failing glance render test**

```rust
#[test]
fn glance_row_is_glyph_and_headline() {
    let row = sidebar::glance_row(&PaneRow {
        state: "working",
        headline: "wiring checkout retry",
        name: "webshop",
        is_agent: true,
    });
    assert_eq!(row, "● webshop  wiring checkout retry");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p gmuxd glance_row`
Expected: FAIL.

- [ ] **Step 3: Implement sidebar list + input mode**

Modes: `pty | sidebar | prompt | drawer`. From `pty`, intercept **only** `ctrl+t`, `ctrl+g`, `ctrl+q`. `ctrl+g` lands in `sidebar` (not prompt). Esc from sidebar → `pty`. `/` not intercepted in `pty`.

Mouse: x < sidebar width → chrome (select row). x ≥ sidebar width → content; forward SGR only if that pane requested mouse tracking.

PTY winsize = terminal cols − 40, rows = terminal rows. Prompt lives **in** the sidebar (not yet interactive — that's Task 8); this task draws a dim footer `>`.

- [ ] **Step 4: Run**

Run: `cargo test -p gmuxd`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/tui-sidebar-glance
git add crates/mux
git commit -m "feat(tui): always-on sidebar with glance rows"
```

---

### Task 7: Funnel (focus + dive), client-local

**Files:**
- Modify: `crates/mux/src/sidebar.rs`, `keymap.rs`
- Test: `crates/mux/src/sidebar.rs` (expansion is local state, not a mux layout RPC)

**Interfaces:**
- Consumes: `PaneSemantics.label` (headline), summary fields when present (`overview`, `summary`, `landed`, `open`, `nextStep`) on the intel patch
- Produces: one expanded overview; Enter opens drawer; Esc closes drawer → overview → glance; never paints the PTY region

- [ ] **Step 1: Write failing funnel tests**

```rust
#[test]
fn only_one_row_expands() {
    let mut f = Funnel::new(vec!["a", "b"]);
    f.select(0);
    f.select(1);
    assert!(f.expanded() == Some(1));
    assert!(f.drawer().is_none());
}

#[test]
fn enter_opens_drawer_esc_collapses() {
    let mut f = Funnel::new(vec!["a"]);
    f.select(0);
    f.enter();
    assert!(f.drawer().is_some());
    f.esc();
    assert!(f.drawer().is_none());
    f.esc();
    assert!(f.expanded().is_none());
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p gmuxd only_one_row`
Expected: FAIL.

- [ ] **Step 3: Implement**

`j`/`k` in `sidebar` move selection. Printable keys from sidebar focus `prompt` (Task 8 will consume them; this task stores `pending_prompt: String` or switches mode). Funnel state is **not** sent to the server. Drawer renders inside the sidebar (summary / landed / open / next), not over the PTY.

- [ ] **Step 4: Run + commit**

```bash
git checkout -b feat/tui-sidebar-funnel
git add crates/mux
git commit -m "feat(tui): sidebar funnel — overview expand and summary drawer"
```

---

### Task 8: gmux prompt + organize grouping apply

**Files:**
- Modify: `src/core/organize-types.ts`, `src/services/organize.ts`, `src/cli/organize-confirm.ts`, `src/cli/commands/organize.ts`
- Modify: `crates/mux/src/tui.rs` (prompt input)
- Modify: intel `classify.intent` / `organize.plan` (existing `src/services/ask-router.ts` + `LlmOrganizePlanner`)
- Test: `tests/organize.test.ts`, `tests/organize-confirm.test.ts`, `tests/ask-router.test.ts`

**Interfaces:**
- Consumes: `MuxGateway.newTab/renameTab/movePane/breakPane`
- Produces: `OrganizePlan.schemaVersion = 2`; ops `new-tab` | `rename-tab` | `move-pane` | `break-pane` only; **`SCHEMA_VERSION` stays 1**

- [ ] **Step 1: Write failing organize-type tests**

```ts
// tests/organize.test.ts — add
it("v2 plan has schemaVersion 2 and no select-layout", async () => {
  const planner = new HeuristicOrganizePlanner();
  const plan = await planner.plan([
    pane({ paneId: "p_A", cwd: "/r/web", harness: "claude-code" }),
    pane({ paneId: "p_B", cwd: "/r/web", harness: "claude-code" }),
    pane({ paneId: "p_C", cwd: "/r/bill", harness: "codex" }),
  ]);
  expect(plan.schemaVersion).toBe(2);
  expect(plan.steps.some((s) => s.op === "select-layout" || s.op === "swap-pane" || s.op === "new-window")).toBe(false);
  expect(plan.steps.every((s) => ["new-tab", "rename-tab", "move-pane", "break-pane"].includes(s.op))).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/organize.test.ts -t "schemaVersion 2"`
Expected: FAIL — no `schemaVersion`, ops still `new-window`.

- [ ] **Step 3: Change the tagged union**

```ts
export type TabTarget = { kind: "tab"; tabId: string } | { kind: "handle"; handle: string };

export type OrganizeStep =
  | { op: "new-tab"; handle: string; name: string; description: string }
  | { op: "rename-tab"; tab: TabTarget; name: string; description: string }
  | { op: "move-pane"; paneId: string; to: TabTarget; description: string }
  | { op: "break-pane"; paneId: string; handle: string; name?: string; description: string };

export interface OrganizePlan {
  schemaVersion: number;
  summary: string;
  steps: OrganizeStep[];
}

export const ORGANIZE_PLAN_SCHEMA_VERSION = 2;
```

Delete `LAYOUTS` / `select-layout` / `swap-pane` from this file. `parseOrganizePlan` drops unknown ops (keep that behavior). Do **not** touch `SCHEMA_VERSION` in `types.ts`.

`applyPlan` calls `MuxGateway` (inject it). Heuristic planner groups by `basename(cwd)` into tabs, same as today's window grouping, without a tiled layout step.

Unattended regrouping is forbidden: classify+plan run only because the user typed in the gmux prompt (or `gmux organize`).

- [ ] **Step 4: Prompt in sidebar**

Typing in `sidebar` focuses `prompt`. Enter with generation guard (`organize-confirm.ts` `makeGeneration` / `confirmKey`) in the drawer. Esc cancels. Dry-run default; apply only on confirm.

- [ ] **Step 5: Run + commit**

```bash
npx vitest run tests/organize.test.ts tests/organize-confirm.test.ts tests/ask-router.test.ts
git checkout -b feat/organize-tabs
git add src/core/organize-types.ts src/services/organize.ts src/cli crates/mux tests
git commit -m "feat(tui): sidebar prompt; organize tabs (no tiling)"
```

---

### Task 9: Prompt extractors + peel submit/clear (slow path)

**Files:**
- Create: `src/services/prompt-extract.ts`
- Create: `tests/prompt-extract.test.ts`
- Create: `tests/fixtures/grids/claude-code/boxed.json`, `tests/fixtures/grids/codex/caret.json`, `tests/fixtures/grids/shell/ps1.json`
- Modify: `src/services/config.ts` (optional `agentHarness`)
- Create: `src/cli/commands/peel.ts` (`gmux peel --json`)
- Modify: `crates/mux/src/peel.rs` (clearKeys, abort-submit-if-uncleared, 20 ms extract timeout)
- Test: cargo peel failure-matrix + vitest extractors

**Interfaces:**
- Consumes: `GridSnapshot` (Task 1/3)
- Produces: `ExtractResult`; parent clear; harness submit of seed; `agentHarness?` on config; `ctrl+shift+t` alias (same peel; does not replace `ctrl+t`)

- [ ] **Step 1: Write failing extractor tests**

```ts
// tests/prompt-extract.test.ts
import { readFileSync } from "node:fs";
import { extract } from "../src/services/prompt-extract.js";
import type { GridSnapshot } from "../src/core/mux-types.js";

function load(p: string): GridSnapshot {
  return JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")) as GridSnapshot;
}

it("claude boxed composer is high confidence and strips placeholder", () => {
  const r = extract(load("./fixtures/grids/claude-code/boxed.json"));
  expect(r.extractor).toBe("claude-code");
  expect(r.confidence).toBe("high");
  expect(r.text).toBe("also fix the webhook");
  expect(r.clearKeys.includes("\x15")).toBe(true);
});

it("codex prefers the caret line", () => {
  const r = extract(load("./fixtures/grids/codex/caret.json"));
  expect(r.extractor).toBe("codex");
  expect(r.text).toContain("webhook");
});

it("shell strips a simple PS1", () => {
  const r = extract(load("./fixtures/grids/shell/ps1.json"));
  expect(r.extractor).toBe("shell");
  expect(r.confidence).toBe("low");
  expect(r.text).toBe("echo hi");
});

it("unknown TUI returns empty", () => {
  const r = extract({
    paneId: "p_x", cols: 4, rows: 1,
    lines: [{ text: "????", intensity: [1, 1, 1, 1] }],
    alternateScreen: true, foregroundCommand: "vim",
  });
  expect(r.text).toBe("");
  expect(r.extractor).toBe("empty");
});
```

Hand-build the three JSON fixtures from the spec's box/caret/PS1 rules (synthetic is fine until a captured dump exists; add at least one **captured** fixture per harness before calling npm default — for this PR, synthetic + a comment `CAPTURE: replace with a live dump` is acceptable if the boxed geometry matches Claude's real `╭`/`│`/`╰` frame). Prefer capturing.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/prompt-extract.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement extractors** as specified in spec §2 (Claude box scan, Codex caret, shell PS1). Confidence: box+interior match = high; shell/shadow = low. DIM interior-only rows dropped.

- [ ] **Step 4: `parseConfig` optional `agentHarness`**

Keep `CONFIG_VERSION === 1`. If `agentHarness` absent, undefined. If present, must be a `ProviderChoice` or the file is untrusted (`null`). Never treat missing as `provider`.

- [ ] **Step 5: Failure matrix (Rust)**

Implement the spec table: empty seed → spawn blank; intel down → shadow; extract timeout 20 ms → shadow; uncleared parent → **no submit**; peel depth ≥ 2 → `peel_bounded`; harness missing → `$SHELL` + status.

Clear then submit, never the reverse. Re-read **mux** grid (no intel) to confirm the seed substring is gone.

- [ ] **Step 6: `gmux peel --json`**

CLI from `cli` class peels specified `paneId` or the most recently attached TUI's focus. Envelope stays `SCHEMA_VERSION` 1: `{ paneId, tabId, submitted: boolean, extractor }`.

- [ ] **Step 7: Run + commit**

```bash
npx vitest run tests/prompt-extract.test.ts tests/config.test.ts && cargo test -p gmuxd
git checkout -b feat/peel-extractors
git add src/services/prompt-extract.ts src/services/config.ts src/cli/commands/peel.ts tests/fixtures/grids crates/mux
git commit -m "feat(peel): grid extractors, parent clear, harness submit"
```

---

### Task 10: Context pack

**Files:**
- Create: `src/services/context-pack.ts`
- Test: `tests/context-pack.test.ts`

**Interfaces:**
- Consumes: cached `SessionSummary` via `attachSummaries` / `summaryPath`; `recentUserPrompts` (ring of **12**, use last **3**); `lastAssistantText` already truncated to 1500 in adapters — clip to 800 in the pack; Codex prompts are **not** `humanText()`-filtered
- Produces: `ContextPack` UTF-8 ≤ 4096; never `readJsonl` on this path; 500 ms then seed+headline; no late second submit; uncleared parent → pack dropped

Pack prompt body (spec):

```
## Task
<seed>

## Parent context (background only)
headline: ...
overview: ...
recent:
- human: ...
- assistant: ...
```

Drop order if over 4096: oldest human turn, then clip assistant tail, then drop overview, then drop headline. Seed never clipped below 512; if seed is huge, clip seed to 2048 and skip the rest.

- [ ] **Step 1: Write failing tests**

```ts
it("does not import readJsonl", async () => {
  const src = await import("node:fs/promises").then(async () =>
    (await import("node:fs/promises")).readFile(
      new URL("../src/services/context-pack.ts", import.meta.url),
      "utf8",
    ),
  );
  expect(src).not.toMatch(/readJsonl/);
});

it("caps at 4096 and keeps the seed", () => {
  const pack = buildContextPack({
    seed: "x".repeat(600),
    parentHeadline: "h",
    parentOverview: "o".repeat(3000),
    recentTurns: [
      { role: "human", text: "a".repeat(2000) },
      { role: "assistant", text: "b".repeat(2000) },
    ],
    parentPaneId: "p_1",
  });
  expect(Buffer.byteLength(serializePack(pack), "utf8")).toBeLessThanOrEqual(4096);
  expect(pack.seed.length).toBeGreaterThanOrEqual(512);
});
```

- [ ] **Step 2–4: Implement, run, commit**

```bash
npx vitest run tests/context-pack.test.ts
git checkout -b feat/peel-context-pack
git add src/services/context-pack.ts tests/context-pack.test.ts
git commit -m "feat(peel): bounded parent context pack"
```

---

### Task 11: Guardian via mux `send_keys`

**Files:**
- Modify: `src/services/guardian.ts` (culprit label), `src/services/daemon.ts` / `sidecar-daemon.ts` send loop
- Test: `tests/guardian.test.ts`, `tests/daemon-guardian.test.ts`

**Interfaces:**
- Consumes: `Guardian.decide` (pure, unchanged policy), `MuxGateway.send`
- Produces: broadcast only to `identity.harness && identity.sessionId`; cooldown/hysteresis; no broadcast if intel down; message uses pane/tab not `window`

- [ ] **Step 1: Write failing label test**

```ts
it("names the culprit as a pane/tab, not a tmux window", () => {
  const g = new Guardian({ policy: "auto", threshold: 0.9, cooldownSeconds: 300 });
  const d = g.decide(host(0.92), [hogPane({ tabId: "t_web", paneId: "p_1", rss: 4_300_000_000 })], 1_000);
  expect(d.message).not.toMatch(/window `/);
  expect(d.message).toMatch(/top consumer:.*web/);
});
```

- [ ] **Step 2: Implement + ACL**

Sidecar send uses intel class (allowed `pane.send_keys` to **agent** panes only). If intel is down, mux does not invent a broadcast.

- [ ] **Step 3: Run + commit**

```bash
npx vitest run tests/guardian.test.ts tests/daemon-guardian.test.ts
git checkout -b feat/guardian-mux-send
git add src/services/guardian.ts src/services/sidecar-daemon.ts tests
git commit -m "feat(guardian): checkpoint-and-pause through MuxGateway"
```

---

### Task 12: Workspace templates (idle shells)

**Files:**
- Create: `src/core/template-types.ts`, `src/services/templates.ts`
- Modify: `src/services/sensors.ts` (`toolStarts` on AgentSensor)
- Modify: adapters only if the parser lives next to fixtures — prefer `src/services/templates.ts` parsing `tool_use` / `function_call` from existing `tailLines` **or** a typed field filled in AgentSensor from the JSONL row
- Test: `tests/templates.test.ts`; fixtures next to `tests/fixtures/build.ts` (one Claude Bash `tool_use`, one Codex `function_call` `name: "shell"` `arguments.cmd`)

**Interfaces:**
- Consumes: `ToolStart { callId, command, paneId }`
- Produces: idle `$SHELL` titled `tests`/`logs`/`review`; **no argv re-exec**; first-match-wins; one live pane per `(workspaceId, templateId)`; cooldown 60 s after close; `gmux spawn --template`

Catalog (spec):
- `tests` — match `jest|vitest|pytest|cargo test|go test|npm test|pnpm test`
- `logs` — match `pnpm dev|npm run dev|vite|next dev` **or** tail tools; spawn idle shell titled `logs` (do not run the command)
- `review` — case-insensitive `\b(pr|pull request|review)\b` on `headline + " " + overview` (no extra model call)

JSON paths:
- Claude: `message.content[]` `type=="tool_use"` → `id` + `name=="Bash"` → `input.command`
- Codex: `function_call` → `name: "shell"` → `arguments.cmd` (string)

- [ ] **Step 1: Write failing tests**

```ts
it("does not re-exec captured argv", () => {
  const acts = decideTemplates({
    workspaceId: "ws_1",
    live: [],
    starts: [{ callId: "1", command: "pnpm dev", paneId: "p_a" }],
    seen: new Set(),
  });
  expect(acts[0]?.argv).toEqual([process.env.SHELL ?? "/bin/zsh"]);
  expect(acts[0]?.title).toBe("logs");
});

it("dedups on callId and (workspaceId, templateId)", () => {
  const seen = new Set(["1"]);
  const acts = decideTemplates({
    workspaceId: "ws_1",
    live: [{ templateId: "logs", workspaceId: "ws_1" }],
    starts: [{ callId: "1", command: "pnpm dev", paneId: "p_a" }],
    seen,
  });
  expect(acts).toEqual([]);
});

it("review matches headline/overview regex only", () => {
  expect(reviewHit("fix login", "open PR 12")).toBe(true);
  expect(reviewHit("wiring checkout", "tests going green")).toBe(false);
});
```

- [ ] **Step 2: Implement + AgentSensor field**

`Observation.toolStarts` filled from new JSONL rows. This is new sensor work, not a reuse of `hasToolError`.

Spawn via `MuxGateway.spawn({ argv: [$SHELL], cwd: parent.cwd, tab: { mode: "new", name: title }, focus: false })`. Never change any client's focus.

- [ ] **Step 3: Run + commit**

```bash
npx vitest run tests/templates.test.ts tests/sensors.test.ts
git checkout -b feat/workspace-templates
git add src/core/template-types.ts src/services/templates.ts src/services/sensors.ts tests
git commit -m "feat(templates): idle tests/logs/review panes on tool-start"
```

---

### Task 13: Agent ACL, `--json` parity, tmux deprecation

**Files:**
- Modify: `crates/mux/src/peer.rs` (enforce classify-by-pid in production paths; tests already in Task 2)
- Modify: `src/cli/commands/setup.ts`, `tmux.ts`, `doctor.ts`, `main.ts`
- Modify: `README.md`, `docs/gmux.md`
- Test: `tests/setup.test.ts`, `tests/tmux-install.test.ts`, `tests/gmux-docs.test.ts` if present

**Interfaces:**
- Consumes: all prior
- Produces: pane cannot `organize.apply` or `send_keys` siblings; `gmux setup` asks `agentHarness`; offers `gmux tmux uninstall`; hide `cockpit`/`overlay` from `--help` (commands may remain hidden for one release); doctor checks mux binary + socket; README: Ghostty/iTerm are the emulator; experimental until Task 9 fixtures exist

- [ ] **Step 1: Write failing ACL test (if not already green from Task 2)**

```rust
#[test]
fn unsetting_gmux_pane_id_is_denied_not_cli() {
    let class = classify(/* pane-tree pid */ 42, /* trees */ &[pid_tree(42)], /*token*/ false, /*env*/ None);
    assert!(matches!(class, Err(Error::PermissionDenied)));
}
```

- [ ] **Step 2: Setup + doctor + hide overlay**

`gmux cockpit` / `gmux overlay` exit 2 with `fix: use gmux attach`. `tmux install` prints deprecation. Docs: finish work in tmux, uninstall, attach.

- [ ] **Step 3: Run full check**

Run: `npm run check && cargo test -p gmuxd`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git checkout -b feat/mux-acl-and-tmux-deprecation
git add src/cli README.md docs/gmux.md crates/mux tests
git commit -m "feat(api): caller ACL, tmux uninstall path, experimental gate docs"
```

---

## Parallelism after Task 5

```
5 (sidecar)
 ├─ 6 → 7 → 8   chrome
 ├─ 9 → 10      peel slow path
 ├─ 11          guardian
 └─ 12          templates (needs 6 for visible rows)
13 last
```

Task 2 already has mux-local peel. Tasks 9–10 only make submit/pack correct.

---

## Self-review (spec coverage)

| Spec requirement | Task |
|---|---|
| Rust gmuxd + TS intel split | 2, 5 |
| Single-PTY + sidebar groups | 4, 6 |
| Per-client focus | 2, 4 |
| mux.sock vs leftover daemon.sock | 1, 5 |
| Binary data plane, skip-if-behind | 4 |
| Bidirectional mux→intel RPC | 5, 8, 9 |
| Pid-first ACL, LOCAL_PEERPID | 2, 13 |
| `ctrl+t` mux-local spawn < 50 ms | 2, 9 |
| Extract 20 ms, clear-then-submit, failure matrix | 9 |
| Context pack 4 KiB, no JSONL | 10 |
| Funnel glance/overview/drawer, never over PTY | 6, 7 |
| `/` not stolen in pty; `ctrl+g` → sidebar | 6, 7 |
| Organize four grouping ops, schemaVersion 2, SCHEMA_VERSION 1 | 8 |
| Guardian via send_keys, pane/tab label | 11 |
| Idle templates, callId dedup, no re-exec | 12 |
| Empty attach bootstrap | 4 |
| Clean tmux break, history lane rollback | 13 |
| `agentHarness` ≠ `provider`, CONFIG_VERSION 1 | 9, 13 |
| `ctrl+shift+t` alias | 9 |
| Fetch-if-missing triples | 13 (docs); binary shipping can follow attach once CI produces artifacts |
| Rejected: herdr-as-mux, wrap, ghost-complete, tiling, dual backend | not implemented |

No TBD placeholders. Types in later tasks match Task 1 (`GmuxPane`, `SpawnOpts.focus`, `GridSnapshot.intensity`).
