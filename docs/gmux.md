# gmux — the always-on awareness layer

**Working name:** gmux ("giga multiplexer" — tmux, but LLM-native). It ships as the `gmux` binary; `gmux` is the product name for the daemon, cockpit, borders, and guardian described here.

## Core job

Running many AI coding agents across a tmux workspace has a high **attention tax**: to know what any pane is doing — and which one needs you — you have to focus each pane in turn. Built-in tools show process state at best; nothing tells you *what the work is* at a glance, across everything.

> gmux lowers your attention tax — glance at the workspace and instantly understand what every pane is doing, without checking each one.

It's not a command you invoke and wait on. It's ambient: start the daemon once, and your tmux borders and the cockpit overlay stay current on their own.

## Two-layer signal

You cannot run an LLM continuously on every pane — too slow, too expensive. The signal is split into two speeds:

- **Instant layer (no LLM).** Local heuristics classify each pane's state — `working | idle | waiting | error | done` — and read per-pane and host memory every tick, in milliseconds. This is the triage-critical signal, and it is always fresh.
- **Semantic layer (LLM, change-gated).** The human-readable "what it's doing" one-liner and full card, refreshed only when the pane's content meaningfully changes, debounced, fed full history.

**Governing invariant: the fast path survives anything the slow path does.** State, memory, and the guardian never wait on the LLM or on tmux — if the model hangs or errors, labels go stale but triage keeps working.

## Architecture

One long-lived **workspace daemon** (`gmux daemon`) maintains a single in-memory **workspace model** — the authoritative "what is every pane doing right now" — and pushes it to display surfaces. Everything else feeds into, or reads from, that model.

```
tmux (panes, layout, PIDs)
  │
  ▼
tmux gateway (sole tmux talker)
  │
  ▼
pane registry (stable identity across re-layout)
  │
  ├─► agent sensor / terminal sensor
  │       │
  │       ▼
  │   instant layer — state classifier + resource monitor (no LLM, every tick)
  │       │
  │       ├──────────────► WORKSPACE MODEL (single source of truth)
  │       │                       │
  │       └─► semantic layer ─────┘   (LLM, gated, a beat later)
  │           (label + card)
  │
  ▼
WORKSPACE MODEL ──► guardian (memory policy) ──► send-keys broadcast to agents
       │
       ├──► border labels (always-on, terse)
       └──► cockpit overlay (ctrl+g, full grid)
```

- **tmux gateway** — the sole talker to tmux (`list-panes`, `capture-pane`, `pipe-pane`, `send-keys`). Isolates tmux quirks; the master test seam.
- **Pane registry** — live tmux panes → durable records, resolving harness/session so identity survives re-layout.
- **Sensors** — one uniform *observation* per pane regardless of source: the agent sensor tails the transcript, the terminal sensor manages a `pipe-pane` log + `capture-pane` tail.
- **State classifier** — pure heuristics over the latest observation → `working | idle | waiting | error | done`. No LLM, deterministic.
- **Resource monitor** — walks the process subtree from each pane's `pane_pid`, sums RSS, and reads host memory pressure from the OS.
- **Semantic summarizer** — change-gated, debounced LLM call that reuses gmux's existing summarize/distill pipeline.
- **Workspace model** — the single source of truth: per-pane `{identity, state, semantics, resources}` plus workspace-level `{hostPressure, guardianLog}`. Emits change events.
- **Guardian** — watches the model for host memory pressure and, per policy, broadcasts a checkpoint message to agent panes. See below.
- **Daemon** — ties sensors → classifiers → model on a tick (~1–2s), and exposes the model over a local unix socket plus a snapshot file (the fallback when the daemon is down).
- **Render surfaces** — thin clients that read the model and paint: the **borders** (terse, always-on) and the **cockpit** (`ctrl+g`, full grid). They sense nothing themselves — new surfaces cost nothing in sensing.

## The guardian: one action, explicit consent

The guardian is the one component in gmux that **acts** — it types into agent panes — so it gets the strictest rules, and it is the one place gmux discloses that it can act on your behalf.

- **Consent is explicit, not buried.** `gmux setup` prompts for the guardian policy prominently, with its own screen: `auto` (broadcast automatically, the default), `notify` (tell you, type nothing), or `off` (never act). Pressing enter still picks a policy — it just picks the one most people want — and you can change it any time by re-running `gmux setup`.
- **Only broadcasts to known agent panes** — never arbitrary shells, since injecting keystrokes where a human is typing would corrupt input.
- **Cooldown + hysteresis.** It fires once at threshold, then stays quiet for a configured number of minutes; it won't re-fire until pressure drops and re-crosses. No spamming while memory sits high.
- **No target, no action.** With no agent panes to protect, it logs the pressure and sends nothing.
- **Names the culprit.** The broadcast/log message includes the top memory consumer, e.g. *"host memory 92% — top consumer: window `webshop-build` (4.2 GB); checkpoint your work and pause non-essential tasks."* When the hog is `unattributed`, it says so honestly rather than guessing.
- **Every action is logged** to the model — timestamp, pressure, culprit — and the cockpit shows the log at the top.

## Memory attribution — read the numbers correctly

gmux attributes memory two ways: `perPaneRss` (per-pane subtree RSS, for ranking/culprit-naming) and `hostPressure` (read directly from the OS, what the guardian fires on). They answer different questions, and both come with caveats that are designed around, not hidden:

1. **RSS double-counts shared pages** — the subtree-RSS walk sums each process's resident set, and processes sharing pages (a common shell + interpreter, forked workers) get that memory counted more than once. It's reliable for **ranking** panes against each other — "who's the hog" — but not for exact totals. (Linux PSS/`smaps_rollup` is a later precision upgrade.)
2. **Detached or containerized children escape the subtree** and show as `unattributed`. A double-fork to init, a `nohup`'d background process, or a container running under the Docker daemon are no longer descendants of the pane's `pane_pid`, so their memory can't be walked back to a pane. gmux surfaces that memory honestly as `unattributed` rather than mis-attributing it to the wrong pane.
3. **`hostPressure` is not the sum of panes.** It's measured separately, straight from the OS (`vm_stat`/`sysctl` on macOS, `/proc/meminfo` on Linux), and includes page cache and every other app on the machine — not just tracked panes. Don't expect the pane memory column to add up to the host pressure number; they're different signals, by design.

## Surfaces

- **Borders** — always-on, terse: `gmux tmux install` binds `alt-g` to toggle them (writing `~/.tmux.conf.local` when the live conf sources it — Oh My Tmux — rather than through that theme's `~/.tmux.conf` symlink); each pane's border shows its current state glyph and headline, painted straight from the workspace model, zero sensing.
- **Cockpit** (`gmux cockpit`, bound to `ctrl+g`) — the full-workspace grid: every pane's state, memory, one-liner, and last activity, with the guardian log pinned at the top. Reads the daemon's live socket, falling back to the snapshot file (marked stale) when the daemon isn't reachable.
- **Picker** (`gmux ls`, `gmux`, `ctrl+shift+g`) — the complementary history/resume lane. See the README's "two lanes" section for how it relates to the cockpit.

See the project [README](../README.md) for the quickstart and rendered examples.
