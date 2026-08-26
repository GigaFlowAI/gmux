/** Small pure string/time helpers. No I/O, no internal imports. */

import { createHash } from "node:crypto";

/** Collapse whitespace and clip to `max`, appending an ellipsis when clipped. */
export function truncate(input: string, max: number): string {
  const flat = input.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/** Stable content hash used as a cache key. */
export function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Compact relative age, e.g. "2h", "3d". Deliberately terse: it is a column in
 * a list, not prose.
 */
export function relativeAge(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "?";
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

/**
 * Parse a duration like "3d", "2w", "24h" into an ISO cutoff timestamp.
 * Returns null for unparseable input.
 */
export function parseSince(input: string, now: Date = new Date()): string | null {
  const match = /^(\d+)\s*([smhdw])$/i.exec(input.trim());
  if (!match) {
    const asDate = new Date(input);
    return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
  }
  const amount = Number(match[1]);
  const unitMs: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  const ms = unitMs[match[2]!.toLowerCase()]!;
  return new Date(now.getTime() - amount * ms).toISOString();
}

/**
 * Greedy word wrap. Returns at least one line, even for empty input, so callers
 * can always render a row.
 *
 * A word longer than the width (a URL, a long path) is hard-split rather than
 * allowed to overflow — overflowing is the bug this exists to fix.
 */
export function wrapText(input: string, width: number): string[] {
  const text = input.replace(/\s+/g, " ").trim();
  if (text === "") return [""];
  if (!Number.isFinite(width) || width <= 0) return [text];

  const lines: string[] = [];
  let line = "";

  for (const word of text.split(" ")) {
    if (line === "" && word.length > width) {
      // Hard-split an oversized word across as many lines as it needs.
      let rest = word;
      while (rest.length > width) {
        lines.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      line = rest;
      continue;
    }

    const candidate = line === "" ? word : `${line} ${word}`;
    if (candidate.length <= width) {
      line = candidate;
      continue;
    }

    lines.push(line);
    line = word.length > width ? "" : word;
    if (word.length > width) {
      let rest = word;
      while (rest.length > width) {
        lines.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      line = rest;
    }
  }

  if (line !== "") lines.push(line);
  return lines.length > 0 ? lines : [""];
}

/**
 * Single-quote for POSIX shells, escaping any embedded single quote.
 *
 * Lives in core because two callers need it: `gm resume --print` emits a line
 * meant to be pasted into a shell, and the picker's fzf reload binding is a
 * shell command string. In both, an unquoted path with a space silently runs
 * the wrong thing rather than failing loudly.
 */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Pad or clip a cell to an exact display width. */
export function cell(input: string, width: number): string {
  const flat = input.replace(/\s+/g, " ").trim();
  if (flat.length === width) return flat;
  if (flat.length < width) return flat.padEnd(width, " ");
  return `${flat.slice(0, Math.max(0, width - 1))}…`;
}
