# Summaries That Orient — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the picker one-liner say what a session is *about*, and give the detail card an `OVERALL` field — by summarizing the session's arc instead of only its tail.

**Architecture:** The opening turns of a session are destroyed at parse time by a `RingBuffer` that keeps only the last 12. A new `DecimatingSampler` captures an evenly-spaced sample of the *whole* session in O(1) memory, stored on `SessionRecord.arcPrompts`. That reaches the prompt, which gains an anchor section and a fifth output field, `overview`. The card leads with it.

**Tech Stack:** TypeScript, ESM, Node 20+, Vitest.

**Spec:** `/Users/jamesgao/Projects/gigamanage/.claude/worktrees/generic-munching-hare/docs/specs/2026-07-17-summary-overview-design.md`

**Branch:** `summary-overview` (already created, spec already committed).

## Global Constraints

- **Layer rule:** `core ← adapters ← services ← cli`. Import from your own layer or leftward, never rightward. `npm test` fails on violations.
- **Read-only:** never write to `~/.claude` or `~/.codex`.
- **No test calls a real model.** Inject `FakeProvider` (`tests/services.test.ts:255-268`).
- **No test reads the real home directory.** `GIGAMANAGE_HOME` points at a temp dir.
- **Every read command supports `--json`.**
- **Every error carries a `fix`** (`src/core/errors.ts`).
- **`SessionRecord` changed ⇒ bump `INDEX_VERSION`** (`src/services/index-store.ts:20`). Done in Task 2.
- **Prompt changed ⇒ bump `PROMPT_VERSION`** (`src/services/distill.ts:33`). Done in Task 3.
- Run `npm run check` (layer check + typecheck + tests) before claiming any task done.

---

### Task 1: `DecimatingSampler`

Captures an evenly-spaced sample across an unbounded stream, in bounded memory, always retaining the first item. This is what lets the summarizer see the session's start without loading the session.

**Files:**
- Modify: `src/adapters/jsonl.ts` (append after `RingBuffer`, which ends at line 52)
- Test: `tests/adapters.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class DecimatingSampler<T> { constructor(capacity: number); push(item: T): void; toArray(): T[] }`

- [ ] **Step 1: Write the failing tests**

Add to `tests/adapters.test.ts`. The file has no `jsonl.js` import yet, so add one below the existing adapter imports (line 5):

```ts
import { DecimatingSampler } from "../src/adapters/jsonl.js";
```

```ts
describe("DecimatingSampler", () => {
  function sample(count: number, capacity = 8): number[] {
    const s = new DecimatingSampler<number>(capacity);
    for (let i = 1; i <= count; i += 1) s.push(i);
    return s.toArray();
  }

  it("keeps everything when the stream fits", () => {
    expect(sample(8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("always retains the first item — that is the original ask", () => {
    expect(sample(2000)[0]).toBe(1);
  });

  it("stays evenly spaced as the stream grows", () => {
    expect(sample(20)).toEqual([1, 5, 9, 13, 17]);
    expect(sample(200)).toEqual([1, 33, 65, 97, 129, 161, 193]);
  });

  it("stays bounded no matter how long the stream is", () => {
    expect(sample(100_000).length).toBeLessThanOrEqual(8);
  });

  it("holds an empty stream", () => {
    expect(sample(0)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/adapters.test.ts -t DecimatingSampler`
Expected: FAIL — `DecimatingSampler is not defined` / no export.

- [ ] **Step 3: Implement it**

Append to `src/adapters/jsonl.ts`:

```ts
/**
 * Keep an evenly-spaced sample of an unbounded stream, in bounded memory.
 *
 * `RingBuffer` above answers "how did this end?". This answers "what shape was
 * it?" — and crucially it never drops the FIRST item, which is the developer's
 * original ask. A summarizer that never sees that writes the same thing the
 * stale harness title already says.
 *
 * Every `stride`-th item is a candidate; when the buffer fills we drop every
 * other one and double the stride. Stride is therefore always a power of two,
 * and the retained set lands between `capacity / 2` and `capacity` — evenly
 * spaced, not exactly `capacity` long. A few waypoints is all the prompt needs.
 */
export class DecimatingSampler<T> {
  private items: T[] = [];
  private stride = 1;
  private seen = 0;

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    const index = this.seen;
    this.seen += 1;
    if (index % this.stride !== 0) return;

    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items = this.items.filter((_, i) => i % 2 === 0);
      this.stride *= 2;
    }
  }

  toArray(): T[] {
    return [...this.items];
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/adapters.test.ts -t DecimatingSampler`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/jsonl.ts tests/adapters.test.ts
git commit -m "feat: add DecimatingSampler for bounded whole-stream sampling"
```

---

### Task 2: Capture `arcPrompts` in both adapters

**Files:**
- Modify: `src/core/types.ts` (add field to `SessionRecord`, after `recentUserPrompts` at line ~57)
- Modify: `src/adapters/claude-code.ts:20,24,92,161-165,183-199`
- Modify: `src/adapters/codex.ts:22,26,88,132-136,165-182`
- Modify: `src/services/index-store.ts:20` (`INDEX_VERSION` 2 → 3)
- Test: `tests/adapters.test.ts`
- Modify (typecheck fallout): `tests/services.test.ts:41`, `tests/ask.test.ts:27`, `tests/auto-summarize.test.ts:63`

**Interfaces:**
- Consumes: `DecimatingSampler` from Task 1.
- Produces: `SessionRecord.arcPrompts: string[]` — evenly-spaced human turns, oldest first, `[0]` is the original ask.

- [ ] **Step 1: Write the failing tests**

Add to `tests/adapters.test.ts`. A 30-turn session is the case that is impossible today: with `RECENT_PROMPT_COUNT = 12`, turn 1 is gone.

This file drives adapters **directly** and sets only `GIGAMANAGE_HOME`. Do not reach for `refreshIndex()` here — it writes to the index cache, and with no `XDG_CACHE_HOME` set in this file it would write to the developer's real `~/.cache`. Non-negotiable #3.

```ts
describe("the session arc", () => {
  const base = { sessionId: CLAUDE_ID, cwd: "/Users/dev/Projects/acme", gitBranch: "main", version: "2.0" };

  async function parseClaude(lines: unknown[]) {
    await writeClaudeSession(home, { slug: "-Users-dev-Projects-acme", sessionId: CLAUDE_ID, lines });
    const adapter = new ClaudeCodeAdapter();
    const refs = await adapter.listSessions();
    return adapter.parseSession(refs[0]!);
  }

  it("keeps the original ask on a session far longer than the tail window", async () => {
    const record = await parseClaude(
      Array.from({ length: 30 }, (_, i) => ({
        ...base,
        type: "user",
        timestamp: `2026-07-10T10:${String(i).padStart(2, "0")}:00.000Z`,
        message: { role: "user", content: `turn ${i + 1}` },
      })),
    );

    // The tail window has long since dropped turn 1 ...
    expect(record.recentUserPrompts).not.toContain("turn 1");
    // ... but the arc still has it.
    expect(record.arcPrompts[0]).toBe("turn 1");
    expect(record.arcPrompts.length).toBeLessThanOrEqual(8);
  });

  it("excludes injected context from the arc, exactly as the tail does", async () => {
    const record = await parseClaude(claudeLines(CLAUDE_ID));

    // No <system-reminder>, no tool_result — humanText() guards both windows.
    expect(record.arcPrompts).toEqual(["set up the auth module", "the admin case still 401s"]);
  });

  it("keeps the original ask for codex too", async () => {
    await writeCodexSession(home, {
      date: "2026-07-11",
      sessionId: CODEX_ID,
      lines: [
        {
          type: "session_meta",
          timestamp: "2026-07-11T10:00:00.000Z",
          payload: { id: CODEX_ID, cwd: "/Users/dev/Projects/beta", originator: "codex_cli" },
        },
        ...Array.from({ length: 30 }, (_, i) => ({
          type: "event_msg",
          timestamp: `2026-07-11T10:${String(i).padStart(2, "0")}:00.000Z`,
          payload: { type: "user_message", message: `turn ${i + 1}` },
        })),
      ],
    });

    const adapter = new CodexAdapter();
    const refs = await adapter.listSessions();
    const record = await adapter.parseSession(refs[0]!);

    expect(record.recentUserPrompts).not.toContain("turn 1");
    expect(record.arcPrompts[0]).toBe("turn 1");
  });
});
```

`ClaudeCodeAdapter`, `CodexAdapter`, `claudeLines`, `writeClaudeSession`, `writeCodexSession`, `home`, `CLAUDE_ID` and `CODEX_ID` are all already in scope at the top of the file (lines 1-20). Nothing new to import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/adapters.test.ts -t "the session arc"`
Expected: FAIL — `arcPrompts` is undefined.

- [ ] **Step 3: Add the field to `SessionRecord`**

In `src/core/types.ts`, directly after the `recentUserPrompts` field:

```ts
  /** Recent human turns, oldest first. Feeds the summarizer. */
  recentUserPrompts: string[];
  /**
   * Evenly-spaced human turns sampled across the WHOLE session, oldest first.
   * `arcPrompts[0]` is the original ask.
   *
   * `recentUserPrompts` says how the work ended; this says what shape it had.
   * Both are needed: a summary written from the tail alone has no subject, and
   * one written from the head alone is just the stale harness title again.
   */
  arcPrompts: string[];
```

- [ ] **Step 4: Populate it in the Claude adapter**

`src/adapters/claude-code.ts` line 20 — extend the import:

```ts
import { readJsonl, DecimatingSampler, RingBuffer } from "./jsonl.js";
```

After line 24 (`const RECENT_PROMPT_COUNT = 12;`):

```ts
/** Waypoints sampled across the whole session. See DecimatingSampler. */
const ARC_PROMPT_COUNT = 8;
```

Line 92, inside `parseSession`:

```ts
    const prompts = new RingBuffer<string>(RECENT_PROMPT_COUNT);
    const arc = new DecimatingSampler<string>(ARC_PROMPT_COUNT);
```

Lines 161-165 — push to both. Same `humanText()` output, so the `<system-reminder>` / tool-result filtering still guards it:

```ts
        const text = humanText(content);
        if (text) {
          userPromptCount += 1;
          prompts.push(text);
          arc.push(text);
        }
```

Line 183 and the returned object:

```ts
    const recentUserPrompts = prompts.toArray();
    const arcPrompts = arc.toArray();
```

and add `arcPrompts,` immediately after `recentUserPrompts,` in the returned record.

- [ ] **Step 5: Populate it in the Codex adapter**

`src/adapters/codex.ts` line 22 — extend the import:

```ts
import { readJsonl, DecimatingSampler, RingBuffer } from "./jsonl.js";
```

After line 26 (`const RECENT_PROMPT_COUNT = 12;`):

```ts
/** Waypoints sampled across the whole session. See DecimatingSampler. */
const ARC_PROMPT_COUNT = 8;
```

Line 88:

```ts
    const prompts = new RingBuffer<string>(RECENT_PROMPT_COUNT);
    const arc = new DecimatingSampler<string>(ARC_PROMPT_COUNT);
```

Lines 132-136 — note Codex truncates at the push site, so truncate once and push the same string to both:

```ts
        if (kind === "user_message") {
          const text = str(payload["message"]);
          if (text) {
            messageCount += 1;
            userPromptCount += 1;
            const prompt = truncate(text, 600);
            prompts.push(prompt);
            arc.push(prompt);
          }
        }
```

Line 165 and the returned object:

```ts
    const recentUserPrompts = prompts.toArray();
    const arcPrompts = arc.toArray();
```

and add `arcPrompts,` immediately after `recentUserPrompts,` in the returned record.

- [ ] **Step 6: Bump `INDEX_VERSION`**

`src/services/index-store.ts:20`. `SessionRecord` changed shape, so cached entries written by the old parser have no `arcPrompts` and must be rejected rather than misread. Cost is a local re-parse, not a model call.

```ts
const INDEX_VERSION = 3;
```

- [ ] **Step 7: Fix the three test record factories**

`arcPrompts` is required, so every `SessionRecord` literal must have it or typecheck fails. In each of `tests/services.test.ts:41`, `tests/ask.test.ts:27`, `tests/auto-summarize.test.ts:63`, add the field directly after `recentUserPrompts`:

```ts
    recentUserPrompts: ["started here", "and ended over there"],
    arcPrompts: ["started here", "and ended over there"],
```

(Use whatever `recentUserPrompts` value that file already has — the three factories differ.)

- [ ] **Step 8: Run the checks**

Run: `npm run check`
Expected: PASS. Layer check clean (`adapters` importing from `adapters` is leftward-legal), typecheck clean, all tests green.

- [ ] **Step 9: Commit**

```bash
git add src/core/types.ts src/adapters/claude-code.ts src/adapters/codex.ts src/services/index-store.ts tests/
git commit -m "feat: capture the session arc, not just its tail

Both adapters kept only the last 12 human turns, so the summarizer never
saw the original ask on any session longer than that. Sample the whole
session in bounded memory alongside the existing tail window.

INDEX_VERSION 2 -> 3: SessionRecord gained a field."
```

---

### Task 3: Send the arc to the model

**Files:**
- Modify: `src/core/types.ts` (`SummaryInput`, after `recentUserPrompts` at line ~120)
- Modify: `src/services/distill.ts:1-14,30-33,43,55-111`
- Modify: `AGENTS.md` ("Facts about the data" section)
- Test: `tests/services.test.ts:218-242`

