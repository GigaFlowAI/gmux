# Pane-border labels + process resolver — Implementation Plan

> Executed directly with TDD in this session (small, self-contained). Steps are checkboxed for tracking.

**Goal:** Resolve a tmux pane to its exact session via the agent process's argv/cwd, show each session's headline on its pane border via a toggle, and remove the popup's first-paint lag. Ships v0.8.0.

**Architecture:** `services/pane-process.ts` reads the pane's process tree (pure parse + thin `pgrep`/`ps`/`lsof` glue). `services/tmux-resolve.ts` gains a process hint as its highest heuristic and an async `resolvePanesLive`. `cli` gains `paneLabel` and `gm tmux label`, plus the install binding; the overlay command consumes `resolvePanesLive` and serves its first paint from the cached index.

## Global Constraints
- Layer rule `core ← adapters ← services ← cli` (enforced). `pane-process` + resolver in `services`; label/command/binding in `cli`.
- ESM `.js` import extensions.
- No model calls in resolve/label/render paths.
- `npm run check` + `npm run build` green before each commit.

---

## Task 1: pure agent parsing (`parseAgentSession`, `pickAgentProcess`)
**Files:** create `src/services/pane-process.ts`; `tests/pane-process.test.ts`.
**Produces:**
- `interface AgentProcess { pid: number; command: string }`
- `interface AgentSession { harness: HarnessId; sessionId: string }`
- `parseAgentSession(command: string): AgentSession | null` — `codex resume <uuid>` → codex; `claude --resume <uuid>` / `claude -r <uuid>` → claude-code; uuid is `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`; else null.
- `pickAgentProcess(procs: AgentProcess[]): AgentProcess | null` — first proc whose command names `claude`/`codex` as the invoked binary AND is not an MCP child (command includes `resume`/`--resume`/`exec` or the bare harness). Prefer a proc yielding a session id; else the first harness proc.

- [ ] Write `tests/pane-process.test.ts` (uuid extraction for both harnesses; `-r`; bare harness → null; MCP child `node ./mcp/server.mjs` → null; malformed uuid → null; pickAgentProcess prefers the resume proc over an MCP child).
- [ ] Run → fail.
- [ ] Implement the pure functions.
- [ ] Run → pass; `npm run check`.
- [ ] Commit `feat(tmux): parse agent session id from process argv`.

## Task 2: process-tree shelling
**Files:** extend `src/services/pane-process.ts`.
**Produces:**
- `panePid(paneId): Promise<number | null>` — `tmux display-message -p -t <paneId> '#{pane_pid}'`.
- `descendants(pid): Promise<AgentProcess[]>` — BFS `pgrep -P` to depth ≤ 6, then `ps -p <ids> -o pid=,command=`.
- `processCwd(pid): Promise<string | null>` — `/proc/<pid>/cwd` (linux) or `lsof -a -p <pid> -d cwd -Fn` (macOS).
- `interface PaneProcessHint { argvSession: AgentSession | null; agentCwd: string | null }`
- `paneProcessHint(paneId): Promise<PaneProcessHint>` — panePid → descendants → pickAgentProcess → { parseAgentSession(agent.command), processCwd(agent.pid) }. All failures degrade to `{ argvSession: null, agentCwd: null }` (never throws).

- [ ] Implement (glue; no new unit tests — pure core covered in Task 1, and it must never throw).
- [ ] `npm run check`; hand-verify `node dist/... ` against a live pane returns the right session id.
- [ ] Commit `feat(tmux): read pane agent process tree (pid, cwd, argv)`.

## Task 3: resolver order + `resolvePanesLive`
**Files:** modify `src/services/tmux-resolve.ts`; extend `tests/tmux-resolve.test.ts`.
**Produces:**
- `resolvePaneToRecord(pane, records, links, hint?: PaneProcessHint)` — order: explicit link → `hint.argvSession` (record with that harness+id) → `hint.agentCwd` newest → `pane.cwd` newest → null. Keeps working with `hint` undefined (today's behaviour).
- `resolvePanesLive(panes, records, links): Promise<ResolvedPane[]>` — computes `paneProcessHint` per pane (in parallel) and calls `resolvePaneToRecord` with it.

- [ ] Add tests: argvSession beats cwd; agentCwd beats pane cwd; hint absent → old behaviour; unknown argv id falls through to cwd.
- [ ] Run → fail; implement; run → pass; `npm run check`.
- [ ] Commit `feat(tmux): resolve panes by agent argv/cwd first`.

## Task 4: `paneLabel` + `gm tmux label` toggle
**Files:** `src/cli/tmux-label.ts` (or in `commands/tmux.ts`); `src/cli/commands/tmux.ts` register; tests for `paneLabel`.
**Produces:**
- `paneLabel(view: SessionView | null, width?: number): string` — `"project — headline"`; `"○ project"` when resolved but unsummarised; `""` when null; clipped.
- `gm tmux label <window>` — toggle: read `pane-border-status`; if off → `resolvePanesLive` for the window's panes, `select-pane -T` each title, then set `pane-border-status top` + `pane-border-format`; if on → set `pane-border-status off`.

- [ ] Test `paneLabel` (three shapes + clip).
- [ ] Implement + register in `main.ts`.
- [ ] `npm run check` + `npm run build`; hand-verify the toggle on a live server.
- [ ] Commit `feat(tmux): gm tmux label toggles pane-border headlines`.

## Task 5: install binding
**Files:** `src/cli/commands/tmux.ts` `bindingsBlock`; `tests/tmux-install.test.ts`.
- [ ] Add `bind -n M-g run-shell "gm tmux label \"$(tmux display -p '#{window_id}')\""` to the block, with a comment; assert it in the test (and that it resolves the window id in-shell).
- [ ] Run → pass; `npm run check`.
- [ ] Commit `feat(tmux): install the pane-label toggle binding`.

## Task 6: overlay uses live resolver + first-paint lag fix + release
**Files:** `src/cli/commands/overlay.ts`; `package.json`; `CHANGELOG.md`.
- [ ] `frame()` uses `resolvePanesLive`; load records once for the overlay's lifetime (don't re-scan every repaint) and re-read only summaries per tick.
- [ ] Bump `0.8.0`; CHANGELOG entry (voice-matched: exact resolution, pane-border labels toggle, instant peek).
- [ ] `npm run check` + `npm run build`; commit `feat: pane-border labels, exact resolution, faster peek (v0.8.0)`.

## Final
- [ ] Full `npm run check` green; PR off `tmux-pane-labels`; own through merge; tag `v0.8.0`; verify npm publish.
