# Picker Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ctrl-r` to the session picker so it reloads to the most recent sessions and kicks off summarization over them, and tighten row headlines so they read at a glance.

**Architecture:** fzf's `reload(cmd)` binding replaces its item list with a command's stdout, so refresh is a hidden `gm __picker-rows` subcommand that reprints the same NUL-delimited records `buildFzfRecords` already builds. Summarization reuses `maybeAutoSummarize` unchanged except for a `force` flag that skips its cooldown (never its lock). Headlines tighten via a prompt edit plus a `PROMPT_VERSION` folded into the summary cache key, which is what makes the edit reach summaries already on disk.

**Tech Stack:** TypeScript (ESM, NodeNext), commander, vitest, fzf (optional runtime dep).

**Spec:** `docs/specs/2026-07-16-picker-refresh-design.md`

## Global Constraints

- **Layering:** `core ← adapters ← services ← cli`. Imports point left or sideways, never right. `scripts/check-layers.mjs` enforces this in `npm test` and CI.
- **Node 20+.** No new dependencies.
- **`.js` extensions on all relative imports.** This is an ESM/NodeNext package; `from "../core/text.js"` even though the file is `.ts`.
- **No test spawns a process or calls a model.** `spawnWorker` and the summary provider are injected in tests. This is load-bearing in `tests/auto-summarize.test.ts` — preserve it.
- **stdout stays clean for `--json` and pipes.** All human notices go to stderr.
- **The feedback-loop guard is inviolable.** `autoSummarizeCandidates` excludes `isAutomated` and `isSidechain` sessions because our own provider is `claude -p`, which writes a session per summary. Never route around it.
- **Run `npm run check` before every commit** (layers + types + tests).

---

### Task 1: Share `shellQuote` from core

`pickerReloadArgs` (Task 5) must shell-quote filter values — a project name with a space would otherwise break the fzf binding. `resume.ts` already has exactly this function. Move it left so both use one copy.

**Files:**
- Modify: `src/core/text.ts` (add `shellQuote`)
- Modify: `src/cli/commands/resume.ts:59-62` (delete local copy, import from core)
- Test: `tests/services.test.ts`

**Interfaces:**
- Produces: `shellQuote(value: string): string` from `src/core/text.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/services.test.ts`. Import `shellQuote` from `../src/core/text.js` (add to the existing import from that module if one exists, otherwise a new import line).

```ts
describe("shell quoting", () => {
  it("leaves a safe path alone", () => {
    expect(shellQuote("/Users/dev/webshop")).toBe("/Users/dev/webshop");
  });

  it("quotes a path with a space, so it cannot split into two arguments", () => {
    expect(shellQuote("/Users/dev/my repo")).toBe("'/Users/dev/my repo'");
  });

  it("escapes an embedded single quote", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services.test.ts -t "shell quoting"`
Expected: FAIL — `shellQuote` is not exported from `src/core/text.ts`.

- [ ] **Step 3: Add `shellQuote` to core**

Append to `src/core/text.ts`:

```ts
/**
 * Single-quote for POSIX shells, escaping any embedded single quote.
 *
 * Lives in core because two callers need it: `gm resume --print` emits a line
 * meant to be pasted into a shell, and the picker's fzf reload binding is a
 * shell command string. In both, an unquoted path with a space silently runs
 * the wrong thing rather than failing loudly.
 */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
```

- [ ] **Step 4: Point `resume.ts` at it**

In `src/cli/commands/resume.ts`, delete the local `shellQuote` function (lines 59-62, including its doc comment) and add the import:

```ts
import { shellQuote } from "../../core/text.js";
```

- [ ] **Step 5: Run the full check**

Run: `npm run check`
Expected: PASS. Layers green (`cli` → `core` points left), types green, all tests pass — including the existing `gm resume --print` tests, which must not change behavior.

- [ ] **Step 6: Commit**

```bash
git add src/core/text.ts src/cli/commands/resume.ts tests/services.test.ts
git commit -m "refactor: share shellQuote from core"
```

---

### Task 2: Version the summary prompt

Editing the prompt changes nothing for sessions already summarized: the cache key is `distill(record).hash`, which covers session *content* only. Fold a prompt version into that hash so an edit marks every cached summary stale and they regenerate through the existing background path.

**Files:**
- Modify: `src/core/types.ts:108-121` (`SummaryInput`)
- Modify: `src/services/distill.ts:19-35` (`distill`)
- Test: `tests/services.test.ts`

**Interfaces:**
- Produces: `PROMPT_VERSION: number` from `src/services/distill.js`; `SummaryInput.promptVersion: number`

- [ ] **Step 1: Write the failing test**

Add to `tests/services.test.ts`. Import `distill` and `PROMPT_VERSION` from `../src/services/distill.js`.

