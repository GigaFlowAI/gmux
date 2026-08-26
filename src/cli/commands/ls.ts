import type { Command } from "commander";

import { SCHEMA_VERSION, type ListFilters } from "../../core/types.js";
import { parseSince } from "../../core/text.js";
import { GigamanageError } from "../../core/errors.js";
import { loadViews } from "../../services/views.js";
import { inProgressIds, maybeAutoSummarize } from "../../services/auto-summarize.js";
import { dim, formatLegend, formatRowLines, jsonEnvelope, terminalWidth } from "../format.js";

export interface LsOptions {
  harness?: string;
  project?: string;
  branch?: string;
  since?: string;
  limit?: string;
  includeSidechains?: boolean;
  includeAutomated?: boolean;
  json?: boolean;
  autoSummarize?: boolean;
  resumeInWindow?: boolean;
}

/**
 * Whether `--no-auto-summarize` was passed.
 *
 * MUST be read with `optsWithGlobals`. `--no-auto-summarize` is declared on the
 * ROOT program, and commander does not copy root options into a subcommand's
 * own `opts()` — reading `options.autoSummarize` there yields `undefined`
 * forever, so `undefined !== false` is always true and the flag silently does
 * nothing. That is exactly what `gm --no-auto-summarize ls` did before this
 * existed: it spent tokens the user had explicitly declined.
 *
 * Shared by `ls`, `pick` and `__picker-rows` so the three cannot drift apart.
 */
export function autoSummarizeRequested(command: Command): boolean {
  return command.optsWithGlobals()["autoSummarize"] !== false;
}

/** Shared by `ls` and the picker so both filter identically. */
export function toFilters(options: LsOptions, fallbackLimit: number): ListFilters {
  const filters: ListFilters = {
    includeSidechains: options.includeSidechains === true,
    includeAutomated: options.includeAutomated === true,
    limit: options.limit ? Number.parseInt(options.limit, 10) : fallbackLimit,
  };
  if (options.harness) filters.harness = options.harness;
  if (options.project) filters.project = options.project;
  if (options.branch) filters.branch = options.branch;

  if (options.since) {
    const cutoff = parseSince(options.since);
    if (!cutoff) {
      throw new GigamanageError(`Could not understand --since "${options.since}".`, {
        fix: "Use a duration like `3d`, `12h`, `2w`, or an ISO date like `2026-07-01`.",
        exitCode: 2,
      });
    }
    filters.since = cutoff;
  }
  return filters;
}

export function registerLs(program: Command): void {
  program
    .command("ls")
    .description("list recent sessions, most recent first")
    .option("--harness <id>", "only this harness (claude-code, codex)")
    .option("-p, --project <name>", "only sessions whose project matches")
    .option("-b, --branch <name>", "only sessions whose git branch matches")
    .option("-s, --since <when>", "only sessions newer than this (3d, 12h, 2w, or a date)")
    .option("-n, --limit <count>", "how many to show", "20")
    .option("--include-sidechains", "include subagent transcripts")
    .option("--include-automated", "include non-interactive runs (claude -p, codex exec)")
    .option("--json", "emit JSON for scripts and agents")
    .action(async (options: LsOptions, command: Command) => {
      const views = await loadViews(toFilters(options, 20));

      if (options.json) {
        process.stdout.write(`${jsonEnvelope(SCHEMA_VERSION, views)}\n`);
        return;
      }

      if (views.length === 0) {
        process.stdout.write(`${dim("No sessions matched.")}\n`);
        return;
      }

      // Kick the background pass off BEFORE rendering, over exactly the sessions
      // we are about to show — so `gm ls -n 50` summarizes all fifty, and the
      // rows it just picked up can be marked ◐ on this very run rather than the
      // next one. Deciding costs a lock write and a spawn; the model calls all
      // happen in the detached child.
      const started = await maybeAutoSummarize({
        records: views.map((v) => v.record),
        enabled: autoSummarizeRequested(command),
        notify: (message) => process.stderr.write(`${dim(message)}\n`),
      });

      // Rows already in flight from an earlier run count too.
      const inProgress = new Set([...(await inProgressIds()), ...started.targetIds]);

      // Wrap to the terminal so a long summary is readable in full. When piped,
      // stay one line per session so `gm ls | grep` still works.
      const width = process.stdout.isTTY ? terminalWidth() : Number.POSITIVE_INFINITY;
      const now = new Date();
      for (const view of views) {
        for (const line of formatRowLines(view, now, width, inProgress)) {
          process.stdout.write(`${line}\n`);
        }
      }

      const legend = formatLegend(views, inProgress);
      if (legend !== "") process.stdout.write(`\n${legend}\n`);
    });
}
