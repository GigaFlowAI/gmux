/**
 * Summaries: the layer that answers "where did this land, and what's next?".
 *
 * The provider is a plain CLI invoked with the distilled prompt on stdin. That
 * keeps gigamanage harness-agnostic — it ships pointing at `claude -p`, but
 * GIGAMANAGE_SUMMARY_CMD can point it at `codex exec` or anything else that
 * reads a prompt and writes text.
 *
 * Summaries are cached by content hash and regenerated only when the session
 * itself changes, so each one is written once and re-read forever.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { SummaryProviderError } from "../core/errors.js";
import { hammingDistance, simhash64 } from "../core/fingerprint.js";
import { summaryPath } from "../core/paths.js";
import { hash } from "../core/text.js";
import type {
  SessionRecord,
  SessionSummary,
  SummaryFields,
  SummaryInput,
  SummaryProvider,
} from "../core/types.js";
import { FALLBACK_COMMAND, readConfig, resolveSummaryCommand } from "./config.js";
import { buildPrompt, distill } from "./distill.js";
import { mapLimit } from "./concurrency.js";
import { runProviderCommand } from "./provider-process.js";
import { onPath } from "./providers.js";

/**
 * How many summaries are written at once.
 *
 * Each is an independent `claude -p`; they do not contend. Eight keeps a
 * twenty-session backfill down to a few wall-clock minutes instead of twenty.
 */
const SUMMARY_CONCURRENCY = Number(process.env["GIGAMANAGE_SUMMARY_CONCURRENCY"]) || 8;
const PROVIDER_TIMEOUT_MS = 120_000;

/**
 * Default provider command, ignoring config.
 *
 * Kept for the synchronous callers that predate config and for tests. Prefer
 * `defaultSummaryProvider()`, which honors what the user chose in `gm setup`.
 */
export function defaultProviderCommand(): string[] {
  const override = process.env.GIGAMANAGE_SUMMARY_CMD;
  if (override && override.trim() !== "") return override.trim().split(/\s+/);
  return [...FALLBACK_COMMAND];
}

export class CliSummaryProvider implements SummaryProvider {
  readonly name: string;
  private readonly argv: string[];

  constructor(argv: string[] = defaultProviderCommand()) {
    this.argv = argv;
    this.name = argv.join(" ");
  }

  async isAvailable(): Promise<boolean> {
    const binary = this.argv[0];
    if (!binary) return false;
    return onPath(binary);
  }

  async generate(input: SummaryInput): Promise<SummaryFields> {
    const prompt = buildPrompt(input);
    try {
      const output = await runProviderCommand(this.argv, prompt, {
        timeoutMs: PROVIDER_TIMEOUT_MS,
      });
      return parseSummaryFields(output, this.name);
    } catch (error) {
      if (error instanceof SummaryProviderError) throw error;
      throw new SummaryProviderError(this.name, (error as Error).message);
    }
  }
}

/**
 * The summary provider for the current config, or null when the user has
 * configured gigamanage to make no model calls.
 *
 * Null is a choice being honored, not a failure. Callers render it as such.
 */
export async function defaultSummaryProvider(): Promise<CliSummaryProvider | null> {
  const command = resolveSummaryCommand(await readConfig());
  return command ? new CliSummaryProvider(command) : null;
}

/**
 * Pull the JSON object out of a model's reply.
 *
 * Models fence their JSON, or preface it, more often than they should — so we
 * take the outermost brace pair rather than trusting the whole reply to parse.
 */
export function parseSummaryFields(raw: string, provider: string): SummaryFields {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new SummaryProviderError(provider, "reply contained no JSON object");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    throw new SummaryProviderError(provider, `reply was not valid JSON: ${(error as Error).message}`);
  }

  const object = parsed as Record<string, unknown>;
  const field = (key: string): string => {
    const value = object[key];
    return typeof value === "string" ? value.trim() : "";
  };

  const headline = field("headline");
  if (headline === "") throw new SummaryProviderError(provider, "reply had no `headline`");

  return {
    headline,
    overview: field("overview"),
    summary: field("summary"),
    landed: field("landed"),
    open: field("open"),
    nextStep: field("nextStep"),
  };
}

