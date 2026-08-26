import type { Command } from "commander";

import { SCHEMA_VERSION } from "../../core/types.js";
import { relativeAge } from "../../core/text.js";
import { loadRecords } from "../../services/views.js";
import { searchSessions } from "../../services/search.js";
import { bold, cyan, dim, jsonEnvelope, sessionLabel } from "../format.js";
import { toFilters, type LsOptions } from "./ls.js";

export function registerGrep(program: Command): void {
  program
    .command("grep <query>")
    .description("search the full text of every transcript, grouped by session")
    .option("--harness <id>", "only this harness")
    .option("-p, --project <name>", "only sessions whose project matches")
    .option("-s, --since <when>", "only sessions newer than this (3d, 12h, 2w)")
    .option("-n, --limit <count>", "max sessions to report", "20")
    .option("-e, --regex", "treat the query as a regular expression")
    .option("-C, --case-sensitive", "match case")
    .option("--include-sidechains", "include subagent transcripts")
    .option("--include-automated", "include non-interactive runs (claude -p, codex exec)")
    .option("--json", "emit JSON for scripts and agents")
    .action(
      async (
        query: string,
        options: LsOptions & { regex?: boolean; caseSensitive?: boolean },
      ) => {
        // Search every session the filters allow, then cap the *results*, not the
        // corpus — capping the corpus first would silently hide matches.
        const filters = toFilters(options, 0);
        delete filters.limit;
        const records = await loadRecords(filters);

        const limit = options.limit ? Number.parseInt(options.limit, 10) : 20;
        const hits = await searchSessions({
          records,
          query,
          regex: options.regex === true,
          caseSensitive: options.caseSensitive === true,
          maxSessions: limit,
        });

        if (options.json) {
          process.stdout.write(`${jsonEnvelope(SCHEMA_VERSION, hits)}\n`);
          return;
        }

        if (hits.length === 0) {
          process.stdout.write(`${dim(`No session mentions "${query}".`)}\n`);
          return;
        }

        for (const hit of hits) {
          const { session } = hit;
          process.stdout.write(
            `${bold(cyan(sessionLabel(session)))} ${dim(session.sessionId.slice(0, 8))} ${dim(
              `${relativeAge(session.updatedAt)} ago · ${hit.matchCount} match${hit.matchCount === 1 ? "" : "es"}`,
            )}\n`,
          );
          for (const snippet of hit.snippets) process.stdout.write(`  ${dim("…")}${snippet}\n`);
          process.stdout.write("\n");
        }

        process.stdout.write(
          `${dim(`${hits.length} session${hits.length === 1 ? "" : "s"}. Open one with: gm show <id>`)}\n`,
        );
      },
    );
}
