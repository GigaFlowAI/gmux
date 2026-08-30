import type { Command } from "commander";

import { SCHEMA_VERSION } from "../../core/types.js";
import { cacheDir, configPath } from "../../core/paths.js";
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
import { supportsDisplayPopup, tmuxVersion } from "../../services/tmux.js";
import { dim, green, jsonEnvelope, red, yellow } from "../format.js";

interface Check {
  name: string;
  ok: boolean;
  /** Not fatal — the tool still works, just less well. */
  optional?: boolean;
  detail: string;
  fix?: string;
}

/**
 * Report what is present, what is missing, and — for anything missing — the
 * exact command that fixes it. No diagnostic should ever leave you guessing.
 */
export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("check what gigamanage can see, and what's missing")
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
        detail: rg ? "on PATH" : "missing — `gm grep` will not work",
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

      const tmuxV = await tmuxVersion();
      const tmuxOk = supportsDisplayPopup(tmuxV);
      checks.push({
        name: "tmux (peek overlay)",
        ok: tmuxOk,
        optional: true,
        detail: tmuxV
          ? tmuxOk
            ? `${tmuxV.raw} — \`ctrl+g\` overlay available`
            : `${tmuxV.raw} — too old; the overlay needs tmux >= 3.2`
          : "not found — the tmux overlay (`gm tmux install`) is unavailable",
        ...(tmuxOk
          ? {}
          : { fix: tmuxV ? "Upgrade tmux to 3.2 or newer." : "brew install tmux, then `gm tmux install`." }),
      });

      // Config first: it explains every provider answer below it.
      const config = await readConfig();
      const hasConfigFile = await configExists();
      checks.push({
        name: "config",
        // Absent config is fine — gm autodetects. A file we couldn't parse is not.
        ok: !hasConfigFile || config !== null,
        optional: true,
        detail: !hasConfigFile
          ? "none yet — gm autodetects a provider. `gm setup` makes the choice explicit"
          : config === null
            ? "unreadable — ignoring it and autodetecting instead"
            : `${configPath()}`,
        ...(hasConfigFile && config === null ? { fix: "Run `gm setup` to rewrite it." } : {}),
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
            : "missing — `gm summarize` and `gm ask` will not work",
        ...(providerOk ? {} : { fix: "Run `gm setup` to choose a provider." }),
      });

      // Background model calls spend tokens, so make it visible that they happen
      // — and say, right here, exactly which of the three "no"s is in effect.
      const envOn = autoSummarizeEnabled();
      const configOn = config ? config.autoSummarize : true;
      const nested = isChildProcess();
      const autoOn = envOn && configOn && !nested;
      const offReason = !envOn
        ? "off (GIGAMANAGE_AUTO_SUMMARIZE=0)"
        : !configOn
          ? "off (you declined it in `gm setup`)"
          : nested
            ? "off (this gm was spawned by gm's own provider)"
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
                ? "Unset GIGAMANAGE_AUTO_SUMMARIZE to let gm keep recent sessions summarized."
                : !configOn
                  ? "Run `gm setup` to turn it back on."
                  : nested
                    ? "Nothing to do — this is the guard that stops gm summarizing its own summarizer."
                    : "Run `gm setup` to choose a provider, or `gm --no-auto-summarize` to silence this.",
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
        ...(total > 0 ? {} : { fix: "Run an agent session first, or check GIGAMANAGE_HOME." }),
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