**Interfaces:**
- Consumes: `SessionRecord.arcPrompts` from Task 2.
- Produces: `SummaryInput.arcPrompts: string[]`; `PROMPT_VERSION = 3`.

- [ ] **Step 1: Write the failing tests**

Replace the existing `describe("distillation")` test at `tests/services.test.ts:219-228` with the following, and add the two new ones. The old test asserts the *old* rule ("sends the tail, not the opening title") — the rule is changing to "sends the arc, and never trusts the title", so the assertion must change with it.

```ts
  it("sends the model the session's arc, and never trusts the recorded title", () => {
    const prompt = buildPrompt(distill(record()));

    expect(prompt).toContain("and ended over there");
    expect(prompt).toContain("the last thing the agent said");
    // The stale title is included, but explicitly labelled as untrustworthy.
    expect(prompt).toContain("may be stale");
    expect(prompt).toContain("where the work ACTUALLY LANDED");
  });

  it("anchors the prompt with the original ask when the tail has lost it", () => {
    const prompt = buildPrompt(
      distill(
        record({
          arcPrompts: ["the original ask", "a middle turn"],
          recentUserPrompts: ["a recent turn", "the very last turn"],
        }),
      ),
    );

    expect(prompt).toContain("## The original ask");
    expect(prompt).toContain("the original ask");
    expect(prompt).toContain("a middle turn");
  });

  it("does not repeat turns the tail already carries", () => {
    // A short session: the sampler and the tail window hold the same turns.
    // Showing both would make the model read duplication as emphasis.
    const same = ["started here", "and ended over there"];
    const prompt = buildPrompt(distill(record({ arcPrompts: same, recentUserPrompts: same })));

    expect(prompt).not.toContain("## The original ask");
    expect(prompt).not.toContain("## How the work moved");
    expect(prompt.match(/started here/g)).toHaveLength(1);
  });
```

Also add, inside `describe("the summary prompt")` (around `tests/services.test.ts:590`):

```ts
  it("asks for an overview and a headline that compresses it", () => {
    const prompt = buildPrompt(distill(record()));

    expect(prompt).toContain('"overview"');
    expect(prompt).toContain("compressed");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/services.test.ts -t distillation`
Expected: FAIL — no `## The original ask` section; `arcPrompts` not accepted by `record()`'s type until Task 2 is in (it is).

- [ ] **Step 3: Add `arcPrompts` to `SummaryInput`**

`src/core/types.ts`, in `SummaryInput`, directly after `recentUserPrompts`:

```ts
  recentUserPrompts: string[];
  /** Evenly-spaced turns across the whole session. `[0]` is the original ask. */
  arcPrompts: string[];
```

- [ ] **Step 4: Pass it through `distill()`**

`src/services/distill.ts`, after line 43:

```ts
    recentUserPrompts: record.recentUserPrompts,
    arcPrompts: record.arcPrompts,
```

- [ ] **Step 5: Bump `PROMPT_VERSION` and correct its comment**

`src/services/distill.ts:30-33`:

```ts
 * 2: headlines tightened to a short scannable clause (was "max 80 chars",
 *    which overflowed the 72-char row and read as truncated).
 * 3: summaries describe the arc, not just the tail — the prompt gained the
 *    original ask, and the output gained `overview`. The headline changed
 *    meaning: it now says what the work IS, not what state it is in.
 */
export const PROMPT_VERSION = 3;
```

- [ ] **Step 6: Correct the file's header comment**

`src/services/distill.ts:5-13`. Property 1 is about to become false — fix it rather than leave a lie at the top of the file:

```ts
 * 1. **The arc, not one endpoint.** We send where the work started, a few
 *    waypoints through it, and how it ended. Head-only is the bug we exist to
 *    fix — that just restates the stale `aiTitle`. But tail-only overcorrects:
 *    a status with no subject ("timestamp check still red") is unreadable next
 *    to twenty others. Never head-only; never the head speaking alone.
 *
 * 2. **Small.** The distilled input is a couple of KB regardless of whether the
 *    session was 20 messages or 2,000, so summarizing is cheap and bounded.
```

- [ ] **Step 7: Rewrite the preamble and add the anchor sections**

`src/services/distill.ts:58-65` — the old preamble says "You are shown the END of the session, not the beginning", which is about to be false:

```ts
  lines.push(
    "You are summarizing a coding-agent session so a developer can decide, at a glance, whether to pick it back up.",
    "",
    "You are shown the ARC of the session: where it started, waypoints through the middle, and how it ended. Describe where the work ACTUALLY LANDED — and what it is fundamentally about, which may not be what it set out to do.",
    "",
    "## Session",
    `harness: ${input.harness}`,
  );
```