```ts
describe("the summary cache key", () => {
  it("covers the prompt version, so tightening the prompt regenerates old summaries", () => {
    // Without this, a prompt edit is invisible: every session already on disk
    // keeps its old summary until its transcript happens to change, which for
    // a finished session is never.
    const input = distill(record());

    expect(input.promptVersion).toBe(PROMPT_VERSION);
    expect(input.hash).not.toBe(hash(JSON.stringify({ ...input, promptVersion: 999, hash: undefined })));
  });

  it("still changes when the session changes", () => {
    const before = distill(record({ lastAssistantText: "one" }));
    const after = distill(record({ lastAssistantText: "two" }));

    expect(before.hash).not.toBe(after.hash);
  });
});
```

`tests/services.test.ts` needs a local `record()` helper if it lacks one — copy the one from `tests/auto-summarize.test.ts:63-86` verbatim. Import `hash` from `../src/core/text.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services.test.ts -t "summary cache key"`
Expected: FAIL — `PROMPT_VERSION` is not exported; `input.promptVersion` is `undefined`.

- [ ] **Step 3: Add the field to the type**

In `src/core/types.ts`, add to `SummaryInput` (before `hash`):

```ts
export interface SummaryInput {
  /**
   * Bumped when the prompt changes shape. Part of the hash, and therefore of
   * the cache key: a prompt edit must invalidate summaries written by the old
   * prompt, or the change never reaches anything already on disk.
   */
  promptVersion: number;
  harness: HarnessId;
  // ...unchanged...
}
```

- [ ] **Step 4: Fold it into the hash**

In `src/services/distill.ts`:

```ts
/**
 * Bump when `buildPrompt` changes what it asks for.
 *
 * The summary cache is keyed on this hash, so bumping marks every cached
 * summary stale at once and they regenerate through the normal background
 * pass — no cache wipe, no migration.
 *
 * 2: headlines tightened to a short scannable clause (was "max 80 chars",
 *    which overflowed the 72-char row and read as truncated).
 */
export const PROMPT_VERSION = 2;

export function distill(record: SessionRecord): SummaryInput {
  const input: Omit<SummaryInput, "hash"> = {
    promptVersion: PROMPT_VERSION,
    harness: record.harness,
    // ...rest unchanged...
  };

  return { ...input, hash: hash(JSON.stringify(input)) };
}
```

- [ ] **Step 5: Run the full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/services/distill.ts tests/services.test.ts
git commit -m "feat: version the summary prompt in the cache key"
```

---

### Task 3: Tighten the headline prompt

**Files:**
- Modify: `src/services/distill.ts:74-86` (`buildPrompt`)
- Test: `tests/services.test.ts`

**Interfaces:**
- Consumes: `PROMPT_VERSION` (Task 2) — already at 2, no further bump needed; Tasks 2 and 3 ship the bump and the edit it accounts for.

- [ ] **Step 1: Write the failing test**

Add to `tests/services.test.ts`:

```ts
describe("the summary prompt", () => {
  it("asks for a headline that fits the row it has to live in", () => {
    // The row truncates at 72 chars. Asking for 80 invites an overflow that
    // renders as a cut-off sentence.
    const prompt = buildPrompt(distill(record()));

    expect(prompt).toContain("60 chars");
    expect(prompt).not.toContain("80 chars");
  });
});
```

Import `buildPrompt` from `../src/services/distill.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services.test.ts -t "summary prompt"`
Expected: FAIL — prompt still says "max 80 chars".

- [ ] **Step 3: Rewrite the headline instruction**

In `src/services/distill.ts`, replace the `"headline"` line in the `## Output` block and add examples after the JSON object. The `landed`/`open`/`nextStep` lines are unchanged:

```ts
  lines.push(
    "",
    "## Output",
    "Reply with ONLY a JSON object, no code fence, no commentary:",
    "{",
    '  "headline": "the state this work is in NOW: one clause, under 60 chars, no trailing period",',
    '  "landed": "1-2 sentences: what actually got done",',
    '  "open": "1-2 sentences: what is unresolved, blocked, or broken. \'Nothing outstanding.\' if genuinely finished",',
    '  "nextStep": "one concrete next action a developer would take"',
    "}",
    "",
    "The headline is read in a narrow list column, at a glance, next to twenty others.",
    "Write a clause, not a sentence:",
    '  good: "Retry logic half-applied; signature test still red"',
    '  bad:  "The retry logic has been partially applied, but the signature verification test is still failing."',
    "",
    "Be specific and factual. Name the files, tests, and errors involved. Never speculate beyond the evidence above.",
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services.test.ts -t "summary prompt"`
Expected: PASS.

