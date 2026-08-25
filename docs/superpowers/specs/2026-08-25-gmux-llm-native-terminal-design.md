# gmux — the LLM-native terminal

**Date:** 2026-08-25
**Status:** Draft
**Author:** gmux
**Supersedes:** [`/Users/jamesgao/Projects/side/gigamanage/docs/superpowers/specs/2026-08-11-gmux-design.md`](/Users/jamesgao/Projects/side/gigamanage/docs/superpowers/specs/2026-08-11-gmux-design.md) (Stage A: awareness layer on stock tmux; Stage C deferred)

**Canonical code + spec:** [`/Users/jamesgao/Projects/side/gigamanage`](/Users/jamesgao/Projects/side/gigamanage) (`@gigaflow/gmux` 0.16.0). Implement here. This file also lives at `docs/superpowers/specs/2026-08-25-gmux-llm-native-terminal-design.md` in that repo.

**Mirrors (not a second codebase):** `/Users/jamesgao/Projects/gigamanage` contains only this spec copy — no `src/`, no package. If copies drift, `side/gigamanage` wins.

---

## Overview

gmux today is an awareness layer on tmux: a TypeScript daemon (`gmux daemon`) talks to tmux through `TmuxGateway` (`src/services/tmux-gateway.ts`), classifies panes, paints border labels and a `ctrl+g` cockpit overlay, and — with consent — broadcasts a checkpoint into agent panes when host memory is critical. That architecture cannot express the product. Stock tmux cannot weave native chrome into the grid, cannot intercept an unsubmitted prompt inside an alternate-screen TUI, and cannot keep agents alive independently of a tmux client in a way gmux owns.

This redesign **pulls Stage C forward**. gmux becomes the multiplexer: a server owns the PTYs; every UI is a client; detach does not kill agents; language is the layout interface; thought-peel (`ctrl+t`) delegates the unsubmitted prompt to a new agent without stealing focus. We explicitly reject forking tmux. Intelligence — summaries, organize, adapters, guardian policy — stays in the existing TypeScript services. The runtime (PTY, grid, TUI, sockets) is a new process-separated mux core.

v1 visual model is **single-PTY + sidebar rows**. The sidebar *is* the multiplexer. Tabs group panes; they do not tile. The TUI shows one focused PTY at a time.

Inspiration is herdr.dev (server owns terminals; CLI and socket are the same *control* surface). gmux's wedge is different: it *understands* the work (headline / overview / summary, thought-peel, promptable layout), not only that a pane is blocked. We still write `gmuxd` rather than sitting on herdr (see Alternatives E).

---

## Background & Motivation

### Current state

gmux is a Node 20+ TypeScript CLI with a strict layer rule (`core ← adapters ← services ← cli`, enforced by `scripts/check-layers.mjs`). Two lanes already exist:

| Lane | Surface | Question |
|---|---|---|
| Live control plane | `gmux daemon` + borders + `gmux cockpit` (`ctrl+g`) | What is every pane doing *right now*? |
| Session history | `gmux ls` / picker / `gmux resume` | What did I run, and can I get back to it? |

The live lane is built on stock tmux. Code root: `/Users/jamesgao/Projects/side/gigamanage`.

- `TmuxGateway` is the sole tmux talker (`list-panes`, `capture-pane`, `pipe-pane`, `send-keys`, layout verbs). Fake: `tests/fixtures/fake-gateway.ts`.
- `PaneRegistry` maps live `%N` pane ids to harness/session via `gmux run` links (`src/services/pane-links.ts`) plus process/cwd heuristics (`src/services/tmux-resolve.ts`). There is no `workspaceId` in the tree today.
- Instant heuristics (`src/core/pane-state.ts` `classifyState`) emit `working | idle | waiting | error | done` every tick (~1500 ms, `DEFAULT_GMUX_CONFIG.tickMs`).
- Change-gated LLM semantics (`src/services/semantic.ts` + `src/services/distill.ts`) land a beat later. `SemanticWorker.enqueue` never awaits the provider; JSON parse/GC still share the Node event loop.
- The cockpit overlay (`src/cli/overlay.ts`, `src/cli/commands/cockpit.ts`) paints summary cards **over** the PTYs and takes organize/ask in a tmux `display-popup` (100%, `src/cli/commands/tmux.ts`).
- Guardian (`src/services/guardian.ts`) is a pure policy state machine; `Daemon.tickOnce` broadcasts via `gateway.send`. Culprit copy still says `window \`${name}\``.
- `ModelServer` (`src/services/daemon-socket.ts`) pushes one `WorkspaceSnapshot` JSON line on connect and on change to `~/.cache/gmux/gmux/daemon.sock` (`gmuxSocketPath()`). Cockpit/borders `subscribe()` (`src/services/daemon-client.ts`). There is no `method`/`id`/`result`.
- `SCHEMA_VERSION = 1` and `CONFIG_VERSION = 1` (`src/core/types.ts`). `parseConfig` returns `null` when `version > CONFIG_VERSION` (rejects the file, then autodetects).

### Pain points this redesign addresses

1. **The overlay is the wrong chrome.** `ctrl+g` `display-popup` covers the agents it is trying to explain. Overlay cards in `src/cli/overlay.ts` literally paint over pane rectangles. Users glance by *hiding* the work.
2. **We cannot see the unsubmitted prompt.** tmux `capture-pane` gives a screen dump, but gmux does not own input, does not keep a VTE grid, and has no reliable way to peel a Claude Code composer. Slash-command `/fork` and ghost-complete were tried/rejected for this reason.
3. **tmux pane ids are the identity.** `%N` dies with the tmux server; `pane-links.json` is cache that is pruned to the live set. Owning PTYs lets pane ids be durable for the life of the mux server.
4. **Stage sequencing is wrong.** The 2026-08-11 spec deferred owning PTYs until after "reorganize-by-conversation" was proven on tmux. Organize already exists (`src/services/organize.ts`, dry-run by default, preview-then-apply). The thing we cannot prove on tmux is thought-peel and native chrome — the actual product.
5. **Agents die when the wrong process dies.** A tmux session survives detach, but gmux does not own that contract, cannot intercept input, and cannot draw a sidebar that isn't a pane border or a popup.

### What we are not doing

Not forking tmux. Not wrapping Claude Code / Codex. Not a git worktree manager. Not unattended tab regrouping. Not tiling panes inside a tab in v1. Not sitting on herdr as the PTY owner.

---

## Goals & Non-Goals

### Goals

1. **gmux owns the PTYs.** Server holds terminals; TUI is a client. Detach and TUI crash do not kill agents.
2. **Three pillars, with the locked autonomy mix:**
   - **Tabs:** language is the layout interface. User prompts gmux or hits `ctrl+t`; gmux executes. No unattended regrouping of tabs. v1 tabs are **groups** (sidebar sections), not tiled windows.
   - **Memory:** actually autonomous (scan + protect). Consent already lives in `gmux setup` (`auto` / `notify` / `off`).
   - **Workspaces:** templates may self-spawn idle panes (tests, logs, review). Bigger grouping changes go through the gmux prompt with a preview. Layout must not move something the user is looking at unattended — in v1 that means: do not change **any client's** `focusedPaneId` unless that user clicks/selects.
3. **Thought-peel (`ctrl+t`)** replaces `/fork` and ghost-complete. Instant pane (mux-local, never waits on intel); title/context pack catch up; focus stays on the parent; seed is cleared from the parent and submitted only after a successful clear (or empty seed).
4. **Attention funnel** in an always-on sidebar: glance → focus (one expanded overview) → dive (summary drawer *inside* the sidebar). Never paints over the PTY.
5. **CLI and unix socket are the same control surface**, `--json` from day one, usable by agents, with a peel recursion bound and caller ACL.
6. **Preserve:** layer rule; read-only session files; two-layer signal (fast path survives the slow path); summary cache hashing; `GMUX_CHILD=1`; provider (`src/services/providers.ts`) vs adapter (`src/adapters/registry.ts`) split.

### Non-goals

- Replacing Ghostty / iTerm / kitty. gmux is a multiplexer TUI that runs *inside* a normal terminal emulator, the way herdr and tmux do.
- Forking tmux, wrapping agent CLIs, injecting into Claude Code / Codex UIs.
- Isolated git worktrees on peel; session clone; silent session fork.
- Fully unattended tab regrouping; fully prompt-gated memory (memory stays autonomous).
- Permanent master-detail column; workspace-wide card zoom (`ctrl+g` overlay).
- **In-tab splits / tiling / `select-layout` in v1.** The TUI is not a compositor of N grids. Follow-up if users demand a herdr-style split tree.
- Live PTY handoff across mux-server upgrades (herdr `SCM_RIGHTS`) in v1.
- Linux cgroup v2 `memory.max` in v1. Subtree RSS + `hostPressure` remain the portable mechanism (`src/services/resources.ts`).
- Rewriting adapters, distill, organize planners, or guardian policy in Rust.
- Import of live tmux panes; a user-facing `gmux.backend = "tmux"|"mux"` flag.
- Building on herdr/zellij as the PTY runtime (Alternatives E).
- Scrollback/copy/zoom UI in v1 (mux still stores 10k compact lines for `pane.read`).
- Windows as a v1 mux target.

