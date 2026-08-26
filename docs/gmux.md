# gmux — the always-on awareness layer

**Working name:** gmux ("giga multiplexer"). It ships as the `gmux` binary.
gmux is a multiplexer TUI that runs *inside* Ghostty, iTerm, or kitty — it is
not a terminal emulator. Open an emulator, run `gmux attach`.

> **Experimental** until peel extractors have captured (non-synthetic) grid
> fixtures per harness. Synthetic fixtures already exist under
> `tests/fixtures/grids/{claude-code,codex,shell}/`.

## Core job

Running many AI coding agents has a high **attention tax**: to know what any
pane is doing — and which one needs you — you have to focus each pane in turn.
Built-in tools show process state at best; nothing tells you *what the work is*
at a glance, across everything.

> gmux lowers your attention tax — glance at the workspace and instantly understand what every pane is doing, without checking each one.

It's ambient: `gmux attach` starts `gmuxd` (and the intel sidecar) if needed.
The sidebar stays current. History (`gmux ls`) still reads session files and
does not require gmuxd.

**Clean break from tmux.** There is no `gmux.backend` flag. Finish remaining
work in tmux; then `gmux tmux uninstall` and `gmux attach`. `gmux tmux install`
is deprecated and prints that redirect. Uninstall still strips `# >>> gmux >>>`
and leftover `# >>> gigamanage >>>` from `~/.tmux.conf` and `~/.tmux.conf.local`.

## Two-layer signal

You cannot run an LLM continuously on every pane — too slow, too expensive. The signal is split into two speeds:

- **Instant layer (no LLM).** Local heuristics classify each pane's state — `working | idle | waiting | error | done` — and read per-pane and host memory every tick, in milliseconds. This is the triage-critical signal, and it is always fresh. **ctrl+t peel spawn is mux-local** and must not wait on intel.
- **Semantic layer (LLM, change-gated).** The human-readable "what it's doing" one-liner and full card, refreshed only when the pane's content meaningfully changes, debounced, fed full history.

**Governing invariant: the fast path survives anything the slow path does.** State, memory, guardian, and peel spawn never wait on the LLM — if the sidecar hangs, labels go stale but triage and `ctrl+t` keep working.

## Architecture

Rust **`gmuxd`** owns PTYs, VTE grids, tabs, keymap, and two sockets (`mux.sock`
NDJSON control + per-client binary frames). The TypeScript **intel sidecar**
(`gmux daemon --sidecar`) patches semantics onto mux panes and never sits on
the `ctrl+t` fast path.

```
Ghostty / iTerm / kitty  (the emulator — we do not replace it)
  │
  ▼
gmux attach  (TUI: one PTY + sidebar)
  │
  ▼
gmuxd  (mux.sock 0600, mux.lock, frames per client)
  │
  ├─► PTY / VTE / shadow / peel (mux-local)
  │
  └─► intel sidecar  (hello + intel.token)
          │
          ├─► sensors → state classifier + resource monitor (no LLM, every tick)
          ├─► semantic layer (LLM, gated)
          └─► guardian → mux guardian.broadcast → send_keys to agent panes
```

- **Peer ACL** — classify by pid (`LOCAL_PEERPID` / `SO_PEERCRED`). A pane-tree
  pid is always `pane`; unsetting `GMUX_PANE_ID` is `permission_denied`, never
  `cli`. Pane callers cannot `organize.apply` or `send_keys` to siblings.
- **Render surfaces** — the TUI sidebar (ctrl+g from pty) and the focused PTY.
  Funnel state never paints over the PTY.
- **History lane** — `gmux ls` / `show` / `resume` / `grep` / `ask` still read
  session files, still `--json` on `SCHEMA_VERSION` 1.

## The guardian: one action, explicit consent

The guardian is the one component in gmux that **acts** — it types into agent panes — so it gets the strictest rules, and it is the one place gmux discloses that it can act on your behalf.

- **Consent is explicit, not buried.** `gmux setup` prompts for the guardian policy prominently, with its own screen: `auto` (broadcast automatically, the default), `notify` (tell you, type nothing), or `off` (never act). Pressing enter still picks a policy — it just picks the one most people want — and you can change it any time by re-running `gmux setup`.
- **Only broadcasts to known agent panes** — never arbitrary shells, since injecting keystrokes where a human is typing would corrupt input.
- **Cooldown + hysteresis.** It fires once at threshold, then stays quiet for a configured number of minutes; it won't re-fire until pressure drops and re-crosses. No spamming while memory sits high.
- **No target, no action.** With no agent panes to protect, it logs the pressure and sends nothing.
- **Names the culprit.** The broadcast/log message includes the top memory consumer, e.g. *"host memory 92% — top consumer: pane `webshop-build` (4.2 GB); checkpoint your work and pause non-essential tasks."* When the hog is `unattributed`, it says so honestly rather than guessing.
- **Every action is logged** to the model — timestamp, pressure, culprit — and the attach sidebar shows the log.

## Memory attribution — read the numbers correctly

gmux attributes memory two ways: `perPaneRss` (per-pane subtree RSS, for ranking/culprit-naming) and `hostPressure` (read directly from the OS, what the guardian fires on). They answer different questions, and both come with caveats that are designed around, not hidden:

1. **RSS double-counts shared pages** — the subtree-RSS walk sums each process's resident set, and processes sharing pages (a common shell + interpreter, forked workers) get that memory counted more than once. It's reliable for **ranking** panes against each other — "who's the hog" — but not for exact totals. (Linux PSS/`smaps_rollup` is a later precision upgrade.)
2. **Detached or containerized children escape the subtree** and show as `unattributed`. A double-fork to init, a `nohup`'d background process, or a container running under the Docker daemon are no longer descendants of the pane's `pane_pid`, so their memory can't be walked back to a pane. gmux surfaces that memory honestly as `unattributed` rather than mis-attributing it to the wrong pane.
3. **`hostPressure` is not the sum of panes.** It's measured separately, straight from the OS (`vm_stat`/`sysctl` on macOS, `/proc/meminfo` on Linux), and includes page cache and every other app on the machine — not just tracked panes. Don't expect the pane memory column to add up to the host pressure number; they're different signals, by design.

## Surfaces

- **Attach TUI** (`gmux attach`) — one focused PTY + sidebar groups. `ctrl+g` from pty opens the sidebar; `ctrl+t` peels; `ctrl+q` detaches.
- **Picker** (`gmux ls`, `gmux`) — the complementary history/resume lane. See the README's "two lanes" section.

`gmux setup` also asks **agentHarness** (the interactive CLI for new panes /
peels). That is not `provider` (the summarizer). `CONFIG_VERSION` stays 1.

## Packaging

`gmux attach` **fetch-if-missing** `gmuxd` from GitHub Releases, checksum
pinned in the npm package. Supported triples:

- `aarch64-apple-darwin`
- `x86_64-apple-darwin`
- `x86_64-unknown-linux-gnu`
- `aarch64-unknown-linux-gnu`

Binary shipping can follow attach once CI produces artifacts. Not the npm
default until captured peel extract fixtures exist.

See the project [README](../README.md) for the quickstart and rendered examples.
