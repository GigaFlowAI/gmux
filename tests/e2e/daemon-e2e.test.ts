/**
 * TRUE end-to-end test: a REAL `gm daemon run` child process, driving a
 * REAL (throwaway, isolated) tmux server over its own unix socket.
 *
 * Everything else in the suite (unit tests, `daemon-wiring.test.ts`, the
 * `FakeTmuxGateway`-backed integration tests) exercises the daemon's logic
 * headlessly. This file is the one place that proves the whole stack —
 * process spawn, `RealTmuxGateway`'s shelled-out `tmux` calls, the
 * `ModelServer` socket + snapshot file, and `@gm_label` border painting —
 * actually works against a live tmux server.
 *
 * Gated behind `GIGAMANAGE_E2E=1` (see the `test:e2e` npm script) so `npm test`
 * stays hermetic and fast: this suite is SKIPPED, not run, without the flag.
 * Also skipped if `tmux` isn't on PATH, so a bare CI image doesn't fail here.
 *
 * Isolation: a fresh `mkdtemp` XDG_CACHE_HOME (so the daemon's socket +
 * snapshot land under a throwaway `gigamanage/daemon/` tree) and a fresh tmux
 * server on its own `-S <sock>` — never the developer's real `~/.cache/gigamanage`
 * or default tmux server. The daemon is routed to the isolated tmux server
 * the same way a real shell would be: via the `TMUX=<sock>,<pid>,0` env var,
 * which makes its bare (`-S`-less) `tmux` invocations resolve to that server.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const E2E = process.env.GIGAMANAGE_E2E === "1";

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Polls `fn` until it returns a truthy value, or gives up and returns null. */
async function waitFor<T>(
  fn: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const PANE_STATES = ["working", "idle", "waiting", "error", "done"];
const STATE_GLYPHS = ["●", "◔", "✗", "✓", "○"];

describe.skipIf(!E2E || !tmuxAvailable())("gm daemon e2e (real tmux + real daemon)", () => {
  let cacheDir: string;
  let sock: string;
  let serverPid: string;
  let daemon: ChildProcess;
  let daemonSnapshotPath: () => string;

  const SESSION = "gm-e2e";

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "gm-e2e-cache-"));
    const tmuxDir = mkdtempSync(join(tmpdir(), "gm-e2e-tmux-"));
    sock = join(tmuxDir, "tmux.sock");

    // Point XDG_CACHE_HOME at the throwaway dir BEFORE importing the path
    // helpers, so the paths we assert against are exactly what the daemon
    // (spawned with the same env) will compute for itself.
    process.env.XDG_CACHE_HOME = cacheDir;
    ({ daemonSnapshotPath } = await import("../../src/core/paths.js"));

    // A real, isolated tmux server: its own socket, never the user's default.
    execFileSync("tmux", ["-S", sock, "new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50"]);
    execFileSync("tmux", ["-S", sock, "split-window", "-t", SESSION]);
    serverPid = execFileSync("tmux", ["-S", sock, "display", "-p", "#{pid}"]).toString().trim();

    // Spawn the REAL daemon binary. TMUX=<sock>,<pid>,0 routes its bare
    // (no -S) `tmux` calls — what RealTmuxGateway shells out to — at the
    // isolated server above, never the developer's real one.
    // GIGAMANAGE_SUMMARY_CMD=false makes the LLM label provider a fast, failing
    // no-op: the SemanticWorker swallows the failure and semantics stay
    // null, so the e2e never spawns a real `claude`/`codex` process.
    daemon = spawn(process.execPath, ["dist/cli/main.js", "daemon", "run"], {
      cwd: join(import.meta.dirname, "..", ".."),
      env: {
        ...process.env,
        XDG_CACHE_HOME: cacheDir,
        TMUX: `${sock},${serverPid},0`,
        GIGAMANAGE_SUMMARY_CMD: "false",
      },
      stdio: "ignore",
    });
  }, 30_000);

  afterAll(() => {
    daemon?.kill("SIGTERM");
    try {
      execFileSync("tmux", ["-S", sock, "kill-server"]);
    } catch {
      /* server may already be gone */
    }
    try {
      rmSync(cacheDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    delete process.env.XDG_CACHE_HOME;
  });

  it(
    "senses real tmux panes into the snapshot",
    async () => {
      const snapshot = await waitFor(() => {
        try {
          return JSON.parse(readFileSync(daemonSnapshotPath(), "utf8"));
        } catch {
          return null;
        }
      }, 20_000);

      expect(snapshot).not.toBeNull();
      expect(snapshot.panes.length).toBeGreaterThanOrEqual(2);
      for (const pane of snapshot.panes) {
        expect(PANE_STATES).toContain(pane.state);
      }
      const withRealCommand = snapshot.panes.find(
        (p: { identity: { command: string; pid: number } }) =>
          typeof p.identity.command === "string" && p.identity.command.length > 0 && p.identity.pid > 0,
      );
      expect(withRealCommand).toBeDefined();
    },
    30_000,
  );

  it(
    "reports host memory pressure (resource monitor ran e2e)",
    async () => {
      const snapshot = await waitFor(() => {
        try {
          return JSON.parse(readFileSync(daemonSnapshotPath(), "utf8"));
        } catch {
          return null;
        }
      }, 20_000);

      expect(snapshot).not.toBeNull();
      expect(snapshot.hostPressure).not.toBeNull();
      expect(snapshot.hostPressure.usedRatio).toBeGreaterThan(0);
      expect(snapshot.hostPressure.usedRatio).toBeLessThan(1);
    },
    30_000,
  );

  it(
    "paints real border labels onto the panes",
    async () => {
      const labels = await waitFor(() => {
        const out = execFileSync("tmux", ["-S", sock, "list-panes", "-a", "-F", "#{@gm_label}"])
          .toString()
          .split("\n")
          .filter((line) => line.trim().length > 0);
        return out.length > 0 ? out : null;
      }, 20_000);

      expect(labels).not.toBeNull();
      const hasStateGlyph = (labels ?? []).some((line) => STATE_GLYPHS.some((glyph) => line.includes(glyph)));
      expect(hasStateGlyph).toBe(true);
    },
    30_000,
  );
});
