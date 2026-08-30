# gigamanage as a background agent

**Date:** 2026-08-11
**Status:** proposed — awaiting review

## The principle

gigamanage is a **background agent that keeps you up to date on your agents'
latest work.** Everything else is a surface for that. You have several coding
agents running in tmux; you should be able to glance and know what each has
gotten to — without switching into them, without running a command, and without
the tool re-summarising constantly for no reason. The tool watches, notices when
a session has *meaningfully* moved, refreshes that session's summary, and keeps
the display current.

The pieces built so far — exact pane→session resolution, the pane-border label
HUD, the summary cache — are the raw materials. This spec adds the thing that
makes it an *agent* rather than a command: a persistent, lightweight watch loop,
and a cheap way to decide *when* a summary is worth refreshing.

## What we're building

**A single background watch service** (`gm watch`), toggled by `Alt-g`, that every
few seconds resolves the agent panes across all windows, keeps their border
labels current from cache, and — gated by a cheap divergence check — refreshes
the summaries of sessions that have actually progressed. It is designed to sit
running all day at negligible cost, spending a model call only when a session has
diverged enough to be worth re-reading.

Two new mechanisms:

1. **A SimHash divergence gate** — a compact per-summary fingerprint that answers
   "has this session changed *enough* to re-summarise?" cheaply, replacing the
   current "changed *at all*" test.
2. **The watch loop** — a detached, single-instance service with a clean toggle
   and lifecycle.

## 1. The divergence gate (SimHash)

Today `isStale` is binary: a summary is stale the instant its session's distilled
content hash changes — which, for a live session, is essentially every message.
A watch loop on that would re-summarise constantly.

Instead, store a **64-bit SimHash** of the distilled content on each summary, as
16 hex characters in the summary's cache file — fixed size regardless of how long
the session grows. On each check, recompute the current SimHash and take the
**Hamming distance** to the stored one:

- distance `< THRESHOLD` → not worth it, skip;
- distance `≥ THRESHOLD` → the session has moved, refresh.

**Core additions** (`core/fingerprint.ts`, pure and tested):
- `simhash64(text: string): string` — tokenise, hash each token to 64 bits
  (FNV-1a via BigInt), sum a signed bit vector, take the sign per bit → 16 hex
  chars. Deterministic.
- `hammingDistance(a: string, b: string): number` — popcount of the XOR.

**The gate** (`services/summarize.ts`), replacing `isStale` at its call sites:
- `shouldRefresh(summary, record): boolean`, true when any of:
  - no summary, or the summary predates fingerprints (fall back to the exact
    `sourceHash` compare — no forced re-summarise burst; a fingerprint is added
    on the next real refresh);
  - `promptVersion` changed (a prompt edit must still reach every summary);
  - a **low-churn significant signal** changed — a new `lastToolFailure`,
    `endedMidTask` flipping, or the `filesTouched` set changing — because those
    are exactly the small-but-important flips a volume-based divergence check
    would miss;
  - otherwise, `hammingDistance(summary.fingerprint, current) ≥ THRESHOLD`.
- `THRESHOLD` is a constant, overridable by `GIGAMANAGE_REFRESH_DISTANCE`, so it
  can be calibrated against real sessions. Default chosen conservative (refresh on
  real progress, not chatter).

`SessionSummary` gains `fingerprint: string` and `promptVersion: number`;
`summarizeSession` writes both. `sourceHash` stays for the fingerprint-absent
fallback.

**The honest tradeoff:** SimHash measures *volume* of change, so the significant-
signal overrides above are load-bearing — they catch the meaningful small changes
the distance would otherwise sleep through.

## 2. The watch service

**`gm watch`** — a single global background service.

- **Single instance.** A PID file (`~/.cache/gigamanage/watch.pid`, `{pid,
  startedAt}`) makes "already running?" a `process.kill(pid, 0)` check. Starting
  when one is alive is a no-op; a stale PID (dead owner, or older than a ceiling)
  is reclaimed — the same discipline as the auto-summarize lock.
