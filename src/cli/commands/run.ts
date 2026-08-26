import { spawn } from "node:child_process";

import type { Command } from "commander";

import { adapterById, allAdapters } from "../../adapters/registry.js";
import type { HarnessAdapter } from "../../adapters/types.js";
import type { SessionRef } from "../../core/types.js";
import { writePaneLink } from "../../services/pane-links.js";
import { dim } from "../format.js";

/** How long to watch for the harness's freshly-written session file. */
const DETECT_WINDOW_MS = 8000;
const DETECT_POLL_MS = 500;

/** Match `gm run <arg>` to a harness by id or by a process-name alias. */
export function resolveHarnessArg(arg: string): HarnessAdapter | null {
  const needle = arg.trim().toLowerCase();
  return (
    adapterById(needle) ??
    allAdapters().find((a) => a.processNames.some((n) => n.toLowerCase() === needle)) ??
    null
  );
}

/**
 * The session the harness just started or touched: newest among those whose id
 * is either new (a fresh session) or whose mtime advanced since `before` (a
 * resumed one — `gm run codex resume`, `gm run claude --resume <id>` write to
 * an EXISTING session file, so no new id ever appears for those).
 */
export function pickChangedSession(
  before: readonly SessionRef[],
  after: readonly SessionRef[],
): SessionRef | null {
  const beforeMtimes = new Map(before.map((r) => [r.sessionId, r.mtimeMs]));
  const changed = after.filter((r) => {
    const priorMtime = beforeMtimes.get(r.sessionId);
    return priorMtime === undefined || r.mtimeMs > priorMtime;
  });
  return [...changed].sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null;
}

async function captureLink(adapter: HarnessAdapter, paneId: string, before: SessionRef[]): Promise<void> {
  const deadline = Date.now() + DETECT_WINDOW_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, DETECT_POLL_MS));
    try {
      const after = await adapter.listSessions();
      const picked = pickChangedSession(before, after);
      if (picked) {
        await writePaneLink({ paneId, harness: adapter.id, sessionId: picked.sessionId });
        return;
      }
    } catch {
      // The harness may not have written its dir yet; keep watching.
    }
  }
  process.stderr.write(
    `${dim("gm: could not link this pane automatically (the overlay will fall back to the cwd heuristic)")}\n`,
  );
}

export function registerRun(program: Command): void {
  program
    .command("run <harness> [args...]")
    .description("launch an agent and record which pane it runs in, for exact overlay mapping")
    .allowUnknownOption(true)
    .action(async (harness: string, args: string[] = []) => {
      const adapter = resolveHarnessArg(harness);
      if (!adapter) {
        process.stderr.write(
          `error  unknown harness "${harness}". Known: ${allAdapters().map((a) => a.id).join(", ")}\n`,
        );
        process.exit(2);
      }

      const paneId = process.env.TMUX_PANE;
      const before = paneId ? await adapter.listSessions().catch(() => []) : [];

      // The wrapper lingers only to capture the session id; stdio is inherited,
      // so the pane is the agent for all interactive purposes.
      const child = spawn(adapter.launchCommand, args, { stdio: "inherit" });

      if (paneId) {
        process.stderr.write(`${dim(`gm: linking pane ${paneId} to this ${adapter.displayName} session`)}\n`);
        void captureLink(adapter, paneId, before);
      }

      child.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          process.stderr.write(`error  "${adapter.launchCommand}" is not on your PATH.\n`);
          process.exit(6);
        }
        process.stderr.write(`error  ${error.message}\n`);
        process.exit(1);
      });
      child.on("close", (code) => process.exit(code ?? 0));
    });
}
