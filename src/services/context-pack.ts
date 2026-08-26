/**
 * Bounded parent context pack for peel. Cache-only — never the transcript.
 * Adapters keep a ring of RECENT_PROMPT_COUNT = 12; the pack uses the last 3.
 * Codex recentUserPrompts are not humanText()-filtered.
 */

import type { SessionRecord, SessionSummary } from "../core/types.js";
import { cachedRecords } from "./index-store.js";
import { readSummary } from "./summarize.js";

export const CONTEXT_PACK_MAX_BYTES = 4096;
export const CONTEXT_PACK_BUDGET_MS = 500;

const PACK_RECENT_HUMAN_TURNS = 3;
const PACK_ASSISTANT_CLIP_CHARS = 800;
const PACK_SEED_MIN_BYTES = 512;
const PACK_SEED_HUGE_BYTES = 2048;

export interface PackTurn {
  role: "human" | "assistant";
  text: string;
}

export interface ContextPack {
  parentPaneId: string;
  parentHeadline: string | null;
  parentOverview: string | null;
  recentTurns: PackTurn[];
  seed: string;
}

export interface PackInput {
  parentPaneId: string;
  seed: string;
  parentHeadline?: string | null;
  parentOverview?: string | null;
  recentTurns?: PackTurn[];
}

export interface PackLookup {
  records: () => Promise<SessionRecord[]>;
  readSummary: (record: SessionRecord) => Promise<SessionSummary | null>;
}

export interface SubmitChoice {
  parentCleared: boolean;
  /** Serialized pack, or null when the 500 ms budget missed. */
  packText: string | null;
  seed: string;
  headline: string | null;
}

function defaultLookup(): PackLookup {
  return {
    records: () => cachedRecords(),
    readSummary: (record) => readSummary(record),
  };
}

export function turnsFromRecord(
  rec: Pick<SessionRecord, "recentUserPrompts" | "lastAssistantText">,
): PackTurn[] {
  const humans = rec.recentUserPrompts.slice(-PACK_RECENT_HUMAN_TURNS).map((text) => ({
    role: "human" as const,
    text,
  }));
  const assistant = rec.lastAssistantText
    ? [{ role: "assistant" as const, text: clipChars(rec.lastAssistantText, PACK_ASSISTANT_CLIP_CHARS) }]
    : [];
  return [...humans, ...assistant];
}

export function buildContextPack(input: PackInput): ContextPack {
  const seedBytes = byteLength(input.seed);
  if (seedBytes > PACK_SEED_HUGE_BYTES) {
    return {
      parentPaneId: input.parentPaneId,
      parentHeadline: null,
      parentOverview: null,
      recentTurns: [],
      seed: clipUtf8(input.seed, PACK_SEED_HUGE_BYTES),
    };
  }

  const pack: ContextPack = {
    parentPaneId: input.parentPaneId,
    parentHeadline: emptyToNull(input.parentHeadline),
    parentOverview: emptyToNull(input.parentOverview),
    recentTurns: normalizeTurns(input.recentTurns ?? []),
    seed: input.seed,
  };
  fit(pack);
  return pack;
}

export function serializePack(pack: ContextPack): string {
  return render({
    seed: pack.seed,
    headline: pack.parentHeadline,
    overview: pack.parentOverview,
    turns: pack.recentTurns,
  });
}

export function serializeSeedAndHeadline(seed: string, headline: string | null): string {
  return render({ seed, headline: emptyToNull(headline), overview: null, turns: [] });
}

/** Uncleared parent → null (pack dropped). Timeout → seed+headline. Else the pack. */
export function chooseSubmitBody(choice: SubmitChoice): string | null {
  if (!choice.parentCleared) return null;
  if (choice.packText != null && choice.packText !== "") return choice.packText;
  return serializeSeedAndHeadline(choice.seed, choice.headline);
}

export async function withPackDeadline<T>(work: Promise<T>, fallback: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(fallback());
    }, CONTEXT_PACK_BUDGET_MS);
  });
  try {
    const result = await Promise.race([work, timeout]);
    if (!timedOut && timer !== undefined) clearTimeout(timer);
    return result;
  } catch (error) {
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut) return fallback();
    throw error;
  }
}

export async function packFromParams(
  params: unknown,
  lookup?: PackLookup,
): Promise<ContextPack> {
  const resolved = lookup ?? defaultLookup();
  const parsed = parseParams(params);
  const records = await resolved.records().catch(() => [] as SessionRecord[]);
  const rec = findRecord(records, parsed.harness, parsed.sessionId);
  const cached = rec ? await resolved.readSummary(rec).catch(() => null) : null;
  const headline = nonempty(cached?.headline) ?? parsed.semanticsLabel;
  const overview = nonempty(cached?.overview) ?? parsed.semanticsCard;
  return buildContextPack({
    parentPaneId: parsed.parentPaneId,
    seed: parsed.seed,
    parentHeadline: headline,
    parentOverview: overview,
    recentTurns: rec ? turnsFromRecord(rec) : [],
  });
}