- **The loop**, every `WATCH_INTERVAL_MS` (default 3000):
  1. `listPanes` across all windows (`list-panes -a`). If tmux is gone, exit.
  2. Resolve each pane (the live process resolver), and set every pane's
     `@gm_label` from its cached summary — cheap, no model calls.
  3. Collect the resolved sessions whose summary `shouldRefresh` (the SimHash
     gate). Hand them to the existing detached summarise path — through the same
     lock, so nothing stampedes — capped by the existing per-pass ceiling.
  4. Sleep.

  A pane whose session is being summarised *right now* (it's in the
  auto-summarize queue, the same `inProgressIds` set the overlay reads) shows
  **`<project> — gm summaries loading…`** instead of a stale headline, so the wait
  is visible rather than silent. This is a light touch: `paneLabel` gains a
  `refreshing` flag, and the watch loop passes it from the in-progress set on each
  iteration — the label flips to loading when a refresh starts and back to the
  fresh headline the moment it lands.
- **Exit** on: tmux server gone, the PID file removed (the toggle's stop path),
  or a terminating signal. Wraps every iteration so one bad read never kills the
  loop.

**`Alt-g` becomes the toggle** (`gm tmux label <window>`, kept as the binding
entry point but now service-aware). Because the service is global, the border is
enabled **globally** (`set -g pane-border-status top`) so *every* window shows its
labels, not only the one you toggled from:
- **Off → On:** set `pane-border-status`/`format` globally, spawn `gm watch`
  detached if not already running, and paint an immediate first frame for the
  current window so labels appear at once (not after the first loop).
- **On → Off:** stop the service (remove the PID file; signal the process), set
  `pane-border-status off` globally.
- "On" is defined by the service running; the toggle reads the PID file, not the
  border option (a theme could set the border for its own reasons).

**`gm watch --stop`** stops it from the CLI; `gm watch` in the foreground (no
detach) is available for debugging.

The label-setting from Task-4's `toggleLabels` moves into a shared helper both the
toggle's first paint and the loop call, so there is one place that turns resolved
panes into `@gm_label` values.

## Surfaces, now and later

The **only surface in this spec is the tmux border labels.** But the service is
the foundation for more, and the design keeps them cheap to add later
(explicitly out of scope here): a desktop/terminal **notification** when a session
flips to `endedMidTask` or a command fails; a `gm feed` that streams "what just
changed"; the `ctrl-g` popup reading the same freshly-maintained cache. The watch
loop is where that intelligence will live.

## Scope

**In v0.9.0:** the SimHash gate, `gm watch` (single-instance global service with a
clean lifecycle), and `Alt-g` toggling it with an immediate first paint.

## Non-goals (deliberately later)

- **Notifications / a change feed.** The service makes them possible; they're not
  in this cut.
- **Per-window watchers.** One global service (chosen); per-window granularity is
  a later refinement if wanted.
- **Auto-start on login / persistence across tmux restarts.** The service lives
  and dies with an explicit toggle (and tmux).
- **Tuning the threshold automatically.** It's a constant with an env override;
  calibration is manual for now.

## Testing

- **`simhash64` / `hammingDistance`** — pure: identical text → distance 0; a small
  edit → small distance; unrelated text → large distance; stable/deterministic
  across runs; fixed 16-char output.
- **`shouldRefresh`** — pure over a fixture summary + record: no summary → true;
  fingerprint absent → falls back to exact hash; promptVersion change → true;
  a new `lastToolFailure` / `endedMidTask` flip / changed files → true even at
  distance 0; below threshold with none of those → false; at/over threshold →
  true. Threshold read from the env override in a test.
- **The label helper** — resolved panes → `@gm_label` values (already covered by
  `paneLabel`; extend for the map, and for the `refreshing` state that renders
  `<project> — gm summaries loading…`).
- **PID-file single-instance logic** — start when free; no-op when a live PID
  exists; reclaim a stale/dead PID. The same shape as the auto-summarize lock
  tests, and tested the same way (no real fork).
- **The loop body and the detach** are thin glue over tested pieces
  (`listPanes`, resolver, `shouldRefresh`, the summarise worker) — the fork is
  asserted as data and through an injected spawner, never actually spawned, as
  `spawnWorker` already is.
- **Layer check** keeps `fingerprint` in `core`, the gate and watch service in
  `services`, the toggle/binding in `cli`.
