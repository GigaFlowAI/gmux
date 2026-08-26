/**
 * Slow-path prompt extractors. Mux sends a grid; we return seed text + clearKeys.
 * Harness UI knowledge lives here (not in Rust) so fixtures retune without a rebuild.
 */

import { allAdapters } from "../adapters/registry.js";
import type { ExtractResult, GridLine, GridSnapshot } from "../core/mux-types.js";

export type { ExtractResult };

/** Same set as `isIdleShell` in organize.ts. */
const SHELL_COMMANDS = new Set(["zsh", "bash", "fish", "sh", "-zsh", "-bash"]);

const VERT = new Set(["│", "┃", "|"]);
const TOP_LEFT = new Set(["╭", "┌"]);
const TOP_RIGHT = new Set(["╮", "┐"]);
const BOT_LEFT = new Set(["╰", "└"]);
const BOT_RIGHT = new Set(["╯", "┘"]);

const EMPTY: ExtractResult = {
  text: "",
  confidence: "low",
  clearKeys: "\x15",
  extractor: "empty",
};

export function extract(grid: GridSnapshot): ExtractResult {
  const which = pickExtractor(grid);
  if (which === "claude-code") return extractClaude(grid);
  if (which === "codex") return extractCodex(grid);
  if (which === "shell") return extractShell(grid);
  return { ...EMPTY };
}

function pickExtractor(grid: GridSnapshot): "claude-code" | "codex" | "shell" | "empty" {
  const cmd = baseName(grid.foregroundCommand);
  for (const adapter of allAdapters()) {
    if (adapter.processNames.some((n) => n === cmd)) {
      return adapter.id === "codex" ? "codex" : "claude-code";
    }
  }
  if (SHELL_COMMANDS.has(cmd) || !grid.alternateScreen) return "shell";
  return "empty";
}

function baseName(command: string): string {
  const normalized = command.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function extractClaude(grid: GridSnapshot): ExtractResult {
  const box = findBox(grid.lines, grid.cols);
  if (!box) return { ...EMPTY, extractor: "claude-code" };
  const interior = grid.lines.slice(box.top + 1, box.bottom);
  const kept: string[] = [];
  for (const row of interior) {
    const stripped = stripVertical(row);
    if (isDimPlaceholder(stripped.text, stripped.intensity)) continue;
    const body = stripGt(stripped.text).replace(/\s+$/, "");
    if (body.trim() === "") continue;
    kept.push(body);
  }
  const text = kept.join("\n").trim();
  const n = Math.max(interior.length, 1);
  return {
    text,
    confidence: "high",
    clearKeys: "\x15".repeat(n),
    extractor: "claude-code",
  };
}

function extractCodex(grid: GridSnapshot): ExtractResult {
  const caret = caretText(grid.lines);
  if (caret) {
    return {
      text: caret,
      confidence: "low",
      clearKeys: "\x15",
      extractor: "codex",
    };
  }
  const boxed = extractClaude({ ...grid, foregroundCommand: "claude" });
  if (boxed.text) {
    return { ...boxed, extractor: "codex" };
  }
  return { ...EMPTY, extractor: "codex" };
}

function extractShell(grid: GridSnapshot): ExtractResult {
  let last = "";
  for (let i = grid.lines.length - 1; i >= 0; i--) {
    const t = grid.lines[i]?.text ?? "";
    if (t.trim() !== "") {
      last = t;
      break;
    }
  }
  return {
    text: stripPs1(last).trim(),
    confidence: "low",
    clearKeys: "\x15",
    extractor: "shell",
  };
}

function caretText(lines: GridLine[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]?.text ?? "";
    if (!raw.includes(">") && !raw.includes("▍") && !raw.includes("›")) continue;
    const stripped = raw.replace(/▍/g, "").replace(/^\s*[>›]\s?/, "").trim();
    if (stripped) return stripped;
  }
  return null;
}

function stripPs1(line: string): string {
  return line.replace(/^(?:[^\s@]+@[^\s:]+(?::\S+)?)?\s*[/%#$>]\s*/, "");
}

function findBox(lines: GridLine[], cols: number): { top: number; bottom: number } | null {
  const minInner = cols * 0.5;
  for (let bottom = lines.length - 1; bottom >= 1; bottom--) {
    const b = corners(lines[bottom]!.text, BOT_LEFT, BOT_RIGHT);
    if (!b || b.r - b.l - 1 < minInner) continue;
    for (let top = bottom - 1; top >= 0; top--) {
      const t = corners(lines[top]!.text, TOP_LEFT, TOP_RIGHT);
      if (!t || t.r - t.l - 1 < minInner) continue;
      return { top, bottom };
    }
  }
  return null;
}

function corners(text: string, left: Set<string>, right: Set<string>): { l: number; r: number } | null {
  const chars = [...text];
  let l = -1;
  let r = -1;
  for (let i = 0; i < chars.length; i++) {
    if (l < 0 && left.has(chars[i]!)) l = i;
    if (right.has(chars[i]!)) r = i;
  }
  if (l < 0 || r <= l) return null;
  return { l, r };
}

function stripVertical(row: GridLine): { text: string; intensity: number[] } {
  const chars = [...row.text];
  const intensity = row.intensity.slice(0, chars.length);
  while (intensity.length < chars.length) intensity.push(1);
  if (chars.length > 0 && VERT.has(chars[0]!)) {
    chars.shift();
    intensity.shift();
  }
  if (chars.length > 0 && VERT.has(chars[chars.length - 1]!)) {
    chars.pop();
    intensity.pop();
  }
  return { text: chars.join(""), intensity };
}

function isDimPlaceholder(text: string, intensity: number[]): boolean {
  const chars = [...text];
  let any = false;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === " ") continue;
    any = true;
    if ((intensity[i] ?? 1) !== 0) return false;
  }
  return any;
}

function stripGt(s: string): string {
  return s.replace(/^\s*>\s?/, "");
}

/** Mux sends `{ grid: GridSnapshot }`; tolerate a bare snapshot too. */
export function extractFromParams(params: unknown): ExtractResult {
  const grid = asGrid(params);
  if (!grid) return { ...EMPTY };
  return extract(grid);
}

function asGrid(params: unknown): GridSnapshot | null {
  if (!params || typeof params !== "object") return null;
  const o = params as Record<string, unknown>;
  const raw =
    o["grid"] && typeof o["grid"] === "object" && !Array.isArray(o["grid"])
      ? (o["grid"] as Record<string, unknown>)
      : o;
  if (!Array.isArray(raw["lines"])) return null;
  const lines: GridLine[] = [];
  for (const item of raw["lines"]) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const text = typeof row["text"] === "string" ? row["text"] : "";
    const intensity = Array.isArray(row["intensity"])
      ? row["intensity"].map((n) => (typeof n === "number" ? n : 1))
      : [];
    lines.push({ text, intensity });
  }
  return {
    paneId: typeof raw["paneId"] === "string" ? raw["paneId"] : "",
    cols: typeof raw["cols"] === "number" ? raw["cols"] : 0,
    rows: typeof raw["rows"] === "number" ? raw["rows"] : lines.length,
    lines,
    alternateScreen: raw["alternateScreen"] === true,
    foregroundCommand: typeof raw["foregroundCommand"] === "string" ? raw["foregroundCommand"] : "",
  };
}
