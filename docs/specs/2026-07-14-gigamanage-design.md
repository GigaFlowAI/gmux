# gigamanage — design

**Date:** 2026-07-14
**Status:** approved

**Amended 2026-07-17:** the summary design below was revised — summaries now
describe the session's arc rather than only its tail, and carry a fifth
field, `overview`. See [`2026-07-17-summary-overview-design.md`](2026-07-17-summary-overview-design.md).

## Problem

Agent coding sessions accumulate faster than memory of them does. On the author's machine: 1,139 Claude Code sessions across 55 project directories (523 MB of JSONL), plus a growing pile of Codex rollouts. Switching context — "what was I doing in that repo last week, and did it finish?" — means guessing from a picker sorted by time, with titles that describe where each session *started*.

The title problem is the crux. Claude Code stamps an `aiTitle` early in a session and never revises it. For a long session it names the opening prompt, not the state the work ended in. That is precisely the wrong signal for deciding what to pick up next.

## Goal

One CLI, `gm`, that answers "what was I doing, and what should I pick up?" in seconds — then puts you back in the session.

Non-goals: editing sessions, syncing them anywhere, a web UI, a daemon.

## Principles (from harness engineering)

The design follows OpenAI's harness-engineering post. Four tenets shape it concretely:

1. **"Anything the agent cannot access at runtime does not exist."** Every read command emits `--json` on a stable schema. `gm` is not only a human tool; it is a tool an *agent* can call to retrieve prior context. A first-class interface, not a debug flag.
2. **Mechanical enforcement over convention.** The one-way layer rule is enforced by a lint script in CI, and its error message carries the fix inline.
3. **Compact agent-facing docs.** `AGENTS.md` is a short navigation map into `docs/`, not a manual. When everything is important, nothing is.
4. **Fast feedback.** Warm listing in milliseconds, tests that never call a real model, and a `gm doctor` that names every missing piece and the exact command that fixes it.

## Harness compatibility

"Compatible with any agent harness" means three distinct things, all in scope:

| Dimension | Meaning |
|---|---|
| **Read** | Discover and parse sessions from any harness. One adapter per harness. |
| **Resume** | Hand off to the right CLI: `claude --resume <id>` vs `codex resume <id>`. |
| **Be called by** | Any agent can shell out to `gm ... --json` to retrieve prior context. |

Shipping adapters: **Claude Code** (`~/.claude/projects/**/*.jsonl`) and **Codex** (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`). Adding a harness is one file implementing `HarnessAdapter`; no other layer changes.

## Architecture

Strict one-way dependency layers. Imports may only point left.

```
core  ←  adapters  ←  services  ←  cli
```

- **`core/`** — types, time/text helpers, error taxonomy. Imports nothing internal.
- **`adapters/`** — per-harness discovery, parsing, resume argv. Imports `core` only.
- **`services/`** — index cache, distillation, summarization, search. Imports `core` + `adapters`.
- **`cli/`** — command wiring, formatting, picker. May import anything.

Enforced by `scripts/check-layers.mjs`, run in CI and in `npm test`. A violation prints the offending import and the rule that forbids it.

### Data flow

```
harness dirs → adapter.listSessions() → SessionRef[]
             → adapter.parseSession() → SessionRecord   (hard facts, free)
             → index cache (mtime+size keyed)           → instant `gm ls`
             → distill(record)        → SummaryInput    (the session's arc)
             → SummaryProvider        → SessionSummary  (LLM, cached)
```

### The index

`~/.cache/gigamanage/index.json`, keyed by file path with `mtimeMs` + `size`. Cold build parses every session once, in parallel; afterwards only changed files re-parse. This is what makes a flat recent-list across 523 MB viable at startup.

### Summaries — the point of the tool

Two tiers, because they cost different amounts.

**Hard facts** (free, extracted during parsing): files touched, PR links, branch, verbatim last user prompt, last tool failure, and whether the session ended mid-task.

**Written summary** (LLM, cached). The distiller feeds the model the session's **arc**, never the whole transcript: the original ask, waypoints sampled evenly across the session, recent user prompts, the final assistant message, files touched, and any failing tool call. It returns five fields:

- `headline` — one line: what the work IS, the overview compressed to a list row
- `overview` — 2-3 sentences on what the session is fundamentally about
- `landed` — the most recent work done
- `open` — what is unresolved or blocked
- `nextStep` — the concrete next action

Never-head-only is the correctness property, not tail-only. The head — the original ask — is in the prompt, but it never speaks alone, and the recorded title is always labelled stale rather than trusted. Tail-only was an overcorrection: a status with no subject ("timestamp check still red") is unreadable next to twenty other sessions.

Cached at `~/.cache/gigamanage/summaries/<harness>-<id>.json`, keyed by a content hash of the distilled input. Regenerated only when the session changes. The provider is pluggable and harness-agnostic: it defaults to `claude -p`, and honors `GIGAMANAGE_SUMMARY_CMD` so a Codex user can point it at `codex exec`.

**Cost control:** no automatic backfill. `gm ls` never blocks on a model; rows without a summary render from hard facts and carry a `~` marker. `gm summarize --recent 20` warms what you care about; `--all` is opt-in and explicit.

## Commands

```
gm                    picker: recent across all harnesses → enter resumes
gm ls                 recent list   [--harness --project --branch --since --limit --json]
gm grep <query>       ripgrep across all transcripts, grouped by session
gm show <id>          full context card    [--json]
gm resume <id>        exec the right harness CLI in the session's cwd
gm summarize          generate/refresh summaries  [--recent N | --all | --force]
gm index --rebuild    rebuild the cache
gm doctor             report what is installed/missing, and the fix for each
```

`<id>` accepts any unique prefix.

## Behavior

- **Sidechains** (subagent transcripts) are excluded by default; `--include-sidechains` shows them.
- **fzf is optional.** Present → fuzzy picker with a preview pane. Absent → plain numbered list, and `gm doctor` names the `brew install fzf` that upgrades it. No hard system dependency.
- **Piped output** drops ANSI automatically. `--json` is stable and versioned.
- **Read-only.** gigamanage never writes to a session file. It owns only its cache.

## Testing

TDD against small hand-built JSONL fixtures for both harnesses. Covered: adapter field extraction, id-prefix resolution, index cache invalidation on mtime change, grep→session mapping, summary cache keying, and the layer lint itself. The summary provider is mocked — **no test ever calls a real model**.

## Open source

MIT. `README.md` (what it is, install, usage), `CONTRIBUTING.md` (setup, the layer rule, how to add a harness adapter), `AGENTS.md` (compact map for agents working in this repo), CI running lint + layer check + tests on Node 20/22.
