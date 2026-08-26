import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BLOCK_END,
  BLOCK_START,
  LEGACY_BLOCK_END,
  LEGACY_BLOCK_START,
  bindingsBlock,
  inspectTmuxBindings,
  installTmuxBindings,
  maybeInstallTmuxBindings,
  removeBlock,
  resolveTmuxConfPath,
  stripManagedBlocks,
  uninstallTmuxBindings,
  upsertBlock,
  type TmuxInspectFs,
} from "../src/cli/commands/tmux.js";

/** The load-bearing Oh My Tmux line: it sources $TMUX_CONF_LOCAL (~/.tmux.conf.local). */
const OMT_CONF = 'run \'"$TMUX_PROGRAM" source "$TMUX_CONF_LOCAL"\'\n';

function inspectFs(opts: { files?: Record<string, string>; symlinkPaths?: string[] }): TmuxInspectFs {
  const files = opts.files ?? {};
  const symlinkPaths = new Set(opts.symlinkPaths ?? []);
  return {
    exists: (p) => p in files || symlinkPaths.has(p),
    isSymlink: (p) => symlinkPaths.has(p),
    read: (p) => (p in files ? files[p]! : null),
  };
}

function homeOf(home: string) {
  return {
    conf: join(home, ".tmux.conf"),
    local: join(home, ".tmux.conf.local"),
  };
}

const GIGAMANAGE_BLOCK = [
  LEGACY_BLOCK_START,
  "bind -n C-g display-popup -E 'gm overlay'",
  LEGACY_BLOCK_END,
].join("\n");

