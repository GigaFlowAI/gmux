import { readFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CLASSIFY_TIMEOUT_MS,
  EXTRACT_TIMEOUT_MS,
  liveIntelHandlers,
  MuxClient,
  ORGANIZE_TIMEOUT_MS,
  PACK_TIMEOUT_MS,
} from "../src/services/mux-client.js";

interface RpcLine {
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

async function loopback(): Promise<{
  client: Socket;
  peer: Socket;
  close: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "gmux-mux-client-"));
  const path = join(dir, "s.sock");
  const server: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  const incoming = new Promise<Socket>((resolve) => server.once("connection", resolve));
  const client = createConnection(path);
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  const peer = await incoming;
  peer.setEncoding("utf8");
  return {
    client,
    peer,
    close: async () => {
      client.destroy();
      peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function attachMux(peer: Socket, handle?: (req: RpcLine) => unknown): { lines: RpcLine[] } {
  const lines: RpcLine[] = [];
  let buf = "";
  peer.on("data", (chunk: string) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      const raw = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as RpcLine;
      lines.push(parsed);
      if (parsed.method && parsed.result === undefined && parsed.error === undefined) {
        const custom = handle?.(parsed);
        const result = custom === undefined ? { ok: true } : custom;
        peer.write(`${JSON.stringify({ id: parsed.id, result })}\n`);
      }
    }
  });
  return { lines };
}

describe("intel deadlines", () => {
  it("matches the controller table", () => {
    expect(EXTRACT_TIMEOUT_MS).toBe(20);
    expect(PACK_TIMEOUT_MS).toBe(500);
    expect(CLASSIFY_TIMEOUT_MS).toBe(30_000);
    expect(ORGANIZE_TIMEOUT_MS).toBe(120_000);
  });
});

describe("MuxClient", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  it("sends hello with class intel and token", async () => {
    const pair = await loopback();
    cleanup = pair.close;
    const { lines } = attachMux(pair.peer, (req) =>
      req.method === "hello" ? { ok: true, class: "intel" } : { ok: true },
    );
    const client = new MuxClient(pair.client);
    await client.hello("tok_test");
    expect(lines[0]).toMatchObject({
      method: "hello",
      params: { class: "intel", token: "tok_test" },
    });
    await client.close();
  });

  it("replies on id to mux-originated prompt.extract", async () => {
    const pair = await loopback();
    cleanup = pair.close;
    attachMux(pair.peer, (req) =>
      req.method === "hello" ? { ok: true, class: "intel" } : { ok: true },
    );
    const client = new MuxClient(pair.client);
    await client.hello("tok_test");

    const reply = new Promise<RpcLine>((resolve) => {
      let buf = "";
      pair.peer.on("data", (chunk: string) => {
        buf += chunk;
        for (;;) {
          const nl = buf.indexOf("\n");
          if (nl === -1) break;
          const raw = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!raw) continue;
          const parsed = JSON.parse(raw) as RpcLine;
          if (parsed.id === "ex_1" && parsed.result !== undefined) resolve(parsed);
        }
      });
    });
    pair.peer.write(`${JSON.stringify({ id: "ex_1", method: "prompt.extract", params: { grid: {} } })}\n`);
    const msg = await reply;
    expect(msg.id).toBe("ex_1");
    expect(msg.result).toMatchObject({ extractor: "shadow", confidence: "low" });
    await client.close();
  });

  it("live prompt.extract runs the TS extractor on a boxed grid", async () => {
    const handlers = liveIntelHandlers();
    const grid = JSON.parse(
      readFileSync(new URL("./fixtures/grids/claude-code/boxed.json", import.meta.url), "utf8"),
    );
    const result = await handlers["prompt.extract"]!({ grid });
    expect(result).toMatchObject({ extractor: "claude-code", confidence: "high", text: "also fix the webhook" });
  });

  it("sends guardian.broadcast not pane.send_keys", async () => {
    const pair = await loopback();
    cleanup = pair.close;
    const { lines } = attachMux(pair.peer, (req) =>
      req.method === "hello" ? { ok: true, class: "intel" } : { ok: true },
    );
    const client = new MuxClient(pair.client);
    await client.hello("tok_test");
    await client.guardianBroadcast("slow down\n");
    expect(lines.some((l) => l.method === "guardian.broadcast")).toBe(true);
    expect(lines.some((l) => l.method === "pane.send_keys")).toBe(false);
    await client.close();
  });
});
