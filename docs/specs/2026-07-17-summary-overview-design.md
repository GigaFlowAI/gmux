# Summaries that orient, not just report

**Status:** approved
**Date:** 2026-07-17

## The problem

The one-liner in the picker row doesn't tell you what a session is about.

`SessionSummary.headline` is specified as *"One line: the state the work is in now"* (`src/core/types.ts:91`), and the prompt asks for exactly that: `"the state this work is in NOW: one clause, under 60 chars"` (`src/services/distill.ts:96`). The result is a status with no subject. *"Timestamp check never written"* is unreadable next to twenty others when you can't remember which session it belongs to.

That is the same failure mode as Claude Code's own sessions view: a terse one-liner about the latest change, offering no context. gigamanage exists to be a *browser* of agent sessions — its summaries have to carry enough context to decide what to open. A status clause alone doesn't.

Two things cause this:

1. **The headline is the wrong fact.** It reports the endpoint instead of orienting you.
2. **The model cannot write a better one.** `distill()` shows it the last 12 human turns, the final assistant message, 25 filenames, and the last failure. On a 200-turn session, turn 1 — the actual ask — is not in the prompt. No prompt rewrite fixes this; the information isn't in the room.

The card has the mirror problem: `formatCard` shows `landed` / `open` / `nextStep` (`src/cli/format.ts:240-251`). The headline appears only as a fallback when `landed` is empty. There is nowhere that says what the session *is*.

## The shape of the fix

**The tail is one component, not the whole summary.** Summarize the *arc*: where the work started, roughly how it moved, where it landed.

This looks like it contradicts a non-negotiable in `AGENTS.md`:

> **Summaries come from the tail.** `src/services/distill.ts` sends the model the END of a session. If you change it to send the beginning, the tool becomes pointless.

It doesn't, but the rule is worded too strongly and must be rewritten as part of this work. What the rule protects is that a summary must never be **head-only** — that reproduces Claude Code's stale `aiTitle`, which is the bug this tool exists to fix. Tail-only was the overcorrection. The arc includes the head; it never lets the head speak alone, and it never treats the recorded title as true. Leaving the doc as written while doing this anyway is how a rule quietly becomes a lie.

## Design

### 1. Capturing the arc (`core` + `adapters`)

The early turns are destroyed at parse time. `RingBuffer.push` (`src/adapters/jsonl.ts:41-44`) calls `items.shift()` once full, and both adapters use it at capacity 12 (`claude-code.ts:92`, `codex.ts:88`). The anchor must be captured one layer below the prompt.

**New `DecimatingSampler` in `src/adapters/jsonl.ts`,** beside `RingBuffer`. Fixed capacity (8); when full, drop every other item and double the stride. Evenly-spaced coverage of the whole session in O(1) memory, always retaining the first item pushed.

```
8 turns,   cap 8 → keeps all 8 (decimation never triggers)
20 turns,  cap 8 → stride 4  → keeps 1, 5, 9, 13, 17
200 turns, cap 8 → stride 32 → keeps 1, 33, 65, 97, 129, 161, 193
```

Stride doubles on each decimation, so it is always a power of two and the
retained set is evenly spaced but not exactly `capacity` long — it lands
between `capacity/2` and `capacity`. That is fine: the prompt needs a few
waypoints through the session, not a precise count.

This preserves what `RingBuffer` was protecting — parse memory stays bounded regardless of session size, and the distilled input stays "a couple of KB whether the session was 20 messages or 2,000" (`distill.ts:1-14`).

**`SessionRecord` gains one field** (`src/core/types.ts`):

```ts
/** Evenly-spaced sample of human turns across the whole session, oldest
 *  first. `arcPrompts[0]` is the original ask. Gives the summarizer the
 *  session's SHAPE; `recentUserPrompts` gives it the detail. */
arcPrompts: string[];
```

It sits beside `recentUserPrompts` rather than replacing it. Arc gives shape, tail gives detail; different jobs.

**Both adapters** push each `humanText()` result into the sampler as well as the ring buffer. Same filtered text, so the `<system-reminder>` / tool-result / slash-command stripping in `humanText()` (`claude-code.ts:264-282`) still guards the input. Bypassing it poisons summaries.

**`INDEX_VERSION` bumps 2 → 3** (`src/services/index-store.ts:20`). Non-negotiable #6: `SessionRecord` changed shape, so stale caches must be rejected or be misread as records with no arc. Effect is a local re-parse, not a model call.

### 2. The prompt and the schema (`core` + `services`)

**`SummaryInput` gains `arcPrompts`** (`types.ts:108-127`), inside the hashed struct.

**`PROMPT_VERSION` bumps 2 → 3** (`distill.ts:33`). Mandatory: `promptVersion` is hashed precisely so a prompt edit reaches summaries already on disk. Guarded by `tests/services.test.ts:570`.

**New prompt sections** in `buildPrompt()`, between the session facts and the tail:

```
## The original ask (session start)
  arcPrompts[0]

## How the work moved (sampled across the session)
  arcPrompts[1..] — minus any that also appear in the tail
```

The dedupe is load-bearing: on a short session the sampler and ring buffer hold the *same* turns, and without it the model sees every prompt twice and reads the repetition as emphasis.

**The preamble changes.** Today: *"You are shown the END of the session, not the beginning"* — which becomes false. It becomes: you are shown the arc (start, middle, end); describe where the work landed; never treat the recorded title as true.

**The output contract** (`distill.ts:94-100`) goes to five fields:

```json
{
  "headline": "what this session is about, one clause, under 60 chars, no trailing period",
  "overview": "2-3 sentences: what this work is fundamentally about, including how the goal shifted if it did",
  "landed": "1-2 sentences: the MOST RECENT work done",
  "open": "1-2 sentences: what is unresolved, blocked, or broken. 'Nothing outstanding.' if genuinely finished",
  "nextStep": "one concrete next action a developer would take"
}
```

Plus an explicit instruction that **`headline` is `overview` compressed to a list row** — same fact, two lengths — so the two cannot drift into contradiction.

`landed` narrows from "what actually got done" to "the most recent work done". Without that narrowing, `overview` and `landed` say the same thing twice.

Retained: the "narrow list column / clause, not sentence" guidance with its good/bad examples, and the `under 60 chars` figure. The row truncates at 72 (`format.ts:141`), and `PROMPT_VERSION` went to 2 because 80-char headlines overflowed and read as truncated. `tests/services.test.ts:591` pins that number.

**`SessionSummary` and `SummaryFields` gain `overview: string`** (`types.ts:83-99`, `:130-135`).

**Validation** (`summarize.ts:98-127`): `headline` stays the *only* hard requirement; `overview` coerces to `""` like `landed` / `open` / `nextStep`. A row must always render, but a provider that flubs one card field shouldn't nuke an otherwise-useful summary.

This gives backward compatibility for free, though not by the mechanism it looks like. `readSummary` (`summarize.ts`) does a bare `JSON.parse(raw) as SessionSummary` — stored summaries are never re-validated through `parseSummaryFields`. So an old file's missing `overview` surfaces as `undefined`, **not** `""`. It renders correctly anyway because every consumer treats it as falsy: the card uses `overview || headline` and `gm ask` guards with `if (summary.overview)`. Any future consumer must do the same, or handle `undefined` explicitly — passing it straight to a string function would throw. Such summaries regenerate on next touch.

**`gm ask` context** (`ask.ts:82`) feeds `overview` alongside `headline`. That command's entire job is having enough context to answer questions.

### 3. The card (`cli`)

`formatCard` (`format.ts:240-251`) becomes:

```
OVERALL       ← summary.overview || summary.headline
RECENT WORK   ← summary.landed   (omitted if empty)
STILL OPEN    ← summary.open
NEXT STEP     ← summary.nextStep
```

`WHERE IT LANDED` renames to `RECENT WORK`, matching the narrowed field.

**The fallback chain inverts.** Today: `indent(summary.landed || summary.headline)` (`format.ts:241`) — the headline stands in for `landed`, which works *because today's headline is a status*. Once the headline is a goal clause, that fallback prints context under a "recent work" heading and quietly lies.

- `OVERALL` falls back to `headline` when `overview` is empty — correct, since both describe the same fact at different lengths, and `headline` is the one field validation guarantees.
- `RECENT WORK` gets **no** fallback; omitted when `landed` is empty.

Old summaries then render `OVERALL` from the old status headline and `RECENT WORK` from `landed`: slightly off-register until regenerated, never wrong.

**`rowText()`** (`format.ts:99-102`) is unchanged. It reads `summary?.headline`; the headline's *meaning* moved, not its position. The `?? record.title ?? record.lastUserPrompt` chain stays.

The fzf preview pane (`picker.ts:196`, window `right,55%,wrap`) renders `gm show`, so it inherits the new card with no change.

## Testing

`formatCard` has **zero** coverage today — nothing in `tests/` references it. We are restructuring it, so it gets covered.

- `formatCard` renders all five fields; omits `OVERALL` / `RECENT WORK` / `STILL OPEN` / `NEXT STEP` when empty; falls back `overview → headline`; does **not** fall back `landed → headline`.
- A summary with no `overview` (legacy on-disk shape) still renders a usable card.
- `DecimatingSampler`: retains the first item; at or under capacity keeps everything; over capacity stays bounded and evenly spaced.
- Adapters populate `arcPrompts[0]` with the first human turn on a session longer than 12 turns — the case that is impossible today. One test per adapter.
- The prompt contains the anchor section; arc-vs-tail dedupes on a short session.
- Update `tests/services.test.ts:218` ("sends the model the tail of the session, not the opening title") to assert the arc is sent *and* that the recorded title is still labeled stale.
- `tests/services.test.ts:591` still pins `60 chars`.

Constraints that hold: no test calls a real model (inject `FakeProvider`); no test reads the real home directory.

## Cost

Bumping `PROMPT_VERSION` invalidates **every summary on disk**. The next `gm ls` re-summarizes the recent window (`AUTO_SUMMARIZE_LIMIT = 20`, `auto-summarize.ts:53`); the rest regenerate as they are touched. This is real token spend across the user's history, unavoidable for a schema change of this kind, and one-time. Accepted.

## Docs to update

- **`AGENTS.md`** — rewrite the "Summaries come from the tail" non-negotiable to "never head-only", per *The shape of the fix* above.
- **`README.md`** — summaries write four things now, led by the overall summary; the current text says *"three things: what landed, what's still open, and the next concrete step"*.

## Out of scope

- Changing `rowText()`'s fallback chain.
- The 72-char row budget and the `⚠` mid-task marker.
- Rolling/incremental summaries that feed a previous summary forward. Considered and rejected: stateful, a bad summary poisons its successors, and `PROMPT_VERSION` bumps can't cleanly rebuild history.
