/**
 * `gmux organize`: turns the live pane set into an `OrganizePlan` (grouping
 * work by project into windows) and, on request, executes that plan against
 * the tmux gateway.
 *
 * Two planners share the `OrganizePlanner` interface:
 *   - `HeuristicOrganizePlanner` — deterministic, no model call, no I/O. The
 *     graceful floor: `gmux organize` with no intent and no provider always
 *     has something sensible to do.
 *   - `LlmOrganizePlanner` — reuses the same provider-CLI plumbing as session
 *     summaries (`resolveSummaryCommand` + `runProviderCommand`) to turn a
 *     natural-language intent into a plan, and NEVER throws: any missing
 *     provider, timeout, or malformed reply falls back to the heuristic.
 *
 * `applyPlan` is the only place in this file that touches the gateway. It
 * validates every step against the live pane/window set (plus handles bound
 * by earlier steps in the same run) and skips — never throws for — a step
 * that no longer makes sense, so one stale reference can't abort the rest of
 * the plan.
 *
 * DESTRUCTION GUARANTEE: `applyPlan` only ever calls
 * `newWindow`/`renameWindow`/`joinPane`/`breakPane`/`swapPane`/`selectLayout`
 * on the gateway. None of those kills a process. A pane moved out of a window
 * that tmux then closes (now empty) has already left *with* its process.
 * There is no code path from a plan to `kill-pane`/`kill-window` — those
 * verbs do not appear anywhere below, and `OrganizeStep` has no op that maps
 * to one.
 */

import { basename } from "node:path";

import {
  isLayoutName,
  type LayoutName,
  type OrganizePane,
  type OrganizePlan,
  type OrganizePlanner,
  type OrganizeStep,
  type WindowTarget,
} from "../core/organize-types.js";
import { readConfig, resolveSummaryCommand } from "./config.js";
import { runProviderCommand } from "./provider-process.js";
import type { TmuxGateway } from "./tmux-gateway.js";

export type { OrganizePlanner } from "../core/organize-types.js";

// ---------------------------------------------------------------------------
// HeuristicOrganizePlanner
// ---------------------------------------------------------------------------

const BARE_SHELL_COMMANDS = new Set(["zsh", "bash", "fish", "sh", "-zsh", "-bash"]);

/**
 * True for a pane that is nothing but an idle interactive shell: no resolved
 * harness, a bare shell as its foreground command, and (when we know a
 * state at all) that state is "idle". Everything else — a resolved harness, a
 * plain non-shell command, or a shell mid-"working"/"error" — is agent-class,
 * so a live process is never swept into the "shells" bucket by mistake.
 */
function isIdleShell(pane: OrganizePane): boolean {
  if (pane.harness !== null) return false;
  if (!BARE_SHELL_COMMANDS.has(pane.command)) return false;
  return pane.state === null || pane.state === "idle";
}

/** `basename(cwd)`, normalized so an empty path or "/" reads as "root". */
function projectKeyOf(cwd: string): string {
  const base = basename(cwd);
  return base === "" ? "root" : base;
}

function paneLabel(pane: OrganizePane): string {
  return pane.label ?? pane.command;
}

function byPaneId(a: OrganizePane, b: OrganizePane): number {
  return a.paneId.localeCompare(b.paneId);
}

/** Panes (from the full input set) currently sharing `windowId`. */
function countInWindow(panes: OrganizePane[], windowId: string): number {
  return panes.filter((p) => p.windowId === windowId).length;
}

/**
 * Deterministic, pure, no-I/O planner. Groups agent panes by project
 * (`basename(cwd)`) into one window each, and idle shells into a shared
 * "shells" window. Ignores `intent` — it has no natural-language input to
 * interpret, which is exactly why it is the safe default and the fallback
 * for `LlmOrganizePlanner`.
 */
