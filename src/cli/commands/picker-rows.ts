import type { Command } from "commander";

import { inProgressIds, maybeAutoSummarize } from "../../services/auto-summarize.js";
import { loadViews } from "../../services/views.js";
import { buildFzfRecords, fzfVersion, supportsMultiline } from "../picker.js";
import { PICKER_ROWS_COMMAND, type PickerRowsOptions } from "./pick.js";
import { autoSummarizeRequested, toFilters } from "./ls.js";

/**
 * The picker's ctrl-r target, re-entered as `gm __picker-rows`.
 *
 * Hidden: like `__auto-summarize`, it is not a thing a person runs. fzf's
 * `reload` binding replaces its item list with a command's stdout, so refresh
 * is exactly "print the records again, having first kicked off summaries".
 *
 * Two rules, both because fzf owns the terminal while this runs:
 *
 * 1. NOTHING goes to stderr. `maybeAutoSummarize`'s notice would land on top of
 *    the picker and corrupt the display. The `◐` markers are the notice here.
 * 2. Width comes from `--width`, not from measuring. Our stdout is a pipe, so
 *    `terminalWidth()` would report its default and every row would reflow to a
 *    different width than it had on open.
 */
export function registerPickerRows(program: Command): void {
  program
    .command(PICKER_ROWS_COMMAND, { hidden: true })
    .description("internal: print picker rows (run by the picker's ctrl-r binding)")
    .option("--harness <id>", "only this harness")
    .option("-p, --project <name>", "only sessions whose project matches")
    .option("-b, --branch <name>", "only sessions whose git branch matches")
    .option("-s, --since <when>", "only sessions newer than this")
    .option("-n, --limit <count>", "how many sessions to offer", "50")
    .option("--include-sidechains", "include subagent transcripts")
    .option("--include-automated", "include non-interactive runs")
    .option("--width <columns>", "list column width, measured by the parent")
    .action(async (options: PickerRowsOptions, command: Command) => {
      const views = await loadViews(toFilters(options, 50));

      // Forced: the user pressed a key. The lock still stops a stampede, and
      // `--no-auto-summarize` — forwarded by pickerReloadArgs — still wins.
      const started = await maybeAutoSummarize({
        records: views.map((v) => v.record),
        enabled: autoSummarizeRequested(command),
        force: true,
      });

      const inProgress = new Set([...(await inProgressIds()), ...started.targetIds]);
      const width = Number.parseInt(options.width ?? "", 10);

      process.stdout.write(
        buildFzfRecords(
          views,
          supportsMultiline(fzfVersion()),
          Number.isFinite(width) && width > 0 ? width : undefined,
          new Date(),
          inProgress,
        ),
      );
    });
}
