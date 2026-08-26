/**
 * NDJSON client for `mux.sock`. Implements `MuxGateway` for the intel sidecar.
 *
 * Method ownership
 * ----------------
 * mux (client → mux): ping, pane.spawn, pane.close, tab.close, peel (fast),
 *   pane.send_keys, pane.list, session.snapshot, client.attach
 * intel (mux originates, intel replies on `id`):
 *   prompt.extract (EXTRACT_TIMEOUT_MS 20),
 *   context.pack (PACK_TIMEOUT_MS 500),
 *   classify.intent (CLASSIFY_TIMEOUT_MS),
 *   organize.plan (ORGANIZE_TIMEOUT_MS)
 * intel → mux: pane.report_semantics, guardian.broadcast (agent panes only)
 *
 * Transport: either peer may originate `{id,method,params}`. Correlation is `id`.
 * Token file `intel.token` is mode 0o600, minted by gmuxd; this client presents
 * it on `hello`. Does not bind `daemon.sock`.
 */

import { readFile } from "node:fs/promises";
import net from "node:net";

import { basename } from "node:path";

import { GmuxError } from "../core/errors.js";
import { isPaneState } from "../core/gmux-types.js";
import type { GmuxPane, GridSnapshot, SpawnOpts } from "../core/mux-types.js";
import type { OrganizePane, OrganizePlanner } from "../core/organize-types.js";
import { intelTokenPath, muxSocketPath } from "../core/paths.js";
import { CLASSIFY_TIMEOUT_MS, classifyIntent, type AskIntent } from "./ask-router.js";
import type { MuxGateway } from "./mux-gateway.js";
import { HeuristicOrganizePlanner, LlmOrganizePlanner, ORGANIZE_TIMEOUT_MS } from "./organize.js";

export const EXTRACT_TIMEOUT_MS = 20;
export const PACK_TIMEOUT_MS = 500;
export { CLASSIFY_TIMEOUT_MS, ORGANIZE_TIMEOUT_MS };

export const INTEL_METHODS = [
  "prompt.extract",
  "context.pack",
  "organize.plan",
  "classify.intent",
] as const;

export type IntelMethod = (typeof INTEL_METHODS)[number];

export interface IntelHandlers {
  "prompt.extract"?: (params: unknown) => Promise<unknown>;
  "context.pack"?: (params: unknown) => Promise<unknown>;
  "organize.plan"?: (params: unknown) => Promise<unknown>;
  "classify.intent"?: (params: unknown) => Promise<unknown>;
}

export interface IntelPatch {
  paneId: string;
  state?: string;
  semantics?: unknown;
  resources?: unknown;
  guardianLog?: unknown;
  hostPressure?: unknown;
}

interface RpcError {
  code: string;
  message: string;
  fix: string;
}

interface RpcLine {
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcError;
  event?: string;
  body?: unknown;
}

function isIntelMethod(method: string): method is IntelMethod {
  return (INTEL_METHODS as readonly string[]).includes(method);
}

/** Default stubs — extract/pack stay stubbed; classify/plan are live via `liveIntelHandlers`. */
export function stubIntelHandlers(): IntelHandlers {
  return {
    "prompt.extract": async () => ({
      text: "",
      confidence: "low",
      clearKeys: "\u0015",
      extractor: "shadow",
    }),
    "context.pack": async () => ({ headline: "", seed: "" }),
    "organize.plan": async () => ({ schemaVersion: 2, steps: [] }),
    "classify.intent": async () => ({ intent: "ask" }),
  };
}

function readPromptParam(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const o = params as Record<string, unknown>;
  return typeof o["prompt"] === "string" ? o["prompt"] : typeof o["text"] === "string" ? o["text"] : "";
}