export class HeuristicOrganizePlanner implements OrganizePlanner {
  async plan(panes: OrganizePane[], _intent?: string): Promise<OrganizePlan> {
    const steps: OrganizeStep[] = [];
    let movedCount = 0;

    const agentPanes = panes.filter((p) => !isIdleShell(p));
    const shellPanes = panes.filter(isIdleShell).sort(byPaneId);

    const groups = new Map<string, OrganizePane[]>();
    for (const pane of agentPanes) {
      const key = projectKeyOf(pane.cwd);
      const group = groups.get(key);
      if (group) group.push(pane);
      else groups.set(key, [pane]);
    }
    for (const group of groups.values()) group.sort(byPaneId);

    const projectKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b));

    for (const key of projectKeys) {
      const group = groups.get(key)!;
      const anchorPane = group.find((p) => p.windowId !== null) ?? null;
      const anchorWindowId = anchorPane?.windowId ?? null;

      let anchor: WindowTarget;
      let freshlyCreated = false;
      if (anchorWindowId !== null) {
        anchor = { kind: "window", windowId: anchorWindowId };
      } else {
        const handle = `w:${key}`;
        steps.push({ op: "new-window", handle, name: key, description: `Create window "${key}"` });
        anchor = { kind: "handle", handle };
        freshlyCreated = true;
      }

      if (!freshlyCreated) {
        steps.push({
          op: "rename-window",
          window: anchor,
          name: key,
          description: `Rename window to "${key}"`,
        });
      }

      for (const pane of group) {
        if (pane === anchorPane) continue; // Already the anchor; nothing to move.
        if (anchorWindowId !== null && pane.windowId === anchorWindowId) continue; // Already grouped.
        steps.push({
          op: "move-pane",
          paneId: pane.paneId,
          to: anchor,
          description: `Move ${pane.paneId} (${paneLabel(pane)}) → "${key}"`,
        });
        movedCount += 1;
      }

      steps.push({ op: "select-layout", window: anchor, layout: "tiled", description: `Tile "${key}"` });
    }

    if (shellPanes.length >= 2 && !shellsAlreadyAloneTogether(panes, shellPanes)) {
      const handle = "w:shells";
      steps.push({ op: "new-window", handle, name: "shells", description: 'Create window "shells"' });
      const anchor: WindowTarget = { kind: "handle", handle };
      for (const pane of shellPanes) {
        steps.push({
          op: "move-pane",
          paneId: pane.paneId,
          to: anchor,
          description: `Move ${pane.paneId} (${paneLabel(pane)}) → "shells"`,
        });
        movedCount += 1;
      }
      steps.push({
        op: "select-layout",
        window: anchor,
        layout: "even-vertical",
        description: 'Arrange "shells"',
      });
    }

    const summary = `${projectKeys.length} project window(s), ${movedCount} pane(s) moved`;
    return { summary, steps };
  }
}

/** True when every idle shell already shares one window, alone (no other pane in it). */
function shellsAlreadyAloneTogether(allPanes: OrganizePane[], shellPanes: OrganizePane[]): boolean {
  const windowIds = new Set(shellPanes.map((p) => p.windowId));
  if (windowIds.size !== 1) return false;
  const [windowId] = [...windowIds];
  if (windowId === null || windowId === undefined) return false;
  return countInWindow(allPanes, windowId) === shellPanes.length;
}

// ---------------------------------------------------------------------------
// LLM planner: prompt + reply parsing (pure) and the planner itself
// ---------------------------------------------------------------------------

const ORGANIZE_TIMEOUT_MS = 120_000;
const MAX_PLAN_STEPS = 200;

function formatPaneLine(pane: OrganizePane): string {
  const parts = [pane.paneId, `win=${pane.windowId ?? "?"}`];
  if (pane.state) parts.push(`state=${pane.state}`);
  parts.push(`cwd=${pane.cwd}`);
  parts.push(`cmd=${pane.command}`);
  if (pane.harness) parts.push(`harness=${pane.harness}`);
  if (pane.label) parts.push(`label=${JSON.stringify(pane.label)}`);
  return parts.join("  ");
}

/** Pure. The prompt an LLM planner is asked to reply to. */
export function buildOrganizePrompt(panes: OrganizePane[], intent: string): string {
  return [
    "You are planning a tmux workspace reorganization.",
    "Current panes:",
    panes.map(formatPaneLine).join("\n"),
    "",
    `Intent: ${intent}`,
    "",
    "Reply with ONLY a JSON object, no prose and no code fence:",
    '{"summary": "<short summary>", "steps": [ <step>, ... ]}',
    "Each <step> is exactly one of:",
    '  {"op":"new-window","handle":"<local id>","name":"<window name>","description":"<text>"}',
    '  {"op":"rename-window","window":<WindowTarget>,"name":"<window name>","description":"<text>"}',
    '  {"op":"move-pane","paneId":"%N","to":<WindowTarget>,"description":"<text>"}',
    '  {"op":"break-pane","paneId":"%N","handle":"<local id>","name":"<window name>","description":"<text>"}',
    '  {"op":"swap-pane","a":"%N","b":"%N","description":"<text>"}',
    '  {"op":"select-layout","window":<WindowTarget>,"layout":"tiled|even-horizontal|even-vertical|main-horizontal|main-vertical","description":"<text>"}',
    'A <WindowTarget> is {"kind":"window","windowId":"@N"} for a window already listed above, or ' +
      '{"kind":"handle","handle":"<local id>"} for a window created earlier in THIS plan by a new-window or break-pane step.',
    "Only reference paneId values from the panes listed above.",
    "Never delete or kill anything — there is no such op, and none should be invented.",
  ].join("\n");
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function readWindowTarget(v: unknown, boundHandles: ReadonlySet<string>): WindowTarget | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o["kind"] === "window" && isNonEmptyString(o["windowId"])) {
    return { kind: "window", windowId: o["windowId"] };
  }
  if (o["kind"] === "handle" && isNonEmptyString(o["handle"])) {
    if (!boundHandles.has(o["handle"])) return null; // Referenced before it was bound (or never bound).
    return { kind: "handle", handle: o["handle"] };
  }
  return null;
}

