/**
 * The semantic worker: turns a gated pane observation into a `PaneSemantics`
 * (one-line label + card) and writes it to the workspace model.
 *
 * THE DECOUPLING INVARIANT. An LLM call can hang, time out, or simply be slow
 * — and gm's fast path (sensors, gate, state transitions, the socket) must
 * never notice. `SemanticWorker` is a bounded concurrent pool keyed by pane:
 * `enqueue` never awaits the provider, coalesces a pane's pending job (newest
 * observation wins), and lets `concurrency` jobs run side by side. One pane
 * hanging never keeps another pane's label from landing.
 */

import type { Observation, PaneEntry, PaneSemantics } from "../core/workspace-types.js";
import { simhash64 } from "../core/fingerprint.js";
import { readConfig, resolveSummaryCommand } from "./config.js";
import { runProviderCommand } from "./provider-process.js";
import type { WorkspaceModel } from "./workspace.js";
import type { SemanticGate } from "./semantic-gate.js";

/** What a label provider is asked for, and what it must answer with. */
export interface LabelProvider {
  label(input: { paneId: string; project: string | null; tailLines: string[] }): Promise<{ label: string; card: string }>;
}

const LABEL_TIMEOUT_MS = 120_000;

/** Cap the prompt so a runaway transcript tail doesn't balloon the call. */
const MAX_TAIL_LINES = 60;

function buildLabelPrompt(input: { paneId: string; project: string | null; tailLines: string[] }): string {
  const project = input.project ?? "an unknown project";
  const tail = input.tailLines.slice(-MAX_TAIL_LINES).join("\n");
  return [
    `You are labeling a live terminal pane working in "${project}".`,
    "Here is the most recent output from that pane:",
    "---",
    tail,
    "---",
    "Reply with ONLY a single JSON object, no prose and no code fence:",
    '{"label": "<=8 words, present tense, what it is doing right now>", "card": "2-4 sentences of context: what it is, what changed recently, what is next"}',
  ].join("\n");
}

/**
 * Pull `{ label, card }` out of a model reply.
 *
 * Models fence their JSON or preface it more often than they should, so —
 * matching `parseSummaryFields` — we take the outermost brace pair rather
 * than trusting the whole reply to parse. A reply we can't make sense of
 * still becomes *something*: the first line as the label, the raw text as
 * the card, so a scrappy provider degrades gracefully instead of throwing.
 */
export function parseLabelFields(raw: string): { label: string; card: string } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      const label = typeof parsed["label"] === "string" ? parsed["label"].trim() : "";
      const card = typeof parsed["card"] === "string" ? parsed["card"].trim() : "";
      if (label) return { label, card };
    } catch {
      // Fall through to the defensive fallback below.
    }
  }
  const firstLine = raw.trim().split("\n")[0]?.trim() ?? "";
  return { label: firstLine || "(no label)", card: raw.trim() };
}

/**
 * The real `LabelProvider`: a thin wrapper over a provider CLI (the same
 * argv `gm`'s session summaries use), with its own compact prompt.
 *
 * Deliberately NOT built on `SummaryProvider`/`SummaryInput` — that shape
 * carries a whole session's prompt history, git branch, files touched, and a
 * six-field reply, none of which a live pane observation (paneId, project,
 * a tail of lines) can honestly fill in. Reusing it would mean fabricating
 * those fields or leaving them empty, which is worse than a dedicated,
 * shorter prompt asking for exactly the two fields we need. `argv` is
 * resolved the same way summaries resolve theirs (`resolveSummaryCommand`),
 * so the two features keep sharing one provider *choice* even though they
 * don't share a prompt shape.
 *
 * `argv: null` means "no provider configured" (`gm setup` never ran, or the
 * user chose to make no model calls) — `label()` throws in that case, which
 * `SemanticWorker`'s try/catch turns into a silent skip rather than a crash.
 */
export class CliLabelProvider implements LabelProvider {
  constructor(private readonly argv: string[] | null) {}

  async label(input: { paneId: string; project: string | null; tailLines: string[] }): Promise<{ label: string; card: string }> {
    if (!this.argv) throw new Error("no summary provider configured");
    const prompt = buildLabelPrompt(input);
    const raw = await runProviderCommand(this.argv, prompt, { timeoutMs: LABEL_TIMEOUT_MS });
    return parseLabelFields(raw);
  }
}

