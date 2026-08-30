# The picker's chat pane — design

**Status:** approved. Two of the six decisions were amended by the user after
measurement; both amendments are recorded below with their reasons.
**Date:** 2026-07-17

Extends [`2026-07-16-setup-and-ask-design.md`](2026-07-16-setup-and-ask-design.md).
That spec gave the picker `ctrl-o`. This one changes what `ctrl-o` *does*.

## The problem

```
--bind=ctrl-o:execute(<self> ask --focus {1})        # picker.ts:289
```

`execute()` suspends fzf and hands the child the whole terminal. The session list
vanishes and you get a full-screen REPL. That is exactly backwards: you press
`ctrl-o` *because* you are looking at a session, and the first thing it does is
take the session away. Browsing and asking are the same activity, and the current
binding makes them mutually exclusive.

The fix: `ctrl-o` becomes a **mode**, not a launch. The list stays. The answer
arrives in the preview pane, underneath the card, while you keep arrowing around.

---

## The six decisions this spec is built on

Quoted so that every later citation points at something. **Two carry an
amendment the user made after the original decision, on measurements taken
after it.** The original wording is kept visible so the change is legible and
nobody "fixes" it back.

1. **Surface** — split the preview pane. Card on top, chat underneath. `gm`
   renders both halves into one preview command's output and owns the split.
   fzf does not gain a pane.
2. **Focus model** — one continuous thread. The highlighted row is "the session
   they're currently looking at". Moving the cursor re-points "this" but does
   not fork or reset the thread.
3. **Thinking time** — ~~stream the answer live, word by word … refresh on new
   bytes, no idle polling~~. The picker must not freeze while the model thinks
   (~20s). esc cancels mid-answer.

   **AMENDED — heartbeat, not word by word.** `claude -p` **buffers**.
   Independently measured twice: a request for 40 lines of numbers came back as
   **one 111-byte stdout write at +3.32s**. There is no stream to render, so
   word-by-word is not a thing our code can choose to do. What ships is a **1s
   in-flight heartbeat** rendering `thinking… 14s`, then the answer in **one
   paint**. The timer ticks **only while a request is in flight**, which is the
   narrow, explicit exception to "no idle polling": chunks were supposed to be
   the clock, and a buffering provider has no chunks, so it has no clock. The
   rest of decision 3 holds completely and is the half that motivated it — the
   picker never freezes, esc cancels mid-answer, and the answer arrives with no
   keypress.
4. **Empty state** — no conversation yet ⇒ the card gets the full pane, exactly
   as today. Nothing regresses for people who never ask.
5. **Fallback** — ~~fzf 0.46+ gets the split chat; fzf < 0.46~~ keeps today's
   full-screen `execute` REPL; no fzf keeps the numbered list's `a` key. Bare
   `gm ask` and `gm ask "q" --json` are unchanged. Nothing anyone has today is
   taken away.

   **AMENDED — the floor is 0.59.0, and the oracle is `$FZF_INPUT_STATE`.** The
   mode oracle is the expensive mechanism and nobody had costed it when 0.46 was
   chosen; costed in full (table under *The version gate*), `$FZF_INPUT_STATE`
   lands at **0.59.0** and every other action the bindings use is at or below
   0.46. **0.46–0.58 therefore gets today's `execute` REPL.** This widens the
   fallback population — some distros still ship ~0.44 — and the user accepted
   that cost explicitly rather than take the 0.46-compatible build, which
   couples control flow to a cosmetic string (see *Rejected alternatives*).
6. **Sequencing** — this spec is *only* the chat pane. Bundling fzf as a
   dependency (via `optionalDependencies`, not a postinstall script) is deferred
   to a separate later spec and is not designed here.

Decision 6 is a **scope** rule, not an order-of-work rule. It is why the card
rewrite and the colour contract that an earlier draft carried have been cut from
this spec: they are not the chat pane. See *What this is not*.

**All version numbers here are changelog-derived; only fzf 0.74.0 was available
to test against.** If the 0.59 floor is load-bearing commercially, one real 0.59
binary should be driven before implementation.

## Smaller calls

- **An aborted turn's question: drop it.** The fold only promotes turns with an
  `end` record; `buildAskPrompt` renders `Developer: q` / `You: a` and has no slot
  for a question with no answer. Keeping it marked-unanswered tells the model it
  failed, which invites an apology instead of an answer. Dropping it means "ok but
  briefly" after an esc has no antecedent — the human still *sees* the aborted
  turn in the pane; only the model's view loses it. Both imperfect. **Drop.**
- **The browse filter persists into ask mode.** Verified: with `disable-search`
  active, `clear-query` does not re-filter — the list stays frozen at whatever the
  browse query matched (observed `11/21`). **Keep the filter.** The rows under the
  cursor should not move when you press ctrl-o.
- **`MULTILINE_FZF = [0,46,0]` is wrong.** Multi-line display landed in
  **0.53.0**; 0.46.0 shipped `FZF_LINES`/`FZF_COLUMNS`. So on 0.46–0.52 the picker
  already sends `--read0` records to an fzf that cannot display them. Pre-existing,
  **out of scope** — but it means the chat gate must not ride on
  `supportsMultiline()`.
- **`gm pick --include-automated` + ctrl-r will list gm's own ask session.**
  Possible today, but today's ctrl-o suspends fzf so you physically cannot press
  ctrl-r mid-call. **Accept it.** The user passed a flag meaning "show me
  non-interactive runs"; hiding one because we made it is lying to the only user
  it affects.

---

## The surface

fzf has exactly **one** preview pane and cannot split it. So gm renders both
halves into one preview command's output and owns the split itself. **fzf does
not gain a pane.**

```
┌─ sessions ─────┬─ preview ──────────────────┐
│ > webshop  2h  │ 4998a936  webshop  2h ago  │
│   api      4h  │ dim meta line              │  ← the card, from formatCard
│   docs     1d  │ WHERE IT LANDED …          │
│                │ NEXT STEP …                │
│                │ ── ask ────────────────────│  ← the divider
│                │ you                        │
│                │   why did this one fail?   │  ← the chat, from the transcript
│                │ gm                         │
│                │   The run died in apply_…  │
└────────────────┴────────────────────────────┘
```

The preview command is **constant for the whole picker run**. Every mutable thing
lives in a file. This is what makes `refresh-preview` sufficient and
`change-preview` unnecessary:

```
<self> __preview-card {1} --chat '<transcript>' --pane-lines ${FZF_PREVIEW_LINES:-0}
```

**`__preview-card`, not `gm show --chat …`.** `gm show` is a public command and
`--chat <path>` is a private IPC channel: it is meaningless to a human at a
terminal and exists only because fzf's preview command must be a shell string.
Every other internal entry point here is `__`-prefixed, the prefix is load-bearing
three times over (see *Recursion guards*), and `__picker-rows` already set the
precedent. So the preview gets a hidden command that calls the same renderer.

**`gm show`'s public surface is unchanged** — same flags, same output, same
`--json` schema. That also disposes of the question an earlier draft left open
("what does `gm show --json --chat <path>` do?"): there is no such invocation.

**`${FZF_PREVIEW_LINES:-0}` — the `:-0` is load-bearing.** Not because the var is
plausibly unset — per the changelog fzf has exported it to the preview process
since **0.18.0**, and in a correctly sized 40x120 pty it was observed set to 38.
(An earlier draft justified this with "verified: in a 0-size pty both were unset".
That is a test-harness artifact — a pty forked without `TIOCSWINSZ` — not a state
a real terminal reaches. Dropped.) The real reason: **the value is
environment-controlled text and the parse must not silently shift arguments.** A
bare `$FZF_PREVIEW_LINES` that expands to nothing makes commander read the *next
flag name* as the value. Treat it as hostile; the test at the bottom pins it.

**Not `$LINES`/`$COLUMNS`.** Verified on a 40x120 terminal: the preview saw
`LINES=40 COLUMNS=120` (the *terminal*) but `FZF_PREVIEW_LINES=32
FZF_PREVIEW_COLUMNS=59` (the *pane*). `sh` resets `LINES`/`COLUMNS` before the
command runs, exactly as fzf's changelog warns. Using them overestimates the pane
by up to 2x.

**Not `terminalWidth()`.** The preview's stdout is a pipe, so
`process.stdout.columns` is undefined and it returns its 100 default. Same problem,
same answer as `__picker-rows --width`: geometry is passed in, never measured.

### Height math

```
CARD_MIN = 6   CHAT_MIN = 8   DIVIDER = 1   MIN_SPLIT = 15
paneLines = --pane-lines > 0 ? it : 24

!chatHasContent    -> card gets all paneLines, divider 0, chat 0
paneLines >= 15    -> chat = clamp(floor(paneLines/2), CHAT_MIN, paneLines-1-CARD_MIN)
                      card = paneLines - chat - 1
paneLines <  15    -> COLLAPSED: card = 1 (its identity strip), divider 1, chat = rest
```

Guessing 24 rather than refusing to split is deliberate: the chat auto-tails, so
an over-guess costs a little fzf scrolling, while refusing shows no chat at all
right after the user asked for one.

**The collapse regime is the answer to "what about a 20-line terminal?"** — the
pane is 14 rows there, and two 7-row halves are useless. Below 15 rows the card
collapses to `formatCard`'s first line (`bold(sessionLabel)`) and the chat takes
everything else. You still know which session "this" is, which is the entire point
of the focus model, and the chat stays readable. That is a better failure than an
8-row card fragment.

