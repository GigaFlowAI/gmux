/**
 * `gmux peel [--from <paneId>] [--json]` — peel a new agent tab from a pane.
 *
 * CLI class: `--from` peels that pane; without it, the most recently attached
 * TUI's focus. Envelope SCHEMA_VERSION 1: `{ paneId, tabId, submitted, extractor }`.
 */

import type { Command } from "commander";

import { SCHEMA_VERSION } from "../../core/types.js";
import { jsonEnvelope } from "../format.js";
import { muxRpc } from "./spawn.js";

export interface PeelJson {
  paneId: string;
  tabId: string;
  submitted: boolean;
  extractor: string;
}

export function registerPeel(program: Command): void {
  program
    .command("peel")
    .description("peel a new agent tab from an unsubmitted prompt")
    .option("--from <paneId>", "pane to peel from")
    .option("--json", "emit JSON for scripts and agents")
    .action(async (options: { from?: string; json?: boolean }) => {
      const params: Record<string, unknown> = {};
      if (options.from) params.paneId = options.from;
      const result = (await muxRpc("peel", params)) as Partial<PeelJson>;
      const data: PeelJson = {
        paneId: result.paneId ?? "",
        tabId: result.tabId ?? "",
        submitted: result.submitted === true,
        extractor: typeof result.extractor === "string" ? result.extractor : "empty",
      };
      if (options.json) {
        process.stdout.write(`${jsonEnvelope(SCHEMA_VERSION, data)}\n`);
        return;
      }
      process.stdout.write(
        `${data.paneId}  tab ${data.tabId}  ${data.submitted ? "submitted" : "unsubmitted"}  ${data.extractor}\n`,
      );
    });
}