- [ ] **Step 5: Run the full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/distill.ts tests/services.test.ts
git commit -m "feat: tighten summary headlines to a scannable clause"
```

---

### Task 4: `force` on `maybeAutoSummarize`

An explicit ctrl-r must always re-decide. The cooldown exists to keep an *incidental* re-decision free (a repeated `gm ls`); a keypress is not incidental. Honoring it would make ctrl-r a silent no-op for its first minute.

**Files:**
- Modify: `src/services/auto-summarize.ts:292-310` (`MaybeAutoSummarizeOptions`), `:328-384` (`decide`)
- Test: `tests/auto-summarize.test.ts`

**Interfaces:**
- Produces: `MaybeAutoSummarizeOptions.force?: boolean`

- [ ] **Step 1: Write the failing tests**

Add to the cooldown `describe` block in `tests/auto-summarize.test.ts`:

```ts
it("decides anyway when forced: ctrl-r is an explicit request, not an incidental re-run", async () => {
  await seedUnsummarizedSession();
  const spawner = fakeSpawner();
  await noteCheck();

  const outcome = await maybeAutoSummarize({
    force: true,
    provider: new FakeProvider(),
    spawnWorker: spawner.spawnWorker,
  });

  expect(outcome.status).toBe("spawned");
  expect(spawner.count).toBe(1);
});

it("still respects the lock when forced, so hammering ctrl-r cannot stampede", async () => {
  await seedUnsummarizedSession();
  const spawner = fakeSpawner();

  const first = await maybeAutoSummarize({
    force: true,
    provider: new FakeProvider(),
    spawnWorker: spawner.spawnWorker,
  });
  expect(first.status).toBe("spawned");

  const second = await maybeAutoSummarize({
    force: true,
    provider: new FakeProvider(),
    spawnWorker: spawner.spawnWorker,
  });

  expect(second.status).toBe("locked");
  expect(spawner.count).toBe(1);
});

it("stays off when forced but disabled: a keypress does not override the env var", async () => {
  await seedUnsummarizedSession();
  process.env.GIGAMANAGE_AUTO_SUMMARIZE = "0";
  const spawner = fakeSpawner();

  const outcome = await maybeAutoSummarize({
    force: true,
    provider: new FakeProvider(),
    spawnWorker: spawner.spawnWorker,
  });

  expect(outcome.status).toBe("disabled");
  expect(spawner.count).toBe(0);
});
```

The `GIGAMANAGE_AUTO_SUMMARIZE` env var must be cleaned up — check the file's `afterEach` deletes it, and add `delete process.env.GIGAMANAGE_AUTO_SUMMARIZE;` there if not.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/auto-summarize.test.ts -t "forced"`
Expected: FAIL — `force` is not a known option; the first test reports `cooling-down`.

- [ ] **Step 3: Add the option**

In `src/services/auto-summarize.ts`, add to `MaybeAutoSummarizeOptions`:

```ts
  /**
   * Skip the cooldown — and only the cooldown.
   *
   * Set when the user explicitly asked for a refresh (ctrl-r in the picker).
   * The cooldown guards against *incidental* re-decisions, like `gm ls` in a
   * loop; a keypress is not incidental, and a key that silently does nothing
   * for its first minute reads as broken.
   *
   * The lock still applies, so hammering the key cannot start two workers, and
   * `GIGAMANAGE_AUTO_SUMMARIZE=0` still wins: force overrides our own
   * optimisation, never the user's opt-out.
   */
  force?: boolean;
```

- [ ] **Step 4: Honor it in `decide`**

In `decide`, change the cooldown line only:

```ts
  if (options.enabled === false || !autoSummarizeEnabled()) return none("disabled");

  // Cheapest checks first: two small file reads keep a repeated `gm ls` free.
  if (options.force !== true && (await inCooldown(now))) return none("cooling-down");
  const held = await readLock();
  if (held && !isLockStale(held, now)) return none("locked");
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/auto-summarize.test.ts`
Expected: PASS — the new tests and every existing one, including "backs off during the cooldown" (unforced calls must be unaffected).

- [ ] **Step 6: Run the full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/services/auto-summarize.ts tests/auto-summarize.test.ts
git commit -m "feat: let an explicit refresh bypass the auto-summarize cooldown"
```

---

### Task 5: `◐` in picker rows, and the reload command string

The picker never renders `◐` today: `buildFzfRecords` takes no `inProgress` set, so every un-summarized row shows `○` regardless of what is running. Without this, ctrl-r kicks off a pass with no visible sign it did anything.

**Files:**
- Modify: `src/cli/picker.ts:65-79` (`buildFzfRecords`), `:87-98` (`previewCommand`)
- Test: `tests/services.test.ts` (the existing `describe("the fzf picker")` block)

**Interfaces:**
- Consumes: `shellQuote` (Task 1); `InProgress` from `src/cli/format.js`
- Produces: `selfCommand(): string`; `buildFzfRecords(views, multiline, width?, now?, inProgress?)`

- [ ] **Step 1: Write the failing test**

Add to the `describe("the fzf picker")` block in `tests/services.test.ts`. Note its local `view()` helper always attaches a summary — add an unsummarized variant next to it:

```ts
const bare = (id: string) => ({ record: record({ sessionId: id, project: "webshop" }) });