/** The `CliLabelProvider` for the user's current config (`gm setup`). */
export async function defaultLabelProvider(): Promise<CliLabelProvider> {
  const config = await readConfig();
  return new CliLabelProvider(resolveSummaryCommand(config));
}

interface PendingJob {
  entry: PaneEntry;
  obs: Observation;
  now: number;
}

/**
 * Priority for the pane a `PendingJob` labels: the active/visible pane
 * outranks any background pane, and a background pane that's mid-`working`
 * outranks an idle one. Ties (any two panes at the same priority) are broken
 * by scan order — `nextJob()` keeps the first one it sees.
 */
function priorityOf(entry: PaneEntry): number {
  if (entry.identity.active) return 3;
  if (entry.state === "working") return 2;
  return 1;
}

/**
 * A bounded worker pool that labels gated observations without ever letting
 * a slow or hung provider call block another pane, or the caller of
 * `enqueue`.
 *
 * `enqueue` is synchronous from the caller's point of view: it consults the
 * gate, coalesces this pane's pending job (a newer observation replaces an
 * older, not-yet-started one), and kicks the pump — it never awaits the
 * provider itself. Up to `concurrency` jobs run side by side; a pane whose
 * `provider.label()` never resolves simply never frees its pool slot, while
 * every other slot keeps turning over.
 */
export class SemanticWorker {
  private running = 0;
  private pending = new Map<string, PendingJob>();
  private waiters: Array<() => void> = [];
  private pumpScheduled = false;

  constructor(
    private readonly model: WorkspaceModel,
    private readonly provider: LabelProvider,
    private readonly gate: SemanticGate,
    private readonly concurrency = 4,
  ) {}

  /** Gate, coalesce, and schedule — never awaits the provider. */
  enqueue(entry: PaneEntry, obs: Observation, now: number): void {
    if (!this.gate.shouldSummarize(entry.identity.paneId, obs, now)) return;
    this.gate.noteQueued(entry.identity.paneId, obs, now);
    this.pending.set(entry.identity.paneId, { entry, obs, now }); // coalesce: newest wins
    this.schedulePump();
  }

  /**
   * Defer the next `pump()` to a microtask instead of dispatching inline.
   *
   * A caller commonly fires several synchronous `enqueue` calls back to back
   * (one scan tick touching many panes). Dispatching inline would let the
   * very first `enqueue` claim a free pool slot before its siblings even
   * land in `pending`, making `nextJob()`'s priority pick blind to the rest
   * of the burst. Coalescing all of them into `pending` before the first
   * pick — via one microtask hop — is what makes prioritization observable;
   * it changes nothing about concurrency or the fire-and-forget run below.
   */
  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  /** Scan `pending` for the highest-`priorityOf` job; null when empty. */
  private nextJob(): [string, PendingJob] | null {
    let best: [string, PendingJob] | null = null;
    for (const kv of this.pending) {
      if (!best || priorityOf(kv[1].entry) > priorityOf(best[1].entry)) best = kv;
    }
    return best;
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.size > 0) {
      const next = this.nextJob();
      if (!next) break; // Guards against a concurrent-mutation edge case under noUncheckedIndexedAccess.
      const [paneId, job] = next;
      this.pending.delete(paneId);
      this.running += 1;
      void this.run(paneId, job).finally(() => {
        this.running -= 1;
        this.pump();
        if (this.running === 0 && this.pending.size === 0) {
          const waiters = this.waiters;
          this.waiters = [];
          waiters.forEach((w) => w());
        }
      });
    }
  }

  private async run(paneId: string, job: PendingJob): Promise<void> {
    try {
      const cwd = job.entry.identity.cwd;
      const project = cwd ? (cwd.split("/").pop() ?? null) : null;
      const { label, card } = await this.provider.label({ paneId, project, tailLines: job.obs.tailLines });
      const semantics: PaneSemantics = {
        label,
        card,
        fingerprint: simhash64(job.obs.tailLines.join("\n")),
        updatedAt: job.now,
        stale: false,
      };
      this.model.applySemantics(paneId, semantics);
    } catch {
      // A provider failure marks nothing rather than crashing the worker;
      // the next meaningful change re-triggers the gate and retries.
    }
  }

  /** Resolves once no job is running and none is pending. */
  drain(): Promise<void> {
    if (this.running === 0 && this.pending.size === 0) return Promise.resolve();
    return new Promise<void>((r) => this.waiters.push(r));
  }
}
