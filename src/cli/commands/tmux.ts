import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";

import { dim, green } from "../format.js";
import { toggleWatch } from "../tmux-label.js";

export const BLOCK_START = "# >>> gigamanage >>>";
export const BLOCK_END = "# <<< gigamanage <<<";

/**
 * The bindings gm manages. `ctrl+g` peeks the overlay full-screen; `ctrl+shift+g`
 * opens the history picker, whose Enter resumes into a new window.
 */
export function bindingsBlock(): string {
  return [
    BLOCK_START,
    "# Peek every pane's summary in place; any key dismisses.",
    // The window id is resolved in-shell rather than passed as a bare
    // `#{window_id}`: tmux does not expand that format inside `display-popup -E`,
    // so the shell would see `#` and comment out the rest of the line, leaving
    // `gm overlay` with no argument. `tmux display -p` expands it correctly.
    `bind -n C-g display-popup -w 100% -h 100% -x 0 -y 0 -B -E 'gm overlay "$(tmux display -p "#{window_id}")"'`,
    "# Toggle a headline label on every pane's border (leaves your panes visible).",
    `bind -n M-g run-shell 'gm tmux label "$(tmux display -p "#{window_id}")"'`,
    "# Browse session history; Enter resumes into a new window.",
    "bind -n C-S-g display-popup -w 80% -h 80% -E 'gm pick --resume-in-window'",
    BLOCK_END,
  ].join("\n");
}

function blockRegion(text: string): { start: number; end: number } | null {
  const start = text.indexOf(BLOCK_START);
  if (start === -1) return null;
  const endMarker = text.indexOf(BLOCK_END, start);
  if (endMarker === -1) return null;
  return { start, end: endMarker + BLOCK_END.length };
}

export function upsertBlock(existing: string, block: string): string {
  const region = blockRegion(existing);
  if (!region) {
    const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    return `${existing}${sep}${block}\n`;
  }
  return existing.slice(0, region.start) + block + existing.slice(region.end);
}

export function removeBlock(existing: string): string {
  const region = blockRegion(existing);
  if (!region) return existing;
  let before = existing.slice(0, region.start);
  let after = existing.slice(region.end);
  if (before.endsWith("\n")) before = before.slice(0, -1);
  if (after.startsWith("\n")) after = after.slice(1);
  return before + (before && after ? "\n" : "") + after;
}

function confPath(): string {
  return join(homedir(), ".tmux.conf");
}

async function readConf(): Promise<string> {
  try {
    return await readFile(confPath(), "utf8");
  } catch {
    return "";
  }
}

export function registerTmux(program: Command): void {
  const tmux = program.command("tmux").description("manage gigamanage's tmux key bindings");

  tmux
    .command("install")
    .description("add the gm overlay/picker key bindings to ~/.tmux.conf")
    .action(async () => {
      await writeFile(confPath(), upsertBlock(await readConf(), bindingsBlock()), "utf8");
      process.stdout.write(`${green("installed")} bindings in ${confPath()}\n`);
      process.stdout.write(
        `${dim("reload with `tmux source-file ~/.tmux.conf`; then ctrl-g peeks, ctrl-shift-g browses")}\n`,
      );
    });

  tmux
    .command("uninstall")
    .description("remove the gigamanage block from ~/.tmux.conf")
    .action(async () => {
      await writeFile(confPath(), removeBlock(await readConf()), "utf8");
      process.stdout.write(`${green("removed")} the gigamanage block from ${confPath()}\n`);
    });

  tmux
    .command("label <window>")
    .description("toggle the live pane-border label agent (used by the M-g binding)")
    .action(async (windowId: string) => {
      await toggleWatch(windowId);
    });
}