function readOrganizePanes(params: unknown): OrganizePane[] {
  if (!params || typeof params !== "object") return [];
  const raw = (params as Record<string, unknown>)["panes"];
  if (!Array.isArray(raw)) return [];
  const out: OrganizePane[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const paneId = typeof o["paneId"] === "string" ? o["paneId"] : "";
    if (!paneId) continue;
    const argv = Array.isArray(o["argv"]) ? o["argv"].filter((x): x is string => typeof x === "string") : [];
    const command =
      typeof o["command"] === "string"
        ? o["command"]
        : argv[0]
          ? basename(argv[0])
          : "";
    const semantics = o["semantics"] && typeof o["semantics"] === "object" ? (o["semantics"] as Record<string, unknown>) : null;
    const state = typeof o["state"] === "string" && isPaneState(o["state"]) ? o["state"] : null;
    out.push({
      paneId,
      tabId: typeof o["tabId"] === "string" ? o["tabId"] : null,
      cwd: typeof o["cwd"] === "string" ? o["cwd"] : "",
      command,
      harness: typeof o["harness"] === "string" ? o["harness"] : null,
      state,
      label: typeof semantics?.["label"] === "string" ? semantics["label"] : typeof o["label"] === "string" ? o["label"] : null,
      active: o["active"] === true,
    });
  }
  return out;
}

/**
 * Live classify.intent / organize.plan. Mux originates these because the user
 * typed in the gmux prompt (or `gmux organize` planned locally). They never
 * run on a timer — the sidecar tick does not call them.
 */
export function liveIntelHandlers(opts: {
  classify?: (prompt: string) => Promise<AskIntent>;
  planner?: OrganizePlanner;
} = {}): IntelHandlers {
  const classify = opts.classify ?? ((prompt: string) => classifyIntent(prompt));
  const planner = opts.planner ?? new LlmOrganizePlanner(new HeuristicOrganizePlanner());
  return {
    "classify.intent": async (params) => {
      const prompt = readPromptParam(params);
      const intent = await classify(prompt);
      return { intent };
    },
    "organize.plan": async (params) => {
      const prompt = readPromptParam(params);
      const panes = readOrganizePanes(params);
      return planner.plan(panes, prompt.trim() === "" ? undefined : prompt);
    },
  };
}

export function connectMuxSocket(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(path);
    sock.once("connect", () => {
      sock.removeListener("error", reject);
      resolve(sock);
    });
    sock.once("error", reject);
  });
}

export async function readIntelToken(path: string = intelTokenPath()): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    throw new GmuxError(`intel.token missing at ${path}`, {
      fix: "Start gmuxd first (`gmux attach` or `gmux spawn`) so it mints intel.token (mode 0600).",
    });
  }
}

/**
 * Bidirectional NDJSON session on `mux.sock`. Outbound calls implement
 * `MuxGateway`; inbound intel methods are answered from `handlers`.
 */
export class MuxClient implements MuxGateway {
  private buf = "";
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private readonly handlers: IntelHandlers;

