import type { Command } from "commander";

import { GmuxError } from "../../core/errors.js";

/**
 * TUI attach lands in Task 4. This build is headless: spawn / panes / snapshot
 * talk NDJSON; `gmux attach` refuses with a fix rather than a dead-end.
 */
export function registerAttach(program: Command): void {
  program
    .command("attach")
    .description("attach a TUI to gmuxd (headless stub until Task 4)")
    .option("--cwd <dir>", "workspace cwd")
    .action(async () => {
      throw new GmuxError("this build is headless", {
        fix: "this build is headless — Task 4",
      });
    });
}
