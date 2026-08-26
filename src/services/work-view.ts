/**
 * Work views: the report layer that answers "what did this session actually
 * DO?" as a small, self-contained HTML fragment a browser can render.
 *
 * Generation runs only on an explicit `v` press in the cockpit, never in the
 * background — so the cache uses an exact source hash (regenerate on any real
 * change), not the summary layer's divergence gate.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { hash } from "../core/text.js";
import { workViewPath } from "../core/paths.js";
import type { HarnessId, SessionRecord, SummaryInput } from "../core/types.js";
import { SummaryProviderError } from "../core/errors.js";
import { FALLBACK_COMMAND, readConfig, resolveSummaryCommand } from "./config.js";
import { mapLimit } from "./concurrency.js";
import { runProviderCommand } from "./provider-process.js";
import { onPath } from "./providers.js";
import { distill } from "./distill.js";

/** Bump when `buildWorkViewPrompt` changes shape, to invalidate cached fragments. */
export const WORKVIEW_PROMPT_VERSION = 1;

export interface WorkView {
  harness: HarnessId;
  sessionId: string;
  /** distill hash folded with the prompt version — the cache key. */
  sourceHash: string;
  generatedAt: string;
  provider: string;
  /** Validated, self-contained HTML fragment. */
  html: string;
}

/** Cache key: session content (via distill) plus this layer's prompt version. */
export function workViewSourceHash(record: SessionRecord): string {
  return hash(JSON.stringify({ session: distill(record).hash, prompt: WORKVIEW_PROMPT_VERSION }));
}

export function isStale(view: WorkView | null, record: SessionRecord): boolean {
  return !view || view.sourceHash !== workViewSourceHash(record);
}

export async function readWorkView(record: SessionRecord): Promise<WorkView | null> {
  try {
    return JSON.parse(await readFile(workViewPath(record.harness, record.sessionId), "utf8")) as WorkView;
  } catch {
    return null;
  }
}

export async function writeWorkView(view: WorkView): Promise<void> {
  const path = workViewPath(view.harness, view.sessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(view), "utf8");
}

/**
 * Pull a usable HTML fragment out of a model reply. Strips a single ```html /
 * ``` fence if present, and requires the body to contain at least one HTML tag —
 * otherwise it is a refusal or prose, and this session fails (collected upstream).
 */
export function extractFragment(raw: string): string {
  let s = raw.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(s);
  if (fenced) s = fenced[1]!.trim();
  if (!/<[a-zA-Z][\s\S]*>/.test(s)) throw new Error("model reply contained no HTML");
  return s;
}

/** The instruction handed to the provider for one session's work view. */
export function buildWorkViewPrompt(input: SummaryInput): string {
  const lines: string[] = [];
  lines.push(
    "You are visualizing a coding-agent session so a developer can re-orient on it at a glance.",
    "You are shown the ARC of the session: where it started, waypoints through the middle, and how it ended.",
    "",
    "## Session",
    `harness: ${input.harness}`,
  );
  if (input.project) lines.push(`project: ${input.project}`);
  if (input.gitBranch) lines.push(`branch: ${input.gitBranch}`);
  if (input.title) lines.push(`title at start (may be stale): ${input.title}`);
  lines.push(`ended mid-task: ${input.endedMidTask ? "yes" : "no"}`);
  if (input.filesTouched.length > 0) {
    lines.push("", "## Files the agent changed", ...input.filesTouched.map((f) => `- ${f}`));
  }
  const tail = new Set(input.recentUserPrompts);
  const [anchor, ...waypoints] = input.arcPrompts;
  if (anchor !== undefined && !tail.has(anchor)) lines.push("", "## The original ask", anchor);
  const fresh = waypoints.filter((p) => !tail.has(p));
  if (fresh.length > 0) lines.push("", "## How the work moved (oldest first)", ...fresh.map((p) => `- ${p}`));
  if (input.recentUserPrompts.length > 0) {
    lines.push("", "## Most recent instructions (oldest first)", ...input.recentUserPrompts.map((p) => `- ${p}`));
  }
  if (input.lastAssistantText) lines.push("", "## The agent's final message", input.lastAssistantText);
  if (input.lastToolFailure) lines.push("", "## The last failing command", input.lastToolFailure);
  lines.push(
    "",
    "## Output",
    "Reply with ONLY a self-contained HTML fragment that visualizes the ARC of this work —",
    "what was explored, built, tested, what landed, and what is still open — as a compact",
    "diagram: prefer inline <svg> for a flow/timeline, or styled inline HTML. Keep it small",
    "(aim for a handful of nodes). Constraints, strictly:",
    "- NO <script>, NO external references (no <script src>, no remote CSS, fonts, or <img>).",
    "- NO <html>, <head>, or <body> wrapper — emit the fragment only.",
    "- All styling inline or in a single <style> inside the fragment.",
    "Return the fragment and nothing else — no prose, no code fence.",
  );
  return lines.join("\n");
}