---

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Mux language | Rust (`portable-pty` + `vte` + `ratatui`) for the runtime; TypeScript for intelligence | PTY/grid/TUI is systems code. Intelligence already exists and is tested in TS. Mixing them in one Node process puts LLM work on the PTY event loop. |
| Process split | `gmuxd` owns PTYs; `gmux attach` is a TUI client; existing `gmux daemon` is the intel sidecar | TUI crash must not kill agents. Intel crash must not kill PTYs. LLM hang must not stall PTY reads **or** `ctrl+t`. |
| Visual model (v1) | **Single focused PTY + sidebar rows.** Tabs are grouping, not tiles. No in-tab splits. | Sidebar is the multiplexer. `select-layout` / tiled windows are today's tmux habit, not this product. A compositor of N grids is a different TUI. |
| Peel fast / slow | Mux-local spawn on the keypress from shadow-or-empty. Extract, clear, pack, submit are slow path and must not block spawn. | Locked: pane visible < 50 ms; fast path survives intel hang/down. |
| Input modes | `pty` \| `sidebar` \| `prompt` \| `drawer`. While `pty`: intercept **only** `ctrl+t`, `ctrl+g`, `ctrl+q`. `ctrl+g` from `pty` lands in **`sidebar`** (j/k work immediately), not the prompt. Printable keys in `sidebar` focus the gmux prompt. Esc from `sidebar` → `pty`. Do not intercept `/` in `pty`. | Keyboard users must reach sidebar navigation without a mouse. `/` stays load-bearing for agents. |
| Socket planes | **Control plane:** NDJSON RPC on `mux.sock`. **Data plane:** private length-prefixed binary frames for TUI only. Agent socket stays small. | 60 Hz color grids as JSON on the public RPC will not meet the paint budget and would leak PTY contents to every agent. |
| Caller ACL | `tui` \| `intel` \| `pane` \| `cli`. Classify by **peer pid first** (macOS `LOCAL_PEERPID`, Linux `SO_PEERCRED`). A descendant of a pane pid is always `pane` — unsetting `GMUX_PANE_ID` is `permission_denied`, never promotion to `cli`. Intel: 0600 token + pid match. | Env-based class is an ACL escape. Dogfood OS is macOS; `SO_PEERCRED` alone is not implementable there. |
| Authority | Mux owns layout + process identity. Intel patches `state` / `semantics` / `resources` / `guardianLog` by `paneId`. `session.snapshot` is mux-assembled. | One snapshot for the TUI. Tick (1500 ms) vs PTY I/O (event-driven) stay different clocks. |
| Mux→intel RPC | Intel socket is **bidirectional**. Mux may send `{id, method, params}` (`prompt.extract`, `context.pack`, `organize.plan`, `classify.intent`) with deadlines; intel replies on the same id. See method-ownership table. | Extract/pack/plan are server-initiated; a client-only socket cannot express them. |
| Focus | **Per-client.** Each `client.attach` has its own `focusedPaneId`. No global server focused pane. `spawn({focus: false})` means do not change **this client's** focus. | Two attached TUIs must not share a PTY or steal keystrokes. |
| Public control API | CLI, TUI, intel, and pane agents speak NDJSON on `mux.sock` (not `daemon.sock`). | herdr-like control surface. Leave `daemon.sock` snapshot stream alone until tmux clients die. |
| Identity | Durable gmux pane ids (`p_` + ULID). `workspaceId` = git root (or cwd) fingerprint. tmux `%N` retired in the live lane. | `PaneLink.paneId` today is a tmux id that dies with the server (`src/core/types.ts`). |
| Empty attach | Create workspace + tab `main` + login `$SHELL` at cwd. Sidebar lists **all** panes, agents first. | Otherwise `gmux attach` is a blank chrome with nothing to focus. |
| Unsubmitted prompt | Primary (slow): VTE-grid scrape in TS extractors. Fallback (fast and slow): mux shadow buffer. Both fail → empty seed. | We own the PTY so we see the alternate screen. We do not wrap the agent. A wrong seed is worse than a blank agent. |
| Extractor home | `src/services/prompt-extract.ts` (TS), slow path only | Harness UI knowledge sits next to adapters. Vitest fixtures, no Rust rebuild to retune a Claude box. |
| Peel layout | New **tab** (group) in the current workspace, one pane, **not focused**. Visible PTY does not change. | Locked: new tab in the sidebar; focus stays; keyboard never moves. |
| Default harness vs summary provider | Two config fields. `provider` stays the summarizer (`claude -p`). New optional `agentHarness` is the interactive CLI `gmux run` already resolves. `CONFIG_VERSION` stays **1**. | `services/providers.ts` is not `adapters/registry.ts`. Bumping on-disk version to 2 would make `parseConfig` reject the file. |
| Context pack | Parent headline + overview + last ≤3 of `recentUserPrompts` (ring of 12) + last assistant clipped to 800 chars. Hard cap 4 KiB. Never the transcript. | Distill already exists to keep summaries small. Peel is delegation, not a fork. |
| Organize v1 | Same preview-then-apply. Verbs: `new-tab`, `rename-tab`, `move-pane` (to a tab), `break-pane`. **No** `select-layout`, `swap-pane`, in-tab join. Add `OrganizePlan.schemaVersion` (2 for tab ops). **`SCHEMA_VERSION` stays 1.** | Grouping, not tiling. Do not break `gmux ls --json` for a plan-shape change. Close is a separate user-initiated verb. |
| Templates | v1 spawns **idle shells** titled `tests`/`logs`/`review`. Do not re-exec the agent's command. | Re-running `pnpm dev` fights the port; re-running tests double-runs the suite. |
| Guardian I/O | Policy stays in `Guardian.decide` (pure). Broadcast goes through mux `pane.send_keys`. Culprit label is pane/tab, not `window`. | Fast path must not wait on LLM. Only known agent panes, cooldown, hysteresis, consent at setup. |
| Chrome | Always-on left sidebar + gmux prompt at the bottom of that chrome. `ctrl+g` from `pty` → `sidebar`. Type in sidebar to use the prompt. | Overlay is replaced, not polished. Keyboard users can j/k immediately after `ctrl+g`. |
| Funnel state | Glance / focus / dive is **client-local**. | Expanding a row is not a layout operation. |
| Recurring panes | Match on tool-call **start id** (new sensor field). One live pane per `(workspaceId, templateId)`. Cooldown 60 s. | `AgentSensor` today has no tool-start field; re-matching the tail every tick would tab-storm. |
| Host emulator | gmux runs inside Ghostty/iTerm/kitty. It is not a terminal emulator. | Same contract as herdr/tmux. |
| Rollback | Clean break. History lane (`gmux ls`) is the only rollback. `TmuxGateway` stays in-tree for tests until a later major delete. | Dual-backend would fork identity, sensors, and the socket. |
| Packaging (v1 experimental) | `gmux attach` fetch-if-missing from GitHub Releases with checksum pinned in the npm package. | Avoids native compile on `npm install`. Not the npm default until extract fixtures exist. |

---

## Proposed Design

### 1. Multiplexer core

#### Recommendation

**Split runtime from intelligence. Do not put the PTY runtime in-process with the TypeScript daemon. Do not wait on the sidecar for `ctrl+t`.**

