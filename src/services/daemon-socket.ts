// src/services/daemon-socket.ts
import { createServer, type Server, type Socket } from "node:net";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkspaceModel } from "./workspace.js";
import { daemonSnapshotPath, daemonSocketPath } from "../core/paths.js";

export class ModelServer {
  private server: Server | undefined;
  private clients = new Set<Socket>();
  private readonly onChange = () => { void this.broadcast().catch(() => {}); };
  /** Serializes snapshot-file writes so overlapping "change" bursts never
   *  race on the same temp path (one write's `rename` could otherwise yank
   *  the temp file out from under another still-in-flight write). */
  private writeChain: Promise<void> = Promise.resolve();
  private writeCounter = 0;

  constructor(
    private readonly model: WorkspaceModel,
    private readonly socketPath: string = daemonSocketPath(),
    private readonly snapshotPath: string = daemonSnapshotPath(),
  ) {}

  async start(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true });
    await rm(this.socketPath, { force: true });
    this.server = createServer((sock) => {
      this.clients.add(sock);
      sock.on("close", () => this.clients.delete(sock));
      sock.on("error", () => this.clients.delete(sock));
      sock.write(this.line()); // initial snapshot
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, resolve);
    });
    this.model.on("change", this.onChange);
    await this.writeSnapshot(this.line());
  }

  private line(): string { return JSON.stringify(this.model.snapshot()) + "\n"; }

  private async broadcast(): Promise<void> {
    const line = this.line();
    // Write the snapshot file first so it never lags behind what clients see
    // (also avoids a race where a socket read outpaces the async fs write).
    await this.writeSnapshot(line);
    for (const c of this.clients) c.write(line);
  }

  /**
   * Serialized through `writeChain` so a burst of near-simultaneous "change"
   * events (e.g. N `upsertIdentity` calls during an initial scan) never has
   * two writes in flight at once — an overlapping `rename()` could otherwise
   * yank the shared temp file out from under a sibling write (ENOENT) and
   * crash the process via an unhandled rejection. Each call also gets its
   * own temp filename as belt-and-suspenders. Never rejects: a failed write
   * is swallowed rather than surfaced, so it can't become an unhandled
   * rejection further up the chain either.
   */
  private async writeSnapshot(content: string): Promise<void> {
    const tmp = `${this.snapshotPath}.${process.pid}.${this.writeCounter++}.tmp`;
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.snapshotPath), { recursive: true });
      await writeFile(tmp, content, "utf8");
      await rename(tmp, this.snapshotPath);
    }).catch(() => {});
    await this.writeChain;
  }

  async stop(): Promise<void> {
    this.model.off("change", this.onChange);
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await rm(this.socketPath, { force: true });
  }
}
