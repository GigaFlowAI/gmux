# Adding a harness

Supporting a new agent harness is one file and one line. If it takes more than that, the abstraction is wrong and that's a bug worth reporting.

## The interface

Implement `HarnessAdapter` (`src/adapters/types.ts`):

```ts
export interface HarnessAdapter {
  readonly id: string;            // "my-agent" — appears in --harness and in --json
  readonly displayName: string;   // "My Agent"

  isAvailable(): Promise<boolean>;                  // does this machine store sessions for it?
  listSessions(): Promise<SessionRef[]>;            // stat only — no parsing
  parseSession(ref: SessionRef): Promise<SessionRecord>;
  resumeCommand(record: SessionRecord): ResumeCommand;  // argv, not a shell string
}
```

Then add it to `allAdapters()` in `src/adapters/registry.ts`. That's the whole registration.

## What good looks like

**`isAvailable()`** should check for the session directory, not for the binary. A user may have transcripts from an agent they've since uninstalled, and they still deserve to search them.

**`listSessions()`** must be cheap: `readdir` + `stat`, no file reads. It runs on every invocation. Recurse if your harness nests sessions (Claude Code hides subagent transcripts several levels down; Codex nests by date).

**`parseSession()`** should stream the file — use `readJsonl()` from `src/adapters/jsonl.ts`. Sessions get large. Never read one into a single string.

**`resumeCommand()`** returns argv plus the directory to run in. Returning argv rather than a string means nothing has to be shell-escaped, and a path with a space in it can't break anything.

## Filling in a SessionRecord

Everything is nullable except `sessionId`, `updatedAt` and the flags. Set what your harness records and leave the rest null — the UI degrades gracefully. But get these right, because they carry most of the value:

| Field | Why it matters |
|---|---|
| `cwd` | Without it, `gm resume` can't return to the right directory. |
| `recentUserPrompts` | The summarizer's main evidence. **Only real human turns.** |
| `arcPrompts` | An evenly-spaced sample of human turns across the WHOLE session, oldest first — `[0]` is the original ask. `recentUserPrompts` says how the work ended; this says what shape it had. Both feed the summarizer. |
| `lastAssistantText` | Where the work ended up. |
| `filesTouched` | What the session actually changed. |
| `lastToolFailure` | The single best predictor of unfinished work. |
| `endedMidTask` | Flags the `⚠` sessions — usually the ones you're hunting for. |
| `isAutomated` | True for non-interactive runs (`-p` / `exec` modes). See below. |
| `isSidechain` | True for subagent transcripts. |

### Two traps, both learned the hard way

**Not every "user" message is a human turn.** Harnesses stuff tool results, system reminders, and slash-command envelopes into user-role records. If you let those through, they become the model's evidence and the summaries turn to mush. See `humanText()` in `claude-code.ts` for the filtering pattern — and apply it uniformly: the same filtered text must go into both `recentUserPrompts` and `arcPrompts`, never raw content into the arc. Use `DecimatingSampler` in `src/adapters/jsonl.ts` to build `arcPrompts` — it keeps the whole session's shape in bounded memory and never drops the first turn.

**Your harness's headless mode creates real sessions.** gigamanage summarizes by shelling out to a model CLI — which, if that CLI is your harness, writes a new session containing gigamanage's own prompt. Set `isAutomated` for non-interactive runs (Claude Code marks them `entrypoint: "sdk-cli"`; Codex marks them `originator: "codex_exec"`) or the tool will pollute its own output.

## Testing it

Add a fixture builder to `tests/fixtures/build.ts` that writes a small, *realistic* transcript — including the awkward parts: injected reminders, tool results, escaped payloads. Then assert, in `tests/adapters.test.ts`:

- discovery finds the session
- only human turns land in `recentUserPrompts`
- the original ask survives in `arcPrompts` on a session longer than the tail window (`RECENT_PROMPT_COUNT = 12`) — that's the case the arc exists for, and the one a tail-only adapter silently gets wrong
- `filesTouched` is right
- an interrupted session sets `endedMidTask`
- a headless run sets `isAutomated`
- `resumeCommand()` produces the argv you'd type yourself

Point `GIGAMANAGE_HOME` at a temp directory. Never read the real `~`.

## Checklist

- [ ] `src/adapters/<harness>.ts` implements `HarnessAdapter`
- [ ] registered in `src/adapters/registry.ts`
- [ ] fixture in `tests/fixtures/build.ts`
- [ ] tests in `tests/adapters.test.ts`
- [ ] `npm run check` passes
- [ ] `gm doctor` lists your harness
