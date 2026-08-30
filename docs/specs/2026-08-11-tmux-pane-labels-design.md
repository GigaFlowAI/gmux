# Pane-border labels: each agent's headline, on its own pane

**Date:** 2026-08-11
**Status:** approved, not yet implemented

## The problem

The `ctrl-g` peek overlay works, but two things surfaced in real use:

1. **It can't tell which session a pane is running.** The resolver matches a
   pane's `pane_current_path` against session working directories. But
   `pane_current_path` is the *shell's* cwd — usually `~` or a parent — while the
   agent runs as a child `node` process whose real cwd is the repo. So panes
   resolve to the wrong session, or to nothing. Measured on a live machine:
   every agent pane reported `cwd = ~`, while its work lived in
   `~/Projects/gigarepo`.

2. **A full-screen popup is heavier than the job needs.** To answer "what is each
   of these panes doing?" you don't want the screen taken over — you want a label
   on each pane, with the pane still visible, so you can ground what you're
   looking at.

There's a much stronger resolution signal sitting unused, and a lighter way to
show the result.

## What we're building

Two things, one enabling the other.

**Exact resolution from the pane's own process.** The agent process carries the
session id in its command line — `codex resume <id>`, `claude --resume <id>` —
and both ids are exactly gigamanage's session id (verified against a live index).
So we walk the pane's process tree to the harness process and read the id
straight off its argv; where there's no id on the line (a fresh session), we use
that process's *real* cwd instead of the shell's. No `gm run`, no `gm link`, no
cwd guessing.

**A pane-border-label HUD.** A toggle that writes each pane's headline into its
tmux pane title and turns on `pane-border-status`, so every pane border carries
its session's one-line summary while the pane content stays fully visible. Toggle
again to clear it. The `ctrl-g` popup stays for the full cards.

Both are additive. Nothing about the existing overlay, adapters, or summariser
changes shape; the resolver gains a stronger first step, and the CLI gains one
command and one binding.

## Why not the alternatives we tried

- **`#(gm pane-label #{pane_id})` in `pane-border-format`.** tmux runs `#()`
  asynchronously and renders empty until it completes, and per-pane `#{pane_id}`
  substitution inside `#()` proved unreliable — it came back blank. Setting pane
  *titles* from one `gm` pass and formatting `#{pane_title}` is synchronous,
  reliable, and cheaper (one resolve pass, not one command per pane per tick).
- **`lsof` for the open `.jsonl`.** Agents don't hold the transcript open
  continuously, so `lsof` misses it. The argv id is always present for a resumed
  session and needs no elevated access.
- **`gm run` / `gm link`.** Both work, but both ask you to change how you launch
  or to run a command per pane. Reading the process metadata means it "just
  works" for panes you already have open.

## 1. The process-introspection resolver

A new `services/pane-process.ts`, and a new first step in
`services/tmux-resolve.ts`.

**Reading the process tree** (glue, hand-verified):

- `panePid(paneId)` → `tmux display-message -p -t <paneId> '#{pane_pid}'`. This is
  the pane's shell.
- `descendants(pid)` → walk `pgrep -P <pid>` breadth-first to a bounded depth,
  collecting `{ pid, command }` for each (via `ps -p <pids> -o pid=,command=`).
  Bounded so a runaway tree can't hang the resolve.
- `processCwd(pid)` → the process's real working directory: `/proc/<pid>/cwd` on
  Linux, `lsof -a -p <pid> -d cwd -Fn` on macOS. Returns null if unavailable.

**The pure core** (unit-tested):

- `parseAgentSession(command)` → `{ harness, sessionId } | null`. Matches the
  harness signatures and extracts the id:
  - `codex resume <uuid>` → `{ harness: "codex", sessionId }`
  - `claude --resume <uuid>` / `claude -r <uuid>` → `{ harness: "claude-code", sessionId }`
  - The `<uuid>` is the standard 8-4-4-4-12 hex form; anything else is ignored.
- `pickAgentProcess(processes)` → the harness process among the descendants, or
  null. A harness process is one whose command names a known harness binary
  (`claude`, `codex`) — **not** its MCP-server children (`node ./mcp/server.mjs`,
  `playwright-mcp`), which are deeper in the tree. Prefer a process whose argv
  yields a session id; otherwise the first harness process, for its cwd.

**The resolution order** in `resolvePaneToRecord`, highest first:

1. **Explicit pane-link** — a `gm run` / `gm link` entry (unchanged; still wins).
2. **argv session id** — `pickAgentProcess` → `parseAgentSession` → the record
   with that `harness` + `sessionId`, if the index knows it. Exact.
