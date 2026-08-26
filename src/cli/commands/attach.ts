import { spawnSync } from "node:child_process";

import type { Command } from "commander";

import { GmuxError } from "../../core/errors.js";
import { ensureMuxd, ensureSidecar, findGmuxd } from "./spawn.js";

/** Hidden `gmux cockpit` / `gmux overlay` aliases redirect here. */
export const LEGACY_SURFACE_FIX = "use gmux attach";

export function legacySurfaceError(name: string): GmuxError {
  return new GmuxError(`${name} is removed; ctrl+g opens the sidebar.`, {
    fix: LEGACY_SURFACE_FIX,
    exitCode: 2,
  });
}

/**
 * Start or connect to gmuxd, then exec the full-bleed TUI (`gmuxd attach`).
 * `ctrl+q` detaches without SIGHUP.
 */
export function registerAttach(program: Command): void {
  program
    .command("attach")
    .description("attach a TUI to gmuxd")
    .option("--cwd <dir>", "workspace cwd")
    .action(async (options: { cwd?: string }) => {
      await ensureMuxd();
      await ensureSidecar();
      const bin = findGmuxd();
      if (!bin) {
        throw new GmuxError("gmuxd is not built", {
          fix: "Run `cargo build -p gmuxd` from the repo root (dev: target/debug/gmuxd).",
        });
      }
      const args = ["attach"];
      if (options.cwd) args.push("--cwd", options.cwd);
      const result = spawnSync(bin, args, { stdio: "inherit", env: process.env });
      if (result.error) {
        throw new GmuxError(`failed to exec gmuxd attach: ${result.error.message}`, {
          fix: "Run `cargo build -p gmuxd` and retry.",
        });
      }
      if (result.status != null && result.status !== 0) {
        process.exit(result.status);
      }
    });
}
