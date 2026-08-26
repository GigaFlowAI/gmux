import { existsSync, lstatSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";

import { GmuxError } from "../../core/errors.js";
import { bold, dim, green, yellow } from "../format.js";
import { toggleWatch } from "../tmux-label.js";

export const BLOCK_START = "# >>> gmux >>>";
export const BLOCK_END = "# <<< gmux <<<";
export const LEGACY_BLOCK_START = "# >>> gigamanage >>>";
export const LEGACY_BLOCK_END = "# <<< gigamanage <<<";

/** Enough filesystem to pick the file tmux will actually keep. */
export interface TmuxPathStat {
  exists(path: string): boolean;
  isSymlink(path: string): boolean;
}

export interface TmuxInspectFs extends TmuxPathStat {
  read(path: string): string | null;
}

export interface TmuxBindingsReport {
  targetPath: string;
  installed: boolean;
  leftoverLegacy: boolean;
}

export interface InstallResult {
  path: string;
  removedLegacy: boolean;
}

/**
 * The bindings gmux manages. `ctrl+g` pulls up the whole-workspace cockpit;
 * `ctrl+shift+g` opens the history picker, whose Enter resumes into a new window.
 */
export function bindingsBlock(): string {
  return [
    BLOCK_START,
    "# Pull up the whole-workspace cockpit; any close key dismisses.",
    // Whole-workspace, so — unlike the overlay it replaced — this needs no
    // window id resolved in-shell.
    "bind -n C-g display-popup -w 100% -h 100% -x 0 -y 0 -B -E 'gmux cockpit'",
    "# Toggle a headline label on every pane's border (leaves your panes visible).",
    `bind -n M-g run-shell 'gmux tmux label "$(tmux display -p "#{window_id}")"'`,
    "# Browse session history; Enter resumes into a new window.",
    "bind -n C-S-g display-popup -w 80% -h 80% -E 'gmux pick --resume-in-window'",
    BLOCK_END,
  ].join("\n");
}

function blockRegion(text: string, startMarker: string, endMarker: string): { start: number; end: number } | null {
  const start = text.indexOf(startMarker);
  if (start === -1) return null;
  const endMarkerAt = text.indexOf(endMarker, start);
  if (endMarkerAt === -1) return null;
  return { start, end: endMarkerAt + endMarker.length };
}

function removeMarkedBlock(existing: string, startMarker: string, endMarker: string): string {
  const region = blockRegion(existing, startMarker, endMarker);
  if (!region) return existing;
  let before = existing.slice(0, region.start);
  let after = existing.slice(region.end);
  if (before.endsWith("\n")) before = before.slice(0, -1);
  if (after.startsWith("\n")) after = after.slice(1);
  return before + (before && after ? "\n" : "") + after;
}

export function upsertBlock(existing: string, block: string): string {
  const region = blockRegion(existing, BLOCK_START, BLOCK_END);
  if (!region) {
    const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    return `${existing}${sep}${block}\n`;
  }
  return existing.slice(0, region.start) + block + existing.slice(region.end);
}

export function removeBlock(existing: string): string {
  return removeMarkedBlock(existing, BLOCK_START, BLOCK_END);
}

/** Drop both the gmux block and a leftover `# >>> gigamanage >>>` block. */
export function stripManagedBlocks(existing: string): string {
  return removeMarkedBlock(removeBlock(existing), LEGACY_BLOCK_START, LEGACY_BLOCK_END);
}

export function tmuxConfFiles(home: string): { conf: string; local: string } {
  return { conf: join(home, ".tmux.conf"), local: join(home, ".tmux.conf.local") };
}

/**
 * True when this conf will actually load `~/.tmux.conf.local`.
 *
 * Oh My Tmux does `source "$TMUX_CONF_LOCAL"`. Vanilla tmux never reads
 * `.tmux.conf.local`, and a dotfiles-repo symlink is not Oh My Tmux just
 * because it is a symlink — those users want write-through.
 */
export function sourcesTmuxConfLocal(confText: string): boolean {
  return /tmux\.conf\.local|TMUX_CONF_LOCAL/.test(confText);
}

/**
 * The file `gmux tmux install` should write: `.tmux.conf.local` only when the
 * live conf sources it. Otherwise `~/.tmux.conf` (including through a
 * user-owned dotfiles symlink).
 */
export function resolveTmuxConfPath(home: string, fs: TmuxInspectFs): string {
  const { conf, local } = tmuxConfFiles(home);
  if (sourcesTmuxConfLocal(fs.read(conf) ?? "")) return local;
  return conf;
}

export function realTmuxFs(): TmuxInspectFs {
  return {
    exists: (path) => existsSync(path),
    isSymlink: (path) => {
      try {
        return lstatSync(path).isSymbolicLink();
      } catch {
        return false;
      }
    },
    read: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}

export function inspectTmuxBindings(home: string, fs: TmuxInspectFs): TmuxBindingsReport {
  const { conf, local } = tmuxConfFiles(home);
  const targetPath = resolveTmuxConfPath(home, fs);
  const targetText = fs.read(targetPath) ?? "";
  const leftoverLegacy = [conf, local].some((p) => (fs.read(p) ?? "").includes(LEGACY_BLOCK_START));
  return {
    targetPath,
    installed: targetText.includes(BLOCK_START),
    leftoverLegacy,
  };
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Install the gmux block into the file tmux will keep, and strip leftover
 * gigamanage/gmux blocks from both candidate files (including through a
 * symlink, so a previous write-through install is cleaned up).
 */
export async function installTmuxBindings(home: string): Promise<InstallResult> {
  const fs = realTmuxFs();
  const { conf, local } = tmuxConfFiles(home);
  const target = resolveTmuxConfPath(home, fs);
  const other = target === local ? conf : local;
  let removedLegacy = false;

  const rewrite = async (path: string, asTarget: boolean): Promise<void> => {
    const existing = await readMaybe(path);
    if (existing === null && !asTarget) return;
    const text = existing ?? "";
    if (text.includes(LEGACY_BLOCK_START)) removedLegacy = true;
    const stripped = stripManagedBlocks(text);
    const next = asTarget ? upsertBlock(stripped, bindingsBlock()) : stripped;
    if (next === text) return;
    try {
      await writeFile(path, next, "utf8");
    } catch {
      throw new GmuxError(`Could not write tmux bindings to ${path}.`, {
        fix: `Check that ${path} is writable, then re-run gmux tmux install.`,
      });
    }
  };

  // Target first so a failed cleanup cannot leave the user with no bindings.
  await rewrite(target, true);
  await rewrite(other, false);

  return { path: target, removedLegacy };
}

export async function uninstallTmuxBindings(home: string): Promise<void> {
  const { conf, local } = tmuxConfFiles(home);
  for (const path of [conf, local]) {
    const existing = await readMaybe(path);
    if (existing === null) continue;
    const next = stripManagedBlocks(existing);
    if (next !== existing) await writeFile(path, next, "utf8");
  }
}

export async function maybeInstallTmuxBindings(opts: {
  available: boolean;
  ask: (question: string, fallback: boolean) => Promise<boolean>;
  home: string;
}): Promise<{ didInstall: boolean; path?: string }> {
  if (!opts.available) return { didInstall: false };
  const report = inspectTmuxBindings(opts.home, realTmuxFs());
  if (report.installed && !report.leftoverLegacy) {
    return { didInstall: false, path: report.targetPath };
  }
  const ok = await opts.ask(
    `\n${bold("Install tmux bindings (ctrl-g cockpit, ctrl-shift-g picker)?")}\n${dim(
      "Writes to ~/.tmux.conf.local when the live conf sources it (Oh My Tmux); otherwise ~/.tmux.conf.",
    )}\n`,
    true,
  );
  if (!ok) return { didInstall: false };
  const result = await installTmuxBindings(opts.home);
  return { didInstall: true, path: result.path };
}

export function registerTmux(program: Command): void {
  const tmux = program.command("tmux").description("manage gmux's tmux key bindings");

  tmux
    .command("install")
    .description("add the gmux cockpit/picker key bindings to ~/.tmux.conf (or ~/.tmux.conf.local)")
    .action(async () => {
      const result = await installTmuxBindings(homedir());
      process.stdout.write(`${green("installed")} bindings in ${result.path}\n`);
      if (result.removedLegacy) {
        process.stdout.write(`${dim("removed leftover gigamanage bindings so ctrl-g opens the cockpit")}\n`);
      }
      process.stdout.write(
        `${dim("reload with `tmux source-file ~/.tmux.conf`; then ctrl-g pulls up the cockpit, ctrl-shift-g browses")}\n`,
      );
    });

  tmux
    .command("uninstall")
    .description("remove the gmux block from ~/.tmux.conf and ~/.tmux.conf.local")
    .action(async () => {
      await uninstallTmuxBindings(homedir());
      process.stdout.write(`${green("removed")} the gmux block from ~/.tmux.conf and ~/.tmux.conf.local\n`);
    });

  tmux
    .command("label <window>")
    .description("toggle the live pane-border label agent (used by the M-g binding)")
    .action(async (windowId: string) => {
      const result = await toggleWatch(windowId);
      if (result === "daemon-owned") {
        process.stderr.write(
          `${yellow("note")} gmux daemon is running and owns the pane borders; stop it with \`gmux daemon stop\` to use alt-g watch.\n`,
        );
      }
    });
}
