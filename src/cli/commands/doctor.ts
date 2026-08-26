import { existsSync } from "node:fs";
import { homedir } from "node:os";

import type { Command } from "commander";

import { SCHEMA_VERSION } from "../../core/types.js";
import { cacheDir, configPath, muxSocketPath } from "../../core/paths.js";
import { allAdapters } from "../../adapters/registry.js";
import {
  AUTO_SUMMARIZE_LIMIT,
  autoSummarizeEnabled,
  lastAutoSummarizeError,
} from "../../services/auto-summarize.js";
import { configExists, isChildProcess, readConfig } from "../../services/config.js";
import { onPath } from "../../services/providers.js";
import { defaultSummaryProvider } from "../../services/summarize.js";
import { discover } from "../../services/index-store.js";
import { tmuxVersion } from "../../services/tmux.js";
import { inspectTmuxBindings, realTmuxFs } from "./tmux.js";
import { dim, green, jsonEnvelope, red, yellow } from "../format.js";
import { findGmuxd, muxPidAlive, readMuxLock, type MuxLockFile } from "./spawn.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** Not fatal — the tool still works, just less well. */
  optional?: boolean;
  detail: string;
  fix?: string;
}

type Check = DoctorCheck;

/** Mux runtime: binary on disk, mux.sock, intel pid from the lock. */
export function muxDoctorChecks(input: {
  binaryPath: string | null;
  socketPath: string;
  socketUp: boolean;
  lock: MuxLockFile | null;
  pidAlive: (pid: number) => boolean;
}): DoctorCheck[] {
  const muxPid = input.lock?.muxPid ?? null;
  const muxAlive = muxPid != null && input.pidAlive(muxPid);
  const intelPid = input.lock?.intelPid ?? null;
  const intelAlive = intelPid != null && input.pidAlive(intelPid);

  return [
    {
      name: "gmuxd (mux binary)",
      ok: input.binaryPath != null,
      optional: true,
      detail: input.binaryPath ? input.binaryPath : "not built — `gmux attach` needs target/debug/gmuxd",
      ...(input.binaryPath ? {} : { fix: "Run `cargo build -p gmuxd` from the repo root." }),
    },
    {
      name: "mux.sock",
      ok: input.socketUp && muxAlive,
      optional: true,
      detail: input.socketUp
        ? muxAlive
          ? `${input.socketPath} (pid ${muxPid})`
          : `${input.socketPath} exists but mux pid is not alive`
        : `${input.socketPath} is down`,
      ...(input.socketUp && muxAlive
        ? {}
        : { fix: "Run `gmux attach` or `gmux spawn` to start gmuxd." }),
    },
    {
      name: "intel sidecar",
      ok: intelAlive,
      optional: true,
      detail: intelAlive ? `up (pid ${intelPid})` : "down — peel still works; classify/pack will time out",
      ...(intelAlive ? {} : { fix: "Start `gmux daemon --sidecar` (attach starts it)." }),
    },
    {
      name: "ctrl+t in host emulator",
      ok: true,
      optional: true,
      detail:
        "gmux runs inside Ghostty/iTerm/kitty — if ctrl+t opens a native tab, unbind it there. The mux binding stays ctrl+t (ctrl+shift+t is an alias).",
    },
  ];
}

const TMUX_MIGRATE_FIX = "Finish work in tmux, then `gmux tmux uninstall` and `gmux attach`.";

/** Leftover tmux is informational. cockpit/overlay always throw — never "overlay available". */
export function leftoverTmuxCheck(tmuxV: { raw: string } | null): DoctorCheck {
  if (!tmuxV) {
    return {
      name: "tmux (leftover)",
      ok: true,
      optional: true,
      detail: "not found — using gmux attach",
    };
  }
  return {
    name: "tmux (leftover)",
    ok: true,
    optional: true,
    detail: `${tmuxV.raw} — leftover. Finish work in tmux, then gmux tmux uninstall and gmux attach`,
    fix: TMUX_MIGRATE_FIX,
  };
}

/**
 * Report what is present, what is missing, and — for anything missing — the
 * exact command that fixes it. No diagnostic should ever leave you guessing.
 */
