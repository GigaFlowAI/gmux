# An icon key for the picker

**Date:** 2026-07-16
**Status:** approved, not yet implemented

## The problem

`gm ls` renders `⚠`, `◐` and `○` on its rows and prints a key underneath
explaining them. The picker — bare `gm`, the command this whole tool exists to
serve — renders the same three markers and explains nothing.

So the markers are legible exactly where you are least likely to need them. `gm
ls` is the command you run when you want a list to read; the picker is the
command you run when you want to *choose*, and choosing is when "what does `⚠`
mean" actually matters. The `⚠` flag is the tool's headline feature — sessions
that died mid-task are usually the ones you're hunting — and in the picker it's
an unexplained glyph.

## Why the `ls` key can't just be dropped in

`formatLegend` is dynamic in two ways: it counts rows (`no summary yet (7)`) and
it omits markers that don't appear in the list.

Both are fine for `ls`, which prints once and exits. Neither survives the
picker. fzf's `--header` is set once, at spawn — `--bind=ctrl-r:reload(...)`
replaces the *item list only*, and leaves the header alone. So counts baked into
the header freeze at open and are wrong after the first refresh, and a key that
lists "only the markers present" goes wrong the same way the moment a refresh
introduces a marker that wasn't there before.

ctrl-r is precisely when those numbers change. A key that is stale exactly when
it matters is worse than no key: absent, you go look; wrong, you don't.

## What we're building

A static key — all three markers, always, no counts — shown by both picker
paths.

```
enter: resume   ctrl-r: refresh   ctrl-c: cancel
⚠ ended mid-task   ◐ summarizing now   ○ no summary yet
```

Static is not a compromise here. Nothing in it can drift out of date, so ctrl-r
stops being a correctness question. The cost is one header line on a fully
summarized list where `○` and `◐` don't appear — cheap, and the price of a key
that is never wrong.

`gm ls` keeps its counted, present-only legend unchanged. The asymmetry is
deliberate: `ls` is a snapshot, so its counts are true by construction; the
picker is live, so it gets the thing that cannot lie.

## 1. One source of truth for the markers

### The change

`format.ts` currently spells out each marker's icon, colour and wording twice —
once in `rowPrefix` (which renders them) and once inline in `formatLegend`
(which explains them). Adding the picker's key would make a third copy, and
three copies of "◐ means summarizing now" drift.

Add a table, ordered as `formatLegend` already orders them:

```ts
const MARKERS = [
  { icon: MID_TASK, color: yellow, label: "ended mid-task" },
  { icon: IN_PROGRESS, color: green, label: "summarizing now" },
  { icon: NO_SUMMARY, color: cyan, label: "no summary yet" },
] as const;
```

Both key functions read from it. `formatLegend` appends its counts to
`label`; `formatMarkerKey` doesn't.

### New export

```ts
/** The static key: every marker, no counts. For live displays. */
export function formatMarkerKey(): string;
```

## 2. The fzf path

`fzfArgs` gains the key as a second `--header` line. The existing keybinding
line is untouched, including its rule that ctrl-r is only advertised when it is
actually bound.

fzf renders `\n` in a header as multiple lines, and per `man fzf` on `--header`,
"ANSI color codes are processed even when --ansi is not set" — so the colours
survive and do not depend on the `--ansi` we already pass.

## 3. The no-fzf fallback

`pickWithPrompt` writes the key between the rows and the "install fzf" hint. It
sits inside the `r` loop and so re-renders with the list.

It shows the same static key as the fzf path rather than the counted legend it
could accurately afford, because "the picker's key" should be one thing whether
or not fzf is installed. Two formats that differ by what happens to be on your
PATH is a distinction with no meaning to the person reading it.

## Testing

- `formatMarkerKey` names all three icons and labels, carries no digits, and is
  plain under `NO_COLOR`.
- `fzfArgs` puts the markers in the header. The two existing header assertions
  still hold: the key contains no `ctrl-r`, so the "does not advertise an
  unbound key" test is unaffected.
- The readline fallback has no test harness today and does not get one for this;
  the `formatMarkerKey` unit test carries the behaviour.

## Out of scope

- Changing `gm ls`'s legend.
- Making the fzf header dynamic via `transform`. It would buy accurate counts at
  the price of fzf-version pressure and a second output channel on
  `__picker-rows`, to restore numbers this design concluded the picker is better
  off without.
