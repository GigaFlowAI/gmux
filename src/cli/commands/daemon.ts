/**
 * `gmux daemon` — the gmux workspace daemon.
 *
 * Without `--sidecar` this is still the tmux-watching tick plus `daemon.sock`
 * (kept for old tests / leftover tmux clients). `--sidecar` connects to
 * `mux.sock`, presents `intel.token`, and patches mux panes. `status` prints
 * mux vs intel independently from `mux.lock`. `stop` SIGTERMs intel then mux
 * (that kills agents; the copy says so).
 */

import type { Command } from "commander";

import { GmuxError } from "../../core/errors.js";
import type { GmuxConfig } from "../../core/gmux-types.js";
import { readConfig, resolveGmuxConfig } from "../../services/config.js";
import { Daemon, type DaemonDeps } from "../../services/daemon.js";
import { readSnapshotFile } from "../../services/daemon-client.js";
import {
  acquireDaemonLock,
  DAEMON_LOCK_STALE_MS,
  type DaemonLock,
  daemonLockPath,
  isDaemonLockStale,
  readDaemonLock,
  releaseDaemonLock,
} from "../../services/daemon-lock.js";
import { ModelServer } from "../../services/daemon-socket.js";
import { Guardian } from "../../services/guardian.js";
import { MuxClient, liveIntelHandlers } from "../../services/mux-client.js";
import type { MuxGateway } from "../../services/mux-gateway.js";
import { ResourceMonitor } from "../../services/resources.js";
import { defaultLabelProvider, type LabelProvider, SemanticWorker } from "../../services/semantic.js";
import { SemanticGate } from "../../services/semantic-gate.js";
import { SidecarDaemon, type SidecarDaemonDeps } from "../../services/sidecar-daemon.js";
import { RealTmuxGateway, type TmuxGateway } from "../../services/tmux-gateway.js";
import { WorkspaceModel } from "../../services/workspace.js";
import { paintFromSnapshot } from "../border-client.js";
import { dim, green, red } from "../format.js";
import { enableBorder } from "../tmux-label.js";
import { muxPidAlive, readMuxLock } from "./spawn.js";

export interface LoopOpts {
  tickMs: number;
  signal: AbortSignal;
  onTick?: () => void;
}

/**
 * The testable core: tick the daemon on an interval until `signal` aborts.
 *
 * A tick failure never kills the loop — `tickOnce` already swallows per-sensor
 * errors, but this catch is belt-and-suspenders against anything else (e.g. a
 * gateway that throws) so the daemon degrades to "nothing observed this tick"
 * rather than exiting.
 *
 * Exactly ONE `abort` listener is attached, before the loop starts, and it
 * lives for the whole call. Attaching a fresh `{ once: true }` listener inside
 * each iteration's wait looks harmless — `once` removes it once *abort*
 * fires — but on the far more common path (the timeout just elapses) nothing
 * ever removes it, so listeners pile up on the long-lived signal and Node
 * emits `MaxListenersExceededWarning` after ~10 ticks. `wake` is the current
 * iteration's resolver; the single listener just calls whichever one is live.
 */
export interface ProcessStatus {
  up: boolean;
  pid: number | null;
}

/** mux and intel are independent — a hung sidecar does not make mux look down. */
export function renderStatus(s: { mux: ProcessStatus; intel: ProcessStatus }): string {
  const mux = s.mux.up && s.mux.pid != null ? `mux: up (pid ${s.mux.pid})` : "mux: down";
  const intel = s.intel.up && s.intel.pid != null ? `intel: up (pid ${s.intel.pid})` : "intel: down";
  return `${mux}\n${intel}\n`;
}

async function runTickLoop(tickOnce: () => Promise<void>, opts: LoopOpts): Promise<void> {
  let wake: (() => void) | undefined;
  const onAbort = (): void => wake?.();
  opts.signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (!opts.signal.aborted) {
      await tickOnce().catch(() => {
        /* keep the loop alive */
      });
      opts.onTick?.();
      if (opts.signal.aborted) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          wake = undefined;
          resolve();
        }, opts.tickMs);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  } finally {
    // Already gone if `abort` fired (the `once` removed it); harmless no-op
    // either way. Guarantees no timer or listener outlives the call.
    opts.signal.removeEventListener("abort", onAbort);
  }
}

export async function runDaemonLoop(deps: DaemonDeps, opts: LoopOpts): Promise<void> {
  const daemon = new Daemon(deps);
  await runTickLoop(() => daemon.tickOnce(), opts);
}

export async function runSidecarLoop(deps: SidecarDaemonDeps, opts: LoopOpts): Promise<void> {
  const daemon = new SidecarDaemon(deps);
  await runTickLoop(() => daemon.tickOnce(), opts);
}

