/**
 * Sensors: the two ways gmux learns what a pane is doing, unified behind one
 * shape.
 *
 * `TerminalSensor` watches a plain shell (or any harness we can't identify a
 * transcript for) via tmux `capture-pane`, and keeps a `pipe-pane` log running
 * so a later "show me the raw tail" view has more than 200 lines to work with.
 * `AgentSensor` watches a known harness's transcript file directly — richer
 * and cheaper than scraping a terminal, but only available once the pane is
 * linked to a session.
 *
 * Both report the same `Observation` shape (`gmux-types.ts`) so the daemon's
 * state-derivation layer never needs to know which kind of pane it is looking
 * at.
 */

import { createHash } from "node:crypto";

import type { Observation, PaneIdentity } from "../core/gmux-types.js";
import { paneLogPath } from "../core/paths.js";
import { readJsonl, RingBuffer } from "../adapters/jsonl.js";
import { cachedRecords } from "./index-store.js";
import { rotateIfLarge, pruneLog, MAX_PANE_LOG_BYTES } from "./log-rotation.js";
import type { TmuxGateway } from "./tmux-gateway.js";

/** How many transcript rows AgentSensor keeps in view per observe(). */
const AGENT_TAIL_CAPACITY = 40;

export interface Sensor {
  readonly kind: "agent" | "terminal";
  observe(now: number): Promise<Observation>;
  teardown(): Promise<void>;
}

const hash = (s: string): string => createHash("sha1").update(s).digest("hex");

/**
 * Watches a pane via tmux capture, for shells and unidentified harnesses.
 *
 * `pipe-pane` is started lazily on first observe (not the constructor) so
 * constructing a sensor is never itself a side effect — only observing one
 * is.
 */
export class TerminalSensor implements Sensor {
  readonly kind = "terminal" as const;
  private lastHash = "";
  private lastActivityTs = 0;
  private piping = false;

  constructor(private readonly identity: PaneIdentity, private readonly gateway: TmuxGateway) {}

  async observe(now: number): Promise<Observation> {
    if (!this.piping) {
      await this.gateway.startPipe(this.identity.paneId, paneLogPath(this.identity.paneId)).catch(() => {});
      this.piping = true;
    }
    const text = await this.gateway.capture(this.identity.paneId, 200);
    const h = hash(text);
    if (h !== this.lastHash) {
      this.lastActivityTs = now;
      this.lastHash = h;
    }
    await rotateIfLarge(paneLogPath(this.identity.paneId), MAX_PANE_LOG_BYTES).catch(() => {});
    const tailLines = text.split("\n").filter((l) => l.length > 0);
    return {
      paneId: this.identity.paneId,
      kind: "terminal",
      ts: now,
      tailLines,
      lastActivityTs: this.lastActivityTs,
    };
  }

  async teardown(): Promise<void> {
    if (this.piping) await this.gateway.stopPipe(this.identity.paneId).catch(() => {});
    await pruneLog(paneLogPath(this.identity.paneId)).catch(() => {});
  }
}

// --- Agent-signal derivation -----------------------------------------------
//
// These read the two shapes gmux already knows how to parse in full
// (`adapters/claude-code.ts`, `adapters/codex.ts`), but here we only ever see
// the last ~40 rows of a possibly-still-growing file, so each helper looks
// for one narrow, well-grounded marker rather than replaying the adapter's
// whole-file logic. Any row shape we don't recognize is simply not a match —
// never a throw.

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function blocks(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((b): b is Record<string, unknown> => record(b) !== null) : [];
}

/** `timestamp` is the one field both `claude-code.ts` and `codex.ts` key on. */
export function tsOf(row: Record<string, unknown> | undefined): number | null {
  if (!row) return null;
  const ts = row["timestamp"];
  if (typeof ts !== "string") return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Which side spoke, for the two shapes we recognize: Claude Code's
 * `type: "user" | "assistant"` rows, and Codex's `event_msg` rows tagged
 * `user_message` / `agent_message` in `payload.type`.
 */
function roleOf(row: Record<string, unknown>): "user" | "assistant" | null {
  const type = row["type"];
  if (type === "user") return "user";
  if (type === "assistant") return "assistant";
  if (type === "event_msg") {
    const payload = record(row["payload"]);
    const kind = payload?.["type"];
    if (kind === "user_message") return "user";
    if (kind === "agent_message") return "assistant";
  }
  return null;
}

/** Last known speaker was the assistant, with no human turn after it yet. */
export function isAssistantWaiting(rows: Record<string, unknown>[]): boolean | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const role = roleOf(rows[i]!);
    if (role === "assistant") return true;
    if (role === "user") return false;
  }
  return undefined;
}

