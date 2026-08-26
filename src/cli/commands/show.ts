import type { Command } from "commander";

import { SCHEMA_VERSION } from "../../core/types.js";
import { loadRecords } from "../../services/views.js";
import { resolveSession } from "../../services/resolve.js";
import { readSummary } from "../../services/summarize.js";
import { formatCard, jsonEnvelope } from "../format.js";

export function registerShow(program: Command): void {
  program
    .command("show <id>")
    .description("show the full context card for one session (id or unique prefix)")
    .option("--json", "emit JSON for scripts and agents")
    .action(async (id: string, options: { json?: boolean }) => {
      // Naming a session explicitly means you want it, whatever kind it is —
      // including the ones `gm ls` hides by default.
      const records = await loadRecords({ includeSidechains: true, includeAutomated: true });
      const record = resolveSession(records, id);
      const summary = await readSummary(record);

      if (options.json) {
        process.stdout.write(`${jsonEnvelope(SCHEMA_VERSION, { record, summary })}\n`);
        return;
      }
      process.stdout.write(`${formatCard({ record, summary })}\n`);
    });
}