**The card is clipped at the divider, exactly as it is clipped at the pane bottom
today.** `--preview-window=…,wrap` keeps doing what it already does. Measured:
`formatCard` never wraps, emits lines up to 647 columns, and renders 23–83 rows
against a 14–41 row pane — **the card already overflows the full pane by 1.2x–6x
at every realistic size.** The split does not break the card; the card was already
clipped. An earlier draft answered that with a six-step priority drop ladder and a
`--pane-columns` flag, which is a rewrite of a working `formatCard` and a
user-visible change to `gm show` for everyone who never presses ctrl-o. That is
out of scope by decision 6 and out of scope by the spec's own rule for
`MULTILINE_FZF`: a pre-existing defect is a pre-existing defect. If `NEXT STEP`
clipping turns out to bite in the split, that is a real observed bug in `gm show`'s
section ordering and it gets its own small PR — probably "move NEXT STEP up", not
a ladder.

### The divider

```
── ask ──────────────────────────────────────────
```

```
dim("── ask " + "─".repeat(Math.max(0, width - 7)))
```

`"── ask "` is **7 display columns**, so the constant is 7 and the rendered width
is `width`. (An earlier draft said `w - 11`, which renders 4 columns short of the
pane and contradicts every diagram in this document — and `String.repeat` throws
`RangeError` on a negative count, so a narrow pane crashed the preview.) The
`Math.max(0, …)` is the same hostile-input rule as `:-0`.

Width comes from `FZF_PREVIEW_COLUMNS`, read by `__preview-card` from its own
environment rather than passed as a flag — fzf exports it to the preview process,
and unlike `--pane-lines` nothing else needs it.

Labelled, because `format.ts`'s idiom is named sections (`WHERE IT LANDED`,
`NEXT STEP`) — an anonymous rule would be the only unnamed boundary on screen.
`dim` not `bold` because it is chrome, matching the meta line and the facts footer.
Unicode `─` needs no ASCII fallback: `format.ts` already ships `⚠ ○ ◐ ·`
unconditionally.

**`--no-color` does not change its shape.** `dim()` no-ops to identity when colour
is off, so the boundary is carried by glyphs and never by colour.

### Colour — monochrome, exactly as the pane is today

The preview pane has been monochrome since it shipped. Verified: the preview's
stdout is not a tty (`process.stdout.isTTY` → false as an fzf preview command),
and `format.ts:12` gates all colour on `isTTY === true`. So `formatCard` emits
zero ANSI in the preview today, `--no-color` at picker.ts:196 is already
redundant, and nobody has filed a bug.

**So the split ships monochrome and `format.ts` is not touched.** An earlier draft
proposed a `FORCE_COLOR=1` contract and a new `useColor` ladder, which changes
colour behaviour for *every* piped `gm` invocation in the tool — a blast radius
wildly out of proportion to "put a chat in the side pane", and not the chat pane
by decision 6. The design already proves it survives without: the divider is
carried by glyphs and never by colour, the speakers are distinguished by layout
with colour only accelerating it, and the cursor is a bare glyph. If colour in the
preview is wanted it is a self-contained ~20-line PR that can land before or after
this one and is trivially reviewable alone.

### Speakers

```
you
  why did this one fail?

gm
  The run died in apply_patch — the span was recorded as
  aborted rather than errored, so the trace shows…
```

`bold("you")` / `cyan("gm")` — `bold` is the section-heading idiom, `cyan` is
already gm's own colour (the `where` column, the `○` marker). Both no-op in the
pane today (see above); they cost nothing and are correct the day the pane gains
colour. Bodies indented 2 via `format.ts`'s `indent()` (module-private today;
**export it**), the same indent the card uses under every heading, so the halves
line up.

**They must be legible with colour off**, and they are: `you` on its own line above
an indented body. The *layout* distinguishes the speakers.

**The `· re:` suffix is conditional.** A question renders as bare `you` normally,
and as `you · re: a1b2c3d4` **when this question's focus differs from the previous
question's, and on the first question of the thread.** Focus re-points per question,
so a thread of five questions can span five sessions, and an answer rendered under
a cursor that has since moved reads as being about the wrong session. But stamping
every question with the same id when focus never moved is noise on the one thing
the pane has least room for. The suffix marks the *change*, which is the only
moment it carries information.

### Scrolling — auto-tail

The chat half renders the **last `chatRows` wrapped rows**. New text appears at the
bottom, old text slides up. This is what makes it read as a chat rather than a
document, it composes with the refresh loop for free, and **it means the common
case needs no scrolling at all.**

That is the whole feature. An earlier draft added `ctrl-g` to zoom the chat to the
full pane, and it is cut, for three independent reasons — any one sufficient:

1. **`ctrl-g` is not free.** The draft claimed "`ctrl-g` is unbound in fzf and
   safe". That is flatly false and I verified it: `man fzf` line 1859 lists
   `abort` → `ctrl-c  ctrl-g  ctrl-q  esc`, and line 2239 repeats it. ctrl-g is one
   of fzf's four documented quit keys. `--bind=ctrl-g:…` does override it, so the
   zoom would have *worked* — by silently stealing a quit key, which is the same
   class of harm as "enter means two things" that this design calls its sharpest
   edge. (If zoom is ever revived: `ctrl-t`, `ctrl-x`, `ctrl-v` and `ctrl-z` are
   genuinely absent from the DEFAULT BINDINGS column. Verify against the column,
   not recollection.)
2. **It could not work as specified.** The preview command is declared constant and
   its argument list contains no state path, so `__preview-card` was never told
   where the zoom bit lived and could not read it.
3. **It is the most expensive line-per-value item in the spec** — a fourth hidden
   command, a fourth binding, and a mode/zoom state file that directly contradicts
   this design's own best argument, *"mode is not stored anywhere"*.

If a user hits the ceiling they can `cat` the transcript. If scrollback turns out
to matter, it lands later on real evidence.

**Not fzf's native preview scroll.** `shift-up`/`shift-down` scroll the *whole*
preview — in split mode that drags the card off the top and reveals nothing. The
halves are not independently scrollable because there is only one pane.

**Not `change-preview-window`.** It resizes fzf's window; our split is internal, so
a taller window hands both halves more rows proportionally. It cannot let the chat
take the card's rows. Wrong lever. (It would also have been a live bug: fzf < 0.73
resets `wrap` state on `change-preview-window`, and we use `wrap`.)

---

## The mode toggle

Ask mode hijacks fzf's query line, because fzf has one text input and its query
line eats plain letter keys (AGENTS.md). While typing a question, fuzzy filtering
is **off** and browsing is arrow keys only.

**Mode is not stored anywhere.** fzf already tracks it. Adding a mode file would be
a second source of truth that can disagree with the first.

**`rebind` cannot give `enter` a new meaning** — it only *restores* a binding after
`unbind`. So `enter` and `esc` are each bound **once**, to a `transform` that
branches on the oracle. (`rebind` *is* the right tool for a key that should simply
be off in ask mode — see `ctrl-r` below.)

### The oracle is ternary, and the environment can lie about it

Two verified corrections to an earlier draft, both of which made ctrl-o a dead key:

**1. `$FZF_INPUT_STATE` has three values, not two.** `man fzf` line 1462:
*"Current input state (enabled, disabled, hidden)"*. `--no-input` yields `hidden`.
So the branch is **`= disabled` means ask mode; everything else means browse** —
never `= enabled` means browse. The `enter` binding got this right by accident; a
`ctrl-o` guarded on `= enabled` is silently inert under `--no-input`.

**2. fzf reads `FZF_DEFAULT_OPTS` from the environment, and picker.ts:314 is
`spawn("fzf", args, { stdio: [...] })` with no `env` option** — so the user's opts
are inherited. With `FZF_DEFAULT_OPTS=--disabled`, `$FZF_INPUT_STATE` is `disabled`
at the `start` event: the picker believes it is in ask mode from the first frame,
enter never resumes, and ctrl-o cannot get you back. **Pass an explicit `env` to
the fzf spawn that strips `FZF_DEFAULT_OPTS` and `FZF_DEFAULT_OPTS_FILE`.** gm
builds its full arg set already; inheriting user opts also risks a user `--bind`
colliding with ours.

### `--with-shell 'sh -c'` is mandatory, and it is free

**fzf runs child commands with `$SHELL -c`, not `sh -c`.** `man fzf` says so twice
(lines 1400–1402 and 2133–2135): *"fzf runs the command with $SHELL -c if SHELL is
set … make sure that the command is POSIX-compliant."*

An earlier draft's transform bodies were bash-only (`[[ ]]`, `if …; then`, `{ …; }`).
Reproduced locally:

```
$ /bin/dash -c '[[ $FZF_INPUT_STATE = enabled ]] && echo yes'
/bin/dash: 1: [[: not found
```

Under `SHELL=/bin/dash` that makes ctrl-o a **dead key** — ask mode unreachable, no
error anywhere. Under `SHELL=/bin/tcsh` the `enter` transform emits *nothing*, a
transform that emits nothing is a no-op, and **enter no longer resumes a session at
all**: the picker is bricked for csh/tcsh users. That is a regression this design
would introduce — today's bindings are plain commands that run under any shell.

**Fix: add `--with-shell 'sh -c'` to `fzfArgs`.** Changelog-verified at **0.51.0**,
comfortably below the 0.59 floor, so it costs nothing. Writing the bodies as POSIX
`[ "$FZF_INPUT_STATE" = disabled ]` is *also* done — it is simply correct — but it
is not sufficient on its own, because csh cannot parse `if …; then …; fi` either.
`--with-shell` is the only fix that covers every login shell. `askTier` gates on
version, fzf presence, provider and self-command; it never looks at `$SHELL`, and
it should not have to.

