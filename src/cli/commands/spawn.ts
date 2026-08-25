/**
 * Headless mux CLI: spawn gmuxd if the lock is free, then speak NDJSON on mux.sock.
 *
 * `MuxGateway` is not wired (Task 5). This file is the control-plane client for
 * `gmux spawn` / `gmux panes ls` / `gmux snapshot`.
 */

import { spawn as spawnProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Command } from "commander";

import { GmuxError } from "../../core/errors.js";
import { muxLockPath, muxSocketPath } from "../../core/paths.js";
import { SCHEMA_VERSION } from "../../core/types.js";
import { dim, jsonEnvelope } from "../format.js";

interface RpcError {
  code: string;
  message: string;
  fix: string;
}

interface RpcReply {
  id?: unknown;
  result?: unknown;
  error?: RpcError;
}

interface MuxLockFile {
  muxPid?: number;
  intelPid?: number | null;
  startedAt?: string;
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readMuxLock(): Promise<MuxLockFile | null> {
  try {
    return JSON.parse(await readFile(muxLockPath(), "utf8")) as MuxLockFile;
  } catch {
    return null;
  }
}

function findGmuxd(): string | null {
  if (process.env.GMUXD_PATH && existsSync(process.env.GMUXD_PATH)) {
    return process.env.GMUXD_PATH;
  }
  const names = ["target/debug/gmuxd", "target/release/gmuxd"];
  let dir = process.cwd();
  for (;;) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    dir = here;
    for (;;) {
      for (const name of names) {
        const candidate = join(dir, name);
        if (existsSync(candidate)) return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* import.meta.url is unavailable in some test shims */
  }
  return null;
}

async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const sock = await connect(path);
      sock.end();
      sock.destroy();
      return;
    } catch (error) {
      last = error as Error;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new GmuxError(`gmuxd did not bind ${path}`, {
    fix: last ? `${last.message}. Run \`cargo build -p gmuxd\` and retry.` : "Run `cargo build -p gmuxd` and retry.",
  });
}

function connect(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(path);
    sock.once("connect", () => {
      sock.removeListener("error", reject);
      resolve(sock);
    });
    sock.once("error", reject);
  });
}

function readLine(sock: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      sock.off("data", onData);
      sock.off("error", onErr);
      resolve(buf.slice(0, nl));
    };
    const onErr = (err: Error): void => {
      sock.off("data", onData);
      reject(err);
    };
    sock.on("data", onData);
    sock.once("error", onErr);
  });
}

async function spawnGmuxd(): Promise<void> {
  const bin = findGmuxd();
  if (!bin) {
    throw new GmuxError("gmuxd is not built", {
      fix: "Run `cargo build -p gmuxd` from the repo root (dev: target/debug/gmuxd).",
    });
  }
  const child = spawnProcess(bin, [], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  await waitForSocket(muxSocketPath(), 3000);
}

export async function ensureMuxd(): Promise<void> {
  const lock = await readMuxLock();
  const live = lock?.muxPid != null && pidAlive(lock.muxPid);
  if (live) {
    try {
      await waitForSocket(muxSocketPath(), 1000);
      return;
    } catch {
      throw new GmuxError(`gmuxd pid ${lock?.muxPid} is alive but mux.sock is down`, {
        fix: "Stop the stale gmuxd or remove mux.lock if the process is wedged.",
      });
    }
  }
  await spawnGmuxd();
}

export async function muxRpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  await ensureMuxd();
  const sock = await connect(muxSocketPath());
  try {
    const id = "1";
    sock.write(`${JSON.stringify({ id, method, params })}\n`);
    const line = await readLine(sock);
    let reply: RpcReply;
    try {
      reply = JSON.parse(line) as RpcReply;
    } catch {
      throw new GmuxError(`gmuxd returned invalid JSON: ${line}`, {
        fix: "Upgrade gmuxd (`cargo build -p gmuxd`) and retry.",
      });
    }
    if (reply.error) {
      throw new GmuxError(reply.error.message, { fix: reply.error.fix });
    }
    return reply.result;
  } finally {
    sock.end();
    sock.destroy();
  }
}

function printJson(data: unknown): void {
  process.stdout.write(`${jsonEnvelope(SCHEMA_VERSION, data)}\n`);
}

/** Mux control commands must not fork the background summarizer. */
export function isMuxControlCommand(name: string, parentName?: string): boolean {
  if (name === "spawn" || name === "snapshot" || name === "attach") return true;
  if (parentName === "panes") return true;
  return false;
}

export function registerSpawn(program: Command): void {
  program
    .command("spawn")
    .description("spawn a pane in gmuxd")
    .option("--cwd <dir>", "working directory", process.cwd())
    .option("--argv <cmd...>", "command and arguments")
    .option("--json", "emit JSON for scripts and agents")
    .argument("[argv...]", "command and arguments (default: $SHELL)")
    .action(async (positional: string[], options: { cwd?: string; argv?: string[]; json?: boolean }) => {
      const argv = (options.argv && options.argv.length > 0 ? options.argv : positional).filter(Boolean);
      const result = await muxRpc("pane.spawn", {
        cwd: options.cwd,
        argv: argv.length > 0 ? argv : [process.env.SHELL ?? "/bin/sh"],
        tab: { mode: "new", name: argv[0] ?? "shell" },
      });
      if (options.json) {
        printJson(result);
        return;
      }
      const spawned = result as { paneId?: string; tabId?: string };
      process.stdout.write(`${spawned.paneId ?? "?"}  tab ${spawned.tabId ?? "?"}\n`);
    });

  program
    .command("snapshot")
    .description("dump the gmuxd session tree")
    .option("--json", "emit JSON for scripts and agents")
    .action(async (options: { json?: boolean }) => {
      const result = await muxRpc("session.snapshot", {});
      if (options.json) {
        printJson(result);
        return;
      }
      const snap = result as {
        workspaces?: Array<{ id: string; cwd: string; tabs?: Array<{ id: string; name: string; paneIds?: string[] }> }>;
        panes?: Array<{ paneId: string; tabId: string; cwd: string; argv?: string[]; pid?: number }>;
      };
      const panes = snap.panes ?? [];
      if (panes.length === 0) {
        process.stdout.write(`${dim("no panes")}\n`);
        return;
      }
      for (const pane of panes) {
        process.stdout.write(
          `${pane.paneId}  ${pane.tabId}  ${pane.cwd}  ${(pane.argv ?? []).join(" ")}  pid ${pane.pid ?? "?"}\n`,
        );
      }
    });

  const panes = program.command("panes").description("list and inspect mux panes");
  panes
    .command("ls")
    .description("list mux panes")
    .option("--json", "emit JSON for scripts and agents")
    .action(async (options: { json?: boolean }) => {
      const result = await muxRpc("pane.list", {});
      if (options.json) {
        printJson(result);
        return;
      }
      const { panes: list = [] } = result as {
        panes?: Array<{ paneId: string; tabId: string; cwd: string; argv?: string[]; pid?: number }>;
      };
      if (list.length === 0) {
        process.stdout.write(`${dim("no panes")}\n`);
        return;
      }
      for (const pane of list) {
        process.stdout.write(
          `${pane.paneId}  ${pane.tabId}  ${pane.cwd}  ${(pane.argv ?? []).join(" ")}  pid ${pane.pid ?? "?"}\n`,
        );
      }
    });
}