```
┌─────────────────────────────────────────────────────────────────┐
│  Ghostty / iTerm / kitty  (the emulator — we do not replace it) │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ gmux attach   (TUI client, ratatui)                       │  │
│  │  sidebar + funnel + prompt chrome                         │  │
│  │  ONE focused PTY (data-plane frames)                      │  │
│  └──────────────┬──────────────────────────┬─────────────────┘  │
└─────────────────┼──────────────────────────┼────────────────────┘
                  │ mux.sock (NDJSON control)│ mux.frames (binary)
                  ▼                          ▼
┌─────────────────────────────────────────────────────────────────┐
│ gmuxd  (Rust mux server)                                        │
│  owns: PTYs, VTE grids, compact-line scrollback, tab grouping,  │
│        keymap, shadow buffers, control socket, frame sockets,   │
│        intel token, process lock                                │
│  does not: call models, parse JSONL, plan organize              │
└──────────────────────────┬──────────────────────────────────────┘
                           │ mux.sock as caller class `intel`
                           │ (token in intel.token, mode 0600)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ gmux daemon --sidecar  (existing TS, `src/services/*`)          │
│  adapters, distill, semantic worker, organize planners,         │
│  guardian policy, prompt extractors, workspace templates        │
│  patches semantics onto mux-owned panes                         │
└─────────────────────────────────────────────────────────────────┘
```

`~/.cache/gmux/gmux/daemon.sock` is **left alone** until cockpit/border clients are gone. New path: `muxSocketPath()` → `~/.cache/gmux/gmux/mux.sock`.

**Why not in-process TypeScript (node-pty + @xterm/headless + Ink):**

| Concern | In-process Node | Split (Rust mux + TS intel) |
|---|---|---|
| TUI crash | Kills agents unless you already split processes | TUI is a client; agents survive |
| LLM hang | `enqueue` never awaits, but JSON parse / gc still share the event loop | Mux event loop never sees a model call; peel does not RPC intel on the fast path |
| Grid parser | `@xterm/headless` works; not what Zellij/herdr run in production | `vte` is the parser Alacritty/WezTerm/Zellij use |
| TUI | Ink/blessed are component TUIs, not multiplexer frame compositors | `ratatui`; v1 only composites chrome + **one** grid |
| Packaging | Stays a pure npm package | Need a native binary |
| Rewrite cost | Zero new language | Intelligence is **not** rewritten |

`@gigaflow/gmux` remains the npm CLI (`gmux ls`, `gmux ask`, `gmux summarize`, `gmux attach`). `gmuxd` is a platform binary the CLI starts (fetch-if-missing). History-lane commands work without `gmuxd`; the live lane does not.

**Why not all-Rust:** adapters (`humanText` in `src/adapters/claude-code.ts`), distill (`PROMPT_VERSION = 4`), `LlmOrganizePlanner`, `Guardian`, `classifyIntent`, provider argv catalogs, and the Vitest suite are the product's tested core.

#### Concrete stack

| Piece | Choice |
|---|---|
| Language | Rust, current stable edition (do not pin “2021 because herdr”) |
| Async | `tokio` |
| PTY | `portable-pty` |
| Parser | `vte` → visible grid as cells; **scrollback as compact lines** (plain text + width), default 10_000 lines, not 10_000 cell-rows |
| TUI | `ratatui` + `crossterm` |
| Control IPC | Unix domain socket `mux.sock`, NDJSON, mode `0600`, owner-uid only |
| Data IPC | After `client.attach`, TUI opens `mux.frames.<clientId>.sock` (mode `0600`). Length-prefixed binary dirty rects. Not NDJSON. Not on the agent socket. |
| TS seam | `MuxGateway` in `src/services/mux-gateway.ts` replaces `TmuxGateway` for the sidecar |
| Tests | `cargo test` in CI (separate job from `npm test`); `FakeMuxGateway` in Vitest; existing `FakeTmuxGateway` at `tests/fixtures/fake-gateway.ts` stays until `TmuxGateway` is deleted |
| Lock | `mux.lock` holds `{ muxPid, intelPid, startedAt }`. Second `gmux attach` connects; it does not spawn a second `gmuxd`. |

**v1 target triples** (fetch-if-missing): `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`. musl and Windows are later.

Expected load (design targets, not promises):

- Typical workspace: 4–20 panes; stretch 50.
- PTY I/O is event-driven (not on the 1500 ms intel tick).
- Data plane: dirty-rect of **this client's focused pane** only, 60 Hz cap, skip-if-behind (`seq - last_ack > 1` → full refresh). Panes no client is viewing are not streamed.
- Sidebar of 50 rows: <16 ms to paint (local, from snapshot).
- Control-plane RTT locally: <5 ms.
- Mux RSS: visible grid ≈ 80×24 cells × ~16 B ≈ 30 KB; scrollback 10k compact lines × ~80 B ≈ 0.8 MB; plus PTY buffers. **~1 MB/pane typical**, ~2 MB worst. 20 panes ≈ 20–40 MB plus agent RSS, which we do not own.

#### Visual model and layout tree (v1)

**The TUI shows exactly one PTY at a time.** The always-on sidebar lists every pane in the current workspace. Clicking a row focuses that pane (the content region swaps to that grid). Tabs are named groups of panes (agents / tests / logs / review / shells), rendered as section headers in the sidebar — not tiled regions, not tmux windows.

```
Session (one gmuxd process)
  └── Workspace  (one repo/cwd; id = fingerprint of git root or cwd)
        └── Tab   (named group: "main", "tests", "logs", …)
              └── Pane*  (0..N PTYs; each TUI client shows one pane — its own focusedPaneId)
```

A tab with several panes is several sidebar rows under one header. It is **not** a split tree. herdr's `pane.split` / BSP is explicitly out of v1.

**Focus is per-client.** The server layout has no global focused pane. Each `client.attach` record holds `{ clientId, focusedPaneId, cols, rows }`. Data-plane frames and `Input` bytes apply to **that client's** `focusedPaneId`. Two TUIs can view different agents; they do not share a PTY or steal keystrokes.

| Today (tmux) | gmux v1 |
|---|---|
| session | mux session |
| window `@N` | tab (group) |
| pane `%N` | pane `p_<ulid>` |
| several panes tiled in one window | several rows in one tab; one PTY visible |
| `select-layout` / `swap-pane` / in-window `join-pane` | **dropped in v1** |

Peel creates a new tab containing one pane and **does not** change **this client's** `focusedPaneId`. The visible PTY stays the parent; a new sidebar row appears. Other attached TUIs are also unchanged (`spawn({focus: false})` is per-client).

**Bootstrap (empty `gmux attach`):**

1. Start or connect to `gmuxd` (singleton lock).
2. If the session has no workspaces: create one.
   - `workspaceId` = `ws_` + 12-char hex of SHA-256(git root if `git rev-parse --show-toplevel` succeeds, else `cwd`).
   - `cwd` of the workspace is that root/cwd.
3. If that workspace has no tabs: create tab `main`.
4. If that tab has no panes: `spawn({ argv: [$SHELL], cwd, tab: existing main, focus: true })` — `focus: true` sets **this attaching client's** `focusedPaneId`, not a server-global field.
5. Attach TUI. Content region is this client's focused PTY. Sidebar lists it.

`workspace.create` exists on the socket for an explicit second repo (`gmux workspace create --cwd …`). v1 UI: one workspace on screen; switching workspaces is a later chrome affordance if needed — for v1, `gmux attach --cwd <repo>` focuses that workspace.

**Resize:** content region = this client's terminal cols − sidebar width, rows = this client's terminal rows (prompt lives *in* the sidebar, so it does not steal PTY rows). On SIGWINCH or sidebar drag, mux `pty.resize(thisClient.focusedPaneId)` to that winsize. Panes no client is viewing keep last winsize until focused (acceptable v1). If two clients focus the same pane, the pane's winsize is the most recently resized client's content region (last-writer-wins; document, don't try to dual-size a PTY).

**Close (user-initiated, not organize):**

- `pane.close` kills that PTY (SIGHUP the child).
- `tab.close` closes every pane in the tab, then the tab.
- Last pane in a tab: closing it closes the tab. Last tab in a workspace: spawn a fresh login shell in a new `main` tab (never leave the TUI with zero focusable rows). Explicit `workspace.close` is a CLI/socket method, not an organize step.
- Organize never calls close/kill.

**Scrollback / copy / zoom:** not v1 UI. Mux still retains 10k compact lines so `pane.read` works for agents and extractors.

**Sidebar membership:** every pane, not only agents. Sort: agent panes first (`harness != null`), then templates, then idle shells. Otherwise a peeled agent or a tests pane is unfocusable.

#### Socket planes

**Control plane** (`mux.sock`): newline-delimited JSON request/response. **Bidirectional on the intel connection:** either side may originate `{id, method, params}`; the other replies `{id, result}` or `{id, error}` on the same id. TUI/cli/pane connections remain client→mux requests plus server-pushed `{event, body}` lines. Methods and ownership in §11. Events (`pane.created`, `pane.exited`, `model.change`, `intel.status`) are still not frames.

**Data plane** (TUI only; one socket per `client.attach`). All multi-byte fields **little-endian**. Each message is `u32le length` (bytes after that field) then payload.

Server → client, `type = 1` (frame):

```
u8  type          = 1
u8  kind          = 0 full | 1 dirty
u16 cols
u16 rows
u32 seq           // per-client, monotonic
[16] pane_id      // raw ULID bytes; public string id is "p_" + Crockford Base32 of these 16 bytes
u32 nrects
nrects ×:
  u16 x, y, w, h
  (w*h) × Cell:
    u8  glen
    glen bytes UTF-8 grapheme (glen 0..8; 0 = blank)
    u32 fg            // 0xAARRGGBB; AA=0 means default
    u32 bg
    u8  attrs         // bit0 bold, bit1 dim, bit2 underline, bit3 inverse, bit4 italic
```

A `full` frame has `nrects = 1` covering `(0,0,cols,rows)`. A `dirty` frame has `nrects ≥ 1` covering only changed cells. There is no separate “end of frame”; `nrects` closes the packet.

Client → server:

```
type = 3 FrameAck  { u8 type=3; u32 seq }
type = 4 Input     { u8 type=4; u32 nbytes; nbytes bytes }   // keys for THIS client's focused pane
type = 5 Resize    { u8 type=5; u16 cols; u16 rows }         // this client's content region
type = 6 Mouse     { u8 type=6; u16 x; u16 y; u8 button; u8 mods; u8 kind }
                   // kind: 0 press, 1 release, 2 drag, 3 move. Coords in the content region.
                   // Mux forwards SGR/mouse to the PTY only if that pane requested mouse tracking.
```

**Skip-if-behind:** the client acks `seq`. If `seq - last_ack > 1`, mux **drops pending dirty rects** and the next frame is `kind = full`. Never enqueue an unbounded dirty backlog.

PR 4 lands one annotated hex fixture of a 2×1 `full` frame (two cells) in `crates/mux/tests/frame_hex.rs`.

`GridSnapshot` for extractors is a **simplified projection** of the same grid: `text` plus `intensity[]` where DIM → 0, BOLD → 2, else 1. Inverse/RGB are ignored for extract. Extract never uses the data plane.

The TUI sends keystrokes for **this client's** focused PTY on the data plane (`Input`). The control plane has `pane.send_keys` for agents/intel/CLI (ACL-gated).

#### Attach / detach / crash

Start order, always: **mux → sidecar → TUI**.

- `gmux attach`: if `mux.lock` live, connect. Else spawn `gmuxd`, which mints `intel.token`, spawns `gmux daemon --sidecar`, waits for intel `hello` (2 s timeout — TUI still attaches; sidebar shows intel down), then accepts TUI.
- `gmux daemon` without attach: same supervisor (mux + sidecar), no TUI. Useful under a process manager.
- `gmux daemon status`: prints `mux: up|down (pid)` and `intel: up|down (pid)` independently.
- `gmux daemon stop`: SIGTERM sidecar, then mux (mux SIGHUPs PTYs — this **is** killing agents; status copy says so).
- Two `gmux attach` races: lockfile with `O_EXCL`; peer pid via macOS `LOCAL_PEERPID` / Linux `SO_PEERCRED`. Loser connects as a second TUI client with its own `focusedPaneId` and frame socket.

```mermaid
sequenceDiagram
    autonumber
    participant U as User shell
    participant TUI as gmux attach
    participant M as gmuxd
    participant A as Agent PTY
    participant I as gmux daemon --sidecar

    U->>TUI: gmux attach
    TUI->>M: connect mux.sock (or spawn gmuxd)
    M->>I: spawn sidecar with intel.token
    I->>M: hello (caller class intel)
    TUI->>M: client.attach (caller class tui)
    TUI->>M: connect mux.frames.<id>
    M-->>TUI: session.snapshot (control)
    loop this client's focused PTY
        TUI->>M: Input (data plane)
        M->>A: write master fd of thisClient.focusedPaneId
        A-->>M: PTY bytes → vte
        M-->>TUI: frame type=1 (nrects, this pane's ULID)
    end
    U->>TUI: detach ctrl+q or TUI crash
    Note over M,A: PTYs keep running
    U->>TUI: gmux attach
    Note over TUI: chrome + PTY view restored; funnel state resets (client-local)
```

| Failure | Agents | Semantics | Glyphs | User sees |
|---|---|---|---|---|
| TUI crash / detach | Alive | Alive | Live | Reattach; funnel resets to glance |
| Intel crash | Alive | Freeze last known | Mux-only `{working, idle}` from PTY byte activity. `waiting`/`error`/`done` freeze. | Sidebar “intel down — glyphs only”. Peel still spawns (see failure matrix). Guardian does not broadcast. |
| Mux crash | **Die** (PTY master gone, SIGHUP) | Rebuildable from transcripts | — | High severity. Keep mux small. SCM_RIGHTS is v2. |
| Host reboot | Die | History lane intact (`gmux ls`) | — | Same as tmux without resurrect |

Pane persistence across TUI crash is the v1 contract. Pane persistence across mux-server upgrade is out of v1.

Degraded classifier (mux-side, no JSONL): if bytes arrived on the PTY in the last `WORKING_WINDOW_MS` (10 s, same constant as `src/core/pane-state.ts`) → `working`, else `idle`. That is the entire mux glyph set when intel is down. Do not invent waiting/error/done from ANSI.

#### `TmuxGateway` → `MuxGateway`

Today (`src/services/tmux-gateway.ts`) — quoted for the seam, not preserved as user-facing backend:

```typescript
export interface TmuxGateway {
  listPanes(): Promise<TmuxPane[]>;
  capture(paneId: string, lines?: number): Promise<string>;
  startPipe(paneId: string, logPath: string): Promise<void>;
  stopPipe(paneId: string): Promise<void>;
  send(paneId: string, keys: string): Promise<void>;
  setOption(paneId: string, name: string, value: string): Promise<void>;
  newWindow(name: string): Promise<string>;
  renameWindow(windowId: string, name: string): Promise<void>;
  joinPane(srcPane: string, dst: string): Promise<void>;
  breakPane(pane: string, name?: string): Promise<string>;
  swapPane(a: string, b: string): Promise<void>;
  selectLayout(windowId: string, layout: string): Promise<void>;
}
```

New seam (`src/services/mux-gateway.ts`). v1 verbs match organize-as-grouping plus spawn/close/read. **No** `selectLayout`, **no** `swapPane`, **no** tiling `joinPane`.

```typescript
export interface MuxGateway {
  listPanes(): Promise<GmuxPane[]>;
  send(paneId: string, keys: string): Promise<void>;
  spawn(opts: SpawnOpts): Promise<{ paneId: string; tabId: string }>;
  closePane(paneId: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  readGrid(paneId: string, rows?: number): Promise<GridSnapshot>;
  readLines(paneId: string, lines?: number): Promise<string>; // compact scrollback
  newTab(name: string): Promise<string>;
  renameTab(tabId: string, name: string): Promise<void>;
  /** Move an existing pane into a tab (grouping). Does not tile. */
  movePane(srcPane: string, dstTab: string): Promise<void>;
  breakPane(pane: string, name?: string): Promise<string>; // pane becomes its own tab
}

