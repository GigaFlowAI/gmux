/**
 * Workspace templates: match agent tool-starts and spawn idle shells.
 *
 * Never re-exec the captured argv (a second `pnpm dev` fights the port).
 * First match wins. One live pane per `(workspaceId, templateId)`.
 */

import { createHash } from "node:crypto";

import type { ToolStart } from "../core/mux-types.js";
import type { SpawnOpts } from "../core/mux-types.js";
import {
  TEMPLATE_COOLDOWN_MS,
  TEMPLATE_IDS,
  TEMPLATE_SEEN_RING,
  isTemplateId,
  type LiveTemplate,
  type PaneTemplate,
  type TemplateAct,
  type TemplateId,
} from "../core/template-types.js";
import type { MuxGateway } from "./mux-gateway.js";

export {
  TEMPLATE_COOLDOWN_MS,
  TEMPLATE_IDS,
  TEMPLATE_SEEN_RING,
  isTemplateId,
};
export type { LiveTemplate, PaneTemplate, TemplateAct, TemplateId };

export function idleShellArgv(): string[] {
  return [process.env.SHELL ?? "/bin/zsh"];
}

export function liveKey(workspaceId: string, templateId: string): string {
  return `${workspaceId}:${templateId}`;
}

export function templateSpawnOpts(templateId: TemplateId, cwd: string): SpawnOpts {
  return {
    cwd,
    argv: idleShellArgv(),
    tab: { mode: "new", name: templateId },
    focus: false,
    templateId,
  };
}

const TESTS_RE = /\b(?:npm test|pnpm test|yarn test|npx vitest|vitest|jest|pytest|cargo test|go test|just test)\b/;
const LOGS_TAIL_RE = /\b(?:tail -f|kubectl logs|docker logs -f)\b/;
const LOGS_DEV_RE = /\b(?:pnpm dev|npm run dev|yarn dev|next dev|vite)\b/;
const REVIEW_CMD_RE = /\b(?:gh pr (?:diff|view|checkout)|git diff --stat)\b/;
const REVIEW_TEXT_RE = /\b(pr|pull request|review)\b/i;

/** Catalog order is the match order. `dev-server-start` shares id `logs`. */
export const CATALOG: PaneTemplate[] = [
  {
    id: "tests",
    title: "tests",
    match: { kind: "tool-command-start", pattern: TESTS_RE.source },
    spawn: { argv: "idle-shell", focus: false },
  },
  {
    id: "logs",
    title: "logs",
    match: { kind: "tool-command-start", pattern: LOGS_TAIL_RE.source },
    spawn: { argv: "idle-shell", focus: false },
  },
  {
    id: "logs",
    title: "logs",
    match: { kind: "dev-server-start", pattern: LOGS_DEV_RE.source },
    spawn: { argv: "idle-shell", focus: false },
  },
  {
    id: "review",
    title: "review",
    match: { kind: "review-start", pattern: REVIEW_CMD_RE.source },
    spawn: { argv: "idle-shell", focus: false },
  },
];

export function reviewHit(headline: string, overview: string): boolean {
  return REVIEW_TEXT_RE.test(`${headline} ${overview}`);
}

function matchTemplate(command: string, headline: string, overview: string): PaneTemplate | null {
  for (const tmpl of CATALOG) {
    if (tmpl.match.kind === "review-start") {
      if (REVIEW_CMD_RE.test(command) && reviewHit(headline, overview)) return tmpl;
      continue;
    }
    if (tmpl.match.kind === "tool-command-start") {
      if (tmpl.id === "tests" && TESTS_RE.test(command)) return tmpl;
      if (tmpl.id === "logs" && LOGS_TAIL_RE.test(command)) return tmpl;
      continue;
    }
    if (tmpl.match.kind === "dev-server-start" && LOGS_DEV_RE.test(command)) return tmpl;
  }
  return null;
}

export interface DecideTemplatesInput {
  workspaceId: string;
  live: LiveTemplate[];
  starts: ToolStart[];
  seen: Set<string>;
  headline?: string;
  overview?: string;
  now?: number;
  closedAt?: ReadonlyMap<string, number>;
}

