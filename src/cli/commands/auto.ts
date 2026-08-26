import type { Command } from "commander";

import {
  AUTO_SUMMARIZE_COMMAND,
  releaseLock,
  runAutoSummarize,
} from "../../services/auto-summarize.js";
import { defaultSummaryProvider } from "../../services/summarize.js";

/**
 * The background worker, re-entered as `gm __auto-summarize`.
 *
 * Hidden: it is not a thing a person runs. It exists so the foreground command
 * can hand the slow model calls to a detached copy of itself and exit.
 *
 * It writes nothing to stdout or stderr — its stdio is `ignore`d anyway — and it
 * exits 0 whatever happens. A failed background summary is not the user's
 * problem; the row simply stays marked "no summary yet".
 */
export function registerAutoSummarizeWorker(program: Command): void {
  program
    .command(AUTO_SUMMARIZE_COMMAND, { hidden: true })
    .description("internal: write summaries for recent sessions (run detached by gm itself)")
    .action(async () => {
      // A null provider means the user configured "no model calls". Same
      // outcome as a missing binary: drop the lock and do nothing.
      const provider = await defaultSummaryProvider();
      if (!provider || !(await provider.isAvailable())) {
        await releaseLock();
        return;
      }
      await runAutoSummarize(provider);
    });
}
