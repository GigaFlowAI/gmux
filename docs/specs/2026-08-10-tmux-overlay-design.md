# The tmux peek overlay: every agent's summary, in place

**Date:** 2026-08-10
**Status:** approved, not yet implemented

## The problem

gigamanage answers "what was I doing, and what should I pick up?" — but only for
sessions *at rest*, browsed one at a time through the picker. The moment you're
running several agents at once, each in its own tmux pane, the tool has nothing
to say. You tab between panes reading scrollback to remember which agent is on
what. The summaries that make a cold session legible aren't reachable while the
work is live and spread across a layout.

The whole value of a summary — *where did this land, what's open, what's next* —
is highest exactly when you have four agents going and your own memory of each
is thinnest. That's the gap this closes.

## What we're building

A **peek overlay** for tmux. Tap `ctrl+g` and every pane in the current window
is covered, in place, by its own summary card — the same card `gm show` renders,
drawn where its pane sits so your spatial map ("webshop is top-left") survives.
Any key drops it and you're back on the live panes, untouched.

Plus the two things that make it trustworthy: a **resolver** that maps a live
pane to the right transcript, and a **refresh** that brings stale cards current
in the background without ever making you wait.

gigamanage stays what it is — a read-only intelligence layer. tmux stays the
multiplexer. This is a new *consumer* of the existing session/summary engine,
not a change to it. If tmux isn't installed, none of this loads and `gm` is
exactly as it was.

## Design principles carried in from the rest of the tool

- **Read-only, on purpose.** The overlay never touches a live pane's process.
  It reads tmux state and paints over the top; it never breaks, splits, or
  restarts a running agent's pane.
- **Free steps always run; paid steps only when asked.** Cards render from the
  existing index instantly. Model calls (refresh) happen in the background and
  only for cards past a staleness threshold.
- **The layer rule holds.** `core ← adapters ← services ← cli`. tmux I/O and the
  resolver live in `services`; the overlay, the per-pane card, and `gm run` are
  `cli`.

## 1. The peek gesture

`ctrl+g` at the tmux root key-table (no prefix) launches a single full-screen
popup bound directly to `display-popup`:

```
bind -n C-g display-popup -w 100% -h 100% -x 0 -y 0 -B -E 'gm overlay #{window_id}'
```

tmux expands `#{window_id}` to the active window at the moment the key fires, and
passes it to `gm overlay` so the popup — which has no pane of its own — knows
which window's layout to draw. Binding `display-popup` directly (rather than
hopping through `run-shell`) keeps it a single client command.

**Why one popup, not N mirrored panes.** An earlier sketch cloned the layout into
a hidden "mirror window" — one real pane per card. The full-screen-popup approach
is strictly better for the gesture we chose:

- **Any-key dismiss is trivial.** The popup is one process reading stdin. The
  first keystroke exits it; `-E` then closes the popup and you're back on the
  live window, which was never modified.
- **Background refresh repaints in place.** The same long-lived process redraws a
  single card when a fresher summary lands. No panes to spawn, swap, or kill.
- **Zero risk to running agents.** Nothing in your real layout is created or
  destroyed. A crash in the overlay closes a popup; it cannot disturb an agent.

**Cost:** `display-popup` needs tmux ≥ 3.2 (mid-2021). `gm doctor` gains a check
for the tmux version and reports the overlay as unavailable below it, the same
way it already reports missing `fzf`/`ripgrep`.

### Why "peek until any key", not hold-to-release