export function rememberCallId(seen: Set<string>, callId: string): void {
  if (seen.has(callId)) return;
  seen.add(callId);
  while (seen.size > TEMPLATE_SEEN_RING) {
    const oldest = seen.values().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

export function decideTemplates(input: DecideTemplatesInput): TemplateAct[] {
  const headline = input.headline ?? "";
  const overview = input.overview ?? "";
  const occupying = new Set(
    input.live.filter((l) => l.workspaceId === input.workspaceId).map((l) => l.templateId),
  );
  const cooling = (id: string): boolean => {
    if (input.now === undefined || !input.closedAt) return false;
    const closed = input.closedAt.get(liveKey(input.workspaceId, id));
    if (closed === undefined) return false;
    return input.now - closed < TEMPLATE_COOLDOWN_MS;
  };

  const acts: TemplateAct[] = [];
  for (const start of input.starts) {
    if (input.seen.has(start.callId)) continue;
    rememberCallId(input.seen, start.callId);
    const matched = matchTemplate(start.command, headline, overview);
    if (!matched) continue;
    if (occupying.has(matched.id)) continue;
    if (cooling(matched.id)) continue;
    occupying.add(matched.id);
    acts.push({
      templateId: matched.id,
      title: matched.title,
      argv: idleShellArgv(),
      workspaceId: input.workspaceId,
      paneId: start.paneId,
      focus: false,
    });
  }
  return acts;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function blocks(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((b): b is Record<string, unknown> => record(b) !== null) : [];
}

function parseClaudeStarts(row: Record<string, unknown>, paneId: string): ToolStart[] {
  if (row["type"] !== "assistant") return [];
  const message = record(row["message"]);
  const out: ToolStart[] = [];
  for (const block of blocks(message?.["content"])) {
    if (block["type"] !== "tool_use") continue;
    if (block["name"] !== "Bash") continue;
    if (typeof block["id"] !== "string" || block["id"].length === 0) continue;
    const input = record(block["input"]);
    if (!input || typeof input["command"] !== "string") continue;
    out.push({ callId: block["id"], command: input["command"], paneId });
  }
  return out;
}

function parseCodexStarts(row: Record<string, unknown>, paneId: string): ToolStart[] {
  if (row["type"] !== "response_item") return [];
  const payload = record(row["payload"]);
  if (payload?.["type"] !== "function_call") return [];
  if (payload["name"] !== "shell") return [];
  if (typeof payload["arguments"] !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload["arguments"]);
  } catch {
    return [];
  }
  const args = record(parsed);
  if (!args || typeof args["cmd"] !== "string") return [];
  const named = payload["name"];
  const callId =
    (typeof payload["call_id"] === "string" && payload["call_id"]) ||
    (typeof payload["id"] === "string" && payload["id"]) ||
    createHash("sha1")
      .update(`${typeof named === "string" ? named : ""}\0${payload["arguments"]}`)
      .digest("hex")
      .slice(0, 16);
  return [{ callId, command: args["cmd"], paneId }];
}

/** Parse Claude `tool_use` Bash / Codex `function_call` shell starts from JSONL rows. */
export function parseToolStarts(rows: Record<string, unknown>[], paneId: string): ToolStart[] {
  const out: ToolStart[] = [];
  for (const row of rows) {
    out.push(...parseClaudeStarts(row, paneId), ...parseCodexStarts(row, paneId));
  }
  return out;
}

export async function applyTemplateActs(
  gateway: MuxGateway,
  acts: TemplateAct[],
  parents: ReadonlyMap<string, { cwd: string }>,
): Promise<Array<{ paneId: string; tabId: string; templateId: TemplateId }>> {
  const spawned: Array<{ paneId: string; tabId: string; templateId: TemplateId }> = [];
  for (const act of acts) {
    const cwd = parents.get(act.paneId)?.cwd ?? process.cwd();
    const result = await gateway.spawn({
      argv: act.argv,
      cwd,
      tab: { mode: "new", name: act.title },
      focus: false,
      templateId: act.templateId,
    });
    spawned.push({ ...result, templateId: act.templateId });
  }
  return spawned;
}

export class TemplateEngine {
  private readonly seen = new Set<string>();
  private readonly closedAt = new Map<string, number>();
  private readonly livePaneIds = new Map<string, string>();

  constructor(private readonly gateway: MuxGateway) {}

  syncLive(
    panes: Array<{ paneId: string; workspaceId?: string; templateId?: string | null }>,
    now: number,
  ): LiveTemplate[] {
    const present = new Set(panes.map((p) => p.paneId));
    for (const [key, paneId] of [...this.livePaneIds]) {
      if (!present.has(paneId)) {
        this.livePaneIds.delete(key);
        this.closedAt.set(key, now);
      }
    }
    const live: LiveTemplate[] = [];
    for (const pane of panes) {
      if (!pane.templateId || !pane.workspaceId) continue;
      const key = liveKey(pane.workspaceId, pane.templateId);
      this.livePaneIds.set(key, pane.paneId);
      live.push({ templateId: pane.templateId, workspaceId: pane.workspaceId });
    }
    return live;
  }

  async apply(opts: {
    workspaceId: string;
    panes: Array<{ paneId: string; cwd: string; workspaceId?: string; templateId?: string | null }>;
    starts: ToolStart[];
    headline?: string;
    overview?: string;
    now: number;
  }): Promise<void> {
    const live = this.syncLive(opts.panes, opts.now);
    const acts = decideTemplates({
      workspaceId: opts.workspaceId,
      live,
      starts: opts.starts,
      seen: this.seen,
      headline: opts.headline,
      overview: opts.overview,
      now: opts.now,
      closedAt: this.closedAt,
    });
    const spawned = await applyTemplateActs(
      this.gateway,
      acts,
      new Map(opts.panes.map((p) => [p.paneId, { cwd: p.cwd }])),
    );
    for (const act of acts) {
      const hit = spawned.find((s) => s.templateId === act.templateId);
      if (hit) this.livePaneIds.set(liveKey(act.workspaceId, act.templateId), hit.paneId);
    }
  }
}
