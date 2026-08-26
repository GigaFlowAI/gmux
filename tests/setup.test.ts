import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerCockpit } from "../src/cli/commands/cockpit.js";
import { registerOverlay } from "../src/cli/commands/overlay.js";
import { buildAgentHarnessOptions, buildSetupConfig } from "../src/cli/commands/setup.js";
import { GmuxError } from "../src/core/errors.js";
import { CONFIG_VERSION } from "../src/core/types.js";
import { maybeUninstallTmuxBindings, BLOCK_START, bindingsBlock } from "../src/cli/commands/tmux.js";

describe("buildSetupConfig", () => {
  it("writes CONFIG_VERSION 1 and omits agentHarness when unset", () => {
    const cfg = buildSetupConfig({
      provider: { id: "claude-code", command: ["claude", "-p"] },
      agentHarness: null,
      autoSummarize: true,
      guardianPolicy: "auto",
    });
    expect(cfg.version).toBe(CONFIG_VERSION);
    expect(cfg.version).toBe(1);
    expect(cfg.agentHarness).toBeUndefined();
    expect(cfg.provider).toEqual({ id: "claude-code", command: ["claude", "-p"] });
  });

  it("stores agentHarness as ProviderChoice without bumping version", () => {
    const harness = { id: "claude-code", command: ["claude"] };
    const cfg = buildSetupConfig({
      provider: { id: "claude-code", command: ["claude", "-p"] },
      agentHarness: harness,
      autoSummarize: false,
      guardianPolicy: "notify",
    });
    expect(cfg.version).toBe(1);
    expect(cfg.agentHarness).toEqual(harness);
    expect(cfg.agentHarness).not.toEqual(cfg.provider);
  });
});

describe("buildAgentHarnessOptions", () => {
  it("lists adapter launch commands, not summarizer argv", () => {
    const labels = buildAgentHarnessOptions().map((o) => o.label);
    expect(labels).toContain("Claude Code");
    expect(labels).toContain("Codex");
    expect(labels.some((l) => /nothing/i.test(l))).toBe(true);
    expect(buildAgentHarnessOptions().some((o) => o.detail.includes("claude -p"))).toBe(false);
  });
});

describe("maybeUninstallTmuxBindings", () => {
  it("does not ask when no bindings are present", async () => {
    const home = await mkdtemp(join(tmpdir(), "gmux-setup-"));
    const asked: string[] = [];
    const result = await maybeUninstallTmuxBindings({
      available: true,
      ask: async (q) => {
        asked.push(q);
        return true;
      },
      home,
    });
    expect(asked).toEqual([]);
    expect(result).toEqual({ didUninstall: false });
  });

  it("offers uninstall (default no) when bindings are installed", async () => {
    const home = await mkdtemp(join(tmpdir(), "gmux-setup-"));
    await writeFile(join(home, ".tmux.conf"), bindingsBlock(), "utf8");
    const fallbacks: boolean[] = [];
    const result = await maybeUninstallTmuxBindings({
      available: true,
      ask: async (_q, fallback) => {
        fallbacks.push(fallback);
        return true;
      },
      home,
    });
    expect(fallbacks).toEqual([false]);
    expect(result).toEqual({ didUninstall: true });
    expect(await readFile(join(home, ".tmux.conf"), "utf8")).not.toContain(BLOCK_START);
  });
});

describe("hidden cockpit / overlay aliases", () => {
  it("hides both from --help and exits 2 with fix: use gmux attach", async () => {
    const program = new Command();
    program.exitOverride();
    registerCockpit(program);
    registerOverlay(program);
    const help = program.helpInformation();
    expect(help).not.toMatch(/\bcockpit\b/);
    expect(help).not.toMatch(/\boverlay\b/);

    await expect(program.parseAsync(["cockpit"], { from: "user" })).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(GmuxError);
      const e = err as GmuxError;
      expect(e.exitCode).toBe(2);
      expect(e.fix).toBe("use gmux attach");
      return true;
    });
  });

  it("redirects overlay without a window argument", async () => {
    const program = new Command();
    program.exitOverride();
    registerOverlay(program);
    await expect(program.parseAsync(["overlay"], { from: "user" })).rejects.toMatchObject({
      exitCode: 2,
      fix: "use gmux attach",
    });
  });
});