/**
 * Assemble the full `DaemonDeps` for a production `gmux daemon run` — all four
 * phases wired: the base tick loop (gateway/model/clock), the LLM semantic
 * worker (Phase 1), and the resource monitor + memory guardian (Phase 2).
 *
 * Pure and synchronous so it can be unit-tested without a socket or real
 * processes: the caller resolves the (async) label provider once and passes
 * it in. The `SemanticWorker`'s own try/catch tolerates a provider that
 * throws, so wiring it unconditionally is safe even when no provider is
 * configured. `resolveAgents` is deliberately left unset — the guardian's
 * real broadcast targeting (harness && sessionId, in `Daemon.tickOnce`) is
 * the production path; that override is a test-only seam.
 */
export function buildDaemonDeps(
  gateway: TmuxGateway,
  model: WorkspaceModel,
  gmuxCfg: GmuxConfig,
  provider: LabelProvider,
): DaemonDeps {
  const semantic = new SemanticWorker(model, provider, new SemanticGate());
  const resources = new ResourceMonitor();
  const guardian = new Guardian({
    policy: gmuxCfg.guardianPolicy,
    threshold: gmuxCfg.memoryThreshold,
    cooldownSeconds: gmuxCfg.cooldownSeconds,
  });
  return { gateway, model, now: () => Date.now(), semantic, resources, guardian };
}

export function buildSidecarDeps(
  gateway: MuxGateway,
  model: WorkspaceModel,
  gmuxCfg: GmuxConfig,
  provider: LabelProvider,
  report?: SidecarDaemonDeps["report"],
  broadcast?: SidecarDaemonDeps["broadcast"],
): SidecarDaemonDeps {
  const semantic = new SemanticWorker(model, provider, new SemanticGate());
  const resources = new ResourceMonitor();
  const guardian = new Guardian({
    policy: gmuxCfg.guardianPolicy,
    threshold: gmuxCfg.memoryThreshold,
    cooldownSeconds: gmuxCfg.cooldownSeconds,
  });
  return { gateway, model, now: () => Date.now(), semantic, resources, guardian, report, broadcast };
}

// --- Lock -------------------------------------------------------------

// Re-exported so existing callers of this module (and its tests) keep
// working unchanged — the primitives themselves now live in
// `services/daemon-lock.ts`, a leaf module with no `cli/` dependents, so
// `cli/tmux-label.ts` can detect a live daemon without importing this file
// (which itself imports `cli/tmux-label.ts` for `enableBorder`).
export {
  acquireDaemonLock,
  DAEMON_LOCK_STALE_MS,
  type DaemonLock,
  daemonLockPath,
  isDaemonLockStale,
  readDaemonLock,
  releaseDaemonLock,
};

// --- Command ------------------------------------------------------------

async function runSidecarForeground(): Promise<void> {
  const client = await MuxClient.connect(undefined, undefined, liveIntelHandlers());
  const config = await readConfig();
  const gmuxCfg = resolveGmuxConfig(config);
  const provider = await defaultLabelProvider();
  const model = new WorkspaceModel();
  const deps = buildSidecarDeps(
    client,
    model,
    gmuxCfg,
    provider,
    (patch) => client.reportSemantics(patch),
    (message) => client.guardianBroadcast(message),
  );
  const ac = new AbortController();
  const stop = (): void => ac.abort();
  try {
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.stdout.write(`${green("gmux intel sidecar started")} (pid ${process.pid})\n`);
    await runSidecarLoop(deps, { tickMs: gmuxCfg.tickMs, signal: ac.signal });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await client.close().catch(() => {});
  }
}

