/**
 * Error taxonomy.
 *
 * Harness-engineering rule: an error message carries the fix inline. A user —
 * or an agent — should never have to guess the next command. `fix` is printed
 * directly beneath the message and included in `--json` output.
 */

export class GigamanageError extends Error {
  /** The exact command or action that resolves this error. */
  readonly fix: string | undefined;
  /** Process exit code. */
  readonly exitCode: number;

  constructor(message: string, options: { fix?: string; exitCode?: number } = {}) {
    super(message);
    this.name = "GigamanageError";
    this.fix = options.fix;
    this.exitCode = options.exitCode ?? 1;
  }
}

/** No session matched the given id or prefix. */
export class SessionNotFoundError extends GigamanageError {
  constructor(id: string) {
    super(`No session matches "${id}".`, {
      fix: "Run `gm ls` to see recent sessions, or `gm index --rebuild` if the cache is stale.",
      exitCode: 4,
    });
    this.name = "SessionNotFoundError";
  }
}

/** A prefix matched more than one session. */
export class AmbiguousSessionError extends GigamanageError {
  constructor(id: string, matches: string[]) {
    const shown = matches.slice(0, 5).join(", ");
    super(`"${id}" matches ${matches.length} sessions: ${shown}${matches.length > 5 ? ", …" : ""}`, {
      fix: "Pass more characters of the session id to disambiguate.",
      exitCode: 5,
    });
    this.name = "AmbiguousSessionError";
  }
}

/** A required external binary is missing. */
export class MissingDependencyError extends GigamanageError {
  constructor(binary: string, fix: string) {
    super(`Required command "${binary}" was not found on PATH.`, { fix, exitCode: 6 });
    this.name = "MissingDependencyError";
  }
}

/** A summary provider returned something unusable. */
export class SummaryProviderError extends GigamanageError {
  constructor(provider: string, detail: string) {
    super(`Summary provider "${provider}" failed: ${detail}`, {
      fix: "Check the provider CLI works standalone, or run `gm setup` to choose another.",
      exitCode: 7,
    });
    this.name = "SummaryProviderError";
  }
}

/**
 * The chat provider behind `gm ask` failed or said nothing.
 *
 * The fix names the provider that actually failed. It used to hardcode
 * `claude -p`, which told a user who had configured Codex to go and test a
 * binary they may not even have — non-negotiable #5 asks for the fix to the
 * problem in front of you, not to the common case.
 */
export class AskProviderError extends GigamanageError {
  constructor(provider: string, detail: string) {
    super(`Ask provider "${provider}" failed: ${detail}`, {
      fix: `Check it works standalone: \`echo hi | ${provider}\`. Or run \`gm setup\` to choose another.`,
      exitCode: 7,
    });
    this.name = "AskProviderError";
  }
}

/**
 * No provider is configured — because the user chose "none" in `gm setup`.
 *
 * Distinct from a missing binary, and it must stay distinct: this is a choice
 * being honored, not a fault. The fix says how to change your mind, not how to
 * install something.
 */
export class NoProviderError extends GigamanageError {
  constructor(what: string) {
    super(`${what} needs a model provider, and this machine is configured to make no model calls.`, {
      fix: "Run `gm setup` to choose one, or set GIGAMANAGE_SUMMARY_CMD for a one-off.",
      exitCode: 8,
    });
    this.name = "NoProviderError";
  }
}
