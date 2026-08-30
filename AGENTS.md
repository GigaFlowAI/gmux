# AGENTS.md

A map for agents working in this repo. It is deliberately short — when everything is marked important, nothing is. Follow the links when you need depth.

## What this is

`gigamanage` (`gm`) is a read-only CLI that indexes AI coding-agent sessions from multiple harnesses, summarizes where each one **landed**, and resumes them. TypeScript, ESM, Node 20+.

## Commands you'll need

```bash
npm run check         # layer check + typecheck + tests. Run before you claim done.
npm test              # layer check + tests
npm run dev -- ls     # run the CLI from source
```

## Layout

| Path | What lives there |
|---|---|
| `src/core/` | Types, errors, pure helpers. No I/O. Imports nothing internal. |
| `src/adapters/` | One file per harness: discover, parse, resume. |
| `src/services/` | Index cache, distillation, summarization, search. |
| `src/cli/` | Commands, formatting, picker. |
| `tests/` | Vitest. Fixtures write real session files to a temp dir. |
| `scripts/check-layers.mjs` | Enforces the layer rule below. |

## The layer rule — this is enforced, not suggested

```
core  ←  adapters  ←  services  ←  cli
```

Import from your own layer or anything to the **left**. Never rightward. `npm test` fails on violations and prints the fix. If you need to import rightward, move the shared code *down* to a lower layer instead.

Details: [`docs/architecture.md`](docs/architecture.md)

## Non-negotiables

1. **Read-only.** Never write to `~/.claude` or `~/.codex`. gigamanage owns exactly two places: `~/.cache/gigamanage` (derived, disposable) and `~/.config/gigamanage` (what a human chose). Wiping the cache must cost summaries, never a provider choice — so nothing keyed by content hash goes in config, and nothing a person typed goes in the cache. **One exception, and it is closed:** *ephemeral IPC* — a scratch buffer one live process writes and its own children read, dead with that process, never read by a later run, safe to `rm` at any instant — belongs in the cache even though it holds typed text, because disposable is what the cache means. `askTranscriptDir()` (the picker's chat thread) is its only member; a person's typed text that outlives its process still goes in config. See `src/core/paths.ts`.
2. **No test calls a real model.** Inject a fake `SummaryProvider` or `AskProvider`. See `tests/services.test.ts`.
3. **No test reads the real home directory.** Set `GIGAMANAGE_HOME` to a temp dir. `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` are already pointed at ones for every test by `tests/setup.ts` — `readConfig()` is called deep inside the summarize path, so a test that never mentions config can still reach the real one, and the cache is the half we write.
4. **Every read command supports `--json`.** An agent can only use what it can parse.
5. **Every error carries a `fix`.** See `src/core/errors.ts`. No dead-end error messages.
6. **Changed `SessionRecord`?** Bump `INDEX_VERSION` in `src/services/index-store.ts`, or stale caches will be misread.
7. **The tool loop belongs to the harness.** `gm ask` grants its provider `gm grep` and lets it dig. We parse no tool calls and speak no vendor protocol — that is what keeps the provider "a CLI that reads a prompt and writes text", and it is the only reason gigamanage depends on no SDK.

## Facts about the data that are easy to get wrong

- **The harness title is stale.** Claude Code's `aiTitle` is written early and never revised. It describes where a session *started*. Never treat it as a summary — that's the bug this tool exists to fix.
- **Summaries come from the arc, never the head alone.** `src/services/distill.ts` sends the model where a session started, waypoints through it, and how it ended. The rule that matters is **never head-only**: a model fed the opening writes the same thing the stale `aiTitle` says, which is the bug this tool exists to fix. Tail-only was the overcorrection — a status with no subject ("timestamp check still red") is unreadable next to twenty others. The head is in the prompt; it never speaks alone, and the recorded title is always labelled stale.
- **Not every `user` line is a human turn.** Claude Code puts tool results, `<system-reminder>` blocks and slash-command envelopes in `user` lines. `humanText()` in `src/adapters/claude-code.ts` filters them. Bypassing it poisons the summaries.
- **Sidechains outnumber real sessions ~9:1.** Subagent transcripts live under `<uuid>/subagents/`. Hidden by default.
- **`claude -p` creates real sessions.** gigamanage's own summarizer would otherwise show up in its own list. Those are flagged `isAutomated` and hidden. Don't undo this.
- **Codex `apply_patch` payloads are JSON-escaped**, so patch newlines arrive as the two characters `\` `n`. Parse accordingly.
- **`readline/promises` drops lines across an async gap.** A line arriving while no `question()` is pending is lost, and the next `question()` then waits forever for input that already came and went. On a TTY there is no gap — a human types *after* the prompt — which is why `gm setup` requires one instead of silently exiting 0 having written nothing.
- **fzf's query line eats plain letter keys.** Picker bindings must be control keys. Not `alt-*` either: macOS Terminal and iTerm2 send accented characters on Option by default.

## Adding a harness

One file in `src/adapters/`, one line in `registry.ts`, one fixture, one test. Nothing else. See [`docs/adding-a-harness.md`](docs/adding-a-harness.md).

## Design

The approved spec is [`docs/specs/2026-07-14-gigamanage-design.md`](docs/specs/2026-07-14-gigamanage-design.md). Read it before making a structural change.
