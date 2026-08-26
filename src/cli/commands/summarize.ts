import type { Command } from "commander";

import { GigamanageError, NoProviderError } from "../../core/errors.js";
import { loadRecords } from "../../services/views.js";
import { resolveSession } from "../../services/resolve.js";
import { defaultSummaryProvider, summarizeBatch } from "../../services/summarize.js";
import { bold, dim, green, yellow } from "../format.js";

export function registerSummarize(program: Command): void {
  program
    .command("summarize [id]")
    .description("write summaries of where sessions landed (cached; only regenerates when a session changed)")
    .option("-r, --recent <count>", "summarize the N most recent sessions", "20")
    .option("--all", "summarize every session (can be expensive — you have a lot)")
    .option("--force", "regenerate even if a cached summary is still current")
    .option("--harness <id>", "only this harness")
    .option("-p, --project <name>", "only sessions whose project matches")
    .action(
      async (
        id: string | undefined,
        options: { recent?: string; all?: boolean; force?: boolean; harness?: string; project?: string },
      ) => {
        // Two different "no", and they need two different answers: "you chose
        // none" is a decision to revisit, "it isn't installed" is a thing to fix.
        const provider = await defaultSummaryProvider();
        if (!provider) throw new NoProviderError("`gm summarize`");
        if (!(await provider.isAvailable())) {
          throw new GigamanageError(`Summary provider "${provider.name}" is not on your PATH.`, {
            fix: "Run `gm setup` to choose a provider that is installed.",
            exitCode: 6,
          });
        }

        const all = await loadRecords({
          ...(options.harness ? { harness: options.harness } : {}),
          ...(options.project ? { project: options.project } : {}),
        });

        const targets = id
          ? [resolveSession(all, id)]
          : options.all
            ? all
            : all.slice(0, Number.parseInt(options.recent ?? "20", 10));

        if (targets.length === 0) {
          process.stdout.write(`${dim("Nothing to summarize.")}\n`);
          return;
        }

        process.stdout.write(
          `${dim(`Summarizing ${targets.length} session${targets.length === 1 ? "" : "s"} with ${provider.name}…`)}\n`,
        );

        const result = await summarizeBatch(targets, provider, {
          force: options.force === true,
          onProgress: (done, total) => {
            if (process.stdout.isTTY) process.stdout.write(`\r${dim(`  ${done}/${total}`)}`);
          },
        });

        if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");

        process.stdout.write(
          `${green(`✓ ${result.generated} written`)}  ${dim(`${result.skipped} already current`)}\n`,
        );

        if (result.failed.length > 0) {
          process.stdout.write(`${yellow(`${result.failed.length} failed:`)}\n`);
          for (const failure of result.failed.slice(0, 5)) {
            process.stdout.write(`  ${bold(failure.sessionId.slice(0, 8))} ${dim(failure.reason)}\n`);
          }
        }
      },
    );
}
