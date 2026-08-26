# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org): while
0.x, a **minor** bump means behavior changed in a way you should read about before
upgrading, and a **patch** is a fix that asks nothing of you.

## 0.17.0

### Back to gigamanage / `gm`, and the tmux cockpit

Native attach (`gmux attach`, `gmuxd`, peel) is unshipped. The live surface is
again the tmux cockpit: `gm setup`, `gm tmux install`, `gm daemon`, **ctrl+g**.

The package, command, env, and paths are gigamanage again:

```bash
npm uninstall -g @gigaflow/gmux
npm install -g gigamanage
gm setup
tmux source-file ~/.tmux.conf
gm daemon
```

- Binaries: `gm` and `gigamanage`
- Env: `GIGAMANAGE_*` (was `GMUX_*`)
- State: `~/.config/gigamanage` and `~/.cache/gigamanage`
- `gm tmux uninstall` still strips a leftover `# >>> gmux >>>` block

Native multiplexer work belongs in a later repo, not this one.

## 0.16.0

### Cockpit prompt, work report, and an onboarding path that actually lands

The ctrl-g grid now takes plain English at the bottom. Type an intent: a
question is broadcast to every visible session and answered inline; a layout
request ("group these by project") is planned, previewed, and applied only on
confirm. `ctrl-v` writes a per-session HTML work report and shows a `file://`
link. `gmux organize` is the same planner from the shell (dry-run default,
`--apply` to run it).