Then, immediately **before** the `recentUserPrompts` block at line 75, insert:

```ts
  // Only what the tail does not already carry. On a short session the sampler
  // and the tail window hold the same turns, and printing both would make the
  // model read the duplication as emphasis.
  const tail = new Set(input.recentUserPrompts);
  const [anchor, ...waypoints] = input.arcPrompts;
  const freshWaypoints = waypoints.filter((p) => !tail.has(p));

  if (anchor !== undefined && !tail.has(anchor)) {
    lines.push("", "## The original ask (how this session opened)", anchor);
  }

  if (freshWaypoints.length > 0) {
    lines.push(
      "",
      "## How the work moved (sampled across the session, oldest first)",
      ...freshWaypoints.map((p) => `- ${p}`),
    );
  }
```

- [ ] **Step 8: Rewrite the output contract**

`src/services/distill.ts:91-108`:

```ts
  lines.push(
    "",
    "## Output",
    "Reply with ONLY a JSON object, no code fence, no commentary:",
    "{",
    '  "headline": "what this work IS, one clause, under 60 chars, no trailing period",',
    '  "overview": "2-3 sentences: what this session is fundamentally about, including how the goal shifted if it did",',
    '  "landed": "1-2 sentences: the MOST RECENT work done",',
    '  "open": "1-2 sentences: what is unresolved, blocked, or broken. \'Nothing outstanding.\' if genuinely finished",',
    '  "nextStep": "one concrete next action a developer would take"',
    "}",
    "",
    "The headline is the overview compressed to fit a narrow list column, read at a glance next to twenty others.",
    "Same fact, two lengths — they must never disagree.",
    "Write a clause, not a sentence:",
    '  good: "Migrating webhook retries to the new queue backend"',
    '  bad:  "The retry logic has been partially applied, but the signature verification test is still failing."',
    "",
    "`landed` is the LATEST work, not a recap of the whole session — that is what `overview` is for.",
    "",
    "Be specific and factual. Name the files, tests, and errors involved. Never speculate beyond the evidence above.",
  );
```

- [ ] **Step 9: Run the tests**

Run: `npx vitest run tests/services.test.ts`
Expected: PASS. The `60 chars` assertion at `:591` still holds (the figure is unchanged); the cache-key test at `:570` still holds.

- [ ] **Step 10: Correct the rule in `AGENTS.md`**

In "Facts about the data that are easy to get wrong", replace the "Summaries come from the tail" bullet. This work sends the beginning; the rule as written forbids it, and the *reason* behind the rule does not. Leaving it is how a rule quietly becomes a lie.

```markdown
- **Summaries come from the arc, never the head alone.** `src/services/distill.ts` sends the model where a session started, waypoints through it, and how it ended. The rule that matters is **never head-only**: a model fed the opening writes the same thing the stale `aiTitle` says, which is the bug this tool exists to fix. Tail-only was the overcorrection — a status with no subject ("timestamp check still red") is unreadable next to twenty others. The head is in the prompt; it never speaks alone, and the recorded title is always labelled stale.
```

- [ ] **Step 11: Commit**

```bash
git add src/core/types.ts src/services/distill.ts tests/services.test.ts AGENTS.md
git commit -m "feat: summarize the session's arc, and ask for an overview

The prompt showed the model only the tail, so it could not say what a
session was about — only what state it ended in. Send the original ask
and sampled waypoints too, and ask for an overview the headline
compresses.

PROMPT_VERSION 2 -> 3: every cached summary regenerates."
```

---

### Task 4: The `overview` field in the schema

**Files:**
- Modify: `src/core/types.ts` (`SessionSummary` ~line 91, `SummaryFields` ~line 131)
- Modify: `src/services/summarize.ts:118-126`
- Test: `tests/services.test.ts` (`describe("summary parsing")`, line 244)

**Interfaces:**
- Consumes: nothing.
- Produces: `SummaryFields.overview: string`, `SessionSummary.overview: string`.

- [ ] **Step 1: Write the failing tests**

Add inside `describe("summary parsing")` in `tests/services.test.ts`:

```ts
  it("reads the overview", () => {
    const raw = '{"headline":"h","overview":"the whole story","landed":"l","open":"o","nextStep":"n"}';
    expect(parseSummaryFields(raw, "test").overview).toBe("the whole story");
  });

  it("survives a reply that omits the overview", () => {
    // headline is the only field a row cannot render without. A provider that
    // flubs one card field should not nuke an otherwise-useful summary — and
    // summaries written before `overview` existed simply lack the key.
    const fields = parseSummaryFields('{"headline":"h","landed":"l"}', "test");
    expect(fields.overview).toBe("");
    expect(fields.headline).toBe("h");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/services.test.ts -t "summary parsing"`
Expected: FAIL — `overview` does not exist on `SummaryFields`.

- [ ] **Step 3: Add the field to both types**

`src/core/types.ts`, in `SessionSummary` — replace the `headline` doc comment, whose meaning has changed:

```ts
  /** One line: what this work IS. The overview, compressed to a list row. */
  headline: string;
  /** 2-3 sentences: what the session is fundamentally about. */
  overview: string;
  /** What got done most recently. */
  landed: string;
```

And in `SummaryFields`:

```ts
/** The five fields a summary provider must return. */
export interface SummaryFields {
  headline: string;
  overview: string;
  landed: string;
  open: string;
  nextStep: string;
}
```

Also update the `SessionSummary` doc block above it (lines ~78-82), which currently says summaries are "Generated from the tail of the transcript, never the head":

```ts
/**
 * A written summary of where a session LANDED, and what it is about.
 *
 * Generated from the session's arc — start, middle, end — so it describes the
 * latest work without losing the thread that leads to it. Never from the head
 * alone: that is just the stale harness title again.
 */
```

- [ ] **Step 4: Return it from the parser**

`src/services/summarize.ts:118-126`. `headline` stays the only hard requirement:

```ts
  const headline = field("headline");
  if (headline === "") throw new SummaryProviderError(provider, "reply had no `headline`");

  return {
    headline,
    overview: field("overview"),
    landed: field("landed"),
    open: field("open"),
    nextStep: field("nextStep"),
  };
```

- [ ] **Step 5: Fix the summary factories the new required field breaks**

`overview` is required on `SessionSummary` and `SummaryFields`, so every literal of either type must gain it or typecheck fails. Two known sites:

- `tests/ask.test.ts:53` — the `summary()` factory. Add after `headline`:
  ```ts
    headline: "Retry logic half-applied; signature test still red",
    overview: "A webhook retry fix that grew into a signature-verification problem.",
  ```
- `tests/services.test.ts:255-268` — `FakeProvider`, if its returned `SummaryFields` literal is spelled out rather than spread.

Run `npx tsc --noEmit` and fix any other literal it flags the same way.

- [ ] **Step 6: Run the checks**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/types.ts src/services/summarize.ts tests/services.test.ts
git commit -m "feat: add overview to the summary schema

headline stays the only required field: a row must always render, but a
provider that flubs one card field should not nuke the whole summary.
Old summaries on disk simply lack the key and read as empty."
```

---

### Task 5: The card leads with `OVERALL`

**Files:**
- Modify: `src/cli/format.ts:240-251`
- Modify: `README.md`
- Modify: `docs/architecture.md:34,47-50`
- Test: `tests/services.test.ts` (new `describe`; `formatCard` has **zero** coverage today)

**Interfaces:**
- Consumes: `SessionSummary.overview` from Task 4.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing tests**

Add `formatCard` to the existing `../src/cli/format.js` import at `tests/services.test.ts:15`. Then add a new `describe` block:

```ts
/** A summary to render. `record()` above supplies the session it belongs to. */
function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    harness: "claude-code",
    sessionId: "aaaa1111-0000-0000-0000-000000000000",
    sourceHash: "abc123",
    generatedAt: "2026-07-01T00:00:00.000Z",
    provider: "test",
    headline: "migrating retries to the new queue",
    overview: "Started as a flaky-retry bug, became a queue migration.",
    landed: "Ported the retry logic to the queue consumer.",
    open: "The timestamp check was never written.",
    nextStep: "Write the timestamp assertion in webhook.test.ts",
    ...overrides,
  };
}