/** Validate + coerce one raw step. Returns null for anything malformed, unknown, or out of range. */
function readStep(
  raw: unknown,
  paneIds: ReadonlySet<string>,
  boundHandles: ReadonlySet<string>,
): OrganizeStep | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const description = isNonEmptyString(o["description"]) ? o["description"] : String(o["op"] ?? "");

  switch (o["op"]) {
    case "new-window": {
      if (!isNonEmptyString(o["handle"]) || !isNonEmptyString(o["name"])) return null;
      return { op: "new-window", handle: o["handle"], name: o["name"], description };
    }
    case "rename-window": {
      const window = readWindowTarget(o["window"], boundHandles);
      if (!window || !isNonEmptyString(o["name"])) return null;
      return { op: "rename-window", window, name: o["name"], description };
    }
    case "move-pane": {
      if (!isNonEmptyString(o["paneId"]) || !paneIds.has(o["paneId"])) return null;
      const to = readWindowTarget(o["to"], boundHandles);
      if (!to) return null;
      return { op: "move-pane", paneId: o["paneId"], to, description };
    }
    case "break-pane": {
      if (!isNonEmptyString(o["paneId"]) || !paneIds.has(o["paneId"])) return null;
      if (!isNonEmptyString(o["handle"])) return null;
      if (o["name"] !== undefined && !isNonEmptyString(o["name"])) return null;
      const name = isNonEmptyString(o["name"]) ? o["name"] : undefined;
      return { op: "break-pane", paneId: o["paneId"], handle: o["handle"], name, description };
    }
    case "swap-pane": {
      if (!isNonEmptyString(o["a"]) || !paneIds.has(o["a"])) return null;
      if (!isNonEmptyString(o["b"]) || !paneIds.has(o["b"])) return null;
      return { op: "swap-pane", a: o["a"], b: o["b"], description };
    }
    case "select-layout": {
      const window = readWindowTarget(o["window"], boundHandles);
      if (!window) return null;
      if (!isNonEmptyString(o["layout"]) || !isLayoutName(o["layout"])) return null;
      const layout: LayoutName = o["layout"];
      return { op: "select-layout", window, layout, description };
    }
    default:
      return null;
  }
}

/**
 * Pure. Turns a raw model reply into a validated `OrganizePlan`, dropping —
 * never throwing on — any step that is malformed, references an unknown
 * pane, or references a window handle not bound by an earlier step in the
 * same reply. Mirrors `parseSummaryFields`/`parseLabelFields`: take the
 * outermost `{`…`}` rather than trusting the whole reply to parse, because
 * models fence or preface their JSON more often than they should.
 */
