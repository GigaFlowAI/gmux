# Setup and Ask — design

**Status:** approved
**Date:** 2026-07-16

Two features that share one dependency: gigamanage needs to know *which model CLI
to call*, and that answer needs somewhere to live.

1. `gm setup` — choose the harness used for LLM calls, persistently.
2. `gm ask` — a chat layer over the summaries already loaded, reachable from the
   picker with `ctrl-o`.

## Why they go together

Today the provider is `GIGAMANAGE_SUMMARY_CMD`, an environment variable, and
gigamanage owns no config file at all. That is survivable for one background
feature the user never invokes directly. It is not survivable for a second,
interactive feature: `gm ask` is a thing you *choose* to run, and it must not
fail with "set this env var and try again."

So `setup` exists to answer "which harness?", and `ask` is the first consumer
that makes the answer visible.

## Part 1 — Config

### Where it lives

`~/.config/gigamanage/config.json`, honoring `XDG_CONFIG_HOME`.

This is the first thing gigamanage owns outside `~/.cache/gigamanage`. The
`AGENTS.md` non-negotiable ("gigamanage owns only `~/.cache/gigamanage`") is
amended to name both directories, because **config is not cache**: `rm -rf` the
cache and you should lose summaries, not your provider choice. Anything keyed by
content hash belongs in the cache; anything a human chose belongs in config.

### Shape

```json
{
  "version": 1,
  "provider": { "id": "claude-code", "command": ["claude", "-p"] },
  "autoSummarize": true
}
```

`provider: null` means "no LLM calls" — a real, supported choice. `version` is
for migration; an unreadable or future-versioned config is treated as absent,
never as an error. A corrupt config must not brick `gm ls`.

### Resolution order

Highest wins:

1. `GIGAMANAGE_SUMMARY_CMD` (env)
2. `config.provider.command`
3. First detected provider from the catalog
4. `claude -p`

The env var staying on top is what keeps every existing test, script and CI job
working without change. Rules 3 and 4 are today's behavior, preserved exactly —
so a user with no config file sees no difference.

### The provider catalog

`src/services/providers.ts`, separate from `src/adapters/registry.ts`.

These are different axes and must not be conflated. Adapters *read* sessions;
providers *make model calls*. You might read Claude Code transcripts while
running summaries through Codex, and a provider may exist that no adapter
parses. Merging them would couple two things that only coincidentally share
names today.

| id | binary | summary argv | ask argv |
|---|---|---|---|
| `claude-code` | `claude` | `claude -p` | `claude -p --allowedTools 'Bash(gm grep:*)'` |
| `codex` | `codex` | `codex exec` | `codex exec --sandbox read-only` |
| `custom` | — | user-supplied | user-supplied |

Detection is `which <binary>`, reusing the probe `CliSummaryProvider.isAvailable()`
already has.

### The wizard

`gm setup` detects what is installed, asks which provider to use, asks whether
to keep background summaries on, writes the config. It is idempotent and shows
the current choice when one exists.

### First-run trigger

The wizard runs on a bare `gm` only when **all** hold:

- no config file exists, and
- `stdin` and `stdout` are both TTYs, and
- not `--json`, and
- not the `__auto-summarize` worker or `__picker-rows`, and
- not `gm setup` itself.

Any gate failing means today's behavior exactly: autodetect, carry on, no
prompt. This is what keeps `gm ls --json` usable by an agent — non-negotiable #4
says every read command supports `--json`, and a command that blocks on a TTY
prompt has broken that promise regardless of what it prints.

## Part 2 — `gm ask`

### Context

The same `SessionView[]` the picker loads (default 20), flattened to a compact
block: headline, landed, open, next step, plus the free hard facts (project,
branch, files touched, mid-task flag). A few KB — the same discipline `distill()`
holds to, and for the same reason.

`--focus <id>` marks one session as the one the user is looking at.

