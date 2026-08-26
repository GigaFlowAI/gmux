import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { HostPressure, PaneResources } from "../core/workspace-types.js";
import { parsePsOutput, subtreeRss } from "../core/proc-tree.js";

const run = promisify(execFile);

/**
 * Cap every resource probe on the tick path. A wedged `ps`/`sysctl`/`vm_stat`
 * would otherwise stall the tick forever; the timeout kills the child and
 * rejects, which the defensive catches below already handle.
 */
const RESOURCE_TIMEOUT_MS = 5000;

export interface ResourceDeps {
  psSnapshot: () => Promise<string>;
  hostMemory: () => Promise<{ usedRatio: number; usedBytes: number }>;
}

export function defaultResourceDeps(): ResourceDeps {
  return {
    psSnapshot: async () => (await run("ps", ["-axo", "pid,ppid,rss,comm"], { timeout: RESOURCE_TIMEOUT_MS })).stdout,
    hostMemory: async () => (process.platform === "darwin" ? readMacMemory() : readLinuxMemory()),
  };
}

export class ResourceMonitor {
  private deps: ResourceDeps;

  constructor(deps: Partial<ResourceDeps> = {}) {
    this.deps = { ...defaultResourceDeps(), ...deps };
  }

  async sample(
    panePids: Map<string, number>,
  ): Promise<{ perPane: Map<string, PaneResources>; host: HostPressure }> {
    const now = Date.now();
    const rows = parsePsOutput(await this.deps.psSnapshot());
    const perPane = new Map<string, PaneResources>();
    let attributed = 0;
    for (const [paneId, pid] of panePids) {
      const rss = subtreeRss(pid, rows);
      attributed += rss;
      perPane.set(paneId, { perPaneRss: rss, ts: now });
    }
    const mem = await this.deps.hostMemory();
    const host: HostPressure = {
      usedRatio: mem.usedRatio,
      unattributed: Math.max(0, mem.usedBytes - attributed),
      ts: now,
    };
    return { perPane, host };
  }
}

/**
 * Parse `vm_stat` + `sysctl -n hw.memsize` / `hw.pagesize` for macOS memory pressure.
 * Used ≈ (active + wired + compressed) pages × page size. Defensive: returns a safe
 * zero reading rather than throwing if parsing fails.
 */
async function readMacMemory(): Promise<{ usedRatio: number; usedBytes: number }> {
  try {
    const [{ stdout: memsizeOut }, { stdout: pagesizeOut }, { stdout: vmStatOut }] = await Promise.all([
      run("sysctl", ["-n", "hw.memsize"], { timeout: RESOURCE_TIMEOUT_MS }),
      run("sysctl", ["-n", "hw.pagesize"], { timeout: RESOURCE_TIMEOUT_MS }),
      run("vm_stat", [], { timeout: RESOURCE_TIMEOUT_MS }),
    ]);
    const total = Number(memsizeOut.trim());
    const pageSize = Number(pagesizeOut.trim());
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(pageSize) || pageSize <= 0) {
      return { usedRatio: 0, usedBytes: 0 };
    }
    const pages = parseVmStatPages(vmStatOut);
    const active = pages.get("Pages active") ?? 0;
    const wired = pages.get("Pages wired down") ?? 0;
    const compressed = pages.get("Pages occupied by compressor") ?? 0;
    const usedBytes = (active + wired + compressed) * pageSize;
    if (!Number.isFinite(usedBytes) || usedBytes < 0) {
      return { usedRatio: 0, usedBytes: 0 };
    }
    return { usedRatio: usedBytes / total, usedBytes };
  } catch {
    return { usedRatio: 0, usedBytes: 0 };
  }
}

/** Parse `vm_stat` output lines like "Pages active:  123456." into a label→count map. */
function parseVmStatPages(raw: string): Map<string, number> {
  const pages = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Za-z][A-Za-z ]*?):\s*([\d,]+)\.?\s*$/);
    if (!m) continue;
    const label = m[1]!.trim();
    const count = Number(m[2]!.replace(/,/g, ""));
    if (Number.isFinite(count)) pages.set(label, count);
  }
  return pages;
}

/**
 * Parse `/proc/meminfo` for Linux memory pressure. Used = MemTotal − MemAvailable (KB→bytes).
 * Defensive: returns a safe zero reading if the expected fields are missing.
 */
async function readLinuxMemory(): Promise<{ usedRatio: number; usedBytes: number }> {
  try {
    const raw = await readFile("/proc/meminfo", "utf8");
    const fields = new Map<string, number>();
    for (const line of raw.split("\n")) {
      const m = line.match(/^(\w+):\s*(\d+)\s*kB/);
      if (!m) continue;
      fields.set(m[1]!, Number(m[2]));
    }
    const totalKb = fields.get("MemTotal");
    const availKb = fields.get("MemAvailable");
    if (totalKb === undefined || availKb === undefined || totalKb <= 0) {
      return { usedRatio: 0, usedBytes: 0 };
    }
    const usedBytes = Math.max(0, totalKb - availKb) * 1024;
    return { usedRatio: usedBytes / (totalKb * 1024), usedBytes };
  } catch {
    return { usedRatio: 0, usedBytes: 0 };
  }
}