export function parseOrganizePlan(raw: string, panes: OrganizePane[]): OrganizePlan {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return { summary: "", steps: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { summary: "", steps: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { summary: "", steps: [] };

  const obj = parsed as Record<string, unknown>;
  const rawSteps = Array.isArray(obj["steps"]) ? obj["steps"].slice(0, MAX_PLAN_STEPS) : [];
  const paneIds = new Set(panes.map((p) => p.paneId));
  const boundHandles = new Set<string>();

  const steps: OrganizeStep[] = [];
  for (const rawStep of rawSteps) {
    const step = readStep(rawStep, paneIds, boundHandles);
    if (!step) continue;
    if (step.op === "new-window" || step.op === "break-pane") boundHandles.add(step.handle);
    steps.push(step);
  }

  const summary = isNonEmptyString(obj["summary"]) ? obj["summary"] : `${steps.length} step(s)`;
  return { summary, steps };
}

/**
 * LLM-backed planner. Reuses the exact provider infra the semantic labeler
 * uses (`resolveSummaryCommand` + `runProviderCommand`). Never throws to the
 * caller: no provider configured, no intent given, a timeout, a malformed
 * reply, or a reply that parses to zero usable steps all fall back to
 * `fallback` (a fresh `HeuristicOrganizePlanner` by default).
 *
 * `argv`, when passed to the constructor, is used as-is (mainly for tests, to
 * avoid touching real config/PATH); when omitted, it is resolved fresh from
 * config on every `plan()` call, same as the labeler does.
 */
export class LlmOrganizePlanner implements OrganizePlanner {
  constructor(
    private readonly fallback: OrganizePlanner = new HeuristicOrganizePlanner(),
    private readonly argv?: string[] | null,
  ) {}

  async plan(panes: OrganizePane[], intent?: string): Promise<OrganizePlan> {
    if (!intent || intent.trim() === "") return this.fallback.plan(panes, intent);

    const argv = this.argv !== undefined ? this.argv : resolveSummaryCommand(await readConfig());
    if (!argv) return this.fallback.plan(panes, intent);

    try {
      const prompt = buildOrganizePrompt(panes, intent);
      const raw = await runProviderCommand(argv, prompt, { timeoutMs: ORGANIZE_TIMEOUT_MS });
      const parsed = parseOrganizePlan(raw, panes);
      if (parsed.steps.length === 0) return this.fallback.plan(panes, intent);
      return parsed;
    } catch {
      return this.fallback.plan(panes, intent);
    }
  }
}

// ---------------------------------------------------------------------------
// applyPlan
// ---------------------------------------------------------------------------

export interface ApplyResult {
  applied: OrganizeStep[];
  skipped: Array<{ step: OrganizeStep; reason: string }>;
}

function describeUnresolved(target: WindowTarget): string {
  return target.kind === "handle"
    ? `unbound window handle ${target.handle}`
    : `window ${target.windowId} not present`;
}

/**
 * Execute a plan against `gateway`, one step at a time, in order.
 *
 * Every step is validated against the live pane/window set (snapshotted once,
 * up front) plus any window handle a prior step in THIS run has bound —
 * never against a fresh `listPanes()` call, so the validation set is stable
 * for the whole run. A step that fails validation, or whose gateway call
 * throws (a tmux race, "can't break the only pane in a window", …), is
 * pushed to `skipped` with a reason and execution continues — one bad step
 * never aborts the rest of the plan.
 *
 * Only `newWindow`/`renameWindow`/`joinPane`/`breakPane`/`swapPane`/
 * `selectLayout` are ever called here. None of those kills a process.
 */
export async function applyPlan(plan: OrganizePlan, gateway: TmuxGateway): Promise<ApplyResult> {
  const panes = await gateway.listPanes();
  const livePaneIds = new Set(panes.map((p) => p.paneId));
  const liveWindowIds = new Set(panes.map((p) => p.windowId).filter((w): w is string => w !== null));
  const handles = new Map<string, string>();

  const applied: OrganizeStep[] = [];
  const skipped: Array<{ step: OrganizeStep; reason: string }> = [];
  const skip = (step: OrganizeStep, reason: string): void => {
    skipped.push({ step, reason });
  };

  const resolveWindow = (target: WindowTarget): string | null => {
    if (target.kind === "window") return liveWindowIds.has(target.windowId) ? target.windowId : null;
    return handles.get(target.handle) ?? null;
  };

  for (const step of plan.steps) {
    try {
      switch (step.op) {
        case "new-window": {
          const windowId = await gateway.newWindow(step.name);
          handles.set(step.handle, windowId);
          liveWindowIds.add(windowId);
          applied.push(step);
          break;
        }
        case "rename-window": {
          const windowId = resolveWindow(step.window);
          if (windowId === null) {
            skip(step, describeUnresolved(step.window));
            break;
          }
          await gateway.renameWindow(windowId, step.name);
          applied.push(step);
          break;
        }
        case "move-pane": {
          if (!livePaneIds.has(step.paneId)) {
            skip(step, `pane ${step.paneId} no longer present`);
            break;
          }
          const windowId = resolveWindow(step.to);
          if (windowId === null) {
            skip(step, describeUnresolved(step.to));
            break;
          }
          await gateway.joinPane(step.paneId, windowId);
          applied.push(step);
          break;
        }
        case "break-pane": {
          if (!livePaneIds.has(step.paneId)) {
            skip(step, `pane ${step.paneId} no longer present`);
            break;
          }
          const windowId = await gateway.breakPane(step.paneId, step.name);
          handles.set(step.handle, windowId);
          liveWindowIds.add(windowId);
          applied.push(step);
          break;
        }
        case "swap-pane": {
          if (!livePaneIds.has(step.a)) {
            skip(step, `pane ${step.a} no longer present`);
            break;
          }
          if (!livePaneIds.has(step.b)) {
            skip(step, `pane ${step.b} no longer present`);
            break;
          }
          await gateway.swapPane(step.a, step.b);
          applied.push(step);
          break;
        }
        case "select-layout": {
          const windowId = resolveWindow(step.window);
          if (windowId === null) {
            skip(step, describeUnresolved(step.window));
            break;
          }
          await gateway.selectLayout(windowId, step.layout);
          applied.push(step);
          break;
        }
      }
    } catch (err) {
      skip(step, err instanceof Error ? err.message : String(err));
    }
  }

  return { applied, skipped };
}