describe("tmux.conf block management", () => {
  it("appends the block when absent, preserving existing config", () => {
    const out = upsertBlock("set -g mouse on\n", bindingsBlock());
    expect(out).toContain("set -g mouse on");
    expect(out).toContain(BLOCK_START);
    expect(out).toContain("gmux cockpit");
    expect(out).toContain(BLOCK_END);
  });

  it("replaces an existing block in place rather than duplicating it", () => {
    const first = upsertBlock("", bindingsBlock());
    const second = upsertBlock(first, "# >>> gmux >>>\nbind -n C-g none\n# <<< gmux <<<");
    expect(second.match(/>>> gmux >>>/g)).toHaveLength(1);
    expect(second).toContain("bind -n C-g none");
    expect(second).not.toContain("gmux overlay");
  });

  it("removes exactly the block and nothing else", () => {
    const withBlock = upsertBlock("set -g mouse on\n", bindingsBlock());
    const cleaned = removeBlock(withBlock);
    expect(cleaned).toContain("set -g mouse on");
    expect(cleaned).not.toContain("gmux");
  });

  it("bindings reference the cockpit and the picker bridge", () => {
    const block = bindingsBlock();
    expect(block).toContain("display-popup");
    // The cockpit is whole-workspace, so unlike the overlay it replaced it
    // needs no window id resolved in-shell.
    expect(block).toContain("bind -n C-g display-popup -w 100% -h 100% -x 0 -y 0 -B -E 'gmux cockpit'");
    expect(block).toContain("gmux pick --resume-in-window");
    // The pane-label toggle, also resolving the window id in-shell.
    expect(block).toContain("bind -n M-g");
    expect(block).toContain('gmux tmux label "$(tmux display -p "#{window_id}")"');
    expect(block).not.toMatch(/gmux tmux label\s+#\{/);
  });
});

describe("resolveTmuxConfPath", () => {
  const home = "/tmp/gmux-home";
  const { conf, local } = homeOf(home);

  it("prefers ~/.tmux.conf.local when the live conf sources it (Oh My Tmux)", () => {
    expect(
      resolveTmuxConfPath(
        home,
        inspectFs({ files: { [conf]: OMT_CONF, [local]: "set -g mouse on\n" }, symlinkPaths: [conf] }),
      ),
    ).toBe(local);
  });

  it("creates ~/.tmux.conf.local when a conf that sources it is a symlink and local does not exist yet", () => {
    expect(
      resolveTmuxConfPath(home, inspectFs({ files: { [conf]: OMT_CONF }, symlinkPaths: [conf] })),
    ).toBe(local);
  });

  it("uses ~/.tmux.conf when it is a regular file and there is no .local", () => {
    expect(resolveTmuxConfPath(home, inspectFs({ files: { [conf]: "set -g mouse on\n" } }))).toBe(conf);
  });

  it("uses ~/.tmux.conf when neither file exists (a fresh machine)", () => {
    expect(resolveTmuxConfPath(home, inspectFs({}))).toBe(conf);
  });

  it("keeps bindings in ~/.tmux.conf when an orphan .tmux.conf.local is not sourced", () => {
    // Vanilla tmux never reads .tmux.conf.local. A leftover file must not steal the write.
    expect(
      resolveTmuxConfPath(
        home,
        inspectFs({ files: { [conf]: "set -g mouse on\n", [local]: "set -g history-limit 10000\n" } }),
      ),
    ).toBe(conf);
  });

  it("writes through a dotfiles symlink that does not source .tmux.conf.local", () => {
    expect(
      resolveTmuxConfPath(
        home,
        inspectFs({ files: { [conf]: "set -g mouse on\n" }, symlinkPaths: [conf] }),
      ),
    ).toBe(conf);
  });
});

describe("stripManagedBlocks", () => {
  it("removes both the gmux block and a leftover gigamanage block", () => {
    const existing = `set -g mouse on\n${GIGAMANAGE_BLOCK}\n${bindingsBlock()}\n`;
    const cleaned = stripManagedBlocks(existing);
    expect(cleaned).toContain("set -g mouse on");
    expect(cleaned).not.toContain("gmux");
    expect(cleaned).not.toContain("gigamanage");
    expect(cleaned).not.toContain("gm overlay");
  });
});

describe("installTmuxBindings / uninstallTmuxBindings", () => {

  it("Oh My Tmux incident: symlink conf + leftover gigamanage in .local → cockpit in .local, theme file untouched", async () => {
    const home = await mkdtemp(join(tmpdir(), "gmux-tmux-"));
    const { conf, local } = homeOf(home);
    const real = join(home, "oh-my-tmux.conf");
    await writeFile(real, `# oh-my-tmux managed\n${OMT_CONF}`, "utf8");
    await symlink(real, conf);
    await writeFile(local, `set -g mouse on\n${GIGAMANAGE_BLOCK}\n`, "utf8");

    const result = await installTmuxBindings(home);

    expect(result.path).toBe(local);
    expect(result.removedLegacy).toBe(true);
    const localText = await readFile(local, "utf8");
    expect(localText).toContain("set -g mouse on");
    expect(localText).toContain(BLOCK_START);
    expect(localText).toContain("gmux cockpit");
    expect(localText).not.toContain("gigamanage");
    expect(localText).not.toContain("gm overlay");
    expect(await readFile(real, "utf8")).toBe(`# oh-my-tmux managed\n${OMT_CONF}`);
  });

  it("vanilla tmux with an orphan .tmux.conf.local keeps bindings in ~/.tmux.conf and still strips leftover gigamanage", async () => {
    const home = await mkdtemp(join(tmpdir(), "gmux-tmux-"));
    const { conf, local } = homeOf(home);
    await writeFile(conf, "set -g default-terminal tmux\n", "utf8");
    await writeFile(local, `set -g mouse on\n${GIGAMANAGE_BLOCK}\n`, "utf8");

    const result = await installTmuxBindings(home);

    expect(result.path).toBe(conf);
    expect(result.removedLegacy).toBe(true);
    expect(await readFile(conf, "utf8")).toContain(BLOCK_START);
    expect(await readFile(local, "utf8")).toContain("set -g mouse on");
    expect(await readFile(local, "utf8")).not.toContain("gigamanage");
  });

  it("moves a previous write-through install out of an Oh My Tmux symlink target and into .tmux.conf.local", async () => {
    const home = await mkdtemp(join(tmpdir(), "gmux-tmux-"));
    const { conf, local } = homeOf(home);
    const real = join(home, "oh-my-tmux.conf");
    await writeFile(real, `# oh-my-tmux managed\n${OMT_CONF}${bindingsBlock()}\n`, "utf8");
    await symlink(real, conf);

    await installTmuxBindings(home);

    expect(await readFile(local, "utf8")).toContain(BLOCK_START);
    expect(await readFile(real, "utf8")).toContain("# oh-my-tmux managed");
    expect(await readFile(real, "utf8")).toContain("TMUX_CONF_LOCAL");
    expect(await readFile(real, "utf8")).not.toContain(BLOCK_START);
  });

  it("uninstall removes the gmux block from both candidate files", async () => {
    const home = await mkdtemp(join(tmpdir(), "gmux-tmux-"));
    const { conf, local } = homeOf(home);
    await writeFile(conf, upsertBlock("set -g mouse on\n", bindingsBlock()), "utf8");
    await writeFile(local, upsertBlock("", bindingsBlock()), "utf8");

    await uninstallTmuxBindings(home);

    expect(await readFile(conf, "utf8")).toContain("set -g mouse on");
    expect(await readFile(conf, "utf8")).not.toContain("gmux");
    expect(await readFile(local, "utf8")).not.toContain("gmux");
  });
});

describe("inspectTmuxBindings", () => {
  it("reports installed when the target file holds the gmux block", () => {
    const home = "/tmp/gmux-home";
    const { conf, local } = homeOf(home);
    const report = inspectTmuxBindings(
      home,
      inspectFs({ files: { [conf]: OMT_CONF, [local]: bindingsBlock() }, symlinkPaths: [conf] }),
    );
    expect(report.targetPath).toBe(local);
    expect(report.installed).toBe(true);
    expect(report.leftoverLegacy).toBe(false);
  });

  it("reports a leftover gigamanage block even when gmux is also installed", () => {
    const home = "/tmp/gmux-home";
    const { conf, local } = homeOf(home);
    const report = inspectTmuxBindings(
      home,
      inspectFs({
        files: { [conf]: OMT_CONF, [local]: `${GIGAMANAGE_BLOCK}\n${bindingsBlock()}` },
        symlinkPaths: [conf],
      }),
    );
    expect(report.installed).toBe(true);
    expect(report.leftoverLegacy).toBe(true);
  });
});

describe("maybeInstallTmuxBindings", () => {
  it("does not ask or install when tmux is not available", async () => {
    const asked: string[] = [];
    const result = await maybeInstallTmuxBindings({
      available: false,
      ask: async (q) => {
        asked.push(q);
        return true;
      },
      home: "/tmp/unused",
    });
    expect(asked).toEqual([]);
    expect(result).toEqual({ didInstall: false });
  });

  it("skips install when the user declines", async () => {
    const home = await mkdtemp(join(tmpdir(), "gmux-tmux-"));
    const result = await maybeInstallTmuxBindings({
      available: true,
      ask: async () => false,
      home,
    });
    expect(result).toEqual({ didInstall: false });
    await expect(readFile(join(home, ".tmux.conf"), "utf8")).rejects.toThrow();
  });

  it("installs when the user accepts, defaulting yes", async () => {
    const home = await mkdtemp(join(tmpdir(), "gmux-tmux-"));
    const fallbacks: boolean[] = [];
    const result = await maybeInstallTmuxBindings({
      available: true,
      ask: async (_q, fallback) => {
        fallbacks.push(fallback);
        return fallback;
      },
      home,
    });
    expect(fallbacks).toEqual([true]);
    expect(result.didInstall).toBe(true);
    expect(result.path).toBe(join(home, ".tmux.conf"));
    expect(await readFile(result.path!, "utf8")).toContain(BLOCK_START);
  });

  it("does not re-ask when bindings are already installed and there is no leftover", async () => {
    const home = await mkdtemp(join(tmpdir(), "gmux-tmux-"));
    await installTmuxBindings(home);
    const asked: string[] = [];
    const result = await maybeInstallTmuxBindings({
      available: true,
      ask: async (q) => {
        asked.push(q);
        return true;
      },
      home,
    });
    expect(asked).toEqual([]);
    expect(result.didInstall).toBe(false);
    expect(result.path).toBe(join(home, ".tmux.conf"));
  });
});
