/**
 * Read which session a tmux pane is running from the pane's own process tree.
 *
 * The agent process carries the session id in its command line — `codex resume
 * <id>`, `claude --resume <id>` — and both ids are exactly gigamanage's session
 * id. That is a far stronger signal than the pane's working directory, which is
 * the *shell's* cwd (usually `~`), not the agent's. Where the argv has no id (a
 * fresh session), the agent process's real cwd stands in.
 *
 * The parsing here is pure and tested; `panePid`/`descendants`/`processCwd` are
 * thin shells over `tmux`/`pgrep`/`ps`/`lsof`, and every one of them degrades to
 * a null rather than throwing — a resolve must never fail because a process
 * vanished mid-walk.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { HarnessId } from "../core/types.js";

const run = promisify(execFile);

export interface AgentProcess {
  pid: number;
  command: string;
}

export interface AgentSession {
  harness: HarnessId;
  sessionId: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** A harness binary invoked as a token — excludes MCP children and unrelated node procs. */
const HARNESS_TOKEN = /(?:^|\/|\s)(?:claude|codex)(?:\s|$)/;

/**
 * The session id on an agent's command line, or null.
 *
 * Codex writes `codex resume <uuid>`; Claude Code writes `claude --resume <uuid>`
 * (or `-r`). The id is the standard 8-4-4-4-12 hex form; anything else is not a
 * session id we can trust, so it reads as null and the caller falls back to cwd.
 */
export function parseAgentSession(command: string): AgentSession | null {
  if (/(?:^|\/|\s)codex(?:\s|$)/.test(command)) {
    const match = command.match(new RegExp(`resume\\s+(${UUID})`, "i"));
    if (match) return { harness: "codex", sessionId: match[1]!.toLowerCase() };
  }
  if (/(?:^|\/|\s)claude(?:\s|$)/.test(command)) {
    const match = command.match(new RegExp(`(?:--resume|-r)\\s+(${UUID})`, "i"));
    if (match) return { harness: "claude-code", sessionId: match[1]!.toLowerCase() };
  }
  return null;
}

/** The harness a command names (claude / codex), even without a session id. */
export function harnessFromCommand(command: string): HarnessId | null {
  if (/(?:^|\/|\s)claude(?:\s|$)/.test(command)) return "claude-code";
  if (/(?:^|\/|\s)codex(?:\s|$)/.test(command)) return "codex";
  return null;
}

/**
 * The harness process among a pane's descendants, or null.
 *
 * Prefer a process whose argv already yields a session id — that is definitive.
 * Otherwise the first process that looks like a harness invocation, for its cwd.
 * An MCP-server child (`node ./mcp/server.mjs`) names no harness, so it is never
 * chosen over the agent that spawned it.
 */
export function pickAgentProcess(procs: readonly AgentProcess[]): AgentProcess | null {
  return (
    procs.find((p) => parseAgentSession(p.command) !== null) ??
    procs.find((p) => HARNESS_TOKEN.test(p.command)) ??
    null
  );
}

interface SnapshotEntry {
  ppid: number;
  command: string;
  /** Seconds since the process started (`ps etime`). Older process → larger. Null if unparsed. */
  elapsedSeconds: number | null;
}

/** The whole process table, pid → {ppid, command, elapsedSeconds}. One `ps` — the parser is pure. */
export type ProcessSnapshot = Map<number, SnapshotEntry>;

/**
 * Parse a `ps` `etime` field — `[[DD-]HH:]MM:SS` — into seconds.
 *
 * We use `etime`, not `etimes`: BSD `ps` on macOS has no `etimes` keyword (it
 * silently drops the column), while `etime` is portable across macOS and Linux.
 * Only relative order matters to the caller, so absolute wall-clock is not needed.
 */
export function parseElapsedSeconds(etime: string): number | null {
  const match = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const mins = Number(match[3]);
  const secs = Number(match[4]);
  return days * 86400 + hours * 3600 + mins * 60 + secs;
}

