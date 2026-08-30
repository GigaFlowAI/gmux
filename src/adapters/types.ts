import type { SessionRecord, SessionRef, HarnessId } from "../core/types.js";

/**
 * The one seam that makes gigamanage harness-agnostic.
 *
 * To support a new agent harness, implement this interface in a single file
 * under `src/adapters/` and register it in `registry.ts`. Nothing else in the
 * codebase changes. See docs/adding-a-harness.md.
 */
export interface HarnessAdapter {
  /** Stable id, e.g. "claude-code". Appears in `--json` and in `--harness`. */
  readonly id: HarnessId;

  /** Name shown to humans, e.g. "Claude Code". */
  readonly displayName: string;

  /**
   * Distinctive `pane_current_command` names that mean "this harness". Used only
   * to *prefer* a harness when resolving a pane; matching is a hint, never a
   * gate, because a node-based harness often shows as "node". List only names
   * that unambiguously identify this harness — omit "node".
   */
  readonly processNames: readonly string[];

  /** The binary `gm run` launches for this harness, e.g. "claude" or "codex". */
  readonly launchCommand: string;

  /**
   * True when this harness stores sessions on this machine. Adapters whose
   * harness isn't installed are skipped silently rather than erroring.
   */
  isAvailable(): Promise<boolean>;

  /** Every session file this harness has written. Cheap: stats only, no parsing. */
  listSessions(): Promise<SessionRef[]>;

  /** Parse one session file into hard facts. No model calls, no network. */
  parseSession(ref: SessionRef): Promise<SessionRecord>;

  /**
   * The command that drops the user back into this session.
   * Returned as argv rather than a string so nothing has to be shell-escaped.
   */
  resumeCommand(record: SessionRecord): ResumeCommand;
}

export interface ResumeCommand {
  command: string;
  args: string[];
  /** Directory to run it in — normally the session's original cwd. */
  cwd: string;
}
