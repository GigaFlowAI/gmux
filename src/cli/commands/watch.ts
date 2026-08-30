import type { Command } from "commander";

import { maybeAutoSummarize } from "../../services/auto-summarize.js";
import { listAllPanes } from "../../services/tmux.js";
import {
  WATCH_INTERVAL_MS,
  WATCH_WORKER_COMMAND,
  clearWatchPid,
  readWatchPid,
  startWatch,
  stopWatch,
} from "../../services/watch.js";
import { disableBorder, enableBorder, labelPanes } from "../tmux-label.js";
import { dim, green } from "../format.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The background agent's loop, running in the detached worker.
 *
 * Each tick: label every pane across every window from cache (cheap), then hand
 * the on-screen sessions to the summariser — WITHOUT `force`, so the existing
 * cooldown throttles how often divergence turns into a model call while the
 * labels stay live. `shouldRefresh` (the SimHash gate) decides what's worth it.
 *
 * It exits cleanly when tmux is gone (`listAllPanes` throws), when its PID file
 * is removed or replaced (the toggle's stop path), or on a terminating signal.
 * A transient per-tick error never kills the loop.
 */
async function runWatch(): Promise<void> {
  const me = process.pid;
  let running = true;
  // Exit promptly on stop rather than waiting out the current sleep. The toggle's
  // stop path has already cleared the pid file; a signal-kill without it leaves a
  // stale pid the next start reclaims.
  const stop = (): void => {
    running = false;
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  while (running) {
    const record = await readWatchPid();
    if (!record || record.pid !== me) break; // toggled off, or superseded

    let panes;
    try {
      panes = await listAllPanes();
    } catch {
      break; // tmux server is gone
    }

    try {
      const records = await labelPanes(panes);
      await maybeAutoSummarize({ records });
    } catch {
      // A transient read/tmux hiccup — skip this tick, keep watching.
    }

    await sleep(WATCH_INTERVAL_MS);
  }

  await clearWatchPid();
}

export function registerWatch(program: Command): void {
  program
    .command("watch")
    .description("run gigamanage's background agent: keep pane labels and summaries current")
    .option("--stop", "stop the running watcher")
    .action(async (options: { stop?: boolean }) => {
      if (options.stop) {
        const was = await stopWatch();
        await disableBorder();
        process.stdout.write(`${was ? green("stopped") : dim("nothing was running")}\n`);
        return;
      }
      const result = await startWatch();
      if (result !== "failed") await enableBorder();
      process.stdout.write(`${dim(`watch ${result}`)}\n`);
    });

  // The detached loop. Hidden (`__`-prefixed), so the postAction summarize hook
  // and the setup wizard both skip it.
  program.command(WATCH_WORKER_COMMAND, { hidden: true }).action(async () => {
    await runWatch();
  });
}