it("marks rows the worker is writing right now, so ctrl-r visibly did something", () => {
  const views = [bare("aaaa1111-x"), bare("bbbb2222-y")];
  const records = buildFzfRecords(views, false, 80, now, new Set(["aaaa1111-x"]));
  const [first = "", second = ""] = records.split("\0");

  expect(first).toContain("◐"); // in flight
  expect(second).toContain("○"); // queued, nothing running
});
```

`now` is the existing `const now` in that file's scope; if the picker block has none, use `new Date("2026-07-14T00:00:00.000Z")`. `record` is the helper added in Task 2.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services.test.ts -t "ctrl-r visibly did something"`
Expected: FAIL — `buildFzfRecords` takes 4 arguments; both rows render `○`.

- [ ] **Step 3: Thread `inProgress` through `buildFzfRecords`**

In `src/cli/picker.ts`, update the import and the function:

```ts
import { formatRow, formatRowLines, terminalWidth, type InProgress } from "./format.js";

export function buildFzfRecords(
  views: readonly SessionView[],
  multiline: boolean,
  width: number = listWidth(),
  now: Date = new Date(),
  inProgress: InProgress = new Set(),
): string {
  return views
    .map((view) => {
      const display = multiline
        ? formatRowLines(view, now, width, inProgress).join("\n")
        : formatRow(view, now, inProgress);
      return `${view.record.sessionId}\t${display}`;
    })
    .join("\0");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services.test.ts -t "ctrl-r visibly did something"`
Expected: PASS.

- [ ] **Step 5: Extract `selfCommand`**

Still in `src/cli/picker.ts`, replace `previewCommand()` with a shared helper. The reload binding needs the same trick for the same reason.

```ts
/**
 * How to re-invoke *this* build, as a shell command string.
 *
 * fzf runs the preview and reload commands through a shell, and they must hit
 * this build — not whatever `gm` happens to be on PATH. During development
 * there may be no `gm` on PATH at all, and both would silently render nothing.
 *
 * Returns null when argv[1] is unavailable, leaving callers to fall back to a
 * bare `gm`.
 */
function selfCommand(): string | null {
  const self = process.argv[1];
  if (!self) return null;
  return `${shellQuote(process.execPath)} ${shellQuote(self)}`;
}

function previewCommand(): string {
  const self = selfCommand();
  return self ? `${self} show {1} --no-color` : "gm show {1} --no-color";
}
```

Add `import { shellQuote } from "../core/text.js";`.

Note this changes preview quoting from `"..."` (double) to `'...'` (single) — stricter, and correct for a path containing `$` or a backtick.

- [ ] **Step 6: Run the full check**

Run: `npm run check`
Expected: PASS — existing picker tests unaffected.

- [ ] **Step 7: Commit**

```bash
git add src/cli/picker.ts tests/services.test.ts
git commit -m "feat: mark in-flight summaries in the picker"
```

---

### Task 6: `pickerReloadArgs`

The reload command must reproduce the exact filter set the picker opened with, or a refresh silently shows a different list.

**Files:**
- Modify: `src/cli/commands/pick.ts`
- Test: `tests/services.test.ts`

**Interfaces:**
- Consumes: `shellQuote` (Task 1); `LsOptions`, `toFilters` from `./ls.js`
- Produces: `pickerReloadArgs(options: LsOptions, width: number): string[]` from `src/cli/commands/pick.js`

- [ ] **Step 1: Write the failing tests**

Add to `tests/services.test.ts`, importing `pickerReloadArgs` from `../src/cli/commands/pick.js` and `toFilters` from `../src/cli/commands/ls.js`:

```ts
describe("the picker's reload command", () => {
  it("reproduces the filters the picker opened with", () => {
    // A refresh that quietly widens or narrows the list is worse than no
    // refresh: you would not know it happened.
    const options = { project: "webshop", branch: "main", since: "3d", limit: "50" };
    const args = pickerReloadArgs(options, 44);

    expect(args).toEqual([
      "__picker-rows",
      "--width",
      "44",
      "-p",
      "webshop",
      "-b",
      "main",
      "-s",
      "3d",
      "-n",
      "50",
    ]);
  });

  it("passes the boolean filters through as flags", () => {
    const args = pickerReloadArgs({ includeSidechains: true, includeAutomated: true }, 44);

    expect(args).toContain("--include-sidechains");
    expect(args).toContain("--include-automated");
  });

  it("omits what was not asked for", () => {
    expect(pickerReloadArgs({}, 44)).toEqual(["__picker-rows", "--width", "44"]);
  });

  it("quotes a project name with a space, so the fzf binding survives it", () => {
    const command = pickerReloadArgs({ project: "my repo" }, 44).map(shellQuote).join(" ");

    expect(command).toContain("'my repo'");
  });

  it("round-trips through toFilters unchanged", () => {
    // The real invariant: reload must filter identically to open.
    const options = { project: "webshop", since: "3d", limit: "50", includeAutomated: true };
    const args = pickerReloadArgs(options, 44);
    const parsed = {
      project: args[args.indexOf("-p") + 1],
      since: args[args.indexOf("-s") + 1],
      limit: args[args.indexOf("-n") + 1],
      includeAutomated: args.includes("--include-automated"),
    };

    expect(toFilters(parsed, 50)).toEqual(toFilters(options, 50));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services.test.ts -t "picker's reload command"`