tmux has no key-*release* event — terminals transmit key presses, and the one
protocol that carries release (kitty's) isn't exposed to tmux bindings and isn't
portable. So a literal "let go to hide" can't be built on portable bindings.
"Show on tap, dismiss on the next keystroke" gives the same glance-and-go feel
and works identically in every terminal. (A fragile hold-to-peek mode driven by
keyboard auto-repeat is noted under Non-goals as a possible later addition.)

## 2. Rendering the overlay: `gm overlay <window>`

A new `cli` command. Given a tmux window id, it:

1. **Reads the geometry.** `tmux list-panes -t <window> -F '#{pane_id}
   #{pane_left} #{pane_top} #{pane_width} #{pane_height} #{pane_current_path}
   #{pane_current_command}'`. Each pane is a rectangle in the terminal grid.
2. **Resolves each pane to a session** (§3).
3. **Draws a card into each rectangle** using absolute cursor positioning,
   reusing the card body that `gm show` already produces — about / landed / open
   / next, the `⚠` mid-task flag — reflowed to the rectangle's width and height,
   with a freshness line at the bottom (`4s ago` / `2m ago ↻` / `refreshing…`).
4. **Degrades gracefully.** A rectangle too small for the full card drops to
   title + landed line; too small for that, just the title. A pane that resolves
   to no session (a plain shell, a log tail) shows a muted "no agent here"
   placeholder — we never guess.
5. **Reads one keystroke and exits.** While waiting, it repaints cards whose
   refresh (§4) has completed. The first keypress ends the process; the popup
   closes.

The card-body reflow is shared with `gm show`, not reimplemented. If `gm show`'s
card is currently assembled inside its command, that assembly moves to a
`services`/`cli-format` helper both call, so the overlay and `gm show` can never
drift.

## 3. The resolver: pane → session

A new `services/tmux-resolve.ts` (may import `core` and `adapters`; matches the
layer rule). For each pane it returns a `SessionRecord` or `null`, **hybrid**:

1. **Explicit link first.** If the pane was started via `gm run` (§5), a
   `pane_id → session_id` entry exists in the link store; use it directly. Exact,
   no guessing.
2. **Heuristic fallback.** Otherwise, take the pane's `pane_current_command`
   (does it look like a known harness — `claude`, `codex`, …?) and
   `pane_current_path`, and pick the **most recently active** transcript in that
   harness whose session directory matches that cwd.
3. **No match → `null`.** Rendered as the muted placeholder. A non-agent pane is
   a normal, expected case, not an error.

The heuristic's one ambiguity — two sessions sharing a cwd and harness — resolves
to the most recent, which is nearly always the running one. `gm run` exists
precisely for when "nearly always" isn't good enough.

## 4. Freshness and background refresh

On peek, cards render from the index immediately; nothing blocks on a model. In
parallel, `gm overlay` asks the existing summarize path to refresh any
resolved session whose summary is older than a threshold (reuse
`auto-summarize`'s staleness notion; a live transcript that has grown since its
last summary is stale by the existing hash rule). As each refresh lands, that
card repaints from `refreshing…` to its new content and a fresh age.

This reuses `services/auto-summarize` and the summary cache wholesale — the
overlay adds no new summarization logic, only a new trigger for it. Concurrency
is bounded by the existing `services/concurrency` limiter, so peeking at a
twelve-pane window doesn't fan out twelve model calls at once.

## 5. `gm run <harness> [args…]` — exact mapping, opt-in

A thin `cli` wrapper you start an agent pane with:

```bash
gm run claude          # instead of: claude
gm run codex resume    # args pass straight through
```

It resolves the session id the harness is about to use (or, where the harness
only reveals it after start, the newest session in the cwd immediately after
launch), records `pane_id → session_id` (from `$TMUX_PANE`) in the link store,
then `exec`s the real harness so the pane *is* the agent — no wrapper process
lingering. Panes started any other way still resolve through the heuristic; this
only upgrades accuracy for panes you opt in.

**Link store placement.** Pane links are ephemeral runtime state — a `pane_id`
means nothing once the tmux server dies. They go under
`~/.cache/gigamanage/pane-links.json`, safe to delete (worst case: a pane falls
back to the heuristic). Entries for pane ids tmux no longer lists are pruned on
read. This is neither config (nothing a human typed) nor a content-hashed cache,
but it belongs on the cache side of the config/cache split: derived, disposable,
regenerated by living in the tool.

## 6. Keybindings, install, and the picker bridge

- **`gm tmux install`** writes an idempotent, clearly-fenced block into
  `~/.tmux.conf`:

  ```
  # >>> gigamanage >>>
  bind -n C-g run-shell 'gm overlay'
  bind -n C-S-g display-popup -w 80% -h 80% -E 'gm pick'
  # <<< gigamanage <<<
  ```

  Re-running replaces the block in place; `gm tmux uninstall` removes exactly
  that block and nothing else. The chosen keys are shown so a user with a `C-g`
  conflict can rebind.
- **The picker bridge.** `ctrl+shift+g` opens the existing picker (`gm pick`) in
  a tmux popup. Its Enter already resumes a session; inside tmux that resume
  lands in a **new pane** in the current window, so browsing history → a live
  agent is one motion. History and live share one model; this is the seam
  between the two lenses.

## Scope

**In v1:** the peek overlay (`gm overlay`), the resolver (hybrid), background
refresh, `gm run`, `gm tmux install`/`uninstall`, the `gm doctor` tmux-version
check, and the picker-in-popup bridge.

## Non-goals (deliberately later)

- **Hold-to-peek** via keyboard auto-repeat — genuine hold semantics, but fragile
  across OS repeat settings and terminals; revisit only if the tap gesture proves
  insufficient.
- **Per-agent status color / notifications** (e.g. tint a card when its agent is
  blocked or finished).
- **Remote / cross-machine** panes.
- **Mouse interaction** inside the overlay (click a card to jump to its pane).
- **Becoming a multiplexer.** tmux owns panes, layout, and persistence,
  permanently. gm is the intelligence on top.

## Testing

- **Resolver** is pure over injected tmux output + a fixture index: explicit link
  wins; heuristic picks the newest matching transcript; ambiguous cwd resolves to
  most-recent; non-agent pane → `null`. No tmux process needed.
- **Card reflow** is tested at several rectangle sizes for the full →
  title+landed → title-only → placeholder degradation ladder, against the same
  fixtures `gm show` uses.
- **Link store** round-trips writes and prunes ids absent from a supplied pane
  list.
- **Layer check** (`scripts/check-layers.mjs`) keeps tmux I/O and the resolver in
  `services`, the overlay/card/`gm run` in `cli`.
- **tmux itself is not unit-tested** — the geometry read and popup launch are thin
  shells over documented tmux flags, exercised by hand and guarded by the
  `gm doctor` version check. What's testable (resolution, reflow, link store) is
  pure and covered.