export interface SpawnOpts {
  cwd: string;
  argv: string[];
  env?: Record<string, string>;
  tab?: { mode: "new"; name: string } | { mode: "existing"; tabId: string };
  focus?: boolean; // default false for peel / templates
}
```

`Daemon` (`src/services/daemon.ts`) already takes `gateway: TmuxGateway`. Switching the type is the intel-side migration. `pipe-pane` goes away: the mux *is* the log. `TerminalSensor` reads `readGrid` / tail events instead of `capture-pane`. `AgentSensor` still tails the harness JSONL — plus a new `toolStarts` field (see §8).

`TmuxGateway` stays in-tree for existing tests (`tests/fixtures/fake-gateway.ts`). It is not a runtime flag. Users finish work in tmux, then `gmux tmux uninstall` + `gmux attach`.

---

### 2. Input interception for `ctrl+t`

Because gmux owns the PTY, the mux sees every byte in and every byte out. `ctrl+t` is a **mux-level binding in `pty` mode** and is never forwarded to the focused pane.

Host-emulator conflict: iTerm2 / some macOS defaults bind `ctrl+t` to "New Tab". `gmux setup` prints a one-line fix. The binding stays `ctrl+t` (locked). `ctrl+shift+t` is an allowed v1 alias (Open Questions); it does not replace `ctrl+t`.

#### Fast path (mux-local — this is `ctrl+t`)

On keypress, **before any intel RPC**:

1. Read the parent pane's shadow buffer (possibly empty).
2. `spawn({ cwd: parent.cwd, argv: defaultHarnessOrShell, tab: { mode: "new", name: placeholder }, focus: false })` — `focus: false` means do not change **this client's** `focusedPaneId`. Other clients unchanged.
3. Sidebar row exists. This client's focus stays on the parent. Budget: pane visible < 50 ms. Intel is not on this path.

Placeholder title: first 6 words of the shadow, clipped to 48 chars; empty shadow → `new agent`. Glyph `working`.

Default harness argv is cached in mux at sidecar hello (`agentHarness` launchCommand). If intel has never said hello, exec `$SHELL` and title `new agent`.

#### Slow path (intel + mux, must not block spawn)

After spawn, mux fires extract/clear/pack/submit asynchronously.

**Extractors** live in `src/services/prompt-extract.ts`. Mux sends a **bidirectional** request on the intel connection:

```json
{"id":"ex_1","method":"prompt.extract","params":{"grid":{…}}}
```

Hard deadline **20 ms**. On timeout, down, or malformed reply: seed = shadow-or-empty; extractor = `"shadow"` or `"empty"`. The extract RPC has a correlation `id`; it is not a fire-and-forget event. Same pattern for `context.pack` (500 ms) after spawn.

```typescript
// src/services/prompt-extract.ts
export interface GridSnapshot {
  paneId: string;
  cols: number;
  rows: number;
  lines: GridLine[];
  alternateScreen: boolean;
  foregroundCommand: string; // e.g. "claude", "codex", "zsh"
}

export interface GridLine {
  text: string;
  /** DIM→0, BOLD→2, else 1. Inverse/RGB ignored. Parallel to text. */
  intensity: number[];
}

export interface ExtractResult {
  text: string;          // empty string means "treat as empty buffer"
  confidence: "high" | "low";
  clearKeys: string;
  extractor: string;     // "claude-code" | "codex" | "shell" | "shadow" | "empty"
}

// confidence: boxed composer with interior match = "high";
// shell PS1 heuristic or shadow buffer = "low".
```

**Claude Code extractor** (fixture grids, not a live binary):

1. Scan `lines` from the bottom for a box-drawing pair (`╭`/`╮` … `╰`/`╯` or `┌`/`┐` … `└`/`┘`) whose interior width is ≥ 50% of `cols`.
2. Interior rows: strip one leading and trailing `│`, then a leading `>` plus optional space.
3. Drop interior rows whose non-space cells are all intensity 0 (placeholder).
4. Join remaining interior rows with `\n`, trim.
5. `clearKeys`: `\x15` (Ctrl+U) × `interiorRowCount`. Secondary: `\x01\x0b` (Ctrl+A, Ctrl+K) once.
6. Empty interior → `text: ""`. Confidence `high` if a box was found.

**Codex extractor:** do **not** assume the same box. Prefer a bottom input line with a `>` or `▍` caret; fall back to the box scan if present. Fixture-driven per Codex version; if chrome changes, update fixtures.

**Shell extractor** (`foregroundCommand` in `{zsh,bash,fish,sh,-zsh,-bash}`, or no alternate screen):

1. Last non-empty line, strip a leading PS1 heuristic (`/%|#|$|>` plus optional user@host).
2. `clearKeys`: `\x15`. Confidence `low`.

Unknown TUI → shadow/empty. Keyed by `HarnessAdapter.processNames` (`["claude"]`, `["codex"]`) plus the `isIdleShell` command set in `src/services/organize.ts`.

#### Shadow buffer (mux-local, always on)

Per pane, UTF-8 of printable input since last submit:

- Append printables and bracketed paste.
- Apply Backspace / Ctrl+H / Ctrl+W / Ctrl+U locally.
- Reset on Enter / Ctrl+M / Ctrl+J that we forwarded, and on `\x03` (Ctrl+C).
- Do not interpret TUI cursor motion, mouse, or multiline editors.

This is the fast-path seed and the slow-path fallback.

#### Clear then submit (never the reverse)