### The literal bindings

```
--with-shell 'sh -c'
--listen

--bind=ctrl-o:transform:
  if [ "$FZF_INPUT_STATE" != disabled ]; then
    printf '%s' "$FZF_QUERY" > '<transcript>.browseq'
    echo "disable-search+clear-query+unbind(ctrl-r)+change-prompt(ask > )+change-header(<ask header>)"
  fi

--bind=enter:transform:
  if [ "$FZF_INPUT_STATE" = disabled ]; then
    if [ -n "$FZF_QUERY" ]; then
      <self> __ask-send --transcript '<path>' --port "$FZF_PORT" --focus {1} --question "$FZF_QUERY" <filters> >/dev/null 2>&1
    fi
    echo "clear-query"
  else
    echo accept
  fi

--bind=esc:transform:
  if [ "$FZF_INPUT_STATE" = disabled ]; then
    <self> __ask-cancel --transcript '<path>' --port "$FZF_PORT" >/dev/null 2>&1
    echo "enable-search+rebind(ctrl-r)+transform-query(cat '<transcript>.browseq')+change-prompt(session > )+change-header(<browse header>)"
  else
    echo abort
  fi
```

Every line is load-bearing:

- **POSIX `[ … ]`, `if … fi`, no braces.** See above. The `--with-shell` and the
  bodies are one fix, not two.
- **`!= disabled` on ctrl-o, `= disabled` on enter/esc.** The ternary oracle. Both
  spellings treat `hidden` as browse, which is the fail-safe direction.
- **`transform-query(cat file)`, not `change-query($(cat …))`.** Sidesteps quoting
  hell when the browse query contains `)` or spaces.
- **`enable-search` before `transform-query`.** Otherwise the restored query never
  re-triggers the search.
- **`unbind(ctrl-r)` / `rebind(ctrl-r)`.** ctrl-r reloads the session list. Left
  bound in ask mode it is unadvertised *and* destructive: `reload` repopulates the
  full list while `disable-search` is active, so the frozen filter — the thing the
  "keep the filter" call exists to protect — evaporates mid-thread and cannot be
  restored until esc. This is exactly what `rebind` is for.
- **A transform that emits nothing is a no-op.** Verified: ctrl-o twice does not
  double-enter or crash. This is why the ctrl-o body needs no `else`.
- **`{1}`, not `$FZF_CURRENT_ITEM`.** Changelog-verified: added **0.73.0**; the NUL
  skip landed **0.73.1** (*"exec(2) rejects the env, breaking preview and other
  child commands"*); the 64 KB skip landed **0.74.0**. So on 0.73.0 exactly, a
  NUL-containing item does not degrade gracefully — it **breaks the preview and
  every other child command outright**. We use `--read0`. `{1}` is correct, and this
  history strengthens it.
- **The empty-query guard on `enter`.** Otherwise enter on an empty ask line sends
  a blank question.
- **`>/dev/null 2>&1` is not tidiness.** Verified: a child that inherits fzf's
  stdout blocks fzf until EOF *even when backgrounded with `&`*.
  `transform(sleep 3 & echo …)` froze fzf for 3s;
  `transform(sleep 3 >/dev/null 2>&1 & echo …)` was instantly responsive.
- **`--port "$FZF_PORT"` is appended unquoted by the picker**, after the quoted
  args, and never routed through the arg builder. `shellQuote`'s allowed class is
  `/^[A-Za-z0-9_./:@-]+$/` — `$` is not in it, so `$FZF_PORT` would be
  single-quoted and the child would receive the literal string. Every
  `refresh-preview` would then silently miss.
- **The filters are baked in at picker start**, exactly as `pickerAskArgs` already
  produces them, for the reason written at pick.ts:35-42: `gm ask` builds its own
  window, and a window built from defaults does not contain the session you are
  pointing at, so `--focus` resolves to null and the chat answers about a list you
  never asked about — looking normal the whole time.

**No `start:execute-silent(echo $FZF_PORT > …)` binding.** An earlier draft had one
and nothing read it: `__ask-send` and `__ask-cancel` get the port from
`--port "$FZF_PORT"`, and the worker gets it on argv. Dead mechanism, deleted.

**`<transcript>.browseq` is a sibling of the transcript**, not a state directory.
An earlier draft referenced an undefined `<state>/` that was never allocated,
never named, never cleaned up, and would have collided between two concurrent
pickers. Deriving it from the transcript path gives it the transcript's
`<pid>-<rand8>` uniqueness for free and puts it in the cleanup and sweep paths
that already exist, with no new concept.

### `transform` is synchronous — and that is fine

Verified: `transform(sleep 3; …)` froze the UI for 3s. `bg-transform` did not. So
the thing bound to `enter` **cannot be the thing that calls the model** — it must
detach and exit. `__ask-send` measured **~170ms**, almost all Node startup. That is
a borderline-perceptible freeze on every enter, and it is the accepted cost of a
0.59 floor. `bg-transform` erases it but costs 0.63.0.

### The headers

```
browse:  enter: resume   ctrl-r: refresh   ctrl-o: ask   ctrl-c: cancel
ask:     enter: send     esc: back
```

picker.ts:246-247 records the rule: *"A key that does nothing is worse than a key
that isn't there, so the header advertises exactly what got bound."* Both headers
now obey it in both directions — the ask header lists exactly the two keys ask mode
rebinds, and `ctrl-r` is absent from it because ask mode `unbind`s it rather than
leaving it live and unadvertised. Both keep the marker legend on line 2 — the `#16`
legend must survive both modes.

**Enter means two things and that is the sharpest edge in this design.** In browse
mode it resumes a session, replacing your terminal. In ask mode it sends. A misfire
is not cosmetic: enter that resumes when you meant send drops you into someone
else's harness and the picker is gone. This is why the prompt changes
(`session > ` → `ask > `), why the header changes, and why the mode oracle is fzf's
own state rather than a file that can go stale.

---

## The focus model

**One continuous thread.** The highlighted row is fed to the model as "the session
they're currently looking at". Moving the cursor mid-conversation re-points "this"
but does **not** fork or reset the thread.

This is free, and the reason is worth stating: **fzf re-substitutes `{1}` every
time the binding fires**, against the row highlighted at that instant. So
`--focus {1}` on the send binding is already "the focus at send time" — no state,
no IPC, no race. The thread survives cursor movement because it lives in a file
rather than in a process.

Focus is captured **per question** and written into the transcript's `question`
record — not passed down to the worker on argv. Two reasons:

1. The transcript becomes self-describing, which is what lets the pane render the
   `re:` suffix when focus changes (see *Speakers*).
2. There is one source of truth for what the model was told, and it is a file you
   can `cat` when the answer is wrong.

**Timing:** you press enter on row A, then arrow to row B while the answer is in
flight. The turn keeps A. The *next* question gets B, and renders `re: B` because
focus changed. That label is what makes it legible instead of confusing.

`buildAskContext` already only claims focus on a session that made the window
(ask.ts:52), so a focus that has scrolled out resolves to null rather than lying.
That guard is why the static filters matter.

---

## The answer and the transcript

**The provider buffers, so there is no stream to render.** Measured twice: one
111-byte stdout write at +3.32s for a 40-line request. The design therefore
turns on a **heartbeat**, not on byte arrival — see decision 3. What follows is
the machinery for getting one answer onto disk and into the pane without
freezing anything.

### The process shape

```
gm pick                       allocates the transcript PATH, creates nothing
  └─ fzf --listen             $FZF_PORT + $FZF_API_KEY exported to children
       ├─ preview   gm __preview-card {1} --chat <path> …   re-runs on every cursor move
       ├─ enter     gm __ask-send --transcript <path> --focus {1} --question {q} …
       │              ~170ms: lock, append the question, refresh, spawn DETACHED, exit
       │              └─ gm __ask-run --transcript <path> --seq N …   [detached]
       │                   └─ runProviderCommand(askArgv, prompt, { onChunk, signal })
       │                        └─ claude -p --allowedTools 'Bash(gm grep:*)'
       │                             └─ gm grep …      sees GIGAMANAGE_CHILD=1
       └─ esc       gm __ask-cancel --transcript <path>
```

Four hidden commands, all `__`-prefixed. The prefix is load-bearing three times
over (see *Recursion guards*).

### **The hard correctness constraint**

**The preview command re-runs on every cursor move. The chat half MUST render from
the cached transcript and MUST NEVER call a model.** Otherwise arrowing down fires
a fresh model call per keystroke. Everything else in this section follows from that
one sentence.

This goes in AGENTS.md's "facts that are easy to get wrong". It already carries two
fzf traps; this is the third and by far the most expensive.

### `runProviderCommand` grows `onChunk` and `signal`

```ts
export interface RunProviderOptions {
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** Decoded stdout as it arrives, in order, never a partial UTF-8 sequence,
   *  never after the promise settles. Throwing here is swallowed. */
  onChunk?: (text: string) => void;
  /** Aborting SIGKILLs the child and rejects. */
  signal?: AbortSignal;
}
export async function runProviderCommand(
  argv: readonly string[], prompt: string, options: RunProviderOptions,
): Promise<string>;
```

**Return type unchanged. Both fields optional.** The two existing callers pass
neither and are byte-for-byte unaffected — they still get the buffered string.

**`onChunk` is a tee, not the mechanism this design depends on.** Against
`claude -p` it fires **exactly once**, because the provider buffers. It stays for
one reason: gm is provider-agnostic, and a provider that *does* trickle then gets
incremental rendering for free, with no second code path and no branch. We
neither assume streaming nor foreclose it. `AskProvider.ask` grows an optional
`onChunk?` only so a *fake* streaming provider is expressible in tests, which is
how non-negotiable #2 is honoured; `SummaryProvider` does not change.

**`signal` is not scope creep.** esc must cancel mid-answer, and a worker cannot
honour that by dying: `spawn` does not kill its child on POSIX, so a worker that
exits leaves `claude -p` running and billing.

**A UTF-8 bug gets fixed on the way.** Line 59 is `stdout += String(chunk)`. Node
splits stdout at arbitrary byte boundaries, so a 3-byte `—` straddling one decodes
as `��` on both sides. **This is live today** — just rare (few outputs cross 64KB)
and invisible (a mangled character deep in a summary). One `StringDecoder` per
stream, `decoder.end()` on close. Not `setEncoding("utf8")`, which is equivalent
but can only be tested through a real child process; an explicit `StringDecoder` can
be pinned by feeding it a two-byte char split at byte 1. **This fix is independent
of the chat pane and lands first** (see *Landing order*).

**Ordering guarantee, in the docstring:** every byte handed to `onChunk` is also in
the resolved string, in the same order, and `onChunk` is never called after settle.
That is what lets the `end` record be written from the resolved
string without a late chunk racing it.

### The transcript

`~/.cache/gigamanage/ask/<pid>-<rand8>.jsonl`.

**This needs a doc amendment, in the same PR, and that is not optional.** AGENTS.md
non-negotiable #1 says, verbatim: *"nothing keyed by content hash goes in config,
and **nothing a person typed goes in the cache**."* `core/paths.ts`'s header is
stricter on both clauses: *"`cacheDir()` — derived data. Keyed by content hash,
thrown away safely."* / *"`configDir()` — what a human chose. … Anything a person
typed belongs here."* The transcript fails both: it is typed text, and it is keyed
by pid rather than by content hash.

The reasoning for cache is sound — this is a scratch IPC buffer for one live picker
that dies with it, not a preference — but **a paragraph in a spec is not a decision,
it is a drift with a footnote.** #1 is enforced by nothing but that doc, so the next
agent reads AGENTS.md, sees typed text under `~/.cache/gigamanage`, and "fixes" it.

So: **amend AGENTS.md #1 and `core/paths.ts`'s header to name a third category** —
*ephemeral IPC that dies with the process that created it, never read by a later
run, safe to `rm` at any instant* — and state that `askTranscriptDir()` is its only
member. Then `askTranscriptDir()` beside `summaryDir()` is correct rather than
exceptional, and the rule still forbids what it exists to forbid.

- **Not `configDir()`** — the thread dies with the picker; that is disposable by
  construction, and `configDir()` implies a retention policy we are not writing.
- **Not `os.tmpdir()`** — `paths.ts` opens with "it never writes anywhere else",
  `cacheDir()` honours `XDG_CACHE_HOME` which is how the test suite redirects gm's
  writes, and tmpdir reapers are free to delete a file mid-append.
- **A subdirectory**, so the orphan sweep is a `readdir` of a directory that
  contains nothing but transcripts and cannot mistake `index.json` for one.
- **The random half** makes concurrent pickers collision-free. **The pid half**
  makes reaping a `readdir` + `process.kill(pid, 0)` with zero file reads.

New in `core/paths.ts`, beside `summaryDir()`:

```ts
export function askTranscriptDir(): string;
export function askTranscriptPath(runId: string): string;
```

### Format: an append-only JSONL **event** log

```jsonl
{"t":"meta","runId":"48213-9f3a1c07","startedAt":"…","provider":"claude -p …"}
{"t":"question","seq":1,"at":"…","focus":"a1b2c3d4","text":"why did this one fail?"}
{"t":"chunk","seq":1,"text":"The build broke in session a1b2c3d4 because …"}
{"t":"end","seq":1,"at":"…"}
{"t":"aborted","seq":2,"at":"…"}
{"t":"error","seq":3,"at":"…","message":"timed out after 300000ms"}
```

One `chunk` per turn is the measured norm, not a simplification of the example:
`claude -p` buffers. The record stays plural-capable because `onChunk` is a tee.

**Events, not turns**, and three requirements force it:

- **A question must land before its answer exists.** The echo of what you typed has
  to appear the instant you press enter — ~9–20s before there is an answer to pair
  it with. A turn record cannot be written until both halves exist, so a JSONL of
  turn records would either delay the echo or rewrite a line, and the third
  requirement forbids rewriting. Events are the only shape where "the question, and
  the answer when it comes" is two appends.
- **Two writers.** `__ask-send` writes `meta`/`question`; the worker writes
  `chunk`/`end`. `O_APPEND` makes that safe for whole records and nothing else.
- **Cheap and stateless to render.** A few KB. `readFile` + `split` + `JSON.parse` +
  fold is well under a millisecond against a preview already paying ~50ms of Node
  startup. Stateless by construction, which is what makes it safe to re-run per
  cursor move.

**A partial read is still normal, and this is not a streaming leftover.** The
preview re-runs on **every cursor move**, which is not synchronized with the worker
in any way, and an answer is a multi-KB line whose append a concurrent reader can
catch half-written. Appends are whole-line and ordered, so **the only line a reader
can ever see torn is the last one**. The reader's rule is
`try { JSON.parse(line) } catch { /* torn tail: the next read gets it */ }`, and a
dropped tail costs one refresh. **No lock is taken on the read path.** That is the
whole point of the format.

**This contradicts one investigation**, which proposed a single `AskChatState` JSON
document rewritten atomically. Rejected: a rename-in-place has a window where the
reader sees the *previous* answer (visible stutter), a non-atomic rewrite has a
window where the file is invalid JSON, and with a preview that re-runs on every
cursor move that window *will* be hit. **gm must never truncate-and-rewrite the
transcript**, or the pane flashes empty.

ANSI from the provider needs no handling: `JSON.stringify` escapes control bytes,
so escape sequences round-trip intact.

```ts
// core/types.ts, beside AskTurn
export type AskEvent =
  | { t: "meta";     runId: string; startedAt: string; provider: string }
  | { t: "question"; seq: number; at: string; focus: string | null; text: string }
  | { t: "chunk";    seq: number; text: string }
  | { t: "end";      seq: number; at: string }
  | { t: "aborted";  seq: number; at: string }
  | { t: "error";    seq: number; at: string; message: string };
```

**`meta` has exactly one writer and one reader, or it would not be here.** The
first `__ask-send` writes it inside the same `openSync` that creates the file,
before the first `question` record. It is read by `gm doctor`-style debugging and
by a human running `cat` on a transcript whose answers look wrong — `provider` is
the field that tells you *which* CLI produced them. `foldCompletedTurns` ignores it.
(An earlier draft had it in the format example and in the union with no writer named
anywhere, which is how dead schema gets built.) **`provider` records the argv, never
the environment** — see the key rule below.

### Writing it

`openSync(path, "a")` + `writeSync(fd, line + "\n")` per record. Keep the fd for the
life of the turn; close in a `finally`.

**Synchronous, deliberately, and this survives the one-paint answer.**
`createWriteStream` buffers and can defer a flush past the `refresh-preview` POST —
the pane would then re-render *without* the answer that triggered the refresh, and
with one paint per turn that is not a frame of lag, it is **the whole answer
missing until something else happens to refresh the pane**. The invariant: **the
bytes are on disk before the POST goes out.** The worker is detached with
`stdio: "ignore"` and has nothing else to do; a blocking write costs it nothing.

`O_APPEND` makes the offset update atomic, so ordering holds even with two writers —
which there deliberately are: `__ask-send` writes the `meta` and `question`, the
worker writes `chunk`/`end`. The alternative (the worker writes its own question)
costs ~170ms of Node startup before the echo of what you typed appears, which reads
as dropped input. The lock plus `O_APPEND` plus strict ordering makes two writers
safe; the seq-keyed fold makes it provably safe.

### Refreshing

```
POST http://127.0.0.1:$FZF_PORT   header x-api-key: $FZF_API_KEY   body refresh-preview
```

Plain `fetch` (global in Node 20), **not `curl`** — a new undeclared dependency for
one HTTP request. `.catch(() => {})`, and that is not laziness: fzf may have exited
(the user hit ctrl-c mid-answer), and a POST to a closed port must not take the
worker down before it finishes writing the transcript.

**Three things trigger a refresh, and only three:**

1. **A 1s heartbeat while a turn is in flight** — started when the worker begins the
   call, cancelled on `end`/`aborted`/`error`. **This is the mechanism** (decision 3).
   The provider buffers, so nothing else fires for ~9–20s; without the heartbeat the
   pane is silent and static for the whole think, which is indistinguishable from
   wedged. The heartbeat is what makes `thinking… 14s` tick, and **it is the only
   timer in the design** — it exists only while a request is in flight, which is the
   whole of the exception to "no idle polling".
2. **A chunk arrives**, throttled to `REFRESH_INTERVAL_MS = 150` (trailing edge).
   Against `claude -p` this fires once, with the answer. It is throttled anyway
   because `onChunk` is a tee and a trickling provider would otherwise spawn one
   `gm __preview-card` **per chunk** — fzf does not save us there. Measured on 0.74:
   100 back-to-back `refresh-preview` POSTs ran a fast preview command **100 times**,
   zero coalescing. fzf collapses only refreshes arriving while a preview is still in
   flight; it bounds concurrency, not spawn rate.
3. **One final unthrottled refresh** after `end`/`aborted`/`error`, so the answer
   cannot be stranded behind the throttle or the cancelled heartbeat.

### The in-flight render

Because the provider buffers, this is the UX for most of the turn's life, so it is
specified rather than implied. `foldForDisplay` renders a `question` with no `end`,
`aborted` or `error` record as:

```
you
  why did this one fail?

gm
  thinking… 14s   (esc to cancel)
```

The elapsed count is `now - question.at`, computed at render time by
`__preview-card` — **not stored, not a field, not written by the heartbeat.** The
heartbeat's only job is to make the pane re-render; the pane does its own
arithmetic. That keeps the transcript free of a value that would be stale the
instant it was written.

The same slot renders `still answering… (esc to cancel)` when a *second* enter is
absorbed by the lock (below).

### Turn history — where the array lives

`repl()` holds `const turns: AskTurn[] = []` in a closure, and replays it every call
**because providers are one-shot**. This design deletes the long-lived process: each
turn is a fresh detached worker that exits when done. **There is no closure left.**

**The transcript file *is* the turn array.** Every worker rebuilds it at start:

```ts
export function foldCompletedTurns(
  events: readonly AskEvent[],
  options?: { maxTurns?: number },   // default 8
): AskTurn[];
```

**`buildAskPrompt` does not change.** It still takes `readonly AskTurn[]`. That is
the test that this design is right: the difference between an in-process REPL and a
fan of detached children is entirely *where the array is materialized*, and none of
it reaches the prompt builder.

The fold's rules, each a decision:

1. **Key by `seq`, not by file order.** Chunks are contiguous in practice (the lock
   guarantees one writer), but folding by position would make this function's
   correctness depend on a lock in another module. Folding by `seq` makes it depend
   on nothing.
2. **A turn enters history only with an `end` record.** In-flight, aborted and
   errored turns are excluded. A half-streamed answer promoted to history is shown to
   the model as *its own completed statement of fact*, and it will build on a sentence
   that stops mid-clause. "The answer so far" and "the conversation so far" are
   different things and must never be the same array.
3. **An aborted turn's question is dropped** — see *Smaller calls*.
4. **The in-flight turn is rendered but not replayed.** Two consumers, two folds over
   one log: `__preview-card` folds everything including partial chunks; the worker
   folds completed turns only. That is why the format is an event log.
5. **Replay is bounded at `maxTurns = 8`** — a plain slice of the most recent turns.
   Every turn re-sends every prior answer, so tokens grow quadratically and the 300s
   `ASK_TIMEOUT_MS` starts to bite right when the thread gets useful. That is the
   whole justification. (An earlier draft additionally `truncate()`d the surviving
   older answers rather than dropping turns whole, to stop a pronoun dangling. That
   is a second speculative decision stacked on the first; cut. A bare slice is the
   bound.) **Bounding at the fold, not in `buildAskPrompt`**, is deliberate:
   `buildAskPrompt` is shared with bare `gm ask`, which decision 5 says is unchanged.

**Read-your-writes:** `__ask-send` appends the `question` **then** spawns. The
`writeSync` + close before `spawn()` is what makes that a happens-before rather than
a hope. Spawn first and the worker races its own question.

### Lifecycle

**Creation is split.** The parent allocates the path and creates nothing — the path
must exist as a string before fzf starts, because it is baked into the preview
command. The first `__ask-send` creates the file as a side effect of
`openSync(path, "a")`.

**A missing file is the empty state**, and this is how the empty state falls out for
free, with no flag and no branch (below).

**The lock.** `<transcript>.lock`, `O_EXCL`, `{ pid, startedAt }` — the same shape and
the same `isLockStale` predicate as `auto-summarize.ts` (owner gone **or** too old).
Not redundant with fzf: `transform` returns immediately, so nothing stops you pressing
enter twice. Two workers interleaving chunks of different `seq`s is the one thing that
makes the fold ambiguous. With the lock, the second enter appends nothing and refreshes
a pane that already says `still answering… (esc to cancel)`. A key that visibly does
nothing for a stated reason is fine; a key that silently corrupts the thread is not.

**Cancellation must kill the process GROUP.** Verified, and this is where the prototype
actually broke — esc flipped back to browse mode *while the model kept running, kept
billing, and kept writing into the transcript*:

| Signal | Parent | Provider child |
|---|---|---|
| `kill -TERM PID` | dead | **ORPHANED, STILL ALIVE** |
| `kill -TERM -- -PID` | dead | dead |

`spawn(cmd, { detached: true, stdio: "ignore" })` makes the child a group leader
(verified `PID 7709, PGID 7709, PPID 1`), so `process.kill(-pid, "SIGTERM")` reaps the
tree, `SIGKILL` after a grace period.

**`setsid` does not exist on macOS** — gm's own platform. A shell-level `setsid`
binding would break for every Mac user. Node's `detached: true` is the portable
equivalent; it calls `setsid(2)`.

**Guard stale pidfiles against PID reuse** — store pid + start time and verify identity
before signalling. This is why liveness is ANDed with age, exactly as `isLockStale`
already does.

`__ask-cancel` kills the group, appends `{"t":"aborted","seq":n}`, removes the lock,
POSTs a refresh. **The canceller owns the `aborted` record, not the worker** — the
worker's SIGTERM handler aborts its signal and exits without writing. A wedged worker
therefore cannot leave the pane stuck on "answering".

**Cleanup on exit, and it is `pick.ts`'s job, not the picker's.** See *Layers* — this
is the one place an earlier draft contradicted its own central invariant. `PickOptions`
gains:

```ts
onClose?: () => Promise<void>;
```

`pickWithFzf` gets a `try/finally` around its `await` (it has none today) plus
SIGINT/SIGTERM/SIGHUP handlers, and all of them do exactly one thing: `await
onClose?.()`. **The picker still knows nothing about files, locks or pids.** `pick.ts`
builds `onClose` — it already owns the provider question (`askIsAvailable()`) and the
transcript path — and *it* removes the transcript, `.browseq` and `.lock`, and
best-effort kills the worker's group. The parent must kill the group because
accept/abort never run the esc binding. Normal exit already covers ctrl-c *inside* fzf
(fzf exits, the promise resolves, `finally` runs); the handlers cover the shell killing
`gm`.

**Orphans after `kill -9`.** `pick.ts` sweeps `askTranscriptDir()` before it calls
`pickSession` — again the parent, not the picker. Remove `<pid>-<rand>.jsonl` (and its
`.lock`, `.browseq`) when the pid is dead **or** the mtime is older than
`LOCK_STALE_MS` (10 min — the ask timeout is 5, so a live worker's file can never be 10
minutes idle). Wrapped in `try/catch` and never able to fail the picker: an orphaned
transcript is a few KB of disposable cache, so the cost of never reaping is nil and the
cost of a sweep that throws is a picker that will not open. **Never remove a file whose
pid is alive** — that is another pane. No cooldown file needed; the sweep is a `readdir`
of a directory with ~0–2 entries.

**It does not survive picker exit.** One thread per picker run, deliberately.
Persisting would create an expectation nothing else serves (resume which thread? shown
where? cleared how?), and would embed answers — which embed summaries — making retention
a real decision rather than a default. If it is ever wanted it gets its own spec and
lands under `configDir()`.

### `--listen` is an arbitrary-command-execution surface

Verified, not theorized. Against a plain `--listen` on 127.0.0.1 at 0.74:

```
POST execute-silent(touch pwned)  -> HTTP 200, file CREATED
POST reload(echo hacked)          -> HTTP 200, list replaced
GET  ?limit=3                     -> full JSON dump of the session list
```

The man page's *"to allow remote process execution, use `--listen-unsafe`"* governs
**non-localhost binds only**. The answer arriving with no keypress requires
`--listen`. So this is a must-fix.

| Mitigation | Result | Floor |
|---|---|---|
| `FZF_API_KEY` in fzf's env | unauthenticated POST and GET → HTTP 401 | **0.43.0** |
| unix socket (`--listen` a path) | socket created `srw-------`, owner-only | 0.66.0 |

(Changelog-verified: `FZF_API_KEY` is **0.43.0**, not the 0.39.0 an earlier draft
claimed.)

**Decision: `FZF_API_KEY`**, 32 random bytes from `/dev/urandom`, base64, minted per
picker run, **delivered by environment inheritance only** — fzf's env → `__ask-send` →
`__ask-run`. The socket is the better boundary but 0.66.0 is too high a floor.

**And the threat model must be stated honestly, because an earlier draft's did not
survive its own mitigation.** That draft passed the key *on the worker's argv*,
reasoning that the fzf command line was unsafe because "`ps` would show it". Measured:

```
$ ps -ww -o args= -p <worker>
/tmp/st/worker.sh --port 54132 --api-key DI+aQPstHKos3Yf4ReWk8EZ1DFz+ORkpiFnCeoHdeeE=
```

Argv is world-readable; another process's environment (`ps e`) requires the same uid.
**So argv was strictly worse than the env — the choice was backwards**, and it defeated
the exact attacker the mitigation names.

So, plainly:

- **`FZF_API_KEY` raises the bar against a different-user or non-local attacker.** It
  does that well, and it costs one env var.
- **It does not stop a same-uid local attacker**, who can read fzf's environment and POST
  as us. Against that attacker the only real boundary is the unix socket, and the 0.59
  floor does not reach 0.66. **This is a known, accepted limitation**, recorded here as a
  limitation rather than dressed up as a fix.
- **The key must never appear in an argv, a binding string, or the transcript's `meta`
  record.** `refreshRequest(port, apiKey)` reads nothing from the environment implicitly —
  the caller passes it — but the *caller* reads it from `process.env` at the call site and
  never logs it. Note the deliberate divergence from `--port "$FZF_PORT"`, which is
  appended to argv precisely because the port is not a secret. The key does not follow the
  port.

### Recursion guards

Both from the sibling spec, both now on a new path.

**The provider→grep guard holds unchanged.** `runProviderCommand` still defaults `env` to
`childEnv()`, and the worker calls it without an `env` override. The invariant to write
down and test: **the worker must not pass `env` to `runProviderCommand`**. A well-meant
`env: { ...process.env, FZF_PORT: port }` on that call would silently drop
`GIGAMANAGE_CHILD` and reopen the loop. Pass `FZF_PORT` on the worker's **argv**, and the
trap cannot be set. (The argv rule protects `GIGAMANAGE_CHILD` on the *provider* call. It
does not apply to the worker *spawn*, which sets its env deliberately — and which is where
`FZF_API_KEY` rides. Two different processes, two different rules.)

**Two new breaks, both real:**

1. **`main.ts`'s `postAction` exemption list is by NAME.**
   `runsItsOwn = new Set([AUTO_SUMMARIZE_COMMAND, PICKER_ROWS_COMMAND, "ls", "pick"])`.
   `__ask-send` inherits fzf's env, which inherited `gm pick`'s — so `GIGAMANAGE_CHILD` is
   **unset** and it is not in the set. **Every question you type would fire a background
   summarize decision from inside fzf**, whose `notify` writes to stderr, which fzf owns
   and is painting. The lock absorbs the spawn but not the decision and not the stderr
   write. **Fix, structurally:** `if (actionCommand.name().startsWith("__")) return;` —
   the same convention `shouldRunSetupWizard` already uses, so the next hidden command
   does not re-learn this. Bare `gm ask` is a non-`__` command and stays exactly as it is,
   per decision 5.
2. **The worker spawn sets its own env.** Mirror `spawnWorker`:
   `{ detached: true, stdio: "ignore", env: { ...childEnv(), GIGAMANAGE_AUTO_SUMMARIZE: "0", FZF_API_KEY: key } }`,
   then `unref()`. `childEnv()` not `process.env`, because the worker is a `gm` that is
   about to make a model call — it is the definition of a child.

**The `__` prefix is load-bearing a third time:** `shouldRunSetupWizard` bails on `__`
commands, so none of the four can block on a human prompt while fzf owns the terminal.

**`execArgv` must be forwarded twice.** picker.ts:167-174 already documents why once:
under `npm run dev` the entry is `src/cli/main.ts` and `execArgv` carries tsx's loader
flags; drop them and the command becomes `node src/cli/main.ts`, which Node 20 cannot run
— so the preview dies in development while working perfectly from `dist/`. The new one:
`__ask-send` **spawns a detached grandchild** and must re-forward its own
`process.execArgv` as `spawn(process.execPath, [...process.execArgv, entry, "__ask-run", …])`.
Because `__ask-send` was itself launched through `selfCommandHere()`, its `execArgv`
already carries tsx's flags, so this composes. Hardcode `"gm"` and every answer silently
never arrives in dev — with `stdio: "ignore"` swallowing the evidence and fzf repainting
over what is left.

### Errors

Non-negotiable #5: every error carries a `fix`. Three new failure modes: transcript
unreadable, refresh POST refused, provider died mid-answer. **The mid-answer case cannot
reach the terminal — fzf owns it.** So it lands in the transcript as an `error` event and
renders in the chat half, `fix` and all. `AskProviderError` already exists.

---

## The empty state

**No conversation yet ⇒ the card gets the full pane, exactly as today.** The chat half
appears only once you hit ctrl-o and send. Nothing regresses for people who never ask.

This needs no flag and no branch. A picker run where the user never presses ctrl-o **never
touches the disk**. `__preview-card --chat <path>` on ENOENT reads zero events,
`splitPreview(n, false)` gives the card all `n` rows, and the output is byte-identical to
`formatCard(view)`.

**ENOENT is a state, not an error.** Nor is a malformed file: `catch { return [] }` →
full-pane card. Same doctrine as `parseConfig` — a bad file is not an error.

---

## The version gate and fallbacks

**The floor is the max over every action and variable the bindings actually
use** — not over the ones that look expensive. Costed in full from the 0.74.0
changelog shipped in the local Homebrew install
(`/opt/homebrew/Cellar/fzf/0.74.0/CHANGELOG.md`):

| Mechanism | Since |
|---|---|
| `--listen` auto-port, `$FZF_PORT` | 0.39.0 |
| `FZF_API_KEY` | 0.43.0 |
| `transform` | 0.45.0 |
| `$FZF_QUERY` / `$FZF_PROMPT` to children | 0.46.0 |
| `--with-shell` | 0.51.0 |
| `change-header`, `change-prompt`, `refresh-preview`, `transform-query`, `enable-search`/`disable-search`, `unbind`/`rebind` | ≤ 0.46.0 |
| **`$FZF_INPUT_STATE`** | **0.59.0** |

The oracle is the whole cost. Everything else is at or below 0.46 — which is
why decision 5's original floor looked right and was wrong by 13 minor versions.

**Nothing anyone has today is taken away.**

```ts
export type AskTier = "split" | "execute" | "prompt" | "none";
export function askTier(input: {
  hasFzf: boolean; fzfVersion: number[] | null;
  askAvailable: boolean; selfCommand: string | null;
}): AskTier;
```

Two rows are new decisions:

| hasFzf | version | provider | self | tier | what ctrl-o does |
|---|---|---|---|---|---|
| yes | ≥ 0.59.0 | yes | set | `split` | the chat pane |
| yes | < 0.59.0 **or unreadable** | yes | set | `execute` | today's full-screen REPL |

**Every other input is today's behaviour, unchanged**, and `tests/ask-fallbacks.test.ts`
pins that: no provider or no self-command → `none` (key unbound, not advertised); no fzf →
`prompt` (the numbered list's `a`), or `none` with no provider.

Unreadable → `execute`, not `split`: degrading to an older UI is a worse UI; degrading to
`split` is a broken one.

`SPLIT_CHAT_FZF = [0, 59, 0]` is **its own constant**, not `supportsMultiline()`. Gating
the chat on multiline is *accidentally* safe today and becomes silently wrong the day
someone fixes `MULTILINE_FZF` to its true `[0,53,0]`. The comparator loop currently
inlined in `supportsMultiline` gets extracted:

```ts
export function atLeast(version: number[] | null, want: readonly number[]): boolean;
export function supportsMultiline(v: number[] | null): boolean;   // atLeast(v, MULTILINE_FZF)
export function supportsSplitChat(v: number[] | null): boolean;   // atLeast(v, SPLIT_CHAT_FZF)
```

**A half-bound ask mode must never ship.** `askTurnCommand()` and `askCancelCommand()` take
the same null-guard as `reloadCommand()`, and if either is null `fzfArgs` falls back to the
whole browse-only arg set. Enter that sends into the void and esc that cannot get you out is
strictly worse than the current REPL.

**A stray 0.59 flag in the `execute` tier does not degrade — it deletes the picker.**
Unknown flags make fzf exit non-zero at startup, for precisely the users the fallback exists
to protect, and only for them. Nobody developing on a current fzf would ever see it. Hence
the test below, and hence its PR lands *before* the chat's.

### `fzfArgs` becomes an options object

`fzfArgs(multiline, preview, reloadCmd, askCmd)` is already four positionals and this adds
tier, port, transcript, send and cancel. Eight positionals is unreadable and every call site
becomes `fzfArgs(true, "p", null, null, "split", 1234, "/tmp/x", …)`.

```ts
/** Everything the chat tier needs, as opaque strings the picker never interprets. */
export interface ChatSpec {
  /** Baked into the preview command and the send/cancel commands. Never opened here. */
  transcript: string;
  /** Full shell command for `enter` in ask mode, minus the appended --port. */
  sendCmd: string;
  /** Full shell command for `esc` in ask mode, minus the appended --port. */
  cancelCmd: string;
}

export interface FzfSpec {
  multiline: boolean;
  preview: string;
  reloadCmd: string | null;
  askCmd: string | null;      // the execute() fallback
  tier: AskTier;
  chat?: ChatSpec;            // required iff tier === "split"
}
export function fzfArgs(spec: FzfSpec): string[];
```

**No `listenPort`.** fzf assigns the port itself (`--listen` with no argument) and exports
`$FZF_PORT` to children; nothing in gm needs to know it. An earlier draft had the field and
a `start` binding that wrote the port to a file nobody read.

This breaks 11 test call sites. That is the largest mechanical cost in the change, it is
worth paying once, and it lands in its own PR (below).

---

## Landing order

The spec is one feature but it is not one reviewable diff. CONTRIBUTING says *"one concern
per PR"*, and several pieces here are prerequisites whose value does not depend on the chat
pane shipping at all. Five PRs, each with its own observable claim. **This is a review-size
call, not one of the six decisions** — decision 6 is about scope, and the scope cuts are
already made above.

1. **Provider plumbing.** The `StringDecoder` UTF-8 fix + `onChunk`/`signal` on
   `runProviderCommand`. Existing callers byte-for-byte unchanged; the test is
   `resolved === chunks.join("")`. Fixes a live bug on its own merits.
2. **Hygiene.** `XDG_CACHE_HOME` in `tests/setup.ts`; `filterArgs(options: LsOptions)`
   extracted from pick.ts:52-58 and pick.ts:70-76; `atLeast()` extracted from
   `supportsMultiline`. No behaviour change.
3. **The gate.** `fzfArgs(spec: FzfSpec)` + `askTier` + `tests/ask-fallbacks.test.ts`.
   **This lands before the chat**, and that is the point: the ladder's test should exist
   before the code that can leak a 0.59 flag into it.
4. **The thread, headless.** `AskEvent`, `askTranscriptDir/Path`, `services/ask-transcript.ts`
   (append/parse/fold/lock/sweep), `__ask-send`/`__ask-run`/`__ask-cancel`, the `postAction`
   `__` guard, and the AGENTS.md + `paths.ts` amendment. No fzf, no rendering — driveable
   entirely from the CLI with the fake-binary seam.
5. **The pane.** `splitPreview`/`formatChat`/`formatPreview`, `__preview-card`, the bindings,
   `--with-shell`, `--listen` + `FZF_API_KEY`, the `env`-stripped fzf spawn, `onClose`.
   **Only this PR changes what ctrl-o does.**

---

## Rejected alternatives

**A tmux split pane.** Rejected: it makes the feature conditional on a multiplexer. gm's
picker works in a bare terminal, over ssh, inside another harness's shell. A chat that only
exists under tmux is a chat most users never see, and the fallback would have to be built
anyway — so we'd own both.

**The chat takes over the whole preview pane.** Rejected: then ctrl-o still takes the session
away, just at 55% width instead of 100%. The card is *the reason you asked*. "Why did this
fail?" is unanswerable to a human who can no longer see what failed. (The one exception is the
collapse regime under 15 rows, where you genuinely cannot have both — and there the card keeps
its identity strip, so "this" still has a referent.)

**A thread per session.** Rejected: it makes the cursor destructive. Arrow down mid-answer and
your conversation is gone — or worse, silently swapped for a different one, so the next answer
is a non-sequitur. It also multiplies state (N transcripts, N locks, N sweeps) to buy an
isolation nobody asked for. One thread, re-pointed, is what people actually do: "why did this
fail?" … "what about this one?"

**Pinned focus** (the thread locks to the session you were on at ctrl-o). Rejected: it makes
"this one" mean the session you *were* looking at, which is the exact ambiguity the feature
exists to remove. The whole point of keeping the list on screen is that the cursor is the
deixis. Pinning would also cost state — `{1}` gives us live focus for free.

**A spinner instead of streaming.** Rejected as the *goal*; measurement then made a
thinking indicator the floor. `claude -p` buffers, so there is no stream to show for the
first ~9–20s no matter what we build. The distinction that matters, and the reason
`thinking… 14s` is still not "a spinner": the picker stays live the entire time, the pane
keeps the card you were reading, esc cancels, and the answer arrives without a keypress.
What was rejected was a spinner *instead of* those.

**`--output-format stream-json` for real token streaming.** Rejected: it is a vendor
envelope, and non-negotiable #7 forbids parsing one — and it is Claude-only, so Codex, which
gm supports today, would get nothing. Streaming for one provider at the cost of the provider
abstraction is not a trade this tool makes.

**`$FZF_PROMPT` as the mode oracle** (which would have bought a 0.46 floor). Rejected: it
couples control flow to a cosmetic string. The mode becomes "whatever the prompt says", so a
future prompt tweak silently breaks `enter` — and `enter` breaking silently means resuming a
session when you meant to send. It does work (verified on 0.74: `change-prompt` does update
`$FZF_PROMPT`); it is simply not worth what it costs.

**Rewriting `formatCard` to shrink-not-clip.** Rejected as scope — see *Height math*. The card
was already clipped before the split existed.

**A colour contract for the preview.** Rejected as scope — see *Colour*. The pane has been
monochrome since it shipped.

**`ctrl-g` to zoom the chat.** Rejected — see *Scrolling*. `ctrl-g` is one of fzf's four
default quit keys.

---

## Layers

```
core      AskEvent; askTranscriptDir/askTranscriptPath; AskProvider.ask(…, onChunk?)
adapters  (untouched)
services  onChunk/signal on runProviderCommand; ask-transcript (read/append/fold/lock/sweep);
          fzf-listen (refreshRequest, shouldRefresh, streamAnswer)
cli       formatChat/formatPreview/splitPreview; __preview-card; __ask-send/__ask-run/
          __ask-cancel; the picker bindings
```

**No rightward imports.** `scripts/check-layers.mjs` enforces this for static import
specifiers — `LAYERS = ["core", "adapters", "services", "cli"]` and the violation is
`targetLayer > fileLayer`. Note what that does *not* catch: co-location conventions.

`AskEvent` belongs in `core/types.ts` for two reasons, and **"any other home is a red build"
is not one of them** — an earlier draft said so and it is simply false: `AskEvent` in
`services/ask-transcript.ts` read by `cli/show.ts` is `cli → services`, which is *leftward*
and passes the checker silently. The real reasons are stronger:

1. **`AskTurn` is already at core/types.ts:171, and `AskEvent` is the thing it folds from.**
   They belong together.
2. **AGENTS.md's layout table says `src/core/` is "Types, errors, pure helpers. No I/O".** A
   pure discriminated union with no I/O has exactly one home.

That is a convention the checker will not enforce for you, which is the same over-trust this
spec warns about next.

**The picker keeps knowing nothing about providers.** picker.ts:126-132 records that
invariant, and it is *not* mechanically enforced — picker.ts is `cli`, so
`import { defaultAskProvider }` would pass the checker silently. It holds today only because
picker.ts imports exactly five modules (`node:child_process`, `node:readline/promises`,
`../core/text.js`, `../core/types.js`, `./format.js`) and none is a service.

**This design is very tempting here**, and an earlier draft gave in without noticing:
*Lifecycle* had `pickWithFzf` itself `rm` the transcript and lock and kill the worker's group,
while *Layers* claimed on the same page that "picker.ts's import list is unchanged". Both
cannot be true — `rm` needs `node:fs`, deriving `<transcript>.lock` needs the lock naming
convention, and killing the group needs `isLockStale`'s `{ pid, startedAt }` shape out of
`services/auto-summarize.ts`.

Preserve it the way `askArgs` already does — **opaque strings in, shell commands out**.
`PickOptions` gains `chat?: ChatSpec` and `onClose?: () => Promise<void>`, both built by
`pick.ts`, which already owns the provider question (`askIsAvailable()`) — exactly the way
`ask`, `reload` and `resolve` are already callbacks for this reason. `previewCommand(transcript?)`
interpolates a string it was handed; it does not know a transcript is a file, where it lives, or
that a provider exists. **The picker never reads or writes it, and picker.ts's import list is
unchanged** — now true rather than aspirational. The orphan sweep runs in `pick.ts` before
`pickSession` is called. Extend the comment at 126-132 to say the same of the fzf path.

**Also required, and currently missing:** `tests/setup.ts` sets `XDG_CONFIG_HOME` but **not
`XDG_CACHE_HOME`** (confirmed — it sets exactly one). `cacheDir()` honours `XDG_CACHE_HOME`, so
the first ask-transcript test would write to the developer's real `~/.cache/gigamanage`.
Non-optional — this is exactly the class of bug setup.ts's own header describes.

**DRY, before the third copy:** pick.ts:52-58 and pick.ts:70-76 are already byte-identical
filter blocks. `pickerAskTurnArgs` would be a third. Extract `filterArgs(options: LsOptions): string[]`
— a filter that drifts in one of three copies is exactly the silent-wrong-window bug pick.ts:35-42
exists to warn about. Lands in PR 2, ahead of the chat.

---

## Testing

Every decision above gets a named pure function, for the same reason `fzfArgs` is already split
from the spawn. **This repo has zero mocks** (`grep vi.mock tests/` → nothing) and does not grow
one here.

### New pure units

```ts
atLeast(version, want): boolean              // extracted from supportsMultiline
askTier(input): AskTier                      // the two new rows as a truth table
enterAskActions(spec): string                // the ctrl-o transform body
exitAskActions(spec): string                 // the esc transform body
chatBindings(spec: ChatSpec): string[]
splitPreview(paneRows: number, hasChat: boolean): PreviewSplit
parseTranscript(text: string): AskTranscript
foldCompletedTurns(events, { maxTurns }): AskTurn[]
formatChat(t: AskTranscript, rows: number, width: number, now: Date): string
formatPreview(view, t: AskTranscript | null, split: PreviewSplit, width: number): string
refreshRequest(port: number, apiKey: string): RefreshRequest
shouldRefresh(state: RefreshState, now: number): boolean
askChildSpawnOptions(): SpawnOptions
```

Supporting types, defined rather than named — an earlier draft left all of these as bare
identifiers, including the one carrying two starred tests:

```ts
/** Row budget for one render. Sums to paneRows. */
export interface PreviewSplit { cardRows: number; dividerRows: 0 | 1; chatRows: number }

/** A parsed transcript. `torn` is true if the final line failed to parse — normal, not an error. */
export interface AskTranscript { events: AskEvent[]; torn: boolean }

/** A refresh POST as data, so the policy is testable without a socket. */
export interface RefreshRequest {
  url: string; method: "POST"; headers: Record<string, string>; body: "refresh-preview";
}

/** Throttle state. `lastAt` is null before the first refresh; `final` bypasses the interval. */
export interface RefreshState { lastAt: number | null; pending: boolean; final: boolean }

/**
 * Runs one turn: calls the provider, appends chunks to the transcript, notifies fzf.
 * The write-then-notify order is the invariant; `notify` is injected so the policy is
 * testable without a port, mirroring `spawnWorker`.
 */
export function streamAnswer(options: {
  argv: readonly string[]; prompt: string; transcriptFd: number; seq: number;
  notify: () => void; signal: AbortSignal; timeoutMs: number;
}): Promise<void>;
```

`apiKey` is **required**, not optional. An optional key is an unauthenticated POST path that
typechecks — exactly the configuration measured above as `HTTP 200, file CREATED`.

`enter`/`exit` are split **specifically so one test can assert they are inverses**: for every
stateful action in `enter`, `exit` contains its undo. Two independent
`askModeBindings()`/`browseModeBindings()` functions cannot be tested for that, and the bug they
invite is asymmetry — ask fires `disable-search`, browse forgets `enable-search`, and the filter
is dead with no error anywhere. The `PAIRS` constant carries
`disable-search`/`enable-search`, `unbind(ctrl-r)`/`rebind(ctrl-r)`, and both `change-prompt` and
`change-header` directions.

### The tests that decide whether this is right

```
✓ ★ formatPreview(view, null, splitPreview(40,false), 80) === formatCard(view)
     — the empty state, byte for byte. Not "contains the card". Identical.
✓ ★ enter and exit are inverses            — table-driven over PAIRS
✓ ★ every binding body executes correctly under `sh`, not just bash
     — spawn `/bin/sh -c <body>` with FZF_INPUT_STATE set; assert the emitted actions.
       `[[ ]]` under dash is a dead ctrl-o; under csh it is a dead ENTER. Also assert
       `--with-shell` is present in the split tier.
✓ ★ the oracle is ternary — enabled | disabled | hidden
     — all three documented values (man fzf:1462) through ctrl-o, enter and esc.
       `hidden` must behave as browse in all three.
✓ ★ parseTranscript tolerates a torn final line
     — the writer is appending as we read. A half-written line is NORMAL.
✓ ★ streamAnswer appends to the transcript BEFORE notifying
     — assert the file's byte length at notify time. Notify-then-write renders the
       previous chunk, forever one behind.
✓ ★ runProviderCommand still resolves the whole buffered output with onChunk set
     — resolved === chunks.join(""). The summarize path must not change.
✓ ★ formatPreview renders with a FakeAskProvider recording ZERO asks
     — the hard correctness constraint, as an assertion.
✓ ★ the execute tier leaks no 0.59 flag
     — not.toContain("--listen"|"disable-search"|"--chat"|"$FZF_INPUT_STATE"). This is the
       one that catches a real regression: it deletes the picker for exactly the users the
       fallback protects, and only for them.
✓   foldCompletedTurns bounds replay at maxTurns (default 8)
✓   the `re:` suffix appears on question 1 and on every focus change, and nowhere else
✓   a chunk split mid-multibyte-character is not mangled
✓   splitPreview(0,true) and (-1,true) don't throw or go negative; the divider at width
     0 and 1 doesn't throw          — both are strings from the environment. Hostile.
✓   never binds a plain letter, in all four tiers   — /--bind=[A-Za-z]:/
✓   the fzf spawn's env has no FZF_DEFAULT_OPTS / FZF_DEFAULT_OPTS_FILE
✓   no argv anywhere contains the api key; `meta.provider` records argv only
✓   the transcript is not under configDir(); pick.ts's onClose deletes it on exit
```

### The seams — no fzf, no model, no port

| Real thing | Faked as | Seam |
|---|---|---|
| the model | `node -e` printing on a timer | `runProviderCommand`'s **argv** |
| the listen port (policy) | injected `notify` callback | `streamAnswer`'s options — mirrors `spawnWorker` |
| the listen port (bytes) | a real `http` server on **port 0** | one integration test, production notifier |
| fzf itself | nothing — `fzfArgs` is data | already split from the spawn |
| the login shell | `/bin/sh -c` and `/bin/dash -c` on the binding bodies | the bodies are strings |
| the detached fork | injected spawner + pure `askChildSpawnOptions()` | mirrors `maybeAutoSummarize` |
| the terminal | `FZF_PREVIEW_LINES` as a **parameter** | `splitPreview` / `__preview-card`'s signature |
| the clock | `now` as a **parameter** | `formatChat(t, rows, width, now)` — the `thinking… 14s` count |
| the transcript | a real file in a temp dir | `askTranscriptPath()` under a redirected `XDG_CACHE_HOME` |

A fake *binary* — `node -e` that prints chunks on a timer — is **not** a violation of
non-negotiable #2: no model, no network, no money, deterministic. It is the only way to get
honest coverage of the things that actually break (chunk boundaries, a timeout racing a live
stream). Siblings: `hangingProviderArgv()`, `exitsNonZeroArgv(stderr)`,
`writesUtf8SplitAcrossChunksArgv()`, `buffersThenDumpsArgv()` — the last one models the measured
`claude -p`.

The injected `notify` proves the *policy* and nothing about the *bytes*, so exactly one test
opens a socket: a `node:http` server on **port 0** (kernel-assigned — no collision, no fixed port
in CI), asserting method, path, body and the `x-api-key` header's presence, plus that a closed
port is a swallowed error rather than a throw. That is what fzf exiting mid-answer actually looks
like.

Do not spawn a detached child in a test. Follow `spawnWorker`: assert the *decision* (`detached`,
`stdio: "ignore"`, `childEnv()`, `unref`) as data.

### `tests/ask-fallbacks.test.ts` — new, and it lands in PR 3

Nothing pins the fallback ladder today. The closest existing test covers one cell of a four-cell
matrix; nothing asserts that an old fzf still gets `execute`, that no-fzf still gets `a`, or that
bare `gm ask` is untouched. That gap is precisely why decision 5 is a decision. The file's header
says what it is for: *these are not tests of the new feature — they are tests that the new feature
is invisible to everyone who cannot use it.*

Add to AGENTS.md's easy-to-get-wrong list:

> **The preview command re-runs on every keystroke and must never call a model.**
> **fzf runs child commands with `$SHELL -c`, not `sh -c`.** Every binding body must be POSIX,
> and `--with-shell 'sh -c'` must stay on the arg list. A bash-ism in a transform is a dead key
> under dash and a dead *enter* under csh, with no error anywhere.
> **fzf's fallback ladder is load-bearing, not politeness.** `ctrl-o` has four tiers (`askTier`);
> the bottom three are what shipped before the split chat. An fzf flag leaked into a tier that
> doesn't understand it doesn't degrade — fzf exits and the picker is gone.

### What no unit test covers

Whether fzf *accepts* the binding strings (a typo in an action name is **silently ignored** — the
pure test asserts the string, not that fzf understood it); whether the pane visibly reflows;
whether the picker stays responsive during a real 20s think; whether esc-cancel feels instant;
terminal-specific ctrl-o interception. Those need the manual script, and its results go in the PR
body — CONTRIBUTING asks for observed behaviour, not description. The blocks that decide whether
this ships:

- **the picker still moves while an answer is in flight** (arrow for 5s at t+2s)
- **the `thinking… Ns` count ticks** and the answer lands without a keypress
- **`enter` sends in ask mode and never resumes** (a misfire is data loss)
- **esc restores the filter** (type `web`, the list must filter again)
- **ctrl-r is inert in ask mode and live again after esc**
- **the empty state is byte-identical to today**
- **`SHELL=/bin/dash gm pick` and `SHELL=/bin/tcsh gm pick`**: ctrl-o enters ask mode, enter
  resumes in browse mode. This is the one an earlier draft would have shipped broken.
- **fzf 0.58 gets the old REPL, and the terminal survives it**
- **`npm run dev -- pick` works** (the `execArgv` trap, twice)
- **`ps aux | grep -c "[c]laude"` is 0 after esc** (the process-group kill)

---

## What this is not

- **Not fzf bundling.** The 0.59 floor widens the fallback population; whether to bundle, and how,
  is a separate spec. Nothing here depends on it, and nothing here is taken away without it — the
  `execute` REPL and the `a` key are exactly what shipped.
- **Not a persistent chat.** The thread dies with the picker run. Persistence needs a retention
  policy and a `configDir()` home; its own spec.
- **Not a vendor integration.** `onChunk` gets raw stdout bytes and nothing more. No
  `--output-format stream-json`, no envelope parsing, no SDK. **Measured: `claude -p` buffers, so
  the answer lands in one paint after a `thinking… Ns` count.** That is the accepted cost of
  non-negotiable #7, stated plainly and decided.
- **Not word-by-word streaming.** There is no stream. See decision 3.
- **Not a change to `gm ask`.** Bare `gm ask`, `gm ask "q"` and `gm ask "q" --json` are untouched,
  per decision 5. `buildAskPrompt` is untouched. The replay bound lives in the fold precisely to
  keep that true.
- **Not a change to `gm show`.** The preview is `__preview-card`, a hidden command. `gm show`'s
  flags, output and `--json` schema are exactly as they are today.
- **Not a rewrite of `formatCard`.** The card clips at the divider as it already clips at the pane
  bottom. Pre-existing, out of scope.
- **Not a colour change.** The preview pane is monochrome today and stays monochrome.
- **Not a fix for `MULTILINE_FZF = [0,46,0]`.** It is wrong (0.53.0 is the real answer) and it is
  pre-existing. The chat gate is given its own constant so the eventual fix cannot silently change
  what ctrl-o does.
- **Not a second preview pane.** fzf has one. gm renders both halves into it and owns the split.
  `change-preview-window` is never called — which is also why there is no reflow and therefore no
  flicker.