/**
 * A tool/command failure in the tail: Claude Code's `tool_result` blocks with
 * `is_error: true` (see `hasToolError` in `adapters/claude-code.ts`), or a
 * Codex `function_call_output` reporting a nonzero exit (see `exitFailure` in
 * `adapters/codex.ts`).
 */
export function hasToolError(rows: Record<string, unknown>[]): boolean {
  return rows.some((row) => {
    if (row["type"] === "user") {
      const message = record(row["message"]);
      const content = message?.["content"];
      return blocks(content).some((b) => b["type"] === "tool_result" && b["is_error"] === true);
    }
    if (row["type"] === "response_item") {
      const payload = record(row["payload"]);
      if (payload?.["type"] === "function_call_output" && typeof payload["output"] === "string") {
        const match = /Process exited with code (\d+)/.exec(payload["output"]);
        return match !== null && match[1] !== "0";
      }
    }
    return false;
  });
}

/**
 * A completion marker in the tail. Only Codex's `task_complete` event is a
 * per-row signal we can trust here — Claude Code's transcripts carry no
 * equivalent single-line marker (its own adapter infers `endedMidTask` from
 * proximity to the end of the *whole* file, which a 40-row tail can't
 * reproduce), so `ended` stays `false` for Claude Code panes at the sensor
 * layer.
 */
export function isEnded(rows: Record<string, unknown>[]): boolean {
  return rows.some((row) => {
    if (row["type"] !== "event_msg") return false;
    const payload = record(row["payload"]);
    return payload?.["type"] === "task_complete";
  });
}

/**
 * Watches a known harness's transcript file.
 *
 * Takes only `identity` — never a `filePath` — so `makeSensor` stays
 * synchronous: the file is resolved lazily, on first `observe()`, via the
 * cached session index, and cached on the instance from then on. If no
 * matching record (or file) is found, `observe` degrades gracefully to an
 * empty observation rather than throwing.
 */
export class AgentSensor implements Sensor {
  readonly kind = "agent" as const;
  private resolvedPath: string | null | undefined;

  constructor(
    private readonly identity: PaneIdentity,
    /** Test-only escape hatch: skip index lookup and read this file directly. */
    private readonly filePathOverride?: string,
    /** Test-only escape hatch: replace the cachedRecords()-based lookup. */
    private readonly lookupOverride?: () => Promise<string | null>,
  ) {}

  private async lookupFromIndex(): Promise<string | null> {
    const records = await cachedRecords().catch(() => []);
    const match = records.find(
      (r) => r.harness === this.identity.harness && r.sessionId === this.identity.sessionId,
    );
    return match?.filePath ?? null;
  }

  private async resolvePath(): Promise<string | null> {
    if (this.filePathOverride) return this.filePathOverride;
    if (this.resolvedPath !== undefined) return this.resolvedPath;
    const filePath = this.lookupOverride ? await this.lookupOverride() : await this.lookupFromIndex();
    // Only memoize a HIT. The daemon keeps one AgentSensor alive for a pane's
    // whole lifetime, so caching a miss would degrade to empty observations
    // forever, even after the index later picks up the transcript. A miss is
    // cheap to retry: cachedRecords() is an in-memory cache read, not a rescan.
    if (filePath) this.resolvedPath = filePath;
    return filePath;
  }

  async observe(now: number): Promise<Observation> {
    const filePath = await this.resolvePath();
    if (!filePath) {
      return { paneId: this.identity.paneId, kind: "agent", ts: now, tailLines: [], lastActivityTs: now };
    }

    const tail = new RingBuffer<Record<string, unknown>>(AGENT_TAIL_CAPACITY);
    try {
      for await (const row of readJsonl(filePath)) tail.push(row);
    } catch {
      // File vanished or became unreadable mid-tick; degrade rather than throw.
      return { paneId: this.identity.paneId, kind: "agent", ts: now, tailLines: [], lastActivityTs: now };
    }

    const rows = tail.toArray();
    const tailLines = rows.map((r) => JSON.stringify(r));
    const lastActivityTs = tsOf(rows[rows.length - 1]) ?? now;

    return {
      paneId: this.identity.paneId,
      kind: "agent",
      ts: now,
      tailLines,
      lastActivityTs,
      awaitingInput: isAssistantWaiting(rows),
      sawError: hasToolError(rows),
      ended: isEnded(rows),
    };
  }

  async teardown(): Promise<void> {}
}

/**
 * Picks the richer sensor whenever the pane is resolvable to a known
 * harness session, else falls back to the terminal sensor.
 */
export function makeSensor(identity: PaneIdentity, gateway: TmuxGateway): Sensor {
  if (identity.harness && identity.sessionId) return new AgentSensor(identity);
  return new TerminalSensor(identity, gateway);
}