The documented first-run path now works on Oh My Tmux. `gmux tmux install` (and
the setup wizard's bindings prompt) write to `~/.tmux.conf.local` when the live
conf sources it, never through Oh My Tmux's git-managed `~/.tmux.conf` symlink.
A leftover `# >>> gigamanage >>>` block is stripped so ctrl-g opens the cockpit
instead of `gm overlay`. Vanilla tmux and a dotfiles-repo symlink of
`~/.tmux.conf` still write through to that file. `gmux doctor` reports both.

**Upgrading from gigamanage / 0.15.0:**

```bash
npm uninstall -g gigamanage          # if the old `gm` command is still around
npm install -g @gigaflow/gmux
gmux setup                           # provider, guardian, tmux bindings
tmux source-file ~/.tmux.conf
gmux daemon
```

The package publishes as `@gigaflow/gmux` (not `@gigaflowai/gmux`).

## 0.15.0

### Always-on workspace awareness — daemon, cockpit, memory guardian

gmux gains the layer the name always implied: a resident daemon that watches your
whole tmux workspace and tells you, at a glance, what every pane is doing — without
focusing each one in turn. It builds on the existing sensing (transcript adapters,
summaries, border labels) and is **additive** — nothing about the picker changed.

- **Start it.** `gmux daemon` runs a resident daemon that senses every pane (agent
  and plain shell) on a ~1.5s tick and serves one workspace model over a local
  socket (with a snapshot-file fallback). `gmux tmux install` wires the border
  labels and the `ctrl+g` cockpit into your `~/.tmux.conf`.
- **Ambient border labels.** Each pane's border shows a state glyph — ● working ·
  ◔ waiting · ✗ error · ✓ done · ○ idle — plus a one-liner: instant heuristic state
  always, and an LLM-written "what it's doing" line a beat later (change-gated and
  debounced, so it stays cheap).
- **The cockpit (`ctrl+g`).** A full-workspace grid: per-pane state, memory, a
  one-liner, and last activity, with a ranked memory column that names the hog
  (and surfaces memory it can't attribute honestly) and a guardian log up top.
- **Memory guardian.** Under host memory pressure the guardian can broadcast a
  "checkpoint your work and pause non-essential tasks" message straight into your
  agent panes, naming the top consumer. This is the one action gmux takes on your
  behalf, so **`gmux setup` discloses it and asks for consent** — default `auto`,
  with `notify` and `off` offered. It only ever types into known agent panes (never
  a shell where a human is at the keyboard) and honors a cooldown so it can't spam.

Two lanes, one tool: the cockpit answers *"what's happening right now across my live
panes"*; the picker (`gmux`, `gmux ls`, `ctrl+shift+g`) still answers *"browse and
resume any session across time."*

The fast path — pane state, memory, and the guardian — is built to survive anything
the LLM or tmux does: a hung summarizer only lets labels go stale, and a tmux hiccup
idles a tick; neither freezes triage. See [`docs/gmux.md`](docs/gmux.md) for the
design, and the memory-attribution caveats (RSS ranks reliably but isn't an exact
total; detached/containerized children show as *unattributed*).

## 0.14.0

### Renamed to gmux

The project is now **gmux** — "giga multiplexer": tmux, but LLM-native. This is a
clean break from the old `gigamanage` / `gm` names, so it asks a few things of you
on upgrade:

- **Install the new package.** It publishes as `@gigaflow/gmux` and installs a
  single command, `gmux`. The old `gm` and `gigamanage` commands are gone.
  ```bash
  npm uninstall -g gigamanage        # remove the old one
  npm install -g @gigaflow/gmux    # gives you `gmux`
  ```
- **Environment variables are now `GMUX_*`.** `GIGAMANAGE_SUMMARY_CMD` →
  `GMUX_SUMMARY_CMD`, `GIGAMANAGE_AUTO_SUMMARIZE` → `GMUX_AUTO_SUMMARIZE`, and so
  on. The old names are no longer read — update your shell profile.
- **State moved.** Config now lives in `~/.config/gmux` and the cache in
  `~/.cache/gmux` (previously `…/gigamanage`). Nothing is migrated: run `gmux setup`
  to choose your provider again, and summaries regenerate on first use. You can
  delete the old `~/.config/gigamanage` and `~/.cache/gigamanage` directories.

Everything the tool *does* is unchanged — same picker, same summaries, same
cross-harness resume, same tmux overlay. Only the name and its surfaces moved. The
[design doc](docs/superpowers/specs/2026-08-11-gmux-design.md) lays out where gmux
goes from here.

## 0.13.6

### Summaries follow the pane, even after you move panes around

When several panes share a directory and their agents were started fresh
(`claude --model=…`, no `--resume <id>`), gmux had nothing to tell the panes
apart — no session id on the command line, no `gmux run` link — so it handed out the
newest sessions in the directory in pane-list order. Move a pane, or let a session
update, and the summaries reshuffled onto the wrong cards.

The overlay now pairs those panes to sessions by **process start order**: within a
directory, the oldest agent process takes the oldest-started session, and so on.
A process's start time is stable and belongs to the pane's real process, so the
mapping holds when you move, swap, or join panes. A directory with a single agent
is unchanged. Exact matches — a `--resume <id>` on the command line, or a `gmux run`
link — still win outright.

## 0.13.5

### ctrl-g closes the overlay it opened

The `ctrl-g` peek now toggles: press it again to dismiss, the same as the key that
opened it. Before, only Esc (or ctrl-c / ctrl-d) closed it — once the ask box
landed, every other key typed into that box, so a second ctrl-g was swallowed and
the overlay stayed up. Esc still closes; the ask-box hint now reads `^G/Esc close`.

## 0.13.4

### Codex summaries work again after an upgrade

A config written by an older `gmux` froze the codex command as `codex exec`. When
the catalog later gained `--skip-git-repo-check` (so codex can summarize outside a
trusted git checkout), that flag never reached an existing config: summary
resolution replayed the stored command verbatim, so every codex summary failed
with *"Not inside a trusted directory and --skip-git-repo-check was not
specified"* and the `ctrl-g` overlay stayed stuck on "no summary yet".

A **known** provider now re-derives its argv from the catalog rather than the
command frozen at setup time — the same self-healing `gmux ask` already had. A
`custom` provider is still run exactly as you wrote it. No re-run of `gmux setup`
needed; upgrade and codex summaries resume.

## 0.13.3

### A fresh claude pane no longer shows a codex session (or vice versa)

Resolving a fresh session — one with no id on its command line — now reads the
harness from the agent's own argv (`claude` vs `codex`) and hard-filters to it, so
it can only match a session of the SAME harness in its directory. Before, a fresh
`claude` pane could grab the newest codex session in the repo (the harness guess
came from `pane_current_command`, which is just `node`). If no session of that
harness is known for the directory, the pane shows nothing rather than the wrong
one.

## 0.13.2

### Force a refresh, and no more cross-window duplicate panes

- **Force refresh:** press **ctrl-r** in the `ctrl-g` overlay to regenerate the
  visible panes' summaries now, ignoring the divergence gate. From the shell:
  `gmux summarize <id> --force`, `gmux summarize --recent 20 --force`, or
  `gmux summarize --all --force`.
- **Cross-window fix:** the overlay (and `gmux ask --window`) used to resolve only
  the current window's panes, so a fresh agent with no session id on its command
  line could grab the session another window's pane already owns — making two
  panes show the same summary. They now resolve every pane in the server and keep
  this window's, so the de-duplication holds across windows.

## 0.13.1

### The broadcast answer appends to the card, it does not replace the summary

When you ask in the overlay, each card now keeps its summary and appends the
per-pane answer (`▸ answer`, or `▸ asking…` while it lands) beneath it — reserving
room so both show, instead of the answer swallowing the summary.

## 0.13.0

### The ask box broadcasts to every pane

A question typed in the `ctrl-g` ask box is now answered **per session**: it fans
out to each pane in parallel and every card shows ITS own answer, not one
synthesized blob. "What is the single most urgent next action?" → each agent's
card shows its own. While answers land, cards read `asking…`. Press Enter on an
empty box to clear the answers back to the summaries; Esc (or ctrl-c) closes.

## 0.12.0

### The ctrl-g overlay has an ask box built in

The `ctrl-g` overlay now carries a text box across the bottom. Just start typing a
question and press Enter — the answer renders above the cards, fanned out over the
current window's agents ("what is each doing?", "what is most urgent?"). Keep
asking; Esc (or ctrl-c) closes. This replaces 0.11.0's "press a to launch a
separate chat" with an integrated box on the overlay itself.

## 0.11.0

### Ask across the agents you are looking at

In the `ctrl-g` overlay, press **`a`** to open a chat that fans out over the agent
sessions in the current window. Ask high-level orienting questions — "what is each
one doing?", "what is most urgent?", "which are waiting on me?" — and keep asking;
it is `gmux ask`, scoped to the panes in front of you rather than your whole recent
list. Any other key still just closes the overlay.

Also available directly: `gmux ask --window <window-id>`.

## 0.10.2

### The ctrl-g cards say when they last updated

Each card in the `ctrl-g` overlay now shows when its summary last landed —
`updated 3m ago` (seconds, minutes, hours, days) — and while a refresh is in
flight it reads `refreshing… · updated 3m ago`, so you still know how old the
summary you are reading is.

## 0.10.1

### The overlay opens about twice as fast

Resolving which session each pane runs walked the pane's process tree with a
`pgrep` per node — dozens of process spawns down a deep agent tree (an agent with
MCP-server children), which dominated the `ctrl-g` latency. It now takes a single
`ps` snapshot and walks the tree in memory. Measured: the overlay path roughly
halved.

### A fresh agent no longer copies another pane's summary

A pane running a *fresh* session (no session id on its command line) fell back to
"newest session in this directory" — which is whatever another pane is actively
working on, so its summary got copied onto the fresh one, especially across
windows. Panes are now resolved together: an exact match (a `gmux run` link or a
session id read from the agent's argv) claims its session, and no heuristic pane
may pick a session another pane already owns.

## 0.10.0

**Upgrading:** the summary prompt changed, so every summary regenerates on its
next background pass (once, in the background). No action needed.

### Summaries in three widening tiers

A summary now narrows your attention gradually, so you decide how much to give a
session:

- **headline** — the scannable one-liner (what the `alt-g` label shows);
- **overview** — 2-3 sentences framing it;
- **summary** — new: a paragraph or two that actually reorients you, tracing how
  the work evolved and where it stands.

`ctrl-g` (and `gmux show`) render all three — headline, overview, then the
drilldown — above the recent/open/next status. The label stays the one-liner;
the drilldown is one keypress away.

### Fixes

- `alt-g` off now fully clears the labels. Older versions set
  `pane-border-status` per window, and that override kept the border (and its
  headline) up even after the global was turned off. Toggling off now clears the
  per-window override and wipes each pane's label.

## 0.9.0

gmux becomes what it was always meant to be: **a background agent that
keeps you up to date on your agents' latest work.**

**Upgrading:** re-run `gmux tmux install` (or, on Oh My Tmux, keep the `Alt-g` line
in `~/.tmux.conf.local`) and reload. `Alt-g` now toggles a live service rather
than painting labels once. Nothing else changes.

### `Alt-g` runs a live label agent

`Alt-g` starts a single, lightweight background service (`gmux watch`) that every
few seconds resolves every agent pane across all your windows and keeps its
border label current — the session's headline, where the pane is, with the
content still visible. A pane whose summary is being regenerated shows
`gmux summaries loading…` until it lands. `Alt-g` again stops it. `ctrl-g` is still
the full card when you want the detail; the two share one continuously-maintained
cache, so the popup opens already current.

You can also drive it directly: `gmux watch` starts it, `gmux watch --stop` stops it.

### Summaries refresh when work *diverges*, not on every keystroke

A live session used to be re-summarised on essentially every message. Now each
summary carries a compact **SimHash fingerprint** of its content (16 hex
characters, fixed size however long the session grows), and a session is
re-summarised only when that fingerprint has drifted past a threshold — with a
safety net: a new tool failure, a flip to ended-mid-task, or a change in the
files touched always refreshes, so a small-but-important change is never slept
through. Tune the threshold with `GMUX_REFRESH_DISTANCE`; the loop interval
with `GMUX_WATCH_INTERVAL_MS`.

## 0.8.2

### Pane-border labels show on every pane, in full

Two fixes to the `Alt-g` label HUD:

- **Every pane, not just the active one.** The label inherited
  `pane-border-style`, which themes like Oh My Tmux dim to near-background for
  inactive panes — so every label but the active pane's was invisible. The label
  now forces its own foreground colour and reads on all panes.
- **No truncation.** The headline was capped at 60 characters; it's now stored in
  full and tmux clips it to the pane's width at render, so a wide pane shows the
  whole thing.

A tmux pane border is a single line, so a headline wider than the pane is clipped
rather than wrapped — press `ctrl-g` for the full card when you need it.

## 0.8.1

### Resolving a pane skips a needless `lsof`

`gmux tmux label` and the `ctrl-g` overlay read each pane's agent process to find
its session. When the agent's command line already carries the session id (a
resumed session — the common case), the id is exact and the process's working
directory is never needed — but 0.8.0 looked it up anyway (`lsof` on macOS,
~100ms per pane). It's now skipped unless there's no id on the line, so resolving
a window of resumed agents no longer pays for a directory lookup per pane.

## 0.8.0

**Upgrading:** re-run `gmux tmux install` to pick up the new `Alt-g` binding, and
reload with `tmux source-file ~/.tmux.conf`. Everything is additive; nothing you
rely on changes.

### It knows which session each pane is running

The overlay used to map a pane to a session by matching the pane's working
directory — but that's the *shell's* directory, usually `~`, not the agent's, so
panes resolved to the wrong session or to nothing. gmux now reads the pane's
own process: the agent's command line carries the session id verbatim (`codex
resume <id>`, `claude --resume <id>`), and that id *is* the session. Where there's
no id on the line (a fresh session), it uses the agent process's real working
directory instead of the shell's. No `gmux run`, no setup — it just reads what's
already there.

### A label on every pane's border

`Alt-g` toggles a one-line summary onto each pane's border — the session's
headline, right where the pane is — while the pane content stays fully visible. It
answers "what is each of these agents doing?" without taking over the screen; the
`ctrl-g` full-card popup is still there when you want the detail. The label is
stored in a pane-local option gmux owns, so a running agent's own title
updates can't clobber it.

### The peek does less work

`ctrl-g` paints from the cached index and resolves each pane once, then upgrades
to a full index read in the background. An open overlay no longer re-scans
thousands of session files every second — it re-reads only the summaries that
change.

## 0.7.1

Fixes and polish for the tmux peek overlay shipped in 0.7.0 — the first release
made it usable in practice.

### The `ctrl-g` binding now actually opens the overlay

`gmux tmux install` wrote `gmux overlay #{window_id}`, but tmux does not expand that
format inside `display-popup -E` — so the shell saw the `#` and treated the rest
of the line as a comment, and `gmux overlay` ran with no window argument. The
result was a popup that flashed and vanished. The binding now resolves the window
id in-shell with `gmux overlay "$(tmux display -p "#{window_id}")"`, which works
whether or not tmux expands the format. If you installed 0.7.0's binding, re-run
`gmux tmux install` (or, on Oh My Tmux, replace the two lines in
`~/.tmux.conf.local`) and reload with `tmux source-file ~/.tmux.conf`.

### Panes are framed, so cards read as separate

Each card is now drawn inside a box border matching its pane's rectangle, so
adjacent summaries no longer blur into one another.

### The peek is instant

The overlay used to block on a tmux-version check and a summary-refresh pass
before painting anything. It now paints from cache immediately and kicks the
background refresh off afterwards, so `ctrl-g` feels like a peek rather than a
load.

### Cards lead with the headline

Each card now leads with the session's one-line headline — the scannable,
subject-first clause — instead of the multi-sentence overview, which tended to
open with a generic verb ("Implemented…"). Glancing across panes, the headline
is what tells them apart.

## 0.7.0

**Upgrading:** nothing changes unless you opt in. Everything below is additive and
gated behind tmux; if you don't run `gmux tmux install`, `gmux` behaves exactly as it
did in 0.6.1. The overlay needs **tmux 3.2 or newer** (for `display-popup`), which
`gmux doctor` now checks for.

### Peek at every agent at once, from tmux

Drive your agents in tmux and `gmux` can now answer "what's happening in each of
these panes?" without you switching into any of them. `gmux tmux install` writes two
key bindings to `~/.tmux.conf`:

- **ctrl-g** peeks — every pane in the current window is overlaid *in place* with
  its summary card (what landed, what's still open, the next step, the `⚠`
  mid-task flag). Cards paint instantly from the cache and refresh in the
  background; any key dismisses the overlay and leaves your panes untouched.
- **ctrl-shift-g** opens the `gmux` picker in a popup, and Enter resumes your choice
  into a new tmux window — history and live panes, one keystroke apart.

The overlay maps a pane to its session by working directory and recency. For an
exact link — including resumed sessions that share a directory — launch through
`gmux run claude` / `gmux run codex resume`: it attaches your terminal as usual and
records which pane the session runs in.

`gmux doctor` reports whether the overlay is available and, if not, why. tmux joins
ripgrep and fzf as an optional companion; nothing here is required.

## 0.6.1

### The chat/summary split is coloured now

The picker's preview pane rendered monochrome — its stdout is a pipe, so gmux's
colour gated itself off, and even the `── ask ──` divider between the session
card and the chat came out plain. fzf paints the preview with `--ansi`, though,
so the seam can carry colour: the divider is now **cyan** (gmux's own accent) and
the `you` / `gmux` speaker labels light up, while the card stays monochrome.

It's an accent, not the message — the divider's glyphs and the speakers' layout
still carry the structure, so `NO_COLOR` and `TERM=dumb` lose only the colour.
`gmux ls` and `gmux show` are unchanged and still pipe clean.

## 0.6.0

**Upgrading:** `ctrl-o` in the picker no longer suspends the list. It opens the
chat in the preview pane instead, so the session you were reading stays on
screen. Nothing else changes for you: bare `gmux ask`, the `--json` form, and the
`fzf < 0.46` and no-fzf fallbacks all behave exactly as before.

### ctrl-o asks in the pane, not over the list

`ctrl-o` used to suspend fzf and hand the child a full-screen REPL — so the first
thing it did was take away the very session you pressed it *to ask about*.
Browsing and asking are the same activity, and that made them mutually exclusive.

Now `ctrl-o` is a **mode**, not a launch. The list stays put, the card moves to
the top of the preview pane, and the answer arrives underneath it while you keep
arrowing around. It's **one continuous thread**: moving the cursor re-points
"this session" without forking or resetting what you've asked. `esc` leaves chat
and hands back the list exactly where you were.

`claude -p` buffers rather than streams, so there is no answer to render word by
word — instead a **1-second heartbeat** shows `thinking… 14s` while the request
is in flight, then the answer lands in one paint. The picker never freezes, and
`esc` cancels a request mid-answer.

Nothing regresses for people who never ask: with no conversation yet, the card
gets the full pane exactly as today. `fzf < 0.46` keeps the full-screen `execute`
REPL, and the no-fzf numbered list keeps its `a` key.

### Fixes

- The orphan-transcript sweep is now keyed on the **run**, not the transcript. A
  picker killed between `ctrl-o` and the first question leaves a `.browseq` with
  no `.jsonl` beside it; keyed on the transcript, the sweep could never see that
  run, so the cache grew one file per killed picker. It now reaps every member of
  a dead run.
- Multi-byte output from providers is no longer mangled at chunk boundaries, and
  callers can watch a request as it streams.

## 0.5.0

**Upgrading:** the first time you run `gmux` in a terminal, it will ask you to
choose a harness before doing any model work. Nothing prompts when the output
isn't a terminal, and `GMUX_SUMMARY_CMD` still overrides everything — so
scripts, CI and agents are unaffected.

### gmux asks who to call, once, instead of assuming

The first time you run `gmux` in a terminal it asks which harness should do its
model work — Claude Code, Codex, any command that reads a prompt on stdin, or
nothing at all. Before, it assumed `claude -p` and started spending tokens in the
background without ever mentioning it.

Your answer lives in `~/.config/gmux/config.json`, and `gmux setup` changes
it. Choosing **nothing** is a real answer: `gmux ls` and `gmux show` still work on
hard facts alone, and nothing calls a model.

Nothing prompts unless there's a human at the other end. No TTY, `--json`, or an
internal command means gmux behaves exactly as it did before: autodetect and carry
on. `GMUX_SUMMARY_CMD` still overrides everything, so existing scripts and
CI need no changes.

### gmux ask

`gmux ls` answers "what was I doing?" one row at a time. **`gmux ask`** answers the
question that spans them:

```bash
gmux ask "what's still broken?"
gmux ask "what did I already try for the retry?" --json
```

It starts from the summaries already on disk, so a question costs one model call
rather than a scan of your transcripts. When the summaries aren't enough it runs
`gmux grep` against the real thing and reads what you actually said.

**In the picker, `ctrl-o`** opens it on the session you're highlighting and drops
you back in the list, right where you were, when you're done. Without fzf, the
numbered list spells it `a`.

Not `shift+f`: fzf's query line eats plain letters, so `F` would just type an
`F`. Not `alt-a` either — macOS Terminal and iTerm2 send `å`.

### The picker explains its markers

`gmux ls` printed a key for `⚠`, `◐` and `○`. The picker — bare `gmux` — rendered the
same three markers and explained none of them, which put the explanation exactly
where you needed it least: `ls` is the command you run to read a list, and the
picker is the one you run to *choose*. `⚠` is the whole point of the tool, and in
the picker it was an unexplained glyph.

Both picker paths now carry a key: a second header line under fzf, and a line
above the "install fzf" hint in the numbered fallback.

It is deliberately static — every marker, always, and never a count — while
`gmux ls` keeps its counted one. fzf sets its header once, at spawn; ctrl-r
replaces the list and leaves the header alone. Counts there would freeze at open
and be wrong after the first refresh, which is precisely when they change. A key
that is stale exactly when it matters is worse than no key at all.

## 0.4.0

### ctrl-r refreshes the picker

The picker used to be a dead end: the list it opened with was the list you were
stuck with. Sessions you started since never appeared, and rows marked `○` stayed
`○` however long you sat there.

**ctrl-r** now reloads to your most recent sessions and starts summaries for any
that need one, without leaving the picker — so it's something you can navigate in
while an agent works alongside you. Without fzf, the numbered list takes `r` for
the same thing.

Repeated presses are safe. The lock that already stopped five `gmux ls` from
starting five summarizers stops this too: a press while a pass is running just
reloads. Sessions whose summary is already current are never rewritten, so ctrl-r
on a fresh list costs nothing.

### Bare `gmux` summarizes what it shows

Only `gmux ls` kicked off a background pass; the picker never did. It does now,
over the sessions it is about to offer, and rows being written are marked `◐`
there as well as in `gmux ls`.

### Fixed: `--no-auto-summarize` never worked

`gmux --no-auto-summarize ls` spent tokens anyway. The flag is declared on the root
command, and commander does not copy root options into a subcommand's own
options — so the check read `undefined`, compared it against `false`, and
concluded you wanted summaries. Only `GMUX_AUTO_SUMMARIZE=0` actually
turned them off.

The flag now works, on `gmux ls` and in the picker, and it is carried across to the
process ctrl-r starts.

### Shorter headlines

Row headlines asked the model for "max 80 chars" and then rendered them in a
72-char column — an overflow by construction, read as a truncated sentence. They
are now one scannable clause, sized to the column they live in.

The summary cache key covers the prompt as well as the session, so this reaches
summaries already on disk: they regenerate in the background on first run rather
than keeping their old headlines forever. That costs a pass of model calls once.
`GMUX_AUTO_SUMMARIZE=0` still opts out of all of it.

## 0.3.0

### Summaries keep up with what you actually look at

The background pass used to cover a fixed **10** sessions while `gmux ls` displayed
**20** — so the bottom half of the default view was permanently marked "no summary
yet", and the feature looked broken even though it was working exactly as built.

The window now follows the list: `gmux ls` keeps 20 summarized, `gmux ls -n 50` keeps
all fifty. Summaries are written **8 at a time** in parallel (tune with
`GMUX_SUMMARY_CONCURRENCY`), and a single pass writes at most 50, saying so
rather than truncating in silence.

### You can see it working

Rows being summarized *right now* are marked `◐`, distinct from `○` ("no summary
yet, nothing running"). The decision is made before the list renders, so the icon
is true on the very run that starts the work.

### Background failures are no longer silent

The worker's stdio is discarded, so a broken provider used to mean summaries
simply never appeared, with nothing to look at. Failures now land in
`~/.cache/gmux/auto-summarize.log`, and `gmux doctor` surfaces the last one.

**Fixed:** the worker could silently write **zero** summaries. It resolved its
queue by loading "the N most recent sessions" and filtering — but with sidechains
included, the most recent N are mostly subagent transcripts, so the filter matched
nothing. It now looks the queued sessions up across the whole store.

### The picker wraps too

fzf rows no longer truncate: a session is one NUL-delimited multi-line record
(`--read0`), so a long summary wraps and is still selected as a single item. fzf
below 0.46 has no multi-line display, so it falls back to single-line rows rather
than rendering one session as several bogus entries. The numbered fallback (no fzf
installed) wraps as well.

## 0.2.0

**gmux now spends tokens on your behalf unless you tell it not to.** That is a
change of default behavior, which is why this is a minor bump rather than a patch —
everything in it already shipped as 0.1.3/0.1.4, but the version number was
under-selling it.

### Summaries write themselves

Any `gmux` command now checks the 10 most recent sessions and, if any lack a current
summary, writes them in a **detached background process**. The foreground command
never waits on a model: it prints, tells you on stderr what it started, and exits.
Summaries appear on your next run. Rows still waiting are marked `○`.

Three things this deliberately does not do:

- **Block.** A summary costs ~8s of model time. Ten of those inline would turn a
  60ms `gmux ls` into a minute of waiting.
- **Stampede.** A lock in `~/.cache/gmux` means five `gmux ls` in a row start
  one summarizer, not five.
- **Loop.** The summarizer *is* `claude -p`, which writes a session of its own.
  Automated runs and sidechains are excluded from the target set, so gmux
  cannot summarize its own summarizer forever.

**Turning it off**, because background model calls cost money:

```bash
gmux --no-auto-summarize ls          # once
export GMUX_AUTO_SUMMARIZE=0 # for good
```

It also stays quiet when no summary provider is installed — a missing `claude`
never breaks a read command. `gmux doctor` reports the current state.

### `gmux ls` wraps instead of truncating

Long descriptions were cut off at 72 characters, so the sessions with the most
informative summaries were exactly the ones you could not read. They now wrap to the
terminal, with continuation lines indented under the description column.

Piped output still emits **one line per session**, untruncated, so `gmux ls | grep`
behaves. The fzf picker's rows stay single-line, because fzf maps lines back to
session ids.

## 0.1.2

- `gmux --version` reported a hardcoded `0.1.0` regardless of the installed version.
  It now reads `package.json`.

## 0.1.1

- First release published through [trusted publishing](https://docs.npmjs.com/trusted-publishers/)
  (OIDC): no long-lived npm token, and every release carries a provenance
  attestation binding the package to the commit and workflow that built it.

## 0.1.0

First release.

- Index sessions from **Claude Code** and **Codex**; one adapter per harness, and
  adding another is a single file.
- Summaries describe where a session **landed**, not where it started — built from
  the *tail* of each transcript, because a harness's own title is written in the
  first few seconds and never revised.
- Sessions that ended mid-task are flagged `⚠`.
- `gmux resume` hands off to the right CLI (`claude --resume` / `codex resume`) in the
  session's original directory.
- `--json` on every read command, so agents can call it too.
- Read-only: never writes to a session file.
