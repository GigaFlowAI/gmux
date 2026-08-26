/**
 * The shared vocabulary of gmux. Every layer speaks these types.
 *
 * `core` imports nothing internal — see docs/architecture.md for the layer rule.
 */

/** Stable identifier for a harness, e.g. "claude-code" or "codex". */
export type HarnessId = string;

/** Schema version for every `--json` payload. Bump on breaking changes. */
export const SCHEMA_VERSION = 1;

/** A session file located on disk, before it has been parsed. */
export interface SessionRef {
  harness: HarnessId;
  sessionId: string;
  filePath: string;
  /** Modification time in ms. Half of the index cache key. */
  mtimeMs: number;
  /** Size in bytes. The other half of the cache key. */
  size: number;
}

/**
 * One tmux pane as gmux sees it: geometry plus enough to resolve it to a
 * session. `command` is `pane_current_command` (the foreground process, e.g.
 * "claude", "codex", "node", "zsh") — a weak signal, since a node-based harness
 * often shows as "node"; the cwd carries most of the resolution.
 */
export interface TmuxPane {
  paneId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  cwd: string;
  command: string;
  /** The pane's shell pid — the root for resolving which agent runs in it. */
  pid: number;
  /** tmux window id (`@N`), or null on tmux builds that omit it. */
  windowId: string | null;
  /** True when this is the active pane in its window. */
  active: boolean;
}

/**
 * An exact pane→session link recorded by `gmux run`. Ephemeral runtime state: a
 * `paneId` means nothing once the tmux server dies, so this lives in the cache
 * and is pruned to the live pane set on every read of the overlay.
 */
export interface PaneLink {
  paneId: string;
  harness: HarnessId;
  sessionId: string;
}

/** A pull request a session produced. */
export interface PrLink {
  number: number;
  url: string;
  repository?: string;
}

/**
 * Hard facts about one session, extracted by an adapter.
 *
 * Everything here is free: no model call, no network. `title` comes from the
 * harness and describes where the session STARTED — prefer a SessionSummary
 * when deciding what a session ended up being about.
 */
export interface SessionRecord {
  harness: HarnessId;
  sessionId: string;
  filePath: string;
  /** Working directory the session ran in. Needed to resume in the right place. */
  cwd: string | null;
  /** Basename of `cwd`, for display. */
  project: string | null;
  gitBranch: string | null;
  startedAt: string | null;
  updatedAt: string;
  messageCount: number;
  userPromptCount: number;
  /** Harness-provided title. Reflects the START of the session; often stale. */
  title: string | null;
  /** The last thing the human actually said. The single most useful hard fact. */
  lastUserPrompt: string | null;
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
  /** Files the agent edited or wrote. */
  filesTouched: string[];
  prLinks: PrLink[];
  /** Tail of the final assistant message. Feeds the summarizer. */
  lastAssistantText: string | null;
  /** Most recent failing tool call, if any. Strong signal of unfinished work. */
  lastToolFailure: string | null;
  /** True when the session was interrupted or ended on a failure. */
  endedMidTask: boolean;
  /** Subagent transcript rather than a top-level conversation. */
  isSidechain: boolean;
  /**
   * A non-interactive run (`claude -p`, `codex exec`) rather than a conversation
   * someone sat through. Hidden by default: these are automation, not work you
   * would context-switch back into — and gmux's own summarizer creates
   * them, so listing them would make the tool pollute its own output.
   */
  isAutomated: boolean;
}

/**
 * A written summary of where a session LANDED, and what it is about.
 *
 * Generated from the session's arc — start, middle, end — so it describes the
 * latest work without losing the thread that leads to it. Never from the head
 * alone: that is just the stale harness title again.
 */
export interface SessionSummary {
  harness: HarnessId;
  sessionId: string;
  /** Hash of the distilled input. Changes when the session changes. */
  sourceHash: string;
  /**
   * SimHash of the session's narrative at summary time. Lets a watcher ask "has
   * this diverged *enough* to re-summarise?" by bit-distance, rather than
   * re-summarising on every keystroke. Absent on summaries written before 0.9.0.
   */
  fingerprint?: string;
  /**
   * Exact hash of the low-churn *significant* signals — prompt version, last tool
   * failure, mid-task flag, files touched. These always force a refresh when they
   * change, catching the small-but-important flips the SimHash distance would
   * sleep through. Absent on pre-0.9.0 summaries.
   */
  signalHash?: string;
  generatedAt: string;
  /** Provider that wrote it, e.g. "claude -p". */
  provider: string;
  /** One line: what this work IS. The scannable label; the top of the drilldown. */
  headline: string;
  /** 2-3 sentences: what the session is fundamentally about. */
  overview: string;
  /**
   * A paragraph or two: the real drilldown — how the work evolved and where it
   * stands, enough to reorient without opening the session. Absent on summaries
   * written before 0.10.0.
   */
  summary?: string;
  /** What got done most recently. */
  landed: string;
  /** What is unresolved or blocked. */
  open: string;
  /** The concrete next action. */
  nextStep: string;
}