  constructor(private readonly sock: net.Socket, handlers: IntelHandlers = {}) {
    this.handlers = { ...stubIntelHandlers(), ...handlers };
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string | Buffer) => this.onData(String(chunk)));
    sock.on("error", (err) => this.failAll(err));
    sock.on("close", () => this.failAll(new GmuxError("mux.sock closed", {
      fix: "Restart gmuxd (`gmux attach` or `gmux spawn`) and retry.",
    })));
  }

  static async connect(
    socketPath: string = muxSocketPath(),
    token?: string,
    handlers?: IntelHandlers,
  ): Promise<MuxClient> {
    const presented = token ?? (await readIntelToken());
    let sock: net.Socket;
    try {
      sock = await connectMuxSocket(socketPath);
    } catch (error) {
      throw new GmuxError(`failed to connect to ${socketPath}: ${(error as Error).message}`, {
        fix: "Start gmuxd first (`gmux attach` or `gmux spawn`). Start order is mux → sidecar → TUI.",
      });
    }
    const client = new MuxClient(sock, handlers);
    try {
      await client.hello(presented);
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
    return client;
  }

  /**
   * CLI-class session on `mux.sock` (no intel hello). Grouping verbs
   * (`tab.new` / `tab.rename` / `pane.move` / `pane.break`) are allowed to
   * `cli` / `tui`, not the sidecar.
   */
  static async connectCli(socketPath: string = muxSocketPath()): Promise<MuxClient> {
    let sock: net.Socket;
    try {
      sock = await connectMuxSocket(socketPath);
    } catch (error) {
      throw new GmuxError(`failed to connect to ${socketPath}: ${(error as Error).message}`, {
        fix: "Start gmuxd first (`gmux attach` or `gmux spawn`).",
      });
    }
    return new MuxClient(sock, {});
  }

  async hello(token: string): Promise<unknown> {
    return this.request("hello", { class: "intel", token });
  }

  async ping(): Promise<unknown> {
    return this.request("ping", {});
  }

  async listPanes(): Promise<GmuxPane[]> {
    const result = (await this.request("pane.list", {})) as { panes?: GmuxPane[] };
    return result.panes ?? [];
  }

  async send(paneId: string, keys: string): Promise<void> {
    await this.request("pane.send_keys", { paneId, keys });
  }

  async spawn(opts: SpawnOpts): Promise<{ paneId: string; tabId: string }> {
    const result = (await this.request("pane.spawn", {
      cwd: opts.cwd,
      argv: opts.argv,
      env: opts.env,
      tab: opts.tab,
      focus: opts.focus ?? false,
      peelDepth: opts.peelDepth ?? 0,
    })) as { paneId: string; tabId: string };
    return { paneId: result.paneId, tabId: result.tabId };
  }

  async closePane(paneId: string): Promise<void> {
    await this.request("pane.close", { paneId });
  }

  async closeTab(tabId: string): Promise<void> {
    await this.request("tab.close", { tabId });
  }

  async readGrid(paneId: string, rows?: number): Promise<GridSnapshot> {
    return (await this.request("pane.read", {
      paneId,
      source: "grid",
      lines: rows,
    })) as GridSnapshot;
  }

  async readLines(paneId: string, lines?: number): Promise<string> {
    const result = (await this.request("pane.read", {
      paneId,
      source: "lines",
      lines,
    })) as { text?: string };
    return result.text ?? "";
  }

  async newTab(name: string): Promise<string> {
    const result = (await this.request("tab.new", { name })) as { tabId: string };
    return result.tabId;
  }

  async renameTab(tabId: string, name: string): Promise<void> {
    await this.request("tab.rename", { tabId, name });
  }

  async movePane(srcPane: string, dstTab: string): Promise<void> {
    await this.request("pane.move", { srcPane, dstTab });
  }

  async breakPane(pane: string, name?: string): Promise<string> {
    const result = (await this.request("pane.break", { pane, name })) as { tabId: string };
    return result.tabId;
  }

  async peel(clientId: string): Promise<{ paneId: string; tabId: string }> {
    return (await this.request("peel", { clientId })) as { paneId: string; tabId: string };
  }

  async snapshot(): Promise<unknown> {
    return this.request("session.snapshot", {});
  }

  async reportSemantics(patch: IntelPatch): Promise<void> {
    await this.request("pane.report_semantics", { ...patch });
  }

  async guardianBroadcast(message: string): Promise<void> {
    await this.request("guardian.broadcast", { message });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new GmuxError("mux client closed", { fix: "Reconnect to mux.sock." }));
    this.sock.end();
    this.sock.destroy();
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) {
      throw new GmuxError("mux client is closed", { fix: "Reconnect to mux.sock." });
    }
    const id = `c${this.nextId++}`;
    const line = `${JSON.stringify({ id, method, params })}\n`;
    const reply = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    try {
      this.sock.write(line);
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return reply;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl === -1) break;
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line.length === 0) continue;
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let parsed: RpcLine;
    try {
      parsed = JSON.parse(line) as RpcLine;
    } catch {
      return;
    }
    if (typeof parsed.method === "string" && isIntelMethod(parsed.method)) {
      void this.replyIntel(parsed.id, parsed.method, parsed.params);
      return;
    }
    if (parsed.method) return;
    if (parsed.event) return;
    const id = parsed.id == null ? "" : String(parsed.id);
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    if (parsed.error) {
      waiter.reject(new GmuxError(parsed.error.message, { fix: parsed.error.fix }));
      return;
    }
    waiter.resolve(parsed.result);
  }

  private async replyIntel(id: unknown, method: IntelMethod, params: unknown): Promise<void> {
    const handler = this.handlers[method];
    try {
      const result = handler ? await handler(params) : {};
      this.write({ id, result });
    } catch (error) {
      const err = error as Error & { fix?: string };
      this.write({
        id,
        error: {
          code: "intel_error",
          message: err.message,
          fix: err.fix ?? "Retry; the sidecar stub should not throw",
        },
      });
    }
  }

  private write(value: unknown): void {
    if (this.closed) return;
    try {
      this.sock.write(`${JSON.stringify(value)}\n`);
    } catch {
      /* socket already dying */
    }
  }

  private failAll(error: Error): void {
    if (this.closed && this.pending.size === 0) return;
    this.closed = true;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of pending) waiter.reject(error);
  }
}