const PROVIDER_TIMEOUT_MS = 120_000;
const WORKVIEW_CONCURRENCY = Number(process.env["GIGAMANAGE_WORKVIEW_CONCURRENCY"]) || 8;

/** A prompt goes in, an HTML fragment (unvalidated) comes out. */
export interface WorkViewProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  render(prompt: string): Promise<string>;
}

/** The default: the same CLI the summarizer uses (`claude -p` / GIGAMANAGE_SUMMARY_CMD). */
export class CliWorkViewProvider implements WorkViewProvider {
  readonly name: string;
  private readonly argv: string[];
  constructor(argv: string[] = [...FALLBACK_COMMAND]) {
    this.argv = argv;
    this.name = argv.join(" ");
  }
  async isAvailable(): Promise<boolean> {
    const binary = this.argv[0];
    return binary ? onPath(binary) : false;
  }
  async render(prompt: string): Promise<string> {
    try {
      return await runProviderCommand(this.argv, prompt, { timeoutMs: PROVIDER_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof SummaryProviderError) throw error;
      throw new SummaryProviderError(this.name, (error as Error).message);
    }
  }
}

/** The provider for the current config, or null when the user configured no model. */
export async function defaultWorkViewProvider(): Promise<CliWorkViewProvider | null> {
  const command = resolveSummaryCommand(await readConfig());
  return command ? new CliWorkViewProvider(command) : null;
}

export async function generateWorkView(
  record: SessionRecord,
  provider: WorkViewProvider,
  now: () => Date = () => new Date(),
): Promise<WorkView> {
  const raw = await provider.render(buildWorkViewPrompt(distill(record)));
  return {
    harness: record.harness,
    sessionId: record.sessionId,
    sourceHash: workViewSourceHash(record),
    generatedAt: now().toISOString(),
    provider: provider.name,
    html: extractFragment(raw),
  };
}

export interface BuildWorkViewsResult {
  views: Map<string, WorkView>;
  failed: { sessionId: string; reason: string }[];
}

/**
 * Build a view per record, serving fresh ones from cache. One session's failure
 * (provider error, non-HTML reply) is collected, never thrown: a single bad
 * session must not blank the whole report.
 */
export async function buildWorkViews(
  records: readonly SessionRecord[],
  provider: WorkViewProvider,
  options: { force?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<BuildWorkViewsResult> {
  const views = new Map<string, WorkView>();
  const failed: { sessionId: string; reason: string }[] = [];
  let done = 0;
  await mapLimit(records, WORKVIEW_CONCURRENCY, async (record) => {
    try {
      let view = options.force ? null : await readWorkView(record);
      if (isStale(view, record)) {
        view = await generateWorkView(record, provider);
        await writeWorkView(view);
      }
      views.set(record.sessionId, view!);
    } catch (error) {
      failed.push({ sessionId: record.sessionId, reason: (error as Error).message });
    } finally {
      done += 1;
      options.onProgress?.(done, records.length);
    }
  });
  return { views, failed };
}