3. **Agent-process cwd** — the harness process's real cwd → newest session in it.
   Covers a fresh session started in a repo, where argv carries no id.
4. **Pane cwd** — the existing `pane_current_path` heuristic, as a last resort.
5. **null** — the muted placeholder / no label.

Steps 2–3 are the new power. Step 1 and 4–5 are today's behaviour, reordered
around them.

**Cost.** Steps 2–3 shell out to `pgrep`/`ps`/`lsof` per pane — a few
milliseconds each, run for a handful of panes, and only when there's no explicit
link. Acceptable for both the label pass and the popup.

## 2. `gm tmux label <window>` — the HUD toggle

A new `cli` command. It **toggles** the border-label HUD for a window:

- Read the window's current `pane-border-status`.
- **If off:** for each pane, resolve it (§1), read its cached summary, and set the
  pane title with `tmux select-pane -t <paneId> -T "<label>"`. Then set
  `pane-border-status top` and `pane-border-format` for the window. The label is
  `project — headline`; a resolved session with no summary yet is `○ project`; an
  unresolved pane keeps an empty title (its border shows nothing).
- **If on:** set `pane-border-status off`. The titles are left as-is (harmless;
  they're only shown when the border status is on).

One `gm` invocation resolves every pane and sets every title — no per-pane
command in the format, no async blanks. Re-running while on repopulates (a manual
refresh); a live auto-refresh is a deliberate non-goal for v1 (see below).

**The label builder** is pure and tested: `paneLabel(view)` →
`"project — headline"`, `"○ project"`, or `""`, clipped so a long headline can't
blow out the border.

`gm tmux label` reuses the resolver and the summary cache; it never calls a model
(labels render from what's already summarised, exactly like the overlay).

## 3. Install and the binding

`gm tmux install`'s block gains a third binding — a toggle on a key distinct from
`ctrl-g` (the popup). Default `M-g` (Alt-g), shown in the block so a user with a
conflict can rebind, and resolving the window id in-shell like the `ctrl-g` fix:

```
bind -n M-g run-shell "gm tmux label \"$(tmux display -p '#{window_id}')\""
```

`pane-border-format` is set by the command, not the config, so the styling lives
in one place: the active pane is emphasised (`#{?pane_active,#[reverse],}`), the
title is centred, and colour degrades to plain on `NO_COLOR`.

## 4. The popup's first paint (bundled lag fix)

While here, fix the `ctrl-g` popup's switch lag. Measured: node start is ~40ms,
but the overlay path is ~200ms because `loadRecords()` re-scans the whole index —
4,681 files, a 14MB cache — on the first paint *and* on every 1s repaint.

- **First paint from cache.** Serve the first frame from the cached index without
  a full re-discovery/re-stat; the background refresh still runs.
- **Don't re-scan every repaint.** Load records once for the overlay's lifetime
  and re-read only the (small) summary files as refreshes land, rather than
  re-statting thousands of files each second.

This is contained to the overlay command; the renderer and resolver are untouched
by it beyond consuming already-loaded records.

## Scope

**In v0.8.0:** the process-introspection resolver, `gm tmux label`, the toggle
binding in `gm tmux install`, and the popup first-paint fix.

## Non-goals (deliberately later)

- **Live auto-refreshing labels** — a tmux hook or timer that repopulates titles
  as work moves. v1 populates on toggle and on demand.
- **Fixing `gm run`'s link capture** (it recorded nothing for a resumed session
  in testing). Superseded in practice by argv resolution; worth its own fix.
- **Non-Unix process introspection** — `pgrep`/`ps`/`lsof` are assumed. On a host
  without them, resolution falls back to the pane-cwd heuristic (step 4).
- **Windows.**

## Testing

- **`parseAgentSession`** — pure, over real argv strings: `codex resume <uuid>`,
  `claude --resume <uuid>`, `claude -r <uuid>`, a bare `codex`/`claude` (no id →
  null), an MCP child command (→ null), a malformed id (→ null).
- **`pickAgentProcess`** — picks the harness process, not its MCP-server children;
  prefers the one with a session id; returns null when the tree has no harness.
- **`paneLabel`** — the three shapes (summary, no-summary, unresolved) and
  clipping.
- **Resolver order** — with injected process data and a fixture index: explicit
  link wins; argv id beats cwd; agent cwd beats pane cwd; pane cwd last; null when
  nothing matches. Pure over injected inputs — no real `ps`/tmux.
- **The `pgrep`/`ps`/`lsof`/tmux shelling and the title-setting** are thin glue,
  exercised by hand against a live tmux server (the spec's own validation run) and
  guarded by the pure layers above.
- **Layer check** keeps `pane-process` and the resolver in `services`, the command
  and binding in `cli`.