Clearing is load-bearing (“cleared from the parent so it isn't sent twice”) but **does not gate spawn**.

Mux-local clear attempt, immediately after spawn, if seed (shadow or extract if it already returned) is non-empty:

1. Send `clearKeys` if we have them, else `\x15`.
2. Re-read **mux** grid (no intel). If the seed string is still a contiguous visible substring, retry secondary clear once.
3. If still visible: **do not submit** to the child. Toast `couldn't clear parent prompt`. Child tab stays (blank or unsubmitted harness). Parent still has the text.
4. If cleared or seed was empty: wait for harness-ready (composer visible or 8 s), then write seed (+ pack if present) + Enter.

If extract later returns a *better* seed than shadow, use it only if we have not submitted yet and a clear of *that* text succeeds.

Rejected: gmux-owned input line that forwards to the agent (wraps slash commands, completions, image paste).

#### Peel failure matrix

| Condition | Spawn | Parent | Child submit | UX |
|---|---|---|---|---|
| Empty shadow + empty extract | Yes, <50 ms | Unchanged | No seed, no pack (blank new agent) | Row `new agent` |
| Intel down | Yes, from shadow-or-empty | Mux-local Ctrl+U best-effort; if unconfirmed, skip submit | Only if mux grid confirms clear or seed empty | Toast `intel down` if submit skipped |
| Extract timeout (>20 ms) | Already spawned | Same as shadow path | Shadow-or-empty if cleared | — |
| Uncleared parent | Already spawned | Text remains | **No** | Toast `couldn't clear parent prompt`; user may close the blank tab |
| Harness not on PATH | Yes (`$SHELL`) | — | No | Status `no agent harness — gmux setup` |
| Peel depth ≥ 2 (caller) | **No** | Unchanged | — | Error `peel_bounded` + fix |
| Empty buffer (locked) | Yes | Unchanged | Blank new agent | Focus stays |

A hung `claude -p` on the sidecar cannot block `ctrl+t`. That is the governing invariant applied to peel.

---

### 3. Peel sequence

```mermaid
sequenceDiagram
    autonumber
    participant K as Keypress ctrl+t
    participant M as gmuxd
    participant I as intel (extract, pack)
    participant P as Parent PTY
    participant N as New pane PTY
    participant S as Sidebar (TUI)

    K->>M: intercept in pty mode (not forwarded)
    M->>M: seed0 = shadow or empty
    M->>N: spawn tab+pane, cwd=parent, focus=false, argv=harness
    M-->>S: pane.created (row visible, <50ms)
    Note over S: parent remains focused; keyboard unmoved
    par slow path (never blocks spawn)
        M->>I: prompt.extract(grid) deadline 20ms
        I-->>M: ExtractResult or timeout
        M->>P: clearKeys (mux-local confirm)
        alt uncleared
            M-->>S: toast; skip submit
        else cleared or empty seed
            I->>I: buildContextPack (≤500ms)
            N-->>M: harness ready (composer or 8s)
            M->>N: seed + pack? + Enter
        end
    end
    I-->>S: title + semantics land a beat later
```

**Hard rules:**

- `spawn(..., { focus: false })` — this **client's** focus does not move. Keyboard: `ctrl+g` then `j`/`k` (or click) are how you land on the new row.
- Same cwd. No worktree. No `resumeCommand`. New harness process, not `claude --resume`.
- Default harness is `agentHarness`, **not** `provider.summaryArgv` (`claude -p` would create an `isAutomated` session — `docs/architecture.md`).
- Submit is delegation into the composer + Enter, never `-p` / `exec`.
- `ctrl+t` on empty = new agent tab, no steal focus.

---

### 4. Context pack

"Relevant slice of parent, not the whole transcript. Must not clone the session." Slow path only. No extra model call.

```typescript
// src/services/context-pack.ts
export interface ContextPack {
  parentPaneId: string;
  parentHeadline: string | null;   // semantics.label ?? summary.headline
  parentOverview: string | null;   // summary.overview (2–3 sentences)
  recentTurns: { role: "human" | "assistant"; text: string }[];
  seed: string;
}

export const CONTEXT_PACK_MAX_BYTES = 4096;
export const CONTEXT_PACK_BUDGET_MS = 500;
```

**Sources, in order, all local:**

1. `WorkspaceModel` / intel patch for the parent: `semantics.label`, `semantics.card`.
2. Cached `SessionSummary` via `attachSummaries` / `summaryPath(harness, sessionId)` — `headline`, `overview`. Do not wait for a refresh.
3. Cached `SessionRecord` (`cachedRecords()`): last **3** of `recentUserPrompts` (adapters keep a ring of `RECENT_PROMPT_COUNT = 12` in both `src/adapters/claude-code.ts` and `src/adapters/codex.ts`). `lastAssistantText` is already truncated to 1500 chars by both adapters; clip again to **800**.
4. Claude `recentUserPrompts` already passed `humanText()` (filters tool results, slash envelopes, `<system-reminder>`). **Codex fills `recentUserPrompts` on its own path — it is not `humanText()`-filtered.** Do not run Claude's filter on Codex text. Do not re-parse JSONL on the peel path.

**Byte budget:** serialize the pack prompt, UTF-8 ≤ 4096. Drop oldest human turn, then clip assistant tail, then drop overview, then drop headline. Seed is never clipped below 512 bytes; if seed itself is huge, clip seed to 2048 and skip the rest.

**Pack prompt** written into the new agent (then Enter):

```
You are a delegated agent. This is a new session, not a fork of the parent.
Work in the same directory. Do not assume the parent's files are staged or that its conversation continues here.

## Task
<seed>

## Parent context (background only)
Headline: <headline>
Overview: <overview>

Recent parent turns (oldest first):
Human: <…>
Assistant: <…>
```

If the 500 ms budget expires, submit **seed plus headline only** (headline is already in the model). A late pack is **not** sent as a second message. If submit was skipped because of an uncleared parent, the pack is dropped.

---

### 5. Sidebar + attention funnel + input modes

Native chrome replaces the tmux popup and the overlay cards in `src/cli/overlay.ts`. Do not polish those; they go away in the live lane.

```
┌────────────────────────────┬─────────────────────────────────────┐
│ gmux  webshop              │                                     │
│                            │                                     │
│ main                       │          focused PTY                │
│ ● webshop  wiring checkout │          (never covered)            │
│   retry, tests going green │                                     │
│ ○ billing  idle            │                                     │
│ tests                      │                                     │
│ ○ tests    idle            │                                     │
│                            │                                     │
│ ⚠ host memory 92% — …      │                                     │
│                            │                                     │
│ ╭ organize · ask · Enter ─╮│                                     │
│ │ >                        ││                                     │
│ ╰──────────────────────────╯│                                     │
└────────────────────────────┴─────────────────────────────────────┘
```

- Sidebar always on, left, default 40 cols, draggable 28–56. Mux chrome, not a pane.
- Click a row to focus that pane (user-initiated change of **this client's** `focusedPaneId`).
- Typing in the gmux prompt never covers an agent.

**Funnel** (reuse `SessionSummary` tiers):

| Tier | How | Data | Whose state |
|---|---|---|---|
| **Glance** | every pane is one row: `stateGlyph` + headline | `state` + `semantics.label ?? summary.headline ?? command` | Server (model) |
| **Focus** | selecting a row expands *that row only* to overview. One expanded at a time. | `summary.overview ?? semantics.card` | **Client-local** |
| **Dive** | Enter / second click opens a **summary drawer inside the sidebar** (summary + landed / open / next). Esc / click-away closes drawer, then overview, then headlines. | `summary.summary`, `.landed`, `.open`, `.nextStep` | **Client-local** |

`stateGlyph` from `src/cli/tmux-label.ts`: `● working · ◔ waiting · ✗ error · ✓ done · ○ idle`. When intel is down, only `●`/`○` move; the others freeze.

**Input-mode state machine**

```
 pty --ctrl+g--> sidebar --printable or /--> prompt
  ▲                 │  ▲                       │
  │                 │  └──── Esc ──────────────┘
  │                 │
  └── Esc, ctrl+g ──┘     sidebar --Enter--> drawer --Esc--> sidebar
  pty --ctrl+q--> detach
  pty --ctrl+t--> peel (stays pty)
```

| Mode | How you enter | Mux intercepts | Everything else |
|---|---|---|---|
| `pty` (default) | attach; Esc from `sidebar`; `ctrl+g` from chrome; click a row in the PTY content region (see mouse) | **only** `ctrl+t` (peel), `ctrl+g` (**enter `sidebar`**, not the prompt), `ctrl+q` (detach) | Forwarded to this client's focused PTY — **including `/` and all other printables** |
| `sidebar` | `ctrl+g` from `pty`; click sidebar chrome (not the prompt box); Esc from `prompt` or `drawer` | `j`/`k`/arrows select, Enter dive, **any printable** or `/` → `prompt`, Esc → `pty`, `ctrl+g` → `pty`, click row → set this client's focus + `pty` | — |
| `prompt` | printable or `/` from `sidebar`/`drawer`; click the prompt box | typing, Enter submit ask/organize, Esc → `sidebar` | — |
| `drawer` | Enter on a selected row | Esc → `sidebar` (overview, then glance); `j`/`k` ignored inside drawer v1 | — |

`ctrl+g` from `pty` lands in **`sidebar`**, so `j`/`k` work immediately. It never opens a popup. It is the migration of today's tmux binding (chrome, not overlay). From `sidebar` or `prompt`, `ctrl+g` returns to `pty`.

`/` is **not** intercepted in `pty` mode. That is load-bearing: Claude Code slash commands, ripgrep, paths. In `sidebar`, `/` (and every other printable) focuses the gmux prompt.

**Mouse hit-test** (capture is on; regions decide the destination):

| Where the event lands | Behavior |
|---|---|
| Sidebar chrome (left N cols, including tab headers, rows, guardian pin) | Chrome. Click row → this client's focus + `pty`. Click empty chrome → `sidebar`. |
| Prompt box (bottom of sidebar) | Enter `prompt`; do not forward to any PTY. |
| PTY content region | If that pane requested mouse tracking (DECSET 1000/1002/1003/1006), forward SGR/mouse to the PTY (data-plane `Mouse`). Else the click is “focus this pane / enter `pty`” — the pane is already this client's focused pane, so it is a no-op besides mode=`pty`. |

Do not capture mouse globally in a way that eats Claude Code clicks: content-region events go to the agent whenever it asked for them. Chrome columns never do.

**Data the sidebar reads:** `session.snapshot` assembled by mux: layout (mux) + intel patches (`state`, `semantics`, `resources`, `hostPressure`, `guardianLog`). Same `PaneEntry` shape as `src/core/gmux-types.ts`, `paneId` now a gmux id.

Never: paint overlay cards over the PTY. Never zoom the whole workspace. Never a permanent master-detail second column.

---

### 6. Organize-from-prompt

Reuse `OrganizePlan` / preview-then-apply. The gmux prompt is the same router (`src/services/ask-router.ts` `classifyIntent`: defaults to `"ask"` on every uncertainty).

**v1 apply target is grouping, not tiling.** Dry-run remains default. Preview still required — `src/cli/organize-confirm.ts` (`[Enter] apply  [Esc] cancel`, generation guard) moves into the sidebar drawer.

```typescript
// src/core/organize-types.ts — v1 tagged union. Do NOT bump SCHEMA_VERSION (ls/show/grep envelope).
export const ORGANIZE_PLAN_VERSION = 2; // 1 = legacy tmux window ops; 2 = tab grouping

export interface OrganizePlan {
  schemaVersion: typeof ORGANIZE_PLAN_VERSION;
  summary: string;
  steps: OrganizeStep[];
}

export type TabTarget = { kind: "tab"; tabId: string } | { kind: "handle"; handle: string };

export type OrganizeStep =
  | { op: "new-tab"; handle: string; name: string; description: string }
  | { op: "rename-tab"; tab: TabTarget; name: string; description: string }
  | { op: "move-pane"; paneId: string; to: TabTarget; description: string }
  | { op: "break-pane"; paneId: string; handle: string; name?: string; description: string };
```

Dropped from v1: `select-layout`, `swap-pane`, any in-tab split. `HeuristicOrganizePlanner` groups by `basename(cwd)` into per-project **tabs** and idle shells into a `shells` tab (`isIdleShell` unchanged) — it **stops emitting** `select-layout` `"tiled"`. `LlmOrganizePlanner` prompt must list only the four ops; `parseOrganizePlan` **drops unknown ops** (already true). `applyPlan` calls `newTab` / `renameTab` / `movePane` / `breakPane` only.

`SCHEMA_VERSION` in `src/core/types.ts` stays **1** — it is the `--json` envelope for `gmux ls` / `show` / `grep` / `ask` / `doctor` / `index`, not organize. Organize JSON stays tmux-shaped (`schemaVersion: 1`, `new-window` ops) until the mux apply PR, which writes `schemaVersion: 2`. A v1 plan is not applied to mux; a v2 plan is not applied to tmux.

Destruction guarantee: organize still has no kill. `pane.close` is a separate user/CLI method.

**Unattended regrouping is forbidden.** Classify + plan run because the user typed in the gmux prompt. They never run on a timer. Templates may spawn idle panes but never change any client's `focusedPaneId`.

---

### 7. Memory guardian

Same policy, new I/O.

`Guardian.decide` in `src/services/guardian.ts` stays a pure function of `{policy, threshold, cooldownSeconds}` + `HostPressure` + `PaneEntry[]` + clock:

- `off` → `log-only`
- `notify` → `notify` (no keys)
- `auto` + no agent panes → `log-only`
- `auto` + agents → `broadcast`
- cooldown + hysteresis (`firedAt` / `belowSinceFire`)
- culprit via subtree RSS; honest `unattributed`

**Change:** `Daemon.tickOnce` calls `MuxGateway.send` (ACL: intel may `pane.send_keys` to **agent** panes). Still only `identity.harness && identity.sessionId`. Still never shells.

Culprit copy today: `window \`${name}\` (${formatBytes(bestRss)})`. Change to `pane \`${name}\`` (cwd basename or command). Same figure as the sidebar memory column.

Fast path does not wait on the LLM. If intel is down, **no broadcast** (cannot identify known agent panes). Mux may still show host pressure if the sidecar last pushed it; it does not send keys.

Consent remains `gmux setup`. Threshold default 0.9, cooldown 300 s.

Attribution caveats in `docs/gmux.md` still apply.

---

### 8. Workspace templates / self-spawn

Templates are not peels: they do not steal a prompt. **v1 always spawns an idle shell** titled `tests` / `logs` / `review` at the parent's cwd. Do **not** re-exec the captured argv (the agent already started that process; a second `pnpm dev` fights the port; a second `npm test` double-runs).

```typescript
// src/core/template-types.ts
export interface PaneTemplate {
  id: "tests" | "logs" | "review";
  title: string;
  match: TemplateMatch;
  spawn: {
    argv: "idle-shell";  // $SHELL at cwd; never inherit-match in v1
    focus: false;
  };
}

export type TemplateMatch =
  | { kind: "tool-command-start"; pattern: string } // tests, logs (tail)
  | { kind: "dev-server-start"; pattern: string }   // logs vs dev split
  | { kind: "review-start"; pattern: string };      // review, plus semantic gate
```

**v1 catalog (conservative):**

| id | Match | Spawn |
|---|---|---|
| `tests` | `tool-command-start` on `^(npm test\|pnpm test\|yarn test\|vitest\|npx vitest\|pytest\|cargo test\|go test\|just test)\b` | Idle `$SHELL`, tab title `tests` |
| `logs` | `tool-command-start` on `^(tail -f\|kubectl logs\|docker logs -f)\b` | Idle `$SHELL`, tab title `logs` |
| `dev` (same template id `logs` pane — one “follow the process” group) | `dev-server-start` on `^(pnpm dev\|npm run dev\|yarn dev\|vite\|next dev)\b` | Idle `$SHELL`, tab title `logs` (reuse `(workspaceId, "logs")` so a dev server and a tail do not create two). User runs `tail` themselves if they want a live view. |
| `review` | `review-start` on `^(gh pr (diff\|view\|checkout)\|git diff --stat)\b` **and** case-insensitive `\b(pr\|pull request\|review)\b` on `headline + " " + overview`. **No extra model call.** Command match alone is not enough. | Idle `$SHELL`, tab title `review` |

A later version may attach to the agent's child or tail a shared log file. v1 does not.

**This is new sensor work, not reuse.** `AgentSensor.observe` (`src/services/sensors.ts`) today returns `tailLines` as `JSON.stringify` of the last 40 rows plus `awaitingInput` / `sawError` / `ended`. There is no tool-command-start field. `hasToolError` is results, not starts.

```typescript
// add to Observation in src/core/gmux-types.ts
export interface ToolStart {
  callId: string;    // Claude tool_use id / Codex call id; required for dedup
  command: string;   // the bash/argv string
}

export interface Observation {
  // …existing fields…
  toolStarts?: ToolStart[]; // new starts in this observe window only
}
```

Parse `tool_use` / `function_call` **starts** in the sensor. Match is an **edge** on `callId`: first time we see that id, consider the pattern; never re-match because the same command still sits in the 40-line tail next tick.

**JSON paths** (pin in PR 12 fixtures, next to adapter fixtures — one Claude Bash `tool_use`, one Codex `function_call`):

```
Claude Code (assistant row):
  row.type === "assistant"
  row.message.content[]  where block.type === "tool_use"
    callId  = block.id                    // required
    name    = block.name                  // must be "Bash" (case-sensitive, Claude's tool name)
    command = block.input.command         // string; skip the block if missing or non-string

Codex (see tests/fixtures/build.ts function_call shape):
  row.type === "response_item"
  row.payload.type === "function_call"
    callId  = payload.call_id ?? payload.id
              ?? sha1(payload.name + "\0" + payload.arguments).slice(0, 16)
              // fixture rows may omit id; hash is the edge key for that observe window
    name    = payload.name                // must be "shell"
    command = JSON.parse(payload.arguments).cmd   // string; skip if parse fails or cmd missing
```

**Match loop:** for each new `ToolStart`, test templates in catalog order (`tests`, `logs` tail, `logs`/`dev-server-start`, `review`). **First match wins.** `dev-server-start` and `logs` share template id `logs`, so the first hit occupies `(workspaceId, "logs")` and the other is a duplicate no-op.

**Duplicate avoidance:**

- At most one live pane per `(workspaceId, templateId)`.
- Also key seen `callId`s (ring, ~256) so a duplicate start with a new id during cooldown does not spawn.
- Cooldown: 60 s per `(workspaceId, templateId)` after close.
- If the pane still exists, do not spawn. Optionally bump its headline. Never steal focus.

Parser tests sit next to adapter fixtures, not live agents.

---

### 9. Identity & session mapping

**Live lane identity:**

```typescript
export interface PaneIdentity {
  paneId: string;          // "p_" + ULID, minted at spawn, stable until pane close
  tabId: string | null;
  workspaceId: string;     // ws_ + fingerprint(git root or cwd)
  active: boolean;
  harness: HarnessId | null;
  sessionId: string | null;
  cwd: string;
  command: string;
  pid: number;
  peelDepth: number;       // 0 user-spawned, +1 each peel
  templateId: string | null;
}
```

`PaneLink` keeps `{ paneId, harness, sessionId }` but `paneId` is a gmux id. Mux-spawn records the link the way `captureLink` in `src/cli/commands/run.ts` already does (8 s window, newest changed session). `gmux run` still launches a harness in the **current** pane (`GMUX_PANE_ID` replaces `TMUX_PANE`).

History lane does not change: `gmux ls` / `show` / `resume` / `grep` / `ask` still read session files, still `--json`. `resumeCommand` still returns `claude --resume <id>` / `codex resume`. Resume opens a **new gmux pane**. Picker stays CLI in v1 (`ctrl+shift+g` tmux popup dies with bindings).

`INDEX_VERSION` bumps only if `SessionRecord` changes shape — it should not.

---

### 10. Migration

**gmux is a multiplexer TUI, not a replacement for Ghostty / iTerm / kitty.** Open an emulator, run `gmux attach`.

**Clean break from tmux.** There is no `gmux.backend` flag. There is no dual-identity daemon. Finish work in tmux; history lane still sees every transcript.

| Old | New |
|---|---|
| `gmux setup` then `tmux source-file` | `gmux setup` (provider, guardian, **agentHarness**) then `gmux attach`. Offers `gmux tmux uninstall` if bindings are present. |
| `gmux tmux install` | Deprecated. Prints redirect to `gmux attach`. `uninstall` still strips `# >>> gmux >>>` and leftover `# >>> gigamanage >>>`. |
| `gmux daemon` as a tmux-watching tick | Supervisor: `gmuxd` + intel sidecar. `status` shows mux and intel independently. `stop` kills agents (says so). |
| `gmux cockpit` / `ctrl+g` popup | Removed as a process. `ctrl+g` from `pty` opens the sidebar (j/k). Type to reach the prompt. |
| `gmux overlay` | Removed. |
| `alt-g` border labels | Replaced by the sidebar. `daemon.sock` snapshot stream remains until these clients are deleted so we do not silently break a user who still has tmux bindings during dogfood — but the **model on that socket is tmux panes** only if they are still running the old daemon binary. New daemon does not speak `daemon.sock`. |
| `TMUX_PANE` / `gmux run` | `GMUX_PANE_ID` / mux spawn. |
| Live tmux panes | **Not imported.** |

Dogfood: two products, two daemons, if someone still has tmux open. Not one model with a backend enum.

`gmux doctor` grows: `gmuxd` present, `mux.sock` up, intel up, emulator note for `ctrl+t`.

Existing `~/.config/gmux/config.json` remains valid. Add optional `agentHarness`. **Do not bump `CONFIG_VERSION`.** `parseConfig` rejects `version > CONFIG_VERSION` (`src/services/config.ts` lines 68–71: ignoring the *file* is safe; it does not parse future versions). Setup writes `agentHarness` into a v1 file.

---

### 11. Agent-native API

CLI and **control** socket are the same surface. `--json` from day one. Every error carries a `fix` (`src/core/errors.ts`). Frames stay off this socket.

**Transport:** NDJSON on `mux.sock`. Either peer may originate a request (required for mux→intel). Correlation is `id`.

```json
{"id":"req_1","method":"pane.list","params":{}}
{"id":"req_1","result":{"panes":[]}}
{"id":"req_1","error":{"code":"not_found","message":"pane not found","fix":"Run gmux panes ls --json"}}
{"id":"ex_1","method":"prompt.extract","params":{"grid":{…}}}
{"id":"ex_1","result":{"text":"","confidence":"low","clearKeys":"\u0015","extractor":"shadow"}}
```

**Injected into every mux-spawned process:**

| Env | Purpose |
|---|---|
| `GMUX_SOCKET_PATH` | control socket |
| `GMUX_PANE_ID` | caller identity |
| `GMUX_TAB_ID` / `GMUX_WORKSPACE_ID` | addressing |
| `GMUX_CHILD=1` | existing recursion guard (`CHILD_ENV` in `src/services/config.ts`) |
| `GMUX_PEEL_DEPTH` | `"0"` / `"1"` / `"2"` |

**Peer pid:** macOS `getsockopt(LOCAL_PEERPID)` (or `LOCAL_PEEREPID` if pid is unavailable); Linux `getsockopt(SO_PEERCRED)` → `ucred.pid`. Pid-reuse across exec is an accepted v1 caveat (a recycled pid could theoretically be mis-classed until the pane's process tree is refreshed on the next tick).

**Classify by pid first** — env is never the class:

1. If pid == lock `intelPid` **and** the request presents `intel.token` → `intel`. Token without pid match, or pid match without token → `permission_denied`.
2. Else if pid is a recorded `client.attach` pid (the `gmux attach` process) → `tui`.
3. Else if pid is in any live pane's process tree (the pane `pid` or a descendant) → **`pane`**. `GMUX_PANE_ID` must equal that pane's id; missing or mismatch → `permission_denied`. **Never promote to `cli`.** Unsetting `GMUX_PANE_ID` cannot escape the pane class.
4. Else if uid == mux uid → `cli` (host tty / user's gun).
5. Else refuse the connection.

| Class | May |
|---|---|
| `tui` | Full control for this session except forging intel patches. Frames on its private data-plane socket. `ctrl+t` peels **this client's** focused pane. |
| `intel` | `pane.report_semantics`, `guardian.broadcast` (send_keys to **agent** panes only), read anything. **Handles** mux-originated `prompt.extract` / `context.pack` / `organize.plan` / `classify.intent`. |
| `pane` | `peel` (depth-bounded, from self), `pane.get`/`read` **self**, `pane.list` (same workspace), `session.snapshot` (read), `spawn --template`. **Not** `organize.apply`, **not** `send_keys` to other panes, **not** `pane.close` others |
| `cli` | Full control, documented. `gmux peel` without `--from` peels the **most recently attached TUI's** `focusedPaneId`; with `--from <id>` peels that pane. |

A compromised agent can peel up to depth 2 from itself and spawn an idle tests pane. It cannot retile the workspace, inject keys into siblings, or become `cli` by dropping env.

**Method ownership** (`mux` = implemented in `gmuxd`; `intel` = handled on the sidecar; `forward` = mux accepts from tui/cli and RPCs intel, then mux executes):

| Method | Owner | Direction | Deadline | Notes |
|---|---|---|---|---|
| `session.snapshot` | mux | client→mux | — | mux-assembled layout + last intel patches |
| `workspace.create` / `list` / `close` | mux | client→mux | — | empty attach uses create internally |
| `pane.list` / `pane.get` / `pane.read` | mux | client→mux | — | `read` is compact lines, not binary cells |
| `pane.send_keys` | mux | client→mux | — | ACL: cli/tui; intel-to-agents only; not pane-to-sibling |
| `pane.spawn` / `pane.close` / `tab.close` | mux | client→mux | — | `spawn({focus})` is per-client |
| `peel` | mux | client→mux | spawn <50 ms | **fast path local**. Then mux→intel `prompt.extract` + `context.pack` |
| `prompt.extract` | intel | **mux→intel** | 20 ms | correlation `id`; timeout → shadow-or-empty |
| `context.pack` | intel | **mux→intel** | 500 ms | timeout → seed+headline only |
| `classify.intent` | intel | **mux→intel** | 30 s (`CLASSIFY_TIMEOUT_MS`) | timeout → `"ask"` |
| `organize.plan` | intel | **mux→intel** (forward from tui/cli) | 120 s (`ORGANIZE_TIMEOUT_MS`) | timeout → heuristic plan |
| `organize.apply` | mux | tui/cli→mux | — | mux executes grouping verbs; **not** forwarded. Pane callers denied. |
| `pane.report_semantics` | mux (accept) | intel→mux | — | patches by `paneId` |
| `guardian.broadcast` | mux (accept) | intel→mux | — | send_keys to agent panes only |
| `events.subscribe` | mux | client→mux | — | `pane.created`, `pane.exited`, `pane.state`, `model.change`, `intel.status` — **not frames** |
| `client.attach` | mux | TUI→mux | — | mints frame-socket name; stores this client's `focusedPaneId` |

TUI data-plane messages (`Input`, `Resize`, `FrameAck`, `Mouse`) are not control methods.

Ask/organize through the prompt is TUI → mux `classify.intent` then `organize.plan` (both mux→intel) then preview; Enter sends `organize.apply` to mux.

**Peel recursion bound:**

```
peelDepth(caller) = int(GMUX_PEEL_DEPTH or 0)
if method == "peel" and peelDepth(caller) >= 2:
    error code=peel_bounded
    fix="Peel is bounded at depth 2. Spawn a template pane (gmux spawn --template tests) or return to the user."
newPane.peelDepth = caller.peelDepth + 1
```

Templates start at depth 0. Bound is always the calling pane's `peelDepth`. `gmux peel` from a host shell (cli class) peels `--from <id>` if given, else the most recently attached TUI's `focusedPaneId`. There is no server-global focus to default to.

---

### 12. Preserve

| Invariant | Where it lives | Notes |
|---|---|---|
| Layer rule `core ← adapters ← services ← cli` | `scripts/check-layers.mjs` | Walks `src/` only. Mux crate is `crates/mux/`. `MuxGateway` is services-layer I/O. |
| Read-only session files | `AGENTS.md` #1 | Owns `~/.cache/gmux` and `~/.config/gmux`. Grids stay in mux memory; snapshot file does not persist full grids. |
| Two-layer signal | `docs/gmux.md`, `classifyState`, `SemanticWorker` | Fast path (state, memory, guardian, **peel spawn**) survives the slow path. A hung `claude -p` cannot block `ctrl+t`. |
| Summary cache hashing | `distill()` hash + `PROMPT_VERSION` | Peel does not invalidate summaries. |
| `GMUX_CHILD=1` | `childEnv()` / `isChildProcess()` | Injected on every spawned pane **and** sidecar provider calls. |
| Provider vs adapter | `providers.ts` vs `adapters/registry.ts` | `agentHarness` is an adapter id. `provider` is a summarizer argv. |

---

## API / Interface Changes

### Config (`src/core/types.ts` `GmConfig`)

```typescript
export interface GmConfig {
  version: number; // stays CONFIG_VERSION = 1
  provider: ProviderChoice | null;
  /** Interactive harness for new panes / peels. Adapter id, e.g. "claude-code". Optional. */
  agentHarness?: HarnessId | null;
  autoSummarize: boolean;
  gmux?: GmuxConfig;
}
```

Summary provider resolution unchanged (`GMUX_SUMMARY_CMD` > config `provider` > first detected > `claude -p`).

Agent harness for peel/spawn:

1. `GMUX_AGENT_HARNESS` env (test/CI).
2. `config.agentHarness` if set and `launchCommand` is on PATH.
3. First adapter whose `launchCommand` is on PATH (catalog order: Claude Code then Codex).
4. Else `$SHELL`, sidebar status `no agent harness — gmux setup`.

`gmux run` keeps `resolveHarnessArg`. Peel uses the resolved default; v1 has no harness flag on `gmux peel` (`pane.spawn` with argv for overrides).

### CLI additions

```
gmux attach [--cwd <dir>]  # start mux if needed, attach TUI
gmux detach                # disconnect this TUI (agents keep running)
gmux snapshot --json
gmux workspace create|ls|close
gmux panes ls|show|read|close --json
gmux peel [--from <id>] [--json]
gmux spawn --template tests|logs|review
gmux spawn --argv claude --cwd …
gmux organize [intent…]    # dry-run default; --apply; --json; OrganizePlan.schemaVersion (SCHEMA_VERSION stays 1)
```

`gmux cockpit` and `gmux overlay` become hidden aliases that print `use gmux attach; ctrl+g opens the sidebar` and exit 2.

History-lane commands stay filesystem-only and do not require `gmuxd`.

---

## Data Model Changes

- `paneId`: `%N` → `p_<ulid>`
- `windowId` → `tabId`
- add `workspaceId`, `peelDepth`, `templateId`
- `Observation.toolStarts?: ToolStart[]` (new sensor work)
- `WorkspaceSnapshot` additive: `tabs: { tabId, name, paneIds }[]`, `intel: { up: boolean }`. Snapshot file remains cache and **does not** include grids.
- `pane-links.json` pruned to mux `pane.list`.
- `OrganizePlan.schemaVersion` = 2 in the organize-verbs PR. **`SCHEMA_VERSION` stays 1.**
- `CONFIG_VERSION` **not** bumped.
- `intel.token`, `mux.lock`, `mux.sock`, `mux.frames.<id>.sock` under `~/.cache/gmux/gmux/`.
- `daemon.sock` untouched until old clients are deleted.

No migration job for tmux layouts. No write to `~/.claude` / `~/.codex`.

---

## Alternatives Considered

### Already rejected (locked — do not reopen)

| Alternative | Why it was rejected |
|---|---|
| Stay a layer on tmux; wrap launch to intercept stdin | Cannot scrape an alternate-screen composer; cannot draw a sidebar that isn't a popup. Wrapping stdin is wrapping the agent. |
| Per-harness plugins | We do not wrap/replace harnesses. |
| Ghost-complete in the prompt | Too slow. Peel must be instant. |
| Jump-to-new-tab on `ctrl+t` | Focus stays on the parent. |
| Isolated worktree on every peel | Same cwd, not a git worktree manager. |
| Silent session fork | New process, slice of context, not a JSONL clone. |
| All-three-pillars fully unattended | Tabs wait for a prompt or `ctrl+t`. |
| All-three wait for a prompt | Memory would only notify. |
| Permanent master-detail sidebar column | Funnel is glance → one overview → drawer. |
| Workspace-wide card zoom | That is the overlay we are replacing. |
| Fork tmux (old "Stage B") | All cost of owning a runtime, none of the clean foundation. |
| Intercept `/` while PTY-focused | Breaks slash commands, paths, search. |

### Considered in this redesign

**A. TypeScript mux in-process with the daemon (`node-pty` + `@xterm/headless` + Ink)**

Rejected as the target. Peel would still share the event loop with LLM work unless we split processes anyway.

**B. All-Rust rewrite of intelligence**

Rejected. Months of adapter/distill/organize/guardian regressions.

**C. gmux-owned input line that forwards to the agent**

Rejected. Wraps the harness. Fallback is shadow buffer + empty peel.

**D. Keep `ctrl+g` as a popup, add a sidebar later**

Rejected. The overlay *is* the product problem.

**E. Stay the TS awareness layer; herdr (or Zellij) owns PTYs**

- Pros: no `gmuxd`; detach-without-death and SCM_RIGHTS already exist on herdr; unix socket + CLI parity already designed; faster path to “agents survive TUI crash.”
- Cons: cannot own peel (`ctrl+t` intercept + composer extract + clear), cannot own the funnel chrome (never-over-PTY drawer, gmux prompt), cannot own the keymap (herdr prefix is `ctrl+b`; `/` and agent keys are their problem but so is our `ctrl+t`). Competitor dependency for the product's wedge. We would still write extractors and then ask herdr to grow a privileged intel client and a non-tiling sidebar — i.e. build gmux inside someone else's mux.
- Verdict: **rejected for v1.** The wedge is understanding + peel + promptable grouping. Owning the runtime is what makes those possible without wrapping agents. Revisit only if `gmuxd` fails to dogfood before peel extractors are real.

**F. Dual tmux/mux backend flag**

Rejected. Two identity systems in one daemon. Clean break; history lane is the rollback.

**G. v1 tiling compositor (herdr-style splits)**

Rejected for v1. Single-PTY + sidebar is the product that matches “new tab appears in the sidebar” and “don't move what you were looking at.” Splits can be a later compositor if users demand them; they are not implied by organize grouping.

---

## Security & Privacy

**Threat model (local, single-user):**

| Threat | Mitigation |
|---|---|
| Socket world-readable | `0600`, owner uid; refuse other uids. |
| Child agent peels until exhaustion | `GMUX_PEEL_DEPTH` ≥ 2 refused. Templates deduped on `callId` + `(workspaceId, templateId)`. |
| Child agent `send_keys` into a sibling / `organize.apply` | Caller class `pane` cannot. |
| Child unsets `GMUX_PANE_ID` to become `cli` | Classified by peer pid first. Descendant of a pane pid is always `pane`; missing env is `permission_denied`. |
| Forged intel | Token 0600 + peer pid must match lock `intelPid` (macOS `LOCAL_PEERPID`, Linux `SO_PEERCRED`). |
| Guardian types into a human shell | Only `harness && sessionId`. |
| Composer text on the public socket | Frames are a private TUI socket. Extract RPCs are intel-only. Snapshot file has no grids. Logs: composer/pack at debug only behind a flag. |
| Session files modified | Unchanged: read-only. |
| `cli` as a gun | Documented. Same uid as the user who started gmuxd. |

Auth is uid + peer pid class (token / pane tree / attach pid). No network bind. Env vars never promote a class.

---

## Observability

| Signal | How | UX |
|---|---|---|
| Mux up | `mux.lock` + `mux.sock` | `gmux daemon status`; TUI “connecting…” |
| Intel up | sidecar hello + heartbeat in snapshot `intel.up` | “intel down — glyphs only” (`working`/`idle` only) |
| Fast-path peel | mux histogram keypress→spawn ms | Log if > 50 ms |
| Extract failures | counter per extractor + timeout + abort-on-uncleared | Sidebar toast |
| Guardian fire | `guardianLog` (last 50) | Sidebar pin |
| Semantic lag | `semantics.stale` | Headline stays, glyph live |
| Provider errors | `gmux doctor` last-error | Unchanged |

Mux log: `~/.cache/gmux/gmux/mux.log`, size-capped. Never log composer contents or context packs at info.

Hang-the-summarizer test remains mandatory, plus: sidecar wedged / killed, `ctrl+t` still spawns within 50 ms (`cargo test` + a Vitest fake).

---

## Rollout Plan

This is **months of dogfood**, not a sprint. Experimental until PR-peel extractors have captured fixtures for current Claude Code and Codex. **Not** the npm default until that gate. `gmux ls` remains the stable product throughout.

1. Headless `gmuxd` + singleton lock + control socket (no TUI).
2. VTE + `pane.read` + full-bleed attach (one PTY, no sidebar) as experimental `gmux attach`.
3. Sidecar intel against mux. Old tmux daemon binary still exists for people who have not switched; new daemon does not paint tmux borders.
4. Sidebar glance → funnel → prompt.
5. Mux-local peel, then extractors + pack.
6. Guardian via mux send_keys (intel class).
7. Templates (idle shells).
8. `gmux tmux uninstall` as the setup recommendation. Delete overlay/cockpit commands.

**Rollback:** `gmux daemon stop` (kills live mux agents). Work that still lives in tmux is untouched. History lane never needs rollback. No `gmux.backend` switch.

---

## Open Questions

Locked product decisions are not repeated here.

1. **`ctrl+shift+t` as a v1 alias** for host-emulator New Tab theft. Does not replace locked `ctrl+t`. Recommendation: yes, alias, no config surface yet.
2. **Homebrew tap** after fetch-if-missing dogfoods. Not v1-blocking.
3. **Import of live tmux panes.** v1 clean break. `gmux import-tmux` would need fd stealing we likely cannot do. Won't-have unless demand appears.
4. **Linux cgroup v2 `memory.max`.** Defer until guardian-on-mux is real.
5. **Mux live-upgrade (`SCM_RIGHTS`).** Needed before 8-hour agents live exclusively in gmux. Not v1.
6. **Picker inside the TUI.** History lane stays CLI in v1.
7. **SSH attach** as a productized remote story. Two local TUIs are **in v1** (per-client focus + per-client frame socket). SSH is not a v1 goal but is not designed out.

---

## References

- Canonical code: [`/Users/jamesgao/Projects/side/gigamanage`](/Users/jamesgao/Projects/side/gigamanage)
- Current product: [`/Users/jamesgao/Projects/side/gigamanage/docs/gmux.md`](/Users/jamesgao/Projects/side/gigamanage/docs/gmux.md)
- Layers, provider vs adapter, `GMUX_CHILD`: [`/Users/jamesgao/Projects/side/gigamanage/docs/architecture.md`](/Users/jamesgao/Projects/side/gigamanage/docs/architecture.md)
- Superseded Stage A/C spec: [`/Users/jamesgao/Projects/side/gigamanage/docs/superpowers/specs/2026-08-11-gmux-design.md`](/Users/jamesgao/Projects/side/gigamanage/docs/superpowers/specs/2026-08-11-gmux-design.md)
- Distill / summary tiers: [`/Users/jamesgao/Projects/side/gigamanage/src/services/distill.ts`](/Users/jamesgao/Projects/side/gigamanage/src/services/distill.ts)
- Overlay being replaced: [`/Users/jamesgao/Projects/side/gigamanage/src/cli/overlay.ts`](/Users/jamesgao/Projects/side/gigamanage/src/cli/overlay.ts)
- Organize: [`/Users/jamesgao/Projects/side/gigamanage/src/services/organize.ts`](/Users/jamesgao/Projects/side/gigamanage/src/services/organize.ts)
- Guardian: [`/Users/jamesgao/Projects/side/gigamanage/src/services/guardian.ts`](/Users/jamesgao/Projects/side/gigamanage/src/services/guardian.ts)
- Ask router: [`/Users/jamesgao/Projects/side/gigamanage/src/services/ask-router.ts`](/Users/jamesgao/Projects/side/gigamanage/src/services/ask-router.ts)
- Fake tmux gateway: [`/Users/jamesgao/Projects/side/gigamanage/tests/fixtures/fake-gateway.ts`](/Users/jamesgao/Projects/side/gigamanage/tests/fixtures/fake-gateway.ts)
- `parseConfig` version reject: [`/Users/jamesgao/Projects/side/gigamanage/src/services/config.ts`](/Users/jamesgao/Projects/side/gigamanage/src/services/config.ts)
- herdr: https://herdr.dev/docs/concepts/ · https://herdr.dev/docs/socket-api/
- herdr live fd handoff (v2): https://herdr.dev/blog/live-updates-without-killing-your-terminal-processes/

---

## PR Plan

Each PR is independently reviewable and mergeable. This sequence is **experimental/dogfood**, not a small increment. npm default stays the current tmux-aware CLI until peel extractors have captured fixtures (gate on the peel-extract PR).

`npm test` remains layer check + vitest. Mux PRs add a **separate** `cargo test` CI job.

### PR 1 — Mux types and `MuxGateway` seam

- **Title:** `feat(gmux): add MuxGateway and durable pane identity types`
- **Files/components:** `src/core/gmux-types.ts`, `src/core/types.ts` (`PaneLink` comment), new `src/core/mux-types.ts` (`GmuxPane`, `GridSnapshot`, `SpawnOpts`, `ToolStart`), new `src/services/mux-gateway.ts` (interface + `FakeMuxGateway`), Vitest for the fake.
- **Dependencies:** none
- **Description:** Additive `tabId` / `workspaceId` / `peelDepth`. **Do not** rename `OrganizeStep` ops. `TmuxGateway` and `tests/fixtures/fake-gateway.ts` stay. No user-facing change.

### PR 2 — Headless `gmuxd` (spawn, detach, control socket, lock)

- **Title:** `feat(mux): headless gmuxd with spawn, singleton lock, and NDJSON control socket`
- **Files/components:** `crates/mux/` (tokio, portable-pty, unix socket). `mux.sock`, `mux.lock`. CLI: `gmux snapshot`, `gmux spawn --argv`, `gmux panes ls`. **No** ratatui yet.
- **Dependencies:** PR 1
- **Description:** `ping`, `session.snapshot`, `pane.list`, `pane.spawn`, `pane.send_keys`, `pane.close`, `events.subscribe`. Two-attach race: second process connects, does not spawn; each client has its own `focusedPaneId`. Peer pid via `LOCAL_PEERPID` (macOS) / `SO_PEERCRED` (Linux); pane-tree descendants never classify as `cli`. Mux-local **shadow peel** RPC (`peel` spawns from shadow-or-empty, `focus: false` = this client). `cargo test` for lock + spawn + peel-without-intel + pid-class. Fetch-if-missing not required yet (dev builds from source). Bidirectional intel framing is stubbed (`hello` only) until PR 5.

### PR 3 — VTE grid + compact scrollback + `pane.read`

- **Title:** `feat(mux): VTE grid parser and compact-line scrollback`
- **Files/components:** `crates/mux` vte integration. `pane.read` / `readGrid`. Cell→`GridSnapshot` intensity mapping (DIM→0, BOLD→2, else 1).
- **Dependencies:** PR 2
- **Description:** Headless. Tests with recorded ANSI fixtures (including a color/dim sample). Scrollback is lines, not cell-rows. Still no TUI.

### PR 4 — Full-bleed attach TUI + data plane

- **Title:** `feat(mux): gmux attach TUI with private frame socket`
- **Files/components:** ratatui client, `client.attach`, `mux.frames.<id>.sock`, closed little-endian frame packet (`nrects`, 16-byte ULID `pane_id`), `Input` / `Resize` / `FrameAck` / `Mouse`. Content region = full terminal (no sidebar yet). `ctrl+q` detach. SIGWINCH → this client's pty.resize. `crates/mux/tests/frame_hex.rs` annotated 2×1 full-frame fixture.
- **Dependencies:** PR 3
- **Description:** One PTY on screen **per client**. Empty attach bootstraps workspace+tab+login shell and sets **this client's** focus. Detach does not kill the child. Skip-if-behind (`seq - last_ack > 1` → next frame `full`). Agent control socket stays NDJSON and does **not** carry frames. Experimental binary, not npm default.

### PR 5 — Intelligence sidecar on mux (not tmux)

- **Title:** `feat(daemon): intel sidecar patches mux panes`
- **Files/components:** `src/services/daemon.ts`, `src/cli/commands/daemon.ts` (`--sidecar`), `src/services/sensors.ts` (`TerminalSensor` via `readGrid`; drop `pipe-pane` on this path), `src/services/pane-registry.ts`, `intel.token`, `Observation.toolStarts` plumbing (field may land empty until templates). `gmux daemon status` prints mux vs intel.
- **Dependencies:** **PR 2 and PR 3** (socket + lock + `readGrid`). PR 4 is dogfood-only, not a merge gate.
- **Description:** Mux owns layout; intel patches `state`/`semantics`/`resources`/`guardianLog`. Intel connection is bidirectional: mux may send `prompt.extract` / `context.pack` / `organize.plan` / `classify.intent` with ids and deadlines. `TerminalSensor` uses `readGrid` (PR 3); drop `pipe-pane` on this path. `session.snapshot` is mux-assembled. Hang-the-summarizer test plus **sidecar killed, peel still spawns** (PR 2 peel method). `daemon.sock` is not reused. `TmuxGateway` unused by the new daemon, kept for old tests. `gmux ls` unchanged.

### PR 6 — Native sidebar chrome (glance, all panes)

- **Title:** `feat(tui): always-on sidebar with glance rows`
- **Files/components:** TUI layout (40-col sidebar + one PTY). `stateGlyph`. Click-to-focus. Lists **all** panes, agents first. PTY winsize = content region. Guardian log pin.
- **Dependencies:** PR 4, PR 5
- **Description:** Replaces tmux borders for attach users. No funnel expansion yet. `ctrl+g` from `pty` enters `sidebar` (not a popup, not the prompt). Mouse: chrome columns are chrome; content region forwards SGR when the pane requested it.

### PR 7 — Funnel (focus + dive), client-local

- **Title:** `feat(tui): sidebar funnel — overview expand and summary drawer`
- **Files/components:** TUI only. Keyboard: `j`/`k` in `sidebar` mode, Enter, Esc. Input-mode state machine: `ctrl+g` from `pty` lands in `sidebar`; printable from sidebar focuses the prompt; Esc from sidebar → `pty`. `/` not intercepted in `pty`.
- **Dependencies:** PR 6
- **Description:** Never paints over the PTY. Expansion is not sent to the server. Keyboard users can reach the peeled row without a mouse.

### PR 8 — gmux prompt + organize grouping apply

- **Title:** `feat(tui): sidebar prompt; organize tabs (no tiling)`
- **Files/components:** TUI prompt (entered by typing from `sidebar`); mux→intel `classify.intent` / `organize.plan`; `src/core/organize-types.ts` v1 four-op union + `OrganizePlan.schemaVersion = 2`; `HeuristicOrganizePlanner` drops `select-layout`; `applyPlan` via `MuxGateway`; **`SCHEMA_VERSION` stays 1**; `src/cli/organize-confirm.ts` generation guard in the drawer.
- **Dependencies:** PR 5, PR 7
- **Description:** Preview-then-apply. Dry-run default. First PR that changes organize `--json` shape (`schemaVersion: 2`) — not while tmux is still the apply target. History-lane `--json` unchanged.

### PR 9 — Prompt extractors + peel submit/clear (slow path)

- **Title:** `feat(peel): grid extractors, parent clear, harness submit`
- **Files/components:** `src/services/prompt-extract.ts`; fixtures `tests/fixtures/grids/{claude-code,codex,shell}/` (**at least one captured fixture per harness** before claiming it works); mux keymap `ctrl+t` already spawning (PR 2); clearKeys + abort-submit-if-uncleared; 20 ms extract timeout; `GMUX_PEEL_DEPTH`; `agentHarness` optional on v1 config; `gmux peel --json`.
- **Dependencies:** PR 3 (grid), PR 5 (intel extract RPC), PR 6 (sidebar row). Fast spawn does **not** depend on this PR.
- **Description:** Slow path only. Failure matrix tests: intel down, timeout, uncleared, empty. npm default still gated on these fixtures.

### PR 10 — Context pack

- **Title:** `feat(peel): bounded parent context pack`
- **Files/components:** `src/services/context-pack.ts`. Cite `RECENT_PROMPT_COUNT = 12`, use last 3; Codex prompts not `humanText()`-filtered; 4 KiB budget; 500 ms headline-only; no late second submit.
- **Dependencies:** PR 9
- **Description:** Never `readJsonl` on this path. Uncleared parent → pack dropped.

### PR 11 — Guardian via mux `send_keys`

- **Title:** `feat(guardian): checkpoint-and-pause through MuxGateway`
- **Files/components:** `src/services/daemon.ts` send loop (intel ACL), `src/services/guardian.ts` culprit label `pane` not `window`, existing fake-clock tests.
- **Dependencies:** PR 5
- **Description:** Same policy/cooldown/hysteresis/consent. No broadcast if intel down. Can parallelize with PRs 6–10 once PR 5 is in.

### PR 12 — Workspace templates (idle shells)

- **Title:** `feat(templates): idle tests/logs/review panes on tool-start`
- **Files/components:** `src/core/template-types.ts`, `src/services/templates.ts`, `AgentSensor` `toolStarts` parser + fixtures (one Claude `tool_use` Bash, one Codex `function_call` shell/`cmd`), `callId` dedup, first-match-wins, review regex `\b(pr|pull request|review)\b` on headline+overview, `gmux spawn --template`.
- **Dependencies:** PR 5 (`toolStarts`), PR 6 (visible rows)
- **Description:** Idle `$SHELL` only. No argv re-exec. `dev-server-start` shares the `logs` template id. JSON paths pinned next to adapter fixtures.

### PR 13 — Agent ACL, `--json` parity, tmux deprecation

- **Title:** `feat(api): caller ACL, tmux uninstall path, experimental gate docs`
- **Files/components:** caller-class enforcement tests, setup `agentHarness` question + uninstall offer, `tmux install` deprecation, `doctor`, README / `docs/gmux.md`, hide `cockpit`/`overlay`.
- **Dependencies:** PRs 2–12
- **Description:** Documents Ghostty/iTerm as the emulator. Recursion: `GMUX_CHILD=1` + peel depth ≥ 2. States clearly: experimental until PR 9 fixtures; not a small increment.

**Parallel after PR 5:** chrome (6–8) ∥ peel slow path (9–10) ∥ guardian (11) ∥ templates (12). PR 13 last.

---

## Revision Summary

Addressed design reviews (2026-08-25): v1 is single-PTY + sidebar groups (no tiling); peel spawn is mux-local; `/` is not intercepted in `pty` mode; `ctrl+g` from `pty` lands in `sidebar` (j/k immediately; type to prompt); mux→intel RPC is bidirectional with a method-ownership table; focus is per-client; ACL classifies by peer pid (`LOCAL_PEERPID` / `SO_PEERCRED`) so unsetting `GMUX_PANE_ID` cannot become `cli`; data-plane wire format is closed (nrects, 16-byte ULID, skip-if-behind → full); `OrganizePlan.schemaVersion` (SCHEMA_VERSION stays 1); PR 5 depends on PR 2+3; ToolStart JSON paths and review regex pinned. Canonical code root is `side/gigamanage`.