export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("check what gmux can see, and what's missing")
    .option("--json", "emit JSON for scripts and agents")
    .action(async (options: { json?: boolean }) => {
      const checks: Check[] = [];

      for (const adapter of allAdapters()) {
        const available = await adapter.isAvailable();
        const sessions = available ? (await adapter.listSessions()).length : 0;
        checks.push({
          name: `harness: ${adapter.displayName}`,
          ok: available,
          optional: true,
          detail: available ? `${sessions} sessions found` : "no session directory on this machine",
          ...(available ? {} : { fix: `Nothing to do unless you use ${adapter.displayName}.` }),
        });
      }

      const rg = onPath("rg");
      checks.push({
        name: "ripgrep (search)",
        ok: rg,
        detail: rg ? "on PATH" : "missing — `gmux grep` will not work",
        ...(rg ? {} : { fix: "brew install ripgrep" }),
      });

      const fzf = onPath("fzf");
      checks.push({
        name: "fzf (fuzzy picker)",
        ok: fzf,
        optional: true,
        detail: fzf ? "on PATH" : "missing — the picker falls back to a numbered list",
        ...(fzf ? {} : { fix: "brew install fzf" }),
      });

      checks.push(leftoverTmuxCheck(await tmuxVersion()));

      const bindings = inspectTmuxBindings(homedir(), realTmuxFs());
      const bindingsMigrated = !bindings.installed && !bindings.leftoverLegacy;
      checks.push({
        name: "tmux bindings",
        ok: bindingsMigrated,
        optional: true,
        detail: bindings.leftoverLegacy
          ? `installed in ${bindings.targetPath} but shadowed by leftover gigamanage bindings`
          : bindings.installed
            ? `installed in ${bindings.targetPath} — finish in tmux, then gmux tmux uninstall`
            : "not installed — using gmux attach",
        ...(bindingsMigrated
          ? {}
          : { fix: "Finish work in tmux, then `gmux tmux uninstall` and `gmux attach`." }),
      });
      if (bindings.leftoverLegacy) {
        checks.push({
          name: "legacy gigamanage tmux bindings",
          ok: false,
          optional: true,
          detail: "old # >>> gigamanage >>> block still present — ctrl-g may open `gm overlay`",
          fix: "`gmux tmux uninstall` strips it, or delete the # >>> gigamanage >>> block from ~/.tmux.conf / ~/.tmux.conf.local",
        });
      }

      const lock = await readMuxLock();
      checks.push(
        ...muxDoctorChecks({
          binaryPath: findGmuxd(),
          socketPath: muxSocketPath(),
          socketUp: existsSync(muxSocketPath()),
          lock,
          pidAlive: muxPidAlive,
        }),
      );

      // Config first: it explains every provider answer below it.
      const config = await readConfig();
      const hasConfigFile = await configExists();
      checks.push({
        name: "config",
        // Absent config is fine — gmux autodetects. A file we couldn't parse is not.
        ok: !hasConfigFile || config !== null,
        optional: true,
        detail: !hasConfigFile
          ? "none yet — gmux autodetects a provider. `gmux setup` makes the choice explicit"
          : config === null
            ? "unreadable — ignoring it and autodetecting instead"
            : `${configPath()}`,
        ...(hasConfigFile && config === null ? { fix: "Run `gmux setup` to rewrite it." } : {}),
      });

      const provider = await defaultSummaryProvider();
      const providerOk = provider !== null && (await provider.isAvailable());
      checks.push({
        name: provider ? `model provider (${provider.name})` : "model provider",
        ok: providerOk,
        optional: true,
        detail: !provider
          ? "none — this machine is configured to make no model calls"
          : providerOk
            ? "on PATH"
            : "missing — `gmux summarize` and `gmux ask` will not work",
        ...(providerOk ? {} : { fix: "Run `gmux setup` to choose a provider." }),
      });

      // Background model calls spend tokens, so make it visible that they happen
      // — and say, right here, exactly which of the three "no"s is in effect.
      const envOn = autoSummarizeEnabled();
      const configOn = config ? config.autoSummarize : true;
      const nested = isChildProcess();
      const autoOn = envOn && configOn && !nested;
      const offReason = !envOn
        ? "off (GMUX_AUTO_SUMMARIZE=0)"
        : !configOn
          ? "off (you declined it in `gmux setup`)"
          : nested
            ? "off (this gmux was spawned by gmux's own provider)"
            : "";
      checks.push({
        name: "auto-summarize (background)",
        ok: autoOn && providerOk,
        optional: true,
        detail: !autoOn
          ? offReason
          : providerOk
            ? `on — the ${AUTO_SUMMARIZE_LIMIT} most recent sessions are summarized in the background`
            : "on, but idle — no model provider available",
        ...(autoOn && providerOk
          ? {}
          : {
              fix: !envOn
                ? "Unset GMUX_AUTO_SUMMARIZE to let gmux keep recent sessions summarized."
                : !configOn
                  ? "Run `gmux setup` to turn it back on."
                  : nested
                    ? "Nothing to do — this is the guard that stops gmux summarizing its own summarizer."
                    : "Run `gmux setup` to choose a provider, or `gmux --no-auto-summarize` to silence this.",
            }),
      });

      // The worker's stdio is ignored, so a broken provider is otherwise silent:
      // summaries simply never appear and there is nothing to look at.
      const lastError = await lastAutoSummarizeError();
      if (lastError) {
        checks.push({
          name: "last background summarize",
          ok: false,
          optional: true,
          detail: lastError,
          fix: "Check the summary provider works standalone: `echo hi | claude -p`.",
        });
      }

      const total = (await discover()).length;
      checks.push({
        name: "sessions visible",
        ok: total > 0,
        detail: `${total} total`,
        ...(total > 0 ? {} : { fix: "Run an agent session first, or check GMUX_HOME." }),
      });

      if (options.json) {
        process.stdout.write(`${jsonEnvelope(SCHEMA_VERSION, { checks, cacheDir: cacheDir() })}\n`);
        return;
      }

      for (const check of checks) {
        const mark = check.ok ? green("✓") : check.optional ? yellow("○") : red("✗");
        process.stdout.write(`${mark} ${check.name}  ${dim(check.detail)}\n`);
        if (!check.ok && check.fix) process.stdout.write(`  ${dim(`fix: ${check.fix}`)}\n`);
      }
      process.stdout.write(`\n${dim(`cache: ${cacheDir()}`)}\n`);

      if (checks.some((c) => !c.ok && !c.optional)) process.exitCode = 1;
    });
}