Expected: FAIL — `pickerReloadArgs` is not exported from `pick.ts`.

- [ ] **Step 3: Implement it**

Add both to `src/cli/commands/pick.ts` — the constant lives here, and Task 7's
`picker-rows.ts` imports it from here, so the command name has exactly one
definition:

```ts
/** The hidden command fzf's ctrl-r binding runs. Not a thing a person runs. */
export const PICKER_ROWS_COMMAND = "__picker-rows";

/**
 * The argv that reproduces this picker's filter set, for fzf's reload binding.
 *
 * Pure, so the thing a refresh actually runs is testable without spawning fzf.
 * Values are NOT quoted here — the caller joins and quotes, because argv and a
 * shell command string want different escaping.
 *
 * `--width` is passed explicitly: the reload child's stdout is a pipe, so it
 * cannot measure the terminal and would fall back to a default width, reflowing
 * every row on refresh. Only the parent, inside fzf, knows the real width.
 */
export function pickerReloadArgs(options: LsOptions, width: number): string[] {
  const args = [PICKER_ROWS_COMMAND, "--width", String(width)];

  if (options.harness) args.push("--harness", options.harness);
  if (options.project) args.push("-p", options.project);
  if (options.branch) args.push("-b", options.branch);
  if (options.since) args.push("-s", options.since);
  if (options.limit) args.push("-n", options.limit);
  if (options.includeSidechains === true) args.push("--include-sidechains");
  if (options.includeAutomated === true) args.push("--include-automated");

  return args;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services.test.ts -t "picker's reload command"`
Expected: PASS — all five.

- [ ] **Step 5: Run the full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/pick.ts tests/services.test.ts
git commit -m "feat: build the picker's reload argv"
```

---

### Task 7: The hidden `__picker-rows` command

**Files:**
- Create: `src/cli/commands/picker-rows.ts`
- Modify: `src/cli/main.ts`

**Interfaces:**
- Consumes: `PICKER_ROWS_COMMAND`, `LsOptions`, `toFilters` (Task 6); `buildFzfRecords`, `listWidth`, `supportsMultiline`, `fzfVersion` (Task 5); `maybeAutoSummarize` with `force` (Task 4)
- Produces: `registerPickerRows(program: Command): void`

- [ ] **Step 1: Write the command**

Create `src/cli/commands/picker-rows.ts`:

```ts
import type { Command } from "commander";

import { inProgressIds, maybeAutoSummarize } from "../../services/auto-summarize.js";
import { loadViews } from "../../services/views.js";
import { buildFzfRecords, fzfVersion, supportsMultiline } from "../picker.js";
import { PICKER_ROWS_COMMAND, type PickerRowsOptions } from "./pick.js";
import { toFilters } from "./ls.js";

/**
 * The picker's ctrl-r target, re-entered as `gm __picker-rows`.
 *
 * Hidden: like `__auto-summarize`, it is not a thing a person runs. fzf's
 * `reload` binding replaces its item list with a command's stdout, so refresh
 * is exactly "print the records again, having first kicked off summaries".
 *
 * Two rules, both because fzf owns the terminal while this runs:
 *
 * 1. NOTHING goes to stderr. `maybeAutoSummarize`'s notice would land on top of
 *    the picker and corrupt the display. The `◐` markers are the notice here.
 * 2. Width comes from `--width`, not from measuring. Our stdout is a pipe, so
 *    `terminalWidth()` would report its default and every row would reflow to a
 *    different width than it had on open.
 */