/** A session paired with its summary, if one has been generated. */
export interface SessionView {
  record: SessionRecord;
  summary: SessionSummary | null;
}

/** The distilled arc of a session, as handed to a summary provider. */
export interface SummaryInput {
  /**
   * Bumped when the prompt changes shape. Part of the hash, and therefore of
   * the cache key: a prompt edit must invalidate summaries written by the old
   * prompt, or the change never reaches anything already on disk.
   */
  promptVersion: number;
  harness: HarnessId;
  sessionId: string;
  project: string | null;
  gitBranch: string | null;
  title: string | null;
  recentUserPrompts: string[];
  /** Evenly-spaced turns across the whole session. `[0]` is the original ask. */
  arcPrompts: string[];
  lastAssistantText: string | null;
  filesTouched: string[];
  lastToolFailure: string | null;
  endedMidTask: boolean;
  /** Stable hash of the above. The summary cache key. */
  hash: string;
}

/** The five fields a summary provider must return. */
export interface SummaryFields {
  headline: string;
  overview: string;
  summary: string;
  landed: string;
  open: string;
  nextStep: string;
}

/**
 * A model CLI gmux may call.
 *
 * `command` is argv for a one-shot call: prompt on stdin, text on stdout. That
 * is the whole contract, and it is why gmux depends on no vendor SDK.
 */
export interface ProviderChoice {
  /** Catalog id ("claude-code", "codex"), or "custom" for a hand-written command. */
  id: string;
  command: string[];
}

/** Config schema version. Bump when `GmConfig` changes shape incompatibly. */
export const CONFIG_VERSION = 1;

/**
 * The choices a human made, persisted.
 *
 * Config is NOT cache. Wiping `~/.cache/gmux` must cost you summaries,
 * never your provider choice — which is why this lives under the config dir and
 * is keyed by nothing.
 */
export interface GmConfig {
  version: number;
  /**
   * null means "make no model calls". A supported answer, not a missing value —
   * `gmux setup` offers it, and it is how you decline the token spend outright.
   */
  provider: ProviderChoice | null;
  /** Keep the recent window summarized in the background. */
  autoSummarize: boolean;
  /** gmux daemon + guardian settings. Absent on configs written before gmux. */
  gmux?: import("./gmux-types.js").GmuxConfig;
}

/** One exchange in an `gmux ask` conversation. */
export interface AskTurn {
  question: string;
  answer: string;
}

/**
 * One record in the picker's chat thread, as it is appended to disk.
 *
 * Events rather than turns, and that is forced: the echo of a question must
 * land the instant you press enter, ~9–20s before there is an answer to pair it
 * with, and the log is append-only — so "the question, and the answer when it
 * comes" has to be two records. `AskTurn` is what these fold *into*
 * (`foldCompletedTurns`), which is why the two live side by side.
 *
 * `seq` keys everything, never file order: two writers append here (the sender
 * writes `question`, the worker writes `chunk`/`end`), and a fold that depended
 * on position would depend on a lock in another module.
 *
 * `meta` is written once, by the first sender, inside the same open that creates
 * the file. Its reader is a human running `cat` on a transcript whose answers
 * look wrong: `provider` is the field that says which CLI produced them — the
 * argv, never the environment, which carries the fzf api key.
 */
export type AskEvent =
  | { t: "meta"; runId: string; startedAt: string; provider: string }
  | { t: "question"; seq: number; at: string; focus: string | null; text: string }
  | { t: "chunk"; seq: number; text: string }
  | { t: "end"; seq: number; at: string }
  | { t: "aborted"; seq: number; at: string }
  | { t: "error"; seq: number; at: string; message: string };

/** Everything `gmux ask` knows about your sessions, before a question is asked. */
export interface AskContext {
  /** The sessions the picker/list had loaded. Summaries where they exist. */
  sessions: SessionView[];
  /** The session the user was looking at when they hit ctrl-o, if any. */
  focusId: string | null;
}

/**
 * Pluggable chat provider. Mocked in tests; never called for real by them.
 *
 * Deliberately the same shape of contract as `SummaryProvider`: a prompt goes
 * in, text comes out. The difference is that the CLI behind it is invoked with
 * permission to run `gmux grep`, so the tool loop belongs to the harness rather
 * than to us.
 */
export interface AskProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  ask(prompt: string): Promise<string>;
}

/** Pluggable summarizer. Mocked in tests; never called for real by them. */
export interface SummaryProvider {
  /** Human-readable name, recorded on the summary. */
  readonly name: string;
  /** True when the underlying CLI is actually installed. */
  isAvailable(): Promise<boolean>;
  generate(input: SummaryInput): Promise<SummaryFields>;
}

/** One hit from a full-text search, resolved back to its session. */
export interface SearchHit {
  session: SessionRecord;
  matchCount: number;
  /** Representative matching lines, already trimmed for display. */
  snippets: string[];
}

/** Filters shared by `ls` and the picker. */
export interface ListFilters {
  harness?: string;
  project?: string;
  branch?: string;
  /** ISO timestamp; sessions older than this are dropped. */
  since?: string;
  limit?: number;
  includeSidechains?: boolean;
  includeAutomated?: boolean;
}
