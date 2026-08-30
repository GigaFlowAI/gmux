# Contributing to gigamanage

Contributions are welcome — especially **adapters for other harnesses**. If you use an agent gigamanage doesn't read yet, that's the highest-value thing you can add, and it's one file.

## Setup

```bash
npm install
npm test          # layer check + unit tests
npm run check     # layer check + typecheck + tests — run this before opening a PR
npm run dev -- ls # run the CLI from source
```

Node 20 or newer. No other services, no API keys: the test suite never calls a model.

## The one rule that matters

gigamanage has a strict, one-way dependency order:

```
core  ←  adapters  ←  services  ←  cli
```

A module may import from its own layer or any layer to its **left**, never to its right.

- `core` — types, errors, pure helpers. Imports nothing internal. No I/O.
- `adapters` — one per harness: find sessions, parse them, know how to resume them.
- `services` — the index cache, distillation, summarization, search.
- `cli` — commands, formatting, the picker.

This isn't a style preference, and it isn't enforced by asking nicely. `npm test` runs `scripts/check-layers.mjs`, which fails the build on a violation and prints the fix. It exists so that `core` stays testable, adapters stay swappable, and logic doesn't quietly accumulate in the CLI where it can't be reused or tested.

If you find yourself wanting to import "rightward," the answer is almost always to move the shared thing *down* into a lower layer, or to pass it in as an argument.

## Adding a harness

Read [`docs/adding-a-harness.md`](docs/adding-a-harness.md). Short version: implement `HarnessAdapter` in `src/adapters/<your-harness>.ts`, register it in `src/adapters/registry.ts`, add a fixture and a test. Nothing else changes.

## Testing

We test against **real session files** written to a temp directory, not mocks of the filesystem. `tests/fixtures/build.ts` writes small but realistic transcripts, including the messy parts — injected system reminders, tool results masquerading as user turns, JSON-escaped patch payloads. Those messy cases are where the bugs live; please add fixtures rather than trimming them out.

Two hard rules:

1. **No test may call a real model.** Summary providers are injected; use a fake. A test suite that costs money is a test suite people stop running.
2. **No test may read the developer's real `~/.claude` or `~/.codex`.** Point `GIGAMANAGE_HOME` at a temp directory (the existing tests show how).

## Principles

gigamanage tries to follow a few ideas from [harness engineering](https://openai.com/index/harness-engineering/) — the practice of building environments that both humans and agents can work in:

- **If it can't be retrieved at runtime, it doesn't exist.** Every read command supports `--json`, on a versioned schema. gigamanage is a tool agents call, not just one people type. New commands ship with `--json` from day one.
- **Errors carry their own fix.** Every `GigamanageError` takes a `fix` string that names the exact command to run. If you add an error and can't articulate the fix, that's a signal the error is in the wrong place.
- **Mechanical enforcement over convention.** See the layer rule above.
- **Read-only, always.** gigamanage must never write to a session file. It owns its cache and nothing else. A PR that writes into `~/.claude` or `~/.codex` will be rejected regardless of how useful it is.

## Releasing (maintainers)

Releases are published to npm by CI, never from a laptop:

```bash
npm version minor        # or patch / major — commits and tags
git push --follow-tags   # the v* tag triggers .github/workflows/release.yml
```

The workflow runs the full check suite before publishing; a release that can't
pass its own tests doesn't ship.

Authentication is [trusted publishing](https://docs.npmjs.com/trusted-publishers/)
(OIDC) — there is **no `NPM_TOKEN`**. GitHub Actions proves the workflow's
identity to npm directly, so there is no long-lived credential to leak, rotate,
or mis-scope, and npm attaches a provenance attestation automatically: a signed
record that the published package was built from a specific commit by a specific
workflow.

The trust config is bound to the workflow **filename**. If you rename
`release.yml`, publishing breaks until you re-point it:

```bash
npm trust github gigamanage --file <new-name>.yml \
  --repo GigaFlowAI/gigamanage --allow-publish
```

One wrinkle, since it is a real npm limitation rather than an oversight here:
**OIDC cannot perform a package's first publish.** npm requires the package to
exist before a trusted publisher can be attached to it, so v0.1.0 was published
with a credential and every release after it is tokenless.

## Pull requests

- Run `npm run check` first.
- One concern per PR.
- If you change what a `SessionRecord` contains, bump `INDEX_VERSION` in `src/services/index-store.ts` so stale caches are discarded rather than silently misread.
- Describe the behavior you observed, not just the code you wrote. "Ran `gm ls` against 1,100 real sessions, cold index 1.2s" is worth more than a paragraph of description.