export async function readSummary(record: SessionRecord): Promise<SessionSummary | null> {
  try {
    const raw = await readFile(summaryPath(record.harness, record.sessionId), "utf8");
    return JSON.parse(raw) as SessionSummary;
  } catch {
    return null;
  }
}

/** A cached summary is stale once the session it describes has moved on. */
export function isStale(summary: SessionSummary | null, record: SessionRecord): boolean {
  if (!summary) return true;
  return summary.sourceHash !== distill(record).hash;
}

/**
 * How many of the 64 SimHash bits must differ before a session is worth
 * re-summarising. Tunable via `GIGAMANAGE_REFRESH_DISTANCE`; the default is
 * conservative — refresh on real progress, not on chatter.
 */
export const REFRESH_DISTANCE = (() => {
  const raw = Number(process.env.GIGAMANAGE_REFRESH_DISTANCE);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
})();

/** The narrative fields — what the SimHash tracks for gradual divergence. */
function narrativeText(input: SummaryInput): string {
  return [...input.arcPrompts, ...input.recentUserPrompts, input.lastAssistantText ?? ""].join("\n");
}

export function contentFingerprint(input: SummaryInput): string {
  return simhash64(narrativeText(input));
}

/** The low-churn significant signals — any change here always forces a refresh. */
export function signalHash(input: SummaryInput): string {
  return hash(
    JSON.stringify({
      promptVersion: input.promptVersion,
      lastToolFailure: input.lastToolFailure,
      endedMidTask: input.endedMidTask,
      files: [...input.filesTouched].sort(),
    }),
  );
}

/**
 * Should this session's summary be re-generated? The divergence-gated successor
 * to `isStale`, for the background/watch path:
 *
 * - no summary → yes;
 * - a pre-0.9.0 summary with no fingerprint → fall back to the exact hash, so
 *   there is no forced re-summarise burst on upgrade;
 * - a significant signal changed (prompt version, a new tool failure, the
 *   mid-task flag, the files touched) → yes, even at SimHash distance 0;
 * - otherwise → only when the narrative SimHash has diverged by ≥ REFRESH_DISTANCE.
 */
export function shouldRefresh(summary: SessionSummary | null, record: SessionRecord): boolean {
  if (!summary) return true;
  const input = distill(record);
  if (!summary.fingerprint) return summary.sourceHash !== input.hash;
  if (summary.signalHash !== signalHash(input)) return true;
  return hammingDistance(summary.fingerprint, contentFingerprint(input)) >= REFRESH_DISTANCE;
}

export async function writeSummary(summary: SessionSummary): Promise<void> {
  const path = summaryPath(summary.harness, summary.sessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(summary, null, 2), "utf8");
}

/** Generate a summary for one session and cache it. */
export async function summarizeSession(
  record: SessionRecord,
  provider: SummaryProvider,
  now: () => Date = () => new Date(),
): Promise<SessionSummary> {
  const input = distill(record);
  const fields = await provider.generate(input);
  const summary: SessionSummary = {
    harness: record.harness,
    sessionId: record.sessionId,
    sourceHash: input.hash,
    fingerprint: contentFingerprint(input),
    signalHash: signalHash(input),
    generatedAt: now().toISOString(),
    provider: provider.name,
    ...fields,
  };
  await writeSummary(summary);
  return summary;
}

export interface SummarizeBatchResult {
  generated: number;
  skipped: number;
  failed: { sessionId: string; reason: string }[];
}

/**
 * Summarize many sessions, skipping those whose cached summary is still fresh.
 * Failures are collected rather than thrown: one bad session must not abort a
 * batch of fifty.
 */
export async function summarizeBatch(
  records: readonly SessionRecord[],
  provider: SummaryProvider,
  options: { force?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<SummarizeBatchResult> {
  const result: SummarizeBatchResult = { generated: 0, skipped: 0, failed: [] };
  let done = 0;

  await mapLimit(records, SUMMARY_CONCURRENCY, async (record) => {
    try {
      if (!options.force) {
        const existing = await readSummary(record);
        if (!isStale(existing, record)) {
          result.skipped += 1;
          return;
        }
      }
      await summarizeSession(record, provider);
      result.generated += 1;
    } catch (error) {
      result.failed.push({ sessionId: record.sessionId, reason: (error as Error).message });
    } finally {
      done += 1;
      options.onProgress?.(done, records.length);
    }
  });

  return result;
}