function parseParams(params: unknown): {
  parentPaneId: string;
  seed: string;
  harness: string | null;
  sessionId: string | null;
  semanticsLabel: string | null;
  semanticsCard: string | null;
} {
  const o = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const semantics =
    o["semantics"] && typeof o["semantics"] === "object" && !Array.isArray(o["semantics"])
      ? (o["semantics"] as Record<string, unknown>)
      : {};
  return {
    parentPaneId: typeof o["parentPaneId"] === "string" ? o["parentPaneId"] : "",
    seed: typeof o["seed"] === "string" ? o["seed"] : "",
    harness: typeof o["harness"] === "string" ? o["harness"] : null,
    sessionId: typeof o["sessionId"] === "string" ? o["sessionId"] : null,
    semanticsLabel: typeof semantics["label"] === "string" ? semantics["label"] : null,
    semanticsCard: typeof semantics["card"] === "string" ? semantics["card"] : null,
  };
}

function findRecord(
  records: SessionRecord[],
  harness: string | null,
  sessionId: string | null,
): SessionRecord | null {
  if (!sessionId) return null;
  return (
    records.find((r) => r.sessionId === sessionId && (harness == null || r.harness === harness)) ??
    null
  );
}

function normalizeTurns(turns: PackTurn[]): PackTurn[] {
  const humans = turns.filter((t) => t.role === "human").slice(-PACK_RECENT_HUMAN_TURNS);
  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant");
  const assistant = lastAssistant
    ? [{ role: "assistant" as const, text: clipChars(lastAssistant.text, PACK_ASSISTANT_CLIP_CHARS) }]
    : [];
  return [...humans, ...assistant];
}

function fit(pack: ContextPack): void {
  while (byteLength(serializePack(pack)) > CONTEXT_PACK_MAX_BYTES) {
    const oldestHuman = pack.recentTurns.findIndex((t) => t.role === "human");
    if (oldestHuman >= 0) {
      pack.recentTurns.splice(oldestHuman, 1);
      continue;
    }
    const asst = pack.recentTurns.find((t) => t.role === "assistant");
    if (asst && asst.text.length > 0) {
      clipAssistantToFit(pack, asst);
      continue;
    }
    if (pack.parentOverview != null) {
      pack.parentOverview = null;
      continue;
    }
    if (pack.parentHeadline != null) {
      pack.parentHeadline = null;
      continue;
    }
    const seedBytes = byteLength(pack.seed);
    if (seedBytes > PACK_SEED_MIN_BYTES) {
      const framing = byteLength(serializePack({ ...pack, seed: "" }));
      const room = Math.max(PACK_SEED_MIN_BYTES, CONTEXT_PACK_MAX_BYTES - framing);
      pack.seed = clipUtf8(pack.seed, Math.min(seedBytes - 1, room));
      continue;
    }
    break;
  }
}

function clipAssistantToFit(pack: ContextPack, asst: PackTurn): void {
  const without = pack.recentTurns.filter((t) => t !== asst);
  const framing = byteLength(serializePack({ ...pack, recentTurns: [...without, { role: "assistant", text: "" }] }));
  const room = CONTEXT_PACK_MAX_BYTES - framing;
  if (room <= 0) {
    pack.recentTurns = without;
    return;
  }
  const clipped = clipUtf8(asst.text, room);
  if (clipped === asst.text) {
    // No UTF-8 progress (room smaller than one character) — drop the turn.
    pack.recentTurns = without;
    return;
  }
  asst.text = clipped;
}

function render(opts: {
  seed: string;
  headline: string | null;
  overview: string | null;
  turns: PackTurn[];
}): string {
  const lines = [
    "You are a delegated agent. This is a new session, not a fork of the parent.",
    "Work in the same directory. Do not assume the parent's files are staged or that its conversation continues here.",
    "",
    "## Task",
    opts.seed,
  ];
  const parent: string[] = [];
  if (opts.headline) parent.push(`Headline: ${opts.headline}`);
  if (opts.overview) parent.push(`Overview: ${opts.overview}`);
  if (opts.turns.length > 0) {
    if (parent.length > 0) parent.push("");
    parent.push("Recent parent turns (oldest first):");
    for (const turn of opts.turns) {
      parent.push(`${turn.role === "human" ? "Human" : "Assistant"}: ${turn.text}`);
    }
  }
  if (parent.length > 0) {
    lines.push("", "## Parent context (background only)", ...parent);
  }
  return lines.join("\n");
}

function clipChars(input: string, max: number): string {
  return input.length <= max ? input : input.slice(0, max);
}

function clipUtf8(input: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(input, "utf8");
  if (buf.byteLength <= maxBytes) return input;
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value === "" ? null : value;
}

function nonempty(value: string | null | undefined): string | null {
  const t = value?.trim();
  return t ? t : null;
}