### The tool loop is the harness's, not ours

The prompt tells the model it may run `gm grep '<query>' --json` for detail, and
we invoke the provider's *ask argv*, which grants exactly that one tool.

We write no tool-call parsing and depend on no vendor SDK. The provider
abstraction stays what `docs/architecture.md` says it is — "a CLI that reads a
prompt on stdin and writes text" — which is the entire reason gigamanage depends
on no vendor. Building our own loop would mean per-vendor protocol handling:
precisely the coupling the architecture exists to avoid.

The cost is that we do not control how many greps the model runs. Accepted: the
grep is read-only, cheap, and bounded by the provider's own turn limit.

### Multi-turn without vendor coupling

`claude -p` is one-shot, and `--resume` is Claude-specific. The REPL therefore
holds the transcript in memory and re-sends context + prior turns each turn.
Bounded, because the context block is bounded.

### Surface

| Invocation | Behavior |
|---|---|
| `gm ask` | REPL. ctrl-d or a blank line returns. |
| `gm ask "<q>"` | One-shot; prints the answer. |
| `gm ask "<q>" --json` | Envelope `{ answer, provider, sessionCount }`. |

The one-shot exists because of non-negotiable #4, not as extra scope.

### Recursion guards

Two, both load-bearing:

1. **Nested `gm` must not summarize.** The agent running `gm grep` fires
   `main.ts`'s `postAction` hook, spawning another detached summarizer. The lock
   in `auto-summarize.ts` would mostly absorb it, but the correct fix is an env
   marker — `GIGAMANAGE_CHILD=1`, set when we spawn the provider — that makes
   nested `gm` calls skip the pass entirely.
2. **`gm ask`'s own session must stay invisible.** Already handled: `claude -p`
   sets `isAutomated`, which is hidden by default. Do not undo this.

## Part 3 — The picker

### The key: `ctrl-o`

Not `shift+f`. fzf's query line consumes plain letter keys — `F` types an `F`
into the search box, indistinguishable from a search keystroke.

Not `alt-a`, the obvious "ask" mnemonic: macOS Terminal and iTerm2 both send
accented characters on Option by default, so it would silently do nothing for
most users on the platform this is developed on.

Not `ctrl-s`/`ctrl-q`: terminal flow control.

`ctrl-o` is unbound in fzf and safe everywhere.

### Binding

```
--bind=ctrl-o:execute(<self> ask --focus {1})
```

`execute()` suspends fzf, hands the child the terminal, and restores the list on
exit. `{1}` is the session id field, so the model knows which session you were
looking at.

It reuses `selfCommand()` and takes the same null-guard as `reloadCommand()`: a
key that cannot be bound is not advertised, because a key that does nothing is
worse than a key that isn't there.

Header: `enter: resume   ctrl-r: refresh   ctrl-o: ask   ctrl-c: cancel`.

The no-fzf numbered fallback gets `a`, alongside its existing `r`.

## Layers

```
core      types (GmConfig, AskProvider, AskContext), configDir/configPath
services  providers catalog, config load/save/resolve, ask context + provider
cli       setup wizard, ask REPL, picker binding
```

No rightward imports. `scripts/check-layers.mjs` enforces it.

## Testing

- Fake `AskProvider`. **No test calls a real model** (non-negotiable #2).
- `XDG_CONFIG_HOME` to a temp dir. **No test reads the real home** (#3).
- Pure units get direct tests: resolution precedence, the first-run gate
  predicate, `fzfArgs` with and without the ask binding, context flattening.
- The gate is a pure function of `(hasConfig, isTty, isJson, commandName)` so it
  is testable without a terminal — the same reason `fzfArgs` is split from the
  spawn.

## What this is not

- Not a general chat UI. It answers questions about *your sessions*.
- Not a summary rewrite. `distill()` and the summary cache are untouched.
- Not a vendor integration. No SDK, no API keys, no protocol handling.
