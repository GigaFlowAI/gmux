/**
 * The shared vocabulary of gigamanage. Every layer speaks these types.
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
