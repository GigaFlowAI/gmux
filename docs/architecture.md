# Architecture

## The layers

```
core  ←  adapters  ←  services  ←  cli
```

Imports may point left or sideways. Never right. `scripts/check-layers.mjs` enforces this in `npm test` and in CI.

| Layer | Responsibility | May import |
|---|---|---|
| `core` | Types, error taxonomy, pure string/time helpers, cache paths. | nothing internal |
| `adapters` | Per-harness: find session files, parse them into `SessionRecord`, produce the resume command. | `core` |
| `services` | Index cache, distillation, summarization, search, view assembly. | `core`, `adapters` |
| `cli` | Command definitions, output formatting, the picker. | anything |

### Why enforce it mechanically

A dependency rule that lives only in a document is a rule that decays. The check exists so that:

- `core` stays free of I/O, and therefore trivially testable.
- Adapters stay swappable — the thing that makes "support any harness" true rather than aspirational.
- Logic doesn't accumulate in `cli`, where it can't be reused by the next command or called by an agent.

When the check fires, it prints the offending import, the rule, and the fix.

## Data flow

```
1. discover     adapters walk the harness directories        → SessionRef[]   (stat only)
2. parse        adapters stream each JSONL                   → SessionRecord  (hard facts, free)
3. index        cache keyed on (path, mtime, size)           → warm reads in ~60ms
4. distill      take the ARC of the session                  → SummaryInput   (a few KB)
5. summarize    hand it to a model CLI, cache by hash        → SessionSummary
6. render       row / card / JSON                            → you, or your agent
```

Steps 1–3 are free and always run. Steps 4–5 cost money and only run when you ask.

## The two tiers of knowledge

**Hard facts** are extracted while parsing and cost nothing: files touched, PR links, branch, the verbatim last human prompt, the last failing command, and whether the session ended mid-task. These are enough to render a useful list on their own.

**Written summaries** cost a model call. They answer the question hard facts can't: *where did this land, and what's next?*

## Why summaries read the arc

Claude Code writes an `aiTitle` in a session's first seconds and never revises it. In a long session it names the opening prompt — precisely the wrong thing when you're deciding what to resume. gigamanage exists to fix that.

The first fix was to read only the **end** of the session. That overcorrected: a status with no subject ("timestamp check still red") tells you nothing when you cannot remember which session it belongs to. So `distill()` sends the **arc** — the original ask, waypoints sampled across the session, the recent human turns, the final assistant message, files touched, the last failure. The head is in the prompt; it never speaks alone, and the recorded title is always labelled stale.

## The index

`~/.cache/gigamanage/index.json`, keyed per file on `(mtimeMs, size)`. Unchanged files are served from cache; changed ones are re-parsed. Measured on 1,148 real sessions (523 MB): **cold 1.2s, warm 59ms**.

Writes go through a temp file and a rename, so a killed process can't leave a half-written index. A corrupt index is treated as a cache miss, not an error.

`INDEX_VERSION` must be bumped whenever `SessionRecord` changes shape, or old caches will be read back with missing fields.

## Summaries and caching

Cached at `~/.cache/gigamanage/summaries/<harness>-<id>.json`, keyed by a hash of the distilled input. A summary is stale exactly when its session's distilled content changes — not on a timer, and not when unrelated parts of the file move.

The provider is a CLI that reads a prompt on stdin and writes text. That is the whole abstraction, and it is why gigamanage doesn't depend on any particular vendor's SDK.

Which CLI gets called is resolved in this order, highest first:

1. `GIGAMANAGE_SUMMARY_CMD` — the env var, which predates config and must keep working untouched.
2. `~/.config/gigamanage/config.json` — what the user chose in `gm setup`. A `provider` of `null` means "make no model calls", and is honored as a decision rather than treated as a fault.
3. The first provider from `services/providers.ts` found on PATH.
4. `claude -p`.

Rules 3 and 4 are the behavior from before config existed, so an upgrading user with no config file sees no change.

`services/providers.ts` is deliberately **not** `adapters/registry.ts`. An adapter reads sessions; a provider makes model calls. You might read Claude Code transcripts while summarizing through Codex, and merging the two would couple things that only coincidentally share names today.

## Config vs cache

gigamanage owns two directories, and the split is load-bearing:

| | `~/.cache/gigamanage` | `~/.config/gigamanage` |
|---|---|---|
| holds | the index, summaries | the provider choice |
| keyed by | content hash | nothing |
| safe to delete | yes — it regenerates | no — you'd be re-asked |

Anything derived goes left. Anything a human typed goes right.

## Ask

`gm ask` answers questions across sessions, starting from the summaries already
on disk — one bounded prompt, not a scan of half a gigabyte.

**Its tool loop belongs to the harness, not to us.** The prompt tells the model it
may run `gm grep '<query>' --json`, and the provider is invoked with exactly that
permission (`askArgv` in the catalog; for Claude Code, `--allowedTools 'Bash(gm grep:*)'`).
gigamanage parses no tool calls and speaks no vendor protocol — which is what
keeps the provider abstraction the single line above it. Building our own loop
would mean per-vendor protocol handling: precisely the coupling this design
exists to avoid.

The trade is that we don't meter how many greps the model runs. Accepted: grep is
read-only and cheap, and the provider's own turn limit bounds it.

Because the providers we call are one-shot (`claude -p` is; `--resume` is
Claude-specific), the REPL keeps its transcript in memory and replays it each
turn. That stays bounded because the context block is.

`gm ask` spawns its provider with `GIGAMANAGE_CHILD=1`, which makes any nested
`gm` skip the background summarize pass. Without it, a model call could start a
model call.

## Search

Half a gigabyte of JSONL is too much to scan in Node, so `gm grep` shells out to ripgrep with `--json` and maps hits back onto indexed sessions by file path. Sessions are filtered *before* the search (so `--project` narrows the corpus), but results are capped *after* it — capping the corpus first would silently hide matches.

## Read-only, on purpose

gigamanage never writes to a session file. It reads harness directories and owns exactly one thing: its cache. This is what makes it safe to run against sessions that are still live and being appended to — which, on a working machine, most of them are.
