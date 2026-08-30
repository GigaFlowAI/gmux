# gigamanage

**Browse, search and resume your AI coding agent sessions — across Claude Code, Codex, and whatever you use next.**

Agent sessions pile up faster than your memory of them does. After a few weeks you have hundreds of transcripts, and the built-in pickers sort them by time and label them with a title generated in the session's *first* few seconds. That title tells you where the work **started**. When you're deciding what to pick back up, you need to know the latest status.

## It's like saying "good morning" to your agents

gigamanage is a small CLI, `gm`, that helps you reorient yourself among your agent sessions.

`gm` shows a full context card for
the highlighted session alongside it — what landed, what's still open, and the
next concrete step. Hit enter and you're back in the session, in the right
harness and the right directory. **ctrl-r** reloads the list to your most recent
sessions and starts summaries for any that need one — handy when you left the
picker open while an agent was working. (Without fzf, the numbered list takes `r`
for the same thing.)

<p align="center">
  <img src="docs/media/gm-picker.png" width="90%" alt="The gm fuzzy picker: session list on the left, and a preview pane on the right showing where the highlighted session landed, what is still open, and the next step">
</p>

## Claude SBS

Both of these are looking at one `webshop` repo with six recent sessions. The
built-in picker labels each one with the title Claude Code generated in its
opening seconds; `gm ls` labels it with where the work actually ended up.

<table>
<tr>
<th width="50%"><code>claude --resume</code></th>
<th width="50%"><code>gm ls</code></th>
</tr>
<tr>
<td valign="top"><img src="docs/media/claude-picker.png" alt="Claude Code's resume picker, listing six sessions by the title generated at the start of each one"></td>
<td valign="top"><img src="docs/media/gm-ls.png" alt="gm ls, listing the same six sessions by where the work landed, with two flagged as ended mid-task"></td>
</tr>
<tr>
<td valign="top"><em>"webhook retries are flaky" is what you asked for four hours ago. Whether it got fixed is anyone's guess — and the two sessions that died mid-task look exactly like the four that didn't.</em></td>
<td valign="top"><em>The retry fix landed but the timestamp check never got written, and the Node 22 bump left the build red. Both are flagged <code>⚠</code>: they ended mid-task.</em></td>
</tr>
</table>

## What makes it different

**Summaries describe what the work became.** gigamanage reads each transcript's *arc* — what you originally asked for, how the work moved, your last instructions, the agent's final message, the files it touched, the last command that failed — and writes four things: what the session is about, what landed most recently, what's still open, and the next concrete step. The harness title names the opening prompt and never revises it; this tells you where the work actually is. That's the whole point of the tool.

**It knows when work was cut off.** Sessions that ended mid-task are flagged `⚠`. Those are usually the ones you're looking for.

**It works across harnesses.** Claude Code and Codex today, with one small interface for adding more. `gm resume` hands off to the right CLI — `claude --resume` or `codex resume` — in the session's original directory.

**Agents can use it too.** Every read command takes `--json`. Your agent can shell out to `gm grep "flaky test" --json` to find what you already tried, instead of asking you.

