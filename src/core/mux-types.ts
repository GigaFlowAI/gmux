import type { HarnessId } from "./types.js";

export type CallerClass = "tui" | "intel" | "pane" | "cli";

export interface GmuxPane {
  paneId: string;       // p_ + Crockford Base32 of 16 ULID bytes
  tabId: string;
  workspaceId: string;
  cwd: string;
  argv: string[];
  pid: number;
  harness: HarnessId | null;
  sessionId: string | null;
  peelDepth: number;    // 0 for user-spawned
  templateId: string | null;
}

export interface GridLine {
  text: string;
  intensity: number[];  // DIM→0, BOLD→2, else 1; length === text length
}

export interface GridSnapshot {
  paneId: string;
  cols: number;
  rows: number;
  lines: GridLine[];
  alternateScreen: boolean;
  foregroundCommand: string;
}

export interface ExtractResult {
  text: string; // empty string means "treat as empty buffer"
  confidence: "high" | "low";
  clearKeys: string;
  extractor: string; // "claude-code" | "codex" | "shell" | "shadow" | "empty"
}

export interface SpawnOpts {
  cwd: string;
  argv: string[];
  env?: Record<string, string>;
  tab?: { mode: "new"; name: string } | { mode: "existing"; tabId: string };
  /** default false. When true, sets THIS client's focusedPaneId only. */
  focus?: boolean;
  peelDepth?: number;
  /** Catalog id when this pane was spawned as a workspace template. */
  templateId?: string | null;
}

export interface ToolStart {
  callId: string;
  command: string;
  paneId: string;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function encodeCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >> bits) & 31];
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

export function decodeCrockford(s: string): Uint8Array {
  const map = new Map([...CROCKFORD].map((c, i) => [c, i]));
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase()) {
    const v = map.get(ch);
    if (v === undefined) throw new Error("invalid crockford");
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 255);
    }
  }
  return Uint8Array.from(out);
}

export function formatPaneId(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error("pane id is 16 ULID bytes");
  return "p_" + encodeCrockford(bytes);
}

export function parsePaneId(id: string): Uint8Array {
  if (!id.startsWith("p_")) throw new Error("pane id must start with p_");
  const bytes = decodeCrockford(id.slice(2));
  if (bytes.length !== 16) throw new Error("pane id must decode to 16 bytes");
  return bytes;
}