describe("the detail card", () => {
  const plain = (view: SessionView) => stripAnsi(formatCard(view, new Date("2026-07-01T00:00:00.000Z")));

  it("leads with what the session is about, then the latest work", () => {
    const card = plain({ record: record(), summary: summary() });

    expect(card).toContain("OVERALL");
    expect(card).toContain("Started as a flaky-retry bug, became a queue migration.");
    expect(card).toContain("RECENT WORK");
    expect(card).toContain("Ported the retry logic to the queue consumer.");
    expect(card).toContain("STILL OPEN");
    expect(card).toContain("NEXT STEP");
    // Context comes before the latest work: it is what orients the reader.
    expect(card.indexOf("OVERALL")).toBeLessThan(card.indexOf("RECENT WORK"));
  });

  it("falls back to the headline when there is no overview", () => {
    // The shape every summary written before `overview` existed has on disk.
    const card = plain({ record: record(), summary: summary({ overview: "" }) });

    expect(card).toContain("OVERALL");
    expect(card).toContain("migrating retries to the new queue");
  });

  it("never prints the headline as if it were the latest work", () => {
    // The headline says what the work IS. Under a RECENT WORK heading that is
    // a lie, so the section is omitted instead.
    const card = plain({ record: record(), summary: summary({ landed: "" }) });

    expect(card).not.toContain("RECENT WORK");
  });

  it("omits the sections a summary left empty", () => {
    const card = plain({ record: record(), summary: summary({ open: "", nextStep: "" }) });

    expect(card).not.toContain("STILL OPEN");
    expect(card).not.toContain("NEXT STEP");
  });

  it("tells you how to summarize a session that has none", () => {
    const card = plain({ record: record(), summary: null });

    expect(card).toContain("No summary yet.");
    expect(card).toContain("gm summarize aaaa1111");
    expect(card).toContain("TITLE (recorded at session start)");
  });
});
```

Import `SessionSummary` and `SessionView` types at the top of the file (extend the existing `../src/core/types.js` import at line 5). The file has no shared `stripAnsi` helper — it inlines the escape regex at lines 455 and 459 — so add one above the new `describe`, matching that exact pattern:

```ts
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/services.test.ts -t "the detail card"`
Expected: FAIL — card renders `WHERE IT LANDED`, not `OVERALL` / `RECENT WORK`.

- [ ] **Step 3: Restructure the card**

`src/cli/format.ts:240-251`. Note the fallback **inverts**: today `landed || headline` lets the headline stand in for the latest work, which only worked while the headline was a status. Now it stands in for the overview instead.

```ts
  if (summary) {
    // `headline` is the overview compressed, so it is the honest stand-in here
    // — and it is the one field parsing guarantees. `landed` gets no fallback:
    // the headline says what the work IS, and printing that under RECENT WORK
    // would be a lie.
    lines.push(bold("OVERALL"), indent(summary.overview || summary.headline), "");
    if (summary.landed) lines.push(bold("RECENT WORK"), indent(summary.landed), "");
    if (summary.open) lines.push(bold("STILL OPEN"), indent(summary.open), "");
    if (summary.nextStep) lines.push(bold("NEXT STEP"), indent(green(summary.nextStep)), "");
  } else {
```

Leave the `else` branch, and everything from `LAST THING YOU SAID` down, untouched.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/services.test.ts -t "the detail card"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Update the README**

In "What makes it different", the first bullet says summaries write *"three things: what landed, what's still open, and the next concrete step"*. It is four now, and the framing "reads the tail" is no longer accurate:

```markdown
**Summaries describe the end, not the beginning.** gigamanage reads each transcript's *arc* — what you originally asked for, how the work moved, your last instructions, the agent's final message, the files it touched, the last command that failed — and writes four things: what the session is about, what landed most recently, what's still open, and the next concrete step. The harness title tells you where the work *started*; this tells you what it *became*. That's the whole point of the tool.
```

- [ ] **Step 6: Correct `docs/architecture.md`**

Found during execution: the plan originally missed this file, and it still asserts the rule Task 3 replaced.

Line 34, in the pipeline diagram — keep the column alignment of the surrounding rows:

```
4. distill      take the ARC of the session                  → SummaryInput   (a few KB)
```

Then the section at line 47, currently titled `## Why summaries read the tail`. Retitle and rewrite it:

```markdown
## Why summaries read the arc

Claude Code writes an `aiTitle` in a session's first seconds and never revises it. In a long session it names the opening prompt — precisely the wrong thing when you're deciding what to resume. gigamanage exists to fix that.

The first fix was to read only the **end** of the session. That overcorrected: a status with no subject ("timestamp check still red") tells you nothing when you cannot remember which session it belongs to. So `distill()` sends the **arc** — the original ask, waypoints sampled across the session, the recent human turns, the final assistant message, files touched, the last failure. The head is in the prompt; it never speaks alone, and the recorded title is always labelled stale.
```

If the surrounding prose in that section references tail-only reasoning beyond these lines, fix it to match. Do not restructure the document.

- [ ] **Step 7: Run the full checks**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/cli/format.ts tests/services.test.ts README.md docs/architecture.md
git commit -m "feat: lead the detail card with what the session is about

The card showed landed/open/nextStep and nowhere said what the work was.
Add OVERALL, and narrow WHERE IT LANDED to RECENT WORK.

The landed -> headline fallback inverts to overview -> headline: now that
the headline says what the work IS, printing it under a RECENT WORK
heading would be a lie. Also the first test coverage formatCard has had."
```

---

### Task 6: `gm ask` sees the overview

**Files:**
- Modify: `src/services/ask.ts:81-86`
- Test: `tests/ask.test.ts`

**Interfaces:**
- Consumes: `SessionSummary.overview` from Task 4.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe("buildAskPrompt")` at `tests/ask.test.ts:115`. It already has a `prompt()` helper (line 116) and a `view()` factory (line 68) — use them; do not build a context by hand.

```ts
  it("gives the model the overview, not just the headline", () => {
    const text = prompt([view({}, { overview: "the whole story of this session" })]);

    expect(text).toContain("the whole story of this session");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ask.test.ts -t overview`
Expected: FAIL — the overview is not in the context.

- [ ] **Step 3: Add it to the context**

`src/services/ask.ts:81-86`. This is the command whose whole job is having enough context to answer questions, so it gets the richest field:

```ts
  if (summary) {
    lines.push(`headline: ${truncate(summary.headline, MAX_FIELD_CHARS)}`);
    if (summary.overview) lines.push(`what it's about: ${truncate(summary.overview, MAX_FIELD_CHARS)}`);
    if (summary.landed) lines.push(`landed: ${truncate(summary.landed, MAX_FIELD_CHARS)}`);
    if (summary.open) lines.push(`open: ${truncate(summary.open, MAX_FIELD_CHARS)}`);
    if (summary.nextStep) lines.push(`next step: ${truncate(summary.nextStep, MAX_FIELD_CHARS)}`);
  } else {
```

- [ ] **Step 4: Run the full checks**

Run: `npm run check`
Expected: PASS — everything green.

- [ ] **Step 5: Verify against a real session**

Run: `npm run dev -- ls --limit 5`
Expected: the index rebuilds (INDEX_VERSION bumped) and summaries regenerate (PROMPT_VERSION bumped). Rows now read as what each session is about. Then:

Run: `npm run dev -- show <one of the ids>`
Expected: the card leads with `OVERALL`, followed by `RECENT WORK`.

This costs real model calls — it is the one-time regeneration the spec accepted. Skip if no provider is configured (`gm setup`).

- [ ] **Step 6: Commit and open the PR**

```bash
git add src/services/ask.ts tests/ask.test.ts
git commit -m "feat: give gm ask the session overview"
git push -u origin summary-overview
gh pr create --title "Summaries that orient, not just report" --body "$(cat <<'EOF'
## What

The picker one-liner reported a status with no subject — "timestamp check never written" is unreadable next to twenty others. Summaries now say what a session is *about*, and the detail card leads with it.

## Why it wasn't a prompt fix

The model couldn't write a better headline: `distill()` showed it the last 12 human turns, so on any longer session the original ask was never in the prompt. `RingBuffer` destroyed it at parse time. The fix reaches down into the adapters.

## Changes

- `DecimatingSampler` — evenly-spaced sample of a whole session in O(1) memory, always keeping the first turn.
- `SessionRecord.arcPrompts`, populated by both adapters. `INDEX_VERSION` 2 → 3.
- The prompt gains the original ask and sampled waypoints, deduped against the tail. `PROMPT_VERSION` 2 → 3.
- `SummaryFields.overview`; `headline` becomes its compression. `headline` stays the only required field.
- The card leads with `OVERALL`; `WHERE IT LANDED` narrows to `RECENT WORK`.
- First test coverage `formatCard` has ever had.

## The rule in AGENTS.md changed

"Summaries come from the tail — if you change it to send the beginning, the tool becomes pointless" now reads "never head-only". What the rule protects is not restating the stale `aiTitle`; tail-only was the overcorrection. The head is in the prompt, but never speaks alone.

## Cost

`PROMPT_VERSION` invalidates every cached summary. They regenerate through the normal background pass. One-time, unavoidable for a schema change.

Spec: `docs/specs/2026-07-17-summary-overview-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Notes for the implementer

- **Task order matters.** Task 2 depends on Task 1's sampler; Task 3 on Task 2's field; Tasks 4-6 on each other's schema. Don't reorder.
- **The headline changed meaning, not shape.** `rowText()` (`format.ts:99-102`) reads `summary?.headline` and needs no edit at all. Resist touching it.
- **The 60-char figure is load-bearing.** The row truncates at 72 (`format.ts:141`), and `PROMPT_VERSION` went to 2 because 80-char headlines overflowed. `tests/services.test.ts:591` pins it. Don't "improve" it.
- **`humanText()` filtering is load-bearing.** Push the *filtered* text into the sampler, never the raw content — otherwise `<system-reminder>` blocks and tool results poison the arc.