**A live view of every agent at once.** Drive your agents in tmux and `gm` keeps every pane's border labelled with what its session is doing (`alt-g`), and overlays the full cards in place on demand (`ctrl+g`) — so you can glance across all of them and drill in only where it's worth it. [Live from tmux](#live-from-tmux) has the setup.

## Install

**From npm** (recommended):

```bash
npm install -g gigamanage
```

Or run it without installing anything:

```bash
npx gigamanage ls
```

**From source** — for hacking on it, or to run an unreleased commit:

```bash
git clone https://github.com/GigaFlowAI/gigamanage
cd gigamanage
npm install
npm run build
npm link          # puts `gm` on your PATH, pointing at this checkout
```

With `npm link`, `gm` tracks your working copy: re-run `npm run build` and the
next `gm` picks it up. To run straight from TypeScript without building, use
`npm run dev -- ls`. To unlink later: `npm unlink -g gigamanage`.

Requires Node 20+. Three optional companions, all surfaced by `gm doctor`:

- **ripgrep** (`brew install ripgrep`) — needed for `gm grep`.
- **fzf** (`brew install fzf`) — upgrades the picker to fuzzy search with a preview pane. Without it you get a numbered list.
- **tmux 3.2+** (`brew install tmux`) — unlocks the live `alt-g` label agent and the `ctrl+g` peek overlay (see [Live from tmux](#live-from-tmux) below).

Summaries are written by a model, so the first time you run `gm` it asks which one to call — Claude Code, Codex, anything that reads a prompt on stdin, or nothing at all. Change your mind any time with `gm setup`. `GIGAMANAGE_SUMMARY_CMD='codex exec'` overrides it for a one-off, and nothing prompts when the output isn't a terminal, so `gm ls --json` stays safe to script.

## Usage

```bash
gm                       # pick a recent session and resume it
gm ls                    # recent sessions, newest first
gm ls -p webshop -s 3d   # ...in one project, from the last 3 days
gm show <id>             # the full context card (id or any unique prefix)
gm grep "rate limit"     # full-text search every transcript
gm ask                   # ask about your sessions — what to pick up, and why
gm resume <id>           # jump back in, in the right harness and directory
gm summarize --recent 20 # write summaries for the 20 most recent sessions, now
gm setup                 # choose which harness gm calls for model work
gm doctor                # what's installed, what's missing, how to fix it

gm tmux install          # add the ctrl-g / ctrl-shift-g tmux bindings
gm run claude            # launch an agent gm can map to its pane exactly

gm --no-auto-summarize ls   # ...without kicking off background summaries
```

Summaries are cached and only regenerate when a session actually changes, so you pay for each one once.

By default the list hides two kinds of noise: **subagent transcripts** (`--include-sidechains`) and **non-interactive runs** like `claude -p` or `codex exec` (`--include-automated`).

## Ask across your sessions

A list answers "what was I doing?" one row at a time. `gm ask` answers the
question that spans them: *given all of it, where should I be looking?*

```bash
gm ask                                  # a conversation; ctrl-d to leave
gm ask "what's still broken?"           # one-shot
gm ask "what did I try for the retry?" --json   # for your agents
```

It starts from the summaries already on disk — so it costs one model call, not a
scan of half a gigabyte. When the summaries don't carry enough, it runs
`gm grep` against the real transcripts and reads what you actually said.

**In the picker, `ctrl-o` opens it** on the session you're highlighting: ask
"what's left here?", read the answer, and land back in the list exactly where you
were. (Without fzf, the numbered list spells it `a`.)

It isn't `shift+f` because fzf's query line eats plain letters — typing `F` types
an `F`. And it isn't `alt-a` because macOS sends `å`.

## Summaries write themselves

Every `gm` command keeps **the sessions you just looked at** summarized. `gm ls`
shows 20 by default, so it keeps 20 written; `gm ls -n 50` keeps all fifty. Any
that are missing or stale are handed to a **detached background process**, eight
at a time, and the command returns immediately:

```
$ gm ls
a1b2c3d4 3m    webshop/main            Checkout spec + 8-task plan written; no tasks executed yet
e5f6a7b8 1h  ◐ webshop/add-search      add pagination to the search results page
c9d0e1f2 4h  ⚠ billing/fix-webhooks    Retry logic half-applied; signature test still red

⚠ ended mid-task   ◐ summarizing now (1)
summarizing 1 session in the background — marked ◐ below
```

| marker | meaning |
|---|---|
| `◐` | being summarized right now |
| `○` | no summary yet, and nothing running |
| `⚠` | the session ended mid-task — usually the one you want |

The foreground command **never waits on a model**: it prints and exits, and the
summaries appear on your next run. Only one background pass runs at a time — a
lock in `~/.cache/gigamanage` means five `gm ls` in a row start one summarizer,
not five. A pass writes at most 50; the rest are picked up next run, and it says so.

The notice goes to **stderr**, so `gm ls --json` stays clean for agents and pipes.

Automated runs and sidechains are never summarized this way. That matters: the
summarizer *is* `claude -p`, which writes a session of its own — summarizing those
would put gigamanage in an infinite loop against your token budget.

**Turning it off.** Background model calls cost tokens. Either of these switches
them off:

```bash
gm --no-auto-summarize ls          # once
export GIGAMANAGE_AUTO_SUMMARIZE=0 # for good, in your shell profile
```

It also stays quiet if no summary provider is installed — a missing `claude` never
breaks a read command. If a background pass fails, `gm doctor` shows you the last
error rather than leaving you to wonder why nothing appeared.

## Live from tmux

If you drive your agents from tmux, `gm` becomes a **background agent that keeps
you current on what each of them is doing** — so you can glance, decide how much
attention a session deserves, and drill in only where it's worth it.

```bash
gm tmux install    # add the key bindings to ~/.tmux.conf
gm tmux uninstall   # remove them again
```

Reload tmux to pick up the change (`tmux source-file ~/.tmux.conf`). That installs
three bindings:

- **alt-g** toggles the **live label agent**. A lightweight background service
  keeps every pane's border labelled with its session's one-line headline, across
  all your windows, while the pane content stays fully visible. It refreshes as
  your agents work — and only re-summarises a session when its content has
  actually moved on, so it can sit running all day. The glance layer.
- **ctrl-g** peeks — every pane's **full card** in place: headline, summary,
  what landed, what's still open, the next step. Press **ctrl-g** again (or Esc)
  to dismiss it — the same key toggles the peek. Type in the ask box at the bottom
  to broadcast a question to every pane — each card shows its own answer
  ('what`s most urgent for each?'). The drilldown layer.
- **ctrl-shift-g** opens the `gm` session picker in a popup; Enter resumes your
  choice into a **new tmux window**, so the pane you peeked from stays untouched.

`gm` resolves which session a pane is running by reading the pane's own process
(the agent's command line carries its session id) — so it works with panes you
already have open, no setup. Launching through `gm run` records an exact link for
the rare cases the process can't be read:

```bash
gm run claude         # instead of: claude
gm run codex resume   # instead of: codex resume
```

Drive the agent directly if you like: `gm watch` starts the live service,
`gm watch --stop` stops it.

This needs **tmux 3.2 or newer** (for `display-popup`); `gm doctor` reports
whether it's available and, if not, why.

## How it works

```
harness dirs → adapter → SessionRecord (hard facts, free)
                       → index cache   (mtime-keyed; 1,100 sessions in ~60ms warm)
                       → distill arc   → model → summary (cached)
```

gigamanage is **read-only**. It never writes to a session file; it owns nothing but its own cache in `~/.cache/gigamanage`.

See [`docs/architecture.md`](docs/architecture.md) for the layering, and [`docs/adding-a-harness.md`](docs/adding-a-harness.md) to add support for another agent.

## Contributing

Yes please — especially adapters for other harnesses. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT
