# Picker refresh and tighter headlines

**Date:** 2026-07-16
**Status:** approved, not yet implemented

## The problem

The picker is a dead end. `gm` loads a list, hands it to fzf, and that list is
frozen until you quit and re-run. Sessions you started since don't appear.
Summaries that landed while you were reading don't show up. Rows marked `○` stay
`○` forever, because `gm pick` never kicks off a summarize pass at all — only
`gm ls` does.

That fights what gigamanage is for. It's a light browser over the harnesses; you
should be able to sit in it and navigate, not treat it as a one-shot query.

Separately, the one-liner each row shows is looser than the column it lives in.
The prompt asks for "max 80 chars" while `formatRow` truncates at 72, so the
model is explicitly invited to overflow.

## What we're building

`ctrl-r` in the picker: reload to the most recent sessions and kick off
summarization over them. Plus the two things that make it worth having — a
picker that summarizes on open, and headlines short enough to read at a glance.

## 1. Tighter headlines

### The change

`buildPrompt` in `src/services/distill.ts` asks for:

```
"headline": "one line, max 80 chars: the state this work is in NOW"
```

Replace with a request for a scannable clause of roughly 60 characters, no
trailing period, plus one good and one bad example. A bare length bound tends to
produce a full sentence that gets trimmed; an example shows the shape we want.

60, not 72, leaves the column room to breathe. 72 is where truncation bites, and
a headline that lands exactly on the limit reads as cut off even when it isn't.

### Why a prompt version is required

A summary's cache key is `distill(record).hash`, which covers session content
only — the prompt is not part of it. `isStale` compares that hash and nothing
else. So editing the prompt changes nothing for any session already summarized:
those rows keep their long headlines until their transcripts happen to change,
which for a finished session is never.

Add a `PROMPT_VERSION` constant in `src/services/distill.ts` and fold it into
the hashed object:

```ts
export const PROMPT_VERSION = 2;

export function distill(record: SessionRecord): SummaryInput {
  const input = { promptVersion: PROMPT_VERSION, harness: record.harness, ... };
  return { ...input, hash: hash(JSON.stringify(input)) };
}
```

Bumping the constant marks every cached summary stale at once. They regenerate
through the background path that already exists — no cache wipe, no migration
step, and every future prompt edit gets the same lever.

`SummaryInput` gains a `promptVersion: number` field in `src/core/types.ts`.

### The rollout cost

The first run after this ships re-summarizes recent sessions. That is real token
spend, and it is the point: without it the change is invisible. It is bounded by
the existing `MAX_PER_PASS = 50` per pass, runs in the background, and the
foreground never waits on it. `GIGAMANAGE_AUTO_SUMMARIZE=0` still opts out
entirely.

## 2. ctrl-r in the picker

### The hidden rows command

fzf's `reload(cmd)` replaces its item list with the command's stdout. So the
reload target is a command that prints exactly what `buildFzfRecords` already
builds.

Add `src/cli/commands/picker-rows.ts`, registering a hidden `gm __picker-rows`
alongside the existing hidden `__auto-summarize`:

- Takes the same filter flags as `pick` (`--harness`, `-p`, `-b`, `-s`, `-n`,
  `--include-sidechains`, `--include-automated`).
- Loads views via `loadViews(toFilters(options, 50))` — the same call `pick`
  makes, so a reload can never disagree with the initial list.
- Calls `maybeAutoSummarize({ records, force: true })`, notifying nothing: fzf
  owns the terminal and a stderr write would corrupt the display.
- Writes `buildFzfRecords(views, multiline, listWidth(), now, inProgress)` to
  stdout.

It is hidden for the same reason `__auto-summarize` is: not a thing a person
runs.

### Terminal width inside the reload

The child's stdout is a pipe, so `process.stdout.columns` is undefined and
`terminalWidth()` returns its 100-column default. Rows would reflow to a
different width on refresh than on open.

The reload command therefore passes the parent's measured `listWidth()` as
`--width <n>`, resolved when the binding string is built — inside fzf, where the
real terminal width is known.

### Wiring fzf

In `pickWithFzf` (`src/cli/picker.ts`):

```
--bind=ctrl-r:reload(<command>)
--header=enter: resume   ctrl-r: refresh   ctrl-c: cancel
```

The command must re-invoke *this* build, not whatever `gm` is on PATH — during
development there may be no `gm` on PATH at all, and the reload would silently
empty the list. `previewCommand()` already solves this by spawning
`process.execPath process.argv[1]`; factor that into a shared `selfCommand()`
helper and build both on top of it.

`reload` honors `--read0`, so multi-line records survive a refresh. On an fzf
older than 0.46 the picker is already in single-line mode and reload behaves the
same way; `reload` itself predates 0.46, so no version gate is needed.

### Rendering the ◐ marker

`buildFzfRecords` doesn't take an `inProgress` set today, so picker rows never
render `◐` — every un-summarized row shows `○` regardless of what's running.
Without fixing this, ctrl-r kicks off a pass with no visible sign it did
anything.

Give it an `inProgress: InProgress = NONE` parameter, threaded to `formatRow` /
`formatRowLines`, which both already accept one. Both `pick` and `__picker-rows`
pass `new Set([...await inProgressIds(), ...started.targetIds])` — the same
union `ls.ts` builds at line 83.

### Reconstructing the flags

`pick` serializes its own options back to argv:

```ts
export function pickerReloadArgs(options: LsOptions, width: number): string[]
```

Pure, and therefore testable without spawning anything. Values are
shell-quoted — a project name with a space in it would otherwise break the
binding. `resume.ts` has a `shellQuote` that does exactly this; move it to
`core/text.ts` and share it rather than writing a second one.

## 3. Summarization on ctrl-r and on open

### force

`MaybeAutoSummarizeOptions` gains `force?: boolean`. When true, `decide` skips
the `inCooldown` check. It skips nothing else.

The lock still holds. Hammering ctrl-r cannot start a second worker: the second
press finds a live lock, returns `locked`, and reloads rows that are already
marked `◐`. The feedback-loop guard in `autoSummarizeCandidates` is untouched.

Target selection is untouched too. `selectAutoSummarizeTargets` already skips
any session whose summary matches its current content hash, so ctrl-r on an
already-summarized list costs a few cache reads and does nothing else. This is
what makes the key safe to lean on.

The cooldown exists so a repeated `gm ls` costs nothing — it guards against
*incidental* re-decisions. A keypress is not incidental. Honoring it would make
ctrl-r a silent no-op for the first minute after opening the picker, which reads
as broken.

### pick summarizes on open

`pick.ts` calls `maybeAutoSummarize` before `pickSession`, mirroring `ls.ts:76`,
over the ~50 records it is about to show.

`pick` gets a pass today via the `postAction` hook in `main.ts`, but that hook
fires after the action returns — and the action ends in `resumeSession`, which
spawns your harness with `stdio: "inherit"` and waits. So the pass runs when you
finally quit Claude Code, against the default 20-session window rather than the
50 you were just looking at. Extend the hook's existing `ls` exemption to `pick`.

Its notice goes to stderr, which fzf does not capture, so it prints to the
terminal before the picker paints.

## 4. Without fzf

`pickWithPrompt` is a numbered readline prompt; ctrl-r isn't interceptable
there. Refresh is spelled `r` — the way a readline prompt can express it.

Wrap the existing question in a loop: `r` re-loads views and re-prints; a valid
number selects; anything else cancels as it does now. The prompt text advertises
it:

```
resume which? [number, r to refresh, or blank to cancel]
```

Reloading needs a callback, since this path has no subprocess to shell out to.
`pickSession` grows an options argument:

```ts
export interface PickOptions {
  /** Re-load views for the no-fzf path. */
  reload?: () => Promise<SessionView[]>;
  /** argv tail reproducing this filter set, for fzf's reload binding. */
  reloadArgs?: readonly string[];
  inProgress?: InProgress;
}
```

Both are optional: `pickSession(views)` keeps working, refresh simply absent.

## 5. Testing

Pure functions carry the tests, matching how `buildFzfRecords` and
`supportsMultiline` are covered today. No test spawns fzf or calls a model.

| Test | Pins |
|---|---|
| `pickerReloadArgs` round-trips filters through `toFilters` | A refresh can't silently widen or narrow the list |
| `pickerReloadArgs` quotes a project name with a space | The binding survives real-world paths |
| `buildFzfRecords` renders `◐` for ids in `inProgress` | ctrl-r visibly did something |
| `maybeAutoSummarize({ force: true })` spawns while in cooldown | The key isn't a no-op for its first minute |
| `maybeAutoSummarize({ force: true })` returns `locked` under a live lock | Hammering ctrl-r can't stampede |
| `distill` hash changes when `PROMPT_VERSION` changes | Existing summaries actually regenerate |
| `autoSummarizeCandidates` still excludes automated + sidechain | The feedback-loop guard survives the refactor |

The fzf binding itself is not unit-testable. Verify by driving the real picker:
open `gm`, press ctrl-r, confirm rows reload, `◐` appears, and a second press
doesn't start a second worker.

`scripts/check-layers.mjs` must stay green. Everything new lives in `cli`
(which may import anything) or extends `services`/`core` in place, so the
`core ← adapters ← services ← cli` rule is unaffected. Moving `shellQuote` from
`cli/commands/resume.ts` to `core/text.ts` moves it leftward, which is legal.

## Files

| File | Change |
|---|---|
| `src/core/types.ts` | `SummaryInput.promptVersion` |
| `src/core/text.ts` | `shellQuote`, moved from `resume.ts` |
| `src/services/distill.ts` | `PROMPT_VERSION`, folded into the hash; tightened headline prompt |
| `src/services/auto-summarize.ts` | `force?: boolean` on `MaybeAutoSummarizeOptions` |
| `src/cli/picker.ts` | `selfCommand()`, ctrl-r binding, `inProgress` on `buildFzfRecords`, `r` in the prompt fallback, `PickOptions` |
| `src/cli/commands/picker-rows.ts` | New: hidden `__picker-rows` |
| `src/cli/commands/pick.ts` | Summarize on open; `pickerReloadArgs` |
| `src/cli/commands/resume.ts` | Import `shellQuote` from core |
| `src/cli/main.ts` | Register `__picker-rows`; exempt `pick` from the postAction hook |
| `README.md` | ctrl-r in the picker section |
| `CHANGELOG.md` | Entry |

## Out of scope

- Auto-refresh on a timer. A key you press is predictable; a list that reshuffles
  while you read it is not.
- Refreshing the preview pane. fzf re-runs the preview command on every move
  already, so it is never stale.
- Forcing regeneration of summaries that are already current. Rejected: the
  transcript didn't change, so neither would the summary — it would spend tokens
  to rewrite identical text.