export function parseProcessSnapshot(output: string): ProcessSnapshot {
  const snapshot: ProcessSnapshot = new Map();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    snapshot.set(Number(match[1]), {
      ppid: Number(match[2]),
      command: match[4]!.trim(),
      elapsedSeconds: parseElapsedSeconds(match[3]!),
    });
  }
  return snapshot;
}

/**
 * One snapshot of every process, taken once and walked in memory — instead of a
 * `pgrep` per node down a deep agent tree, which spawned dozens of processes and
 * dominated resolve latency.
 */
export async function processSnapshot(): Promise<ProcessSnapshot> {
  try {
    const { stdout } = await run("ps", ["-eo", "pid=,ppid=,etime=,command="]);
    return parseProcessSnapshot(stdout);
  } catch {
    return new Map();
  }
}

/** Every descendant of `rootPid` in the snapshot (pure breadth-first, cycle-safe). */
export function descendantsOf(rootPid: number, snapshot: ProcessSnapshot): AgentProcess[] {
  const childrenByParent = new Map<number, number[]>();
  for (const [pid, entry] of snapshot) {
    const siblings = childrenByParent.get(entry.ppid);
    if (siblings) siblings.push(pid);
    else childrenByParent.set(entry.ppid, [pid]);
  }

  const out: AgentProcess[] = [];
  const seen = new Set<number>([rootPid]);
  let frontier = [rootPid];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const parent of frontier) {
      for (const child of childrenByParent.get(parent) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        out.push({ pid: child, command: snapshot.get(child)?.command ?? "" });
        next.push(child);
      }
    }
    frontier = next;
  }
  return out;
}

/** A process's real working directory: /proc on Linux, lsof on macOS. Null if unknown. */
export async function processCwd(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      const { readlink } = await import("node:fs/promises");
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    const line = stdout.split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

export interface PaneProcessHint {
  /** Session id read straight off the agent's argv — exact when present. */
  argvSession: AgentSession | null;
  /** Which harness the agent is (from its command line) — so a fresh session
   *  resolves to that harness, never another. Null when no agent was found;
   *  absent on hints from callers that don't inspect the process. */
  agentHarness?: HarnessId | null;
  /** The agent process's real cwd, for a fresh session with no id on the line. */
  agentCwd: string | null;
  /**
   * Seconds since the agent process started (`ps etime`). Older process → larger.
   *
   * This is the discriminator between fresh same-cwd panes: with no session id on
   * the command line, the process's start ORDER matches the sessions' start order,
   * so a group of panes pairs to its sessions by this rather than by array order.
   * Absent on hints from callers that don't inspect the process.
   */
  agentElapsedSeconds?: number | null;
}

const EMPTY_HINT: PaneProcessHint = {
  argvSession: null,
  agentHarness: null,
  agentCwd: null,
  agentElapsedSeconds: null,
};

/**
 * What the pane's running agent tells us about its session, from a shared process
 * snapshot. Never throws — every failure (no agent, no permission) degrades to an
 * empty hint, and the resolver falls back to its cwd heuristics.
 */
export async function paneProcessHint(
  panePid: number,
  snapshot: ProcessSnapshot,
): Promise<PaneProcessHint> {
  try {
    const agent = pickAgentProcess(descendantsOf(panePid, snapshot));
    if (!agent) return EMPTY_HINT;
    const argvSession = parseAgentSession(agent.command);
    const agentHarness = argvSession?.harness ?? harnessFromCommand(agent.command);
    // Only pay for the cwd lookup (lsof on macOS, ~100ms) when the argv had no
    // session id — a resumed session is already resolved exactly, so skip it.
    const agentCwd = argvSession ? null : await processCwd(agent.pid);
    const agentElapsedSeconds = snapshot.get(agent.pid)?.elapsedSeconds ?? null;
    return { argvSession, agentHarness, agentCwd, agentElapsedSeconds };
  } catch {
    return EMPTY_HINT;
  }
}
