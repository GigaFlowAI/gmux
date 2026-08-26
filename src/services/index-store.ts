/**
 * The session index.
 *
 * Parsing 1,000+ sessions on every invocation would make `gm` unusable, so we
 * cache parsed records keyed on each file's (mtime, size). A file whose stats
 * are unchanged is served from cache; anything else is re-parsed. That keeps a
 * warm `gm ls` in the millisecond range while staying correct as sessions grow.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { indexPath } from "../core/paths.js";
import type { ListFilters, SessionRecord, SessionRef } from "../core/types.js";
import { availableAdapters, adapterById } from "../adapters/registry.js";
import { mapLimit } from "./concurrency.js";

const PARSE_CONCURRENCY = 16;
/** Bump whenever SessionRecord changes shape, so stale caches are discarded. */
const INDEX_VERSION = 3;

interface IndexFile {
  version: number;
  entries: IndexEntry[];
}

interface IndexEntry {
  mtimeMs: number;
  size: number;
  record: SessionRecord;
}

export interface RefreshResult {
  records: SessionRecord[];
  parsed: number;
  cached: number;
}

async function loadIndexFile(): Promise<Map<string, IndexEntry>> {
  try {
    const raw = await readFile(indexPath(), "utf8");
    const parsed = JSON.parse(raw) as IndexFile;
    if (parsed.version !== INDEX_VERSION || !Array.isArray(parsed.entries)) return new Map();
    return new Map(parsed.entries.map((e) => [e.record.filePath, e]));
  } catch {
    return new Map(); // Missing or corrupt cache is not an error; rebuild it.
  }
}

async function saveIndexFile(entries: Map<string, IndexEntry>): Promise<void> {
  const path = indexPath();
  await mkdir(dirname(path), { recursive: true });
  const payload: IndexFile = { version: INDEX_VERSION, entries: [...entries.values()] };
  // Write-then-rename: a killed `gm` must never leave a half-written index.
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(payload), "utf8");
  await rename(temp, path);
}

/** Every session file every installed harness knows about. */
export async function discover(): Promise<SessionRef[]> {
  const adapters = await availableAdapters();
  const lists = await Promise.all(adapters.map((a) => a.listSessions()));
  return lists.flat();
}

/**
 * Bring the index up to date and return every known session record.
 *
 * `force` re-parses everything, for when a parser bug is fixed and the cached
 * records are wrong rather than stale.
 */
export async function refreshIndex(options: { force?: boolean } = {}): Promise<RefreshResult> {
  const cache = options.force ? new Map<string, IndexEntry>() : await loadIndexFile();
  const refs = await discover();

  let parsed = 0;
  let cached = 0;

  const records = await mapLimit(refs, PARSE_CONCURRENCY, async (ref) => {
    const hit = cache.get(ref.filePath);
    if (hit && hit.mtimeMs === ref.mtimeMs && hit.size === ref.size) {
      cached += 1;
      return hit.record;
    }
    const adapter = adapterById(ref.harness);
    if (!adapter) return null;
    try {
      const record = await adapter.parseSession(ref);
      parsed += 1;
      return record;
    } catch {
      return null; // One unreadable session must not sink the whole index.
    }
  });

  const next = new Map<string, IndexEntry>();
  for (let i = 0; i < refs.length; i++) {
    const record = records[i];
    const ref = refs[i]!;
    if (!record) continue;
    next.set(ref.filePath, { mtimeMs: ref.mtimeMs, size: ref.size, record });
  }

  await saveIndexFile(next);

  const all = [...next.values()].map((e) => e.record);
  all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { records: all, parsed, cached };
}

/**
 * Records straight from the on-disk cache — no directory discovery, no re-stat.
 *
 * A fast, slightly-stale read for latency-sensitive callers (the overlay's first
 * paint): it skips the thousands-of-files scan `refreshIndex` does, at the cost
 * of missing sessions created since the last refresh. The caller upgrades to
 * `refreshIndex` in the background.
 */
export async function cachedRecords(): Promise<SessionRecord[]> {
  const records = [...(await loadIndexFile()).values()].map((e) => e.record);
  records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return records;
}

/** Apply the shared `ls`/picker filters. Pure — exported for tests. */
export function filterRecords(records: readonly SessionRecord[], filters: ListFilters): SessionRecord[] {
  let out = [...records];

  if (!filters.includeSidechains) out = out.filter((r) => !r.isSidechain);
  if (!filters.includeAutomated) out = out.filter((r) => !r.isAutomated);
  if (filters.harness) out = out.filter((r) => r.harness === filters.harness);
  if (filters.project) {
    const needle = filters.project.toLowerCase();
    out = out.filter((r) => (r.project ?? "").toLowerCase().includes(needle));
  }
  if (filters.branch) {
    const needle = filters.branch.toLowerCase();
    out = out.filter((r) => (r.gitBranch ?? "").toLowerCase().includes(needle));
  }
  if (filters.since) {
    const cutoff = filters.since;
    out = out.filter((r) => r.updatedAt >= cutoff);
  }

  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (filters.limit != null && filters.limit > 0) out = out.slice(0, filters.limit);
  return out;
}