export function registerDaemon(program: Command): void {
  const cmd = program.command("daemon").description("run and manage the gmux workspace daemon");
  cmd.option("--sidecar", "run as the intel sidecar against gmuxd (mux.sock, not tmux)");

  cmd
    .command("run", { isDefault: true })
    .description("run the daemon loop in the foreground")
    .option("--sidecar", "run as the intel sidecar against gmuxd (mux.sock, not tmux)")
    .action(async (options: { sidecar?: boolean }, command: Command) => {
      const sidecar = Boolean(options.sidecar) || Boolean(command.parent?.opts()?.sidecar);
      if (sidecar) {
        try {
          await runSidecarForeground();
        } catch (error) {
          const err = error instanceof GmuxError ? error : new GmuxError((error as Error).message, {
            fix: "Start gmuxd first (`gmux attach` or `gmux spawn`). Start order is mux → sidecar → TUI.",
          });
          process.stderr.write(`${red("error")} ${err.message}\n`);
          if (err.fix) process.stderr.write(`${dim("fix")} ${err.fix}\n`);
          process.exitCode = 1;
        }
        return;
      }

      if (!(await acquireDaemonLock())) {
        const existing = await readDaemonLock();
        process.stderr.write(
          `${red("error")} a daemon is already running (pid ${existing?.pid ?? "?"})\n`,
        );
        process.exitCode = 1;
        return;
      }

      // From here on the lock is held, so EVERYTHING — config/dep assembly,
      // server construction, `start()`, the loop — must run inside this
      // `try`. Any of those can throw (a bad config file, a label provider
      // that fails to initialize, the socket path being unwritable, a stale
      // socket file that's somehow un-removable, ...); if any of it runs
      // outside a `try/finally` the lock file is leaked forever and every
      // future `gmux daemon run` refuses to start until someone manually
      // deletes it.
      let model: WorkspaceModel | undefined;
      let server: ModelServer | undefined;
      let onChange: (() => void) | undefined;
      const ac = new AbortController();
      const stop = (): void => ac.abort();

      try {
        const config = await readConfig();
        const gmuxCfg = resolveGmuxConfig(config);
        const provider = await defaultLabelProvider();
        const gateway = new RealTmuxGateway();
        model = new WorkspaceModel();
        const deps = buildDaemonDeps(gateway, model, gmuxCfg, provider);
        server = new ModelServer(model);

        // Repaints every pane's `@gmux_label` on each model change — state
        // only, zero sensing. Never lets a paint failure (e.g. a pane that
        // vanished mid-write) propagate into the model's "change" emitter
        // and take down the daemon loop.
        const paneModel = model;
        onChange = (): void => {
          paintFromSnapshot(paneModel.snapshot(), (id, text) => gateway.setOption(id, "@gmux_label", text)).catch(() => {});
        };

        await server.start();
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        process.stdout.write(`${green("gmux daemon started")} (pid ${process.pid})\n`);
        await enableBorder();
        model.on("change", onChange);
        await runDaemonLoop(deps, { tickMs: gmuxCfg.tickMs, signal: ac.signal });
      } finally {
        if (model && onChange) model.off("change", onChange);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        // Safe even when `start()` itself threw, or the throw happened
        // before `server` was even assigned: `stop()` no-ops when the
        // server was never started, and force-removes the socket path
        // either way. Never let a cleanup failure hide the original error
        // or, worse, skip releasing the lock below.
        await server?.stop().catch(() => {});
        await releaseDaemonLock();
      }
    });

  cmd
    .command("status")
    .description("show whether mux and intel are running")
    .action(async () => {
      const lock = await readMuxLock();
      const muxPid = lock?.muxPid ?? null;
      const intelPid = lock?.intelPid ?? null;
      const muxUp = muxPid != null && muxPidAlive(muxPid);
      const intelUp = intelPid != null && muxPidAlive(intelPid);
      process.stdout.write(
        renderStatus({
          mux: { up: muxUp, pid: muxUp ? muxPid : null },
          intel: { up: intelUp, pid: intelUp ? intelPid : null },
        }),
      );

      const snap = await readSnapshotFile();
      if (snap) {
        process.stdout.write(
          `${dim(`snapshot: ${snap.snapshot.panes.length} pane(s), ${Math.round(snap.ageMs / 1000)}s old`)}\n`,
        );
      } else {
        process.stdout.write(`${dim("snapshot: none yet")}\n`);
      }
    });

  cmd
    .command("stop")
    .description("stop intel then mux (this kills agents)")
    .action(async () => {
      const lock = await readMuxLock();
      const muxPid = lock?.muxPid != null && muxPidAlive(lock.muxPid) ? lock.muxPid : null;
      const intelPid = lock?.intelPid != null && muxPidAlive(lock.intelPid) ? lock.intelPid : null;
      if (muxPid != null || intelPid != null) {
        if (intelPid != null) {
          try { process.kill(intelPid, "SIGTERM"); } catch { /* already gone */ }
        }
        if (muxPid != null) {
          try { process.kill(muxPid, "SIGTERM"); } catch { /* already gone */ }
        }
        process.stdout.write(
          `${green("stopped")} intel${intelPid != null ? ` (pid ${intelPid})` : ""} then mux${muxPid != null ? ` (pid ${muxPid})` : ""} — this kills agents\n`,
        );
        return;
      }

      const tmuxLock = await readDaemonLock();
      if (!tmuxLock || isDaemonLockStale(tmuxLock)) {
        process.stdout.write(`${dim("nothing was running")}\n`);
        return;
      }
      try {
        process.kill(tmuxLock.pid, "SIGTERM");
        process.stdout.write(`${green("stopped")} (sent SIGTERM to pid ${tmuxLock.pid})\n`);
      } catch {
        process.stdout.write(`${dim("nothing was running")}\n`);
      }
    });
}