export function registerPickerRows(program: Command): void {
  program
    .command(PICKER_ROWS_COMMAND, { hidden: true })
    .description("internal: print picker rows (run by the picker's ctrl-r binding)")
    .option("--harness <id>", "only this harness")
    .option("-p, --project <name>", "only sessions whose project matches")
    .option("-b, --branch <name>", "only sessions whose git branch matches")
    .option("-s, --since <when>", "only sessions newer than this")
    .option("-n, --limit <count>", "how many sessions to offer", "50")
    .option("--include-sidechains", "include subagent transcripts")
    .option("--include-automated", "include non-interactive runs")
    .option("--width <columns>", "list column width, measured by the parent")
    .action(async (options: PickerRowsOptions) => {
      const views = await loadViews(toFilters(options, 50));

      // Forced: the user pressed a key. The lock still stops a stampede.
      const started = await maybeAutoSummarize({
        records: views.map((v) => v.record),
        enabled: options.autoSummarize !== false,
        force: true,
      });

      const inProgress = new Set([...(await inProgressIds()), ...started.targetIds]);
      const width = Number.parseInt(options.width ?? "", 10);
      const records = buildFzfRecords(
        views,
        supportsMultiline(fzfVersion()),
        Number.isFinite(width) && width > 0 ? width : undefined,
        new Date(),
        inProgress,
      );

      process.stdout.write(records);
    });
}
```

Add to `src/cli/commands/pick.ts`:

```ts
export interface PickerRowsOptions extends LsOptions {
  /** The parent's measured list width. Our own stdout is a pipe. */
  width?: string;
}
```

- [ ] **Step 2: Register it, and exempt it from the postAction hook**

In `src/cli/main.ts`, add the import and registration:

```ts
import { registerPickerRows } from "./commands/picker-rows.js";
// ...
registerPickerRows(program);
```

Extend the `postAction` hook's exemption — this command runs its own forced pass, and the hook would fire a second, unforced decision after it:

```ts
  .hook("postAction", async (thisCommand, actionCommand) => {
    // `ls`, `pick` and `__picker-rows` run the pass themselves, BEFORE
    // rendering, so they can mark the rows they just kicked off with ◐.
    // Running it again here would be a wasted decision.
    const own = new Set([AUTO_SUMMARIZE_COMMAND, "ls", "pick", PICKER_ROWS_COMMAND]);
    if (own.has(actionCommand.name())) return;
```

Import `PICKER_ROWS_COMMAND` from `./commands/pick.js`. (`pick` joins this set in Task 8; adding it here is safe either way, since Task 8's `pick` will run its own pass and today's `pick` only reaches the hook after the resumed harness exits.)

- [ ] **Step 3: Verify it prints records**

Run: `npm run dev -- __picker-rows --width 44 --no-auto-summarize | head -c 200`
Expected: tab-separated records, each starting with a session id. Non-empty. No stderr noise.

- [ ] **Step 4: Verify it stays out of `--help`**

Run: `npm run dev -- --help`
Expected: `__picker-rows` does NOT appear in the command list.

- [ ] **Step 5: Run the full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/picker-rows.ts src/cli/commands/pick.ts src/cli/main.ts
git commit -m "feat: add the hidden __picker-rows command"
```

---

### Task 8: Wire ctrl-r into fzf, and summarize on open

**Files:**
- Modify: `src/cli/picker.ts:82-85` (`pickSession`), `:100-142` (`pickWithFzf`)
- Modify: `src/cli/commands/pick.ts:28-44` (the action)

**Interfaces:**
- Consumes: `pickerReloadArgs` (Task 6), `selfCommand` (Task 5), `__picker-rows` (Task 7)
- Produces: `PickOptions { reload?, reloadArgs?, inProgress? }`; `pickSession(views, options?)`

- [ ] **Step 1: Add `PickOptions` and the binding**

In `src/cli/picker.ts`:

```ts
export interface PickOptions {
  /** argv reproducing this filter set, for fzf's reload binding. */
  reloadArgs?: readonly string[];
  /** Re-load views for the no-fzf path, which has no subprocess to shell out to. */
  reload?: () => Promise<SessionView[]>;
  /** Rows the worker is writing right now, rendered `◐`. */
  inProgress?: InProgress;
}

/** Returns the chosen session, or null if the user cancelled. */
export async function pickSession(
  views: readonly SessionView[],
  options: PickOptions = {},
): Promise<SessionView | null> {
  if (views.length === 0) return null;
  return hasFzf() ? pickWithFzf(views, options) : pickWithPrompt(views, options);
}
```

In `pickWithFzf(views, options)`:

```ts
  const records = buildFzfRecords(views, multiline, listWidth(), new Date(), options.inProgress);

  const args = [
    "--ansi",
    "--delimiter=\t",
    "--with-nth=2..",
    "--height=90%",
    "--layout=reverse",
    "--border",
    "--prompt=session > ",
    "--preview",
    previewCommand(),
    "--preview-window=right,55%,wrap",
  ];

  // ctrl-r replaces the list with a fresh one, and kicks off summaries for
  // whatever needs them. `reload` feeds on the command's stdout, so the binding
  // is just "print the records again" — see commands/picker-rows.ts.
  const reload = reloadCommand(options.reloadArgs);
  args.push(
    "--header",
    reload
      ? "enter: resume   ctrl-r: refresh   ctrl-c: cancel"
      : "enter: resume   ctrl-c: cancel",
  );
  if (reload) args.push(`--bind=ctrl-r:reload(${reload})`);
```

And the helper, next to `previewCommand`:

```ts
/**
 * The shell command behind ctrl-r, or null when we cannot address this build.
 *
 * Without a reload command the key is simply not bound and the header does not
 * advertise it — a key that does nothing is worse than a key that isn't there.
 */
function reloadCommand(reloadArgs: readonly string[] | undefined): string | null {
  const self = selfCommand();
  if (!self || !reloadArgs || reloadArgs.length === 0) return null;
  return `${self} ${reloadArgs.map(shellQuote).join(" ")}`;
}
```

- [ ] **Step 2: Summarize on open, and pass the reload args**

Replace the action body in `src/cli/commands/pick.ts`:

```ts
    .action(async (options: LsOptions) => {
      const views = await loadViews(toFilters(options, 50));

      if (views.length === 0) {
        process.stdout.write(
          `${dim("No sessions found. If you expected some, run `gm doctor`.")}\n`,
        );
        return;
      }

      // Kick the pass off over the sessions we are about to offer, exactly as
      // `ls` does — the postAction hook cannot serve the picker, because our
      // action ends in `resumeSession`, which waits on your harness. That hook
      // fires when you quit Claude Code, not when the list is drawn.
      //
      // The notice goes to stderr, which fzf does not capture, so it prints
      // before the picker paints rather than on top of it.
      const started = await maybeAutoSummarize({
        records: views.map((v) => v.record),
        enabled: options.autoSummarize !== false,
        notify: (message) => process.stderr.write(`${dim(message)}\n`),
      });

      const inProgress = new Set([...(await inProgressIds()), ...started.targetIds]);

      const chosen = await pickSession(views, {
        inProgress,
        reloadArgs: pickerReloadArgs(options, listWidth()),
        reload: () => loadViews(toFilters(options, 50)),
      });
      if (!chosen) {
        process.stdout.write(`${dim("Nothing selected.")}\n`);
        return;
      }
      await resumeSession(chosen.record);
    });
```

Add imports to `pick.ts`:

```ts
import { inProgressIds, maybeAutoSummarize } from "../../services/auto-summarize.js";
import { listWidth, pickSession } from "../picker.js";
```

- [ ] **Step 3: Run the full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 4: Drive the real picker**

The binding is not unit-testable. Run: `npm run dev`

Confirm, in order:
1. The picker opens; the header reads `enter: resume   ctrl-r: refresh   ctrl-c: cancel`.
2. Any un-summarized rows show `◐` (a pass started on open), not `○`.
3. Press ctrl-r. The list reloads: rows stay put, nothing flickers into a different width, the preview pane still works on the highlighted row.
4. Press ctrl-r several times fast. Check `ls ~/.cache/gigamanage/auto-summarize.lock` — one lock, and `pgrep -fa "__auto-summarize" | wc -l` reports at most 1. No stampede.
5. Wait for a summary to land, press ctrl-r: that row's `◐` is replaced by its headline.
6. ctrl-c still cancels; enter still resumes.

- [ ] **Step 5: Commit**

```bash
git add src/cli/picker.ts src/cli/commands/pick.ts
git commit -m "feat: refresh the picker with ctrl-r"
```

---

### Task 9: `r` refreshes the no-fzf fallback

ctrl-r is not interceptable at a readline prompt. Refresh is spelled `r` — the way a numbered prompt can express it.

**Files:**
- Modify: `src/cli/picker.ts:144-166` (`pickWithPrompt`)

**Interfaces:**
- Consumes: `PickOptions.reload` (Task 8)

- [ ] **Step 1: Loop the prompt**

Replace `pickWithPrompt` in `src/cli/picker.ts`:

```ts
async function pickWithPrompt(
  views: readonly SessionView[],
  options: PickOptions = {},
): Promise<SessionView | null> {
  // Wrap here too: the numbered fallback is a list you have to read, so chopping
  // the description defeats the point just as badly as it does in fzf.
  const width = Math.max(40, terminalWidth() - 5);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let current = views;

  try {
    for (;;) {
      const shown = current.slice(0, 30);
      for (const [i, view] of shown.entries()) {
        const [first = "", ...rest] = formatRowLines(view, new Date(), width, options.inProgress);
        process.stdout.write(`${String(i + 1).padStart(3)}. ${first}\n`);
        for (const line of rest) process.stdout.write(`     ${line}\n`);
      }
      process.stdout.write("\n(install fzf for fuzzy search and previews: brew install fzf)\n");

      const refreshable = options.reload !== undefined;
      const hint = refreshable ? "number, r to refresh, or blank to cancel" : "number, or blank to cancel";
      const answer = (await rl.question(`\nresume which? [${hint}] `)).trim();

      if (refreshable && answer.toLowerCase() === "r") {
        current = await options.reload!();
        process.stdout.write("\n");
        continue;
      }

      const choice = Number.parseInt(answer, 10);
      if (!Number.isFinite(choice) || choice < 1 || choice > shown.length) return null;
      return shown[choice - 1] ?? null;
    }
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 2: Run the full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 3: Drive the fallback**

Run: `PATH=/usr/bin:/bin npm run dev` — an fzf-free PATH, so `hasFzf()` is false.

Confirm: the prompt reads `resume which? [number, r to refresh, or blank to cancel]`; `r` re-prints the list; a number selects; blank cancels.

If `npm`/`node` are not on that PATH, instead run the built CLI directly with a trimmed PATH: `PATH=/usr/bin:/bin node dist/cli/main.js` after `npm run build`.

- [ ] **Step 4: Commit**

```bash
git add src/cli/picker.ts
git commit -m "feat: refresh the numbered picker with r"
```

---

### Task 10: Document it

**Files:**
- Modify: `README.md:30-37` (the picker paragraph), `:120-125` (the marker table)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Document ctrl-r in the README**

In the paragraph introducing the picker (after the `gm ls` comparison table), append to the sentence ending "in the right harness and the right directory":

```markdown
`gm` on its own puts that list in a fuzzy picker, with the full context card for
the highlighted session alongside it — what landed, what's still open, and the
next concrete step. Hit enter and you're back in the session, in the right
harness and the right directory. **ctrl-r** reloads the list to your most recent
sessions and starts summaries for any that need one — handy when you left the
picker open while an agent was working. (Without fzf, the numbered list takes
`r` for the same thing.)
```

- [ ] **Step 2: Add a CHANGELOG entry**

Follow the existing format in `CHANGELOG.md` — read it first and match its heading style and voice. Under a new `## Unreleased` section (or the existing one):

```markdown
### Added

- **ctrl-r refreshes the picker.** Reloads to your most recent sessions and kicks
  off summaries for whatever needs one, without leaving the picker. `r` does the
  same in the numbered fallback.
- Bare `gm` now summarizes the sessions it is about to show, like `gm ls` does.
  Rows being written right now are marked `◐` in the picker.

### Changed

- Headlines are shorter — one scannable clause, sized to the column they live in
  rather than overflowing it. Existing summaries regenerate in the background on
  first run.
```

- [ ] **Step 3: Verify the docs match the code**

Run: `npm run dev -- --help`
Expected: no `__picker-rows` in the list — the README describes a keybinding, not a command, and this confirms that stays true.

Re-read the README paragraph against `pickWithFzf`'s header string. They must agree on the key.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document ctrl-r refresh in the picker"
```

---

### Task 11: Ship it

- [ ] **Step 1: Full check from clean**

Run: `npm run check`
Expected: PASS — layers, types, and every test.

- [ ] **Step 2: Confirm the layer rule held**

Run: `npm run check:layers`
Expected: PASS. Everything new lives in `cli` (may import anything) or extends `services`/`core` in place. `shellQuote` moved `cli` → `core`, which is leftward and legal.

- [ ] **Step 3: End-to-end, in the real picker**

Run: `npm run dev`

Confirm the whole feature in one pass: rows show tightened headlines for anything re-summarized, `◐` appears for in-flight rows, ctrl-r reloads and picks up finished summaries, enter resumes into the right harness and directory.

- [ ] **Step 4: Push and open a PR**

```bash
git push -u origin docs/screenshot-comparison
gh pr create --title "feat: refresh the picker with ctrl-r" --body "$(cat <<'EOF'
## Summary

`ctrl-r` in the picker reloads to your most recent sessions and kicks off summaries for whatever needs one — so the picker is something you can sit in and navigate, rather than a one-shot list that goes stale the moment it paints.

Three things had to come together for that to be worth having:

- **The picker never summarized on open.** Only `gm ls` did. `pick`'s `postAction` hook fires after `resumeSession` waits on your harness — i.e. when you quit Claude Code. Bare `gm` now runs the pass before drawing, like `ls` does.
- **Picker rows couldn't render `◐`.** `buildFzfRecords` took no in-progress set, so a refresh would kick off work with no sign it had.
- **Headlines overflowed the column.** The prompt asked for 80 chars into a 72-char row. Tightened to a scannable clause — and versioned, because the summary cache key covers session content only, so a prompt edit would otherwise never reach anything already on disk.

`force` on `maybeAutoSummarize` skips the cooldown and nothing else: the lock still means hammering ctrl-r can't stampede, and `GIGAMANAGE_AUTO_SUMMARIZE=0` still wins.

## Test plan

- `npm run check` — layers, types, tests
- Drove the real picker: ctrl-r reloads, `◐` appears, repeated presses hold at one worker, ctrl-c and enter unaffected
- Drove the no-fzf fallback with a trimmed PATH: `r` refreshes

Spec: `docs/specs/2026-07-16-picker-refresh-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Note: the branch is `docs/screenshot-comparison`, which no longer describes the work. Rename before pushing:

```bash
git branch -m feat/picker-ctrl-r-refresh
```
