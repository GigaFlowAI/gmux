/**
 * Full-text search across every transcript.
 *
 * Half a gigabyte of JSONL is too much to scan in Node, so we shell out to
 * ripgrep and map its hits back onto indexed sessions. `--json` gives us exact
 * byte offsets and match counts without us parsing rg's human output.
 */

import { spawn } from "node:child_process";

import { MissingDependencyError } from "../core/errors.js";
import type { SearchHit, SessionRecord } from "../core/types.js";
import { truncate } from "../core/text.js";

const MAX_SNIPPETS_PER_SESSION = 3;

/**
 * Cap on the bytes of file paths handed to one ripgrep invocation.
 *
 * We pass explicit paths so that `--project` and friends narrow the corpus
 * exactly. But argv is finite: ARG_MAX is 1 MB on macOS and 128 KB per argument
 * on Linux, and a heavy user's session paths add up fast (1,163 sessions is
 * already ~230 KB). Past the limit the spawn fails with E2BIG — so we batch.
 */
const MAX_ARGV_BYTES = 60_000;

export interface SearchOptions {
  /** Restrict to these sessions. Also supplies the file→session mapping. */
  records: readonly SessionRecord[];
  query: string;
  /** Treat the query as a regex rather than a literal. */
  regex?: boolean;
  caseSensitive?: boolean;
  maxSessions?: number;
}

export async function searchSessions(options: SearchOptions): Promise<SearchHit[]> {
  const { records, query } = options;
  if (records.length === 0 || query.trim() === "") return [];

  const byPath = new Map(records.map((r) => [r.filePath, r]));
  const flags = [
    "--json",
    ...(options.regex ? [] : ["--fixed-strings"]),
    // Always pass the pattern via -e. As a bare positional, a query that starts
    // with a dash (`gm grep "-n"`) would be parsed by ripgrep as an option.
    "-e",
    query,
    options.caseSensitive ? "--case-sensitive" : "--ignore-case",
    "--",
  ];

  const hits = new Map<string, SearchHit>();

  for (const batch of batchPaths([...byPath.keys()], MAX_ARGV_BYTES)) {
    const lines = await runRipgrep([...flags, ...batch]);

    for (const line of lines) {
      let event: RgEvent;
      try {
        event = JSON.parse(line) as RgEvent;
      } catch {
        continue;
      }
      if (event.type !== "match") continue;

      // rg reports a non-UTF8 path as `bytes` rather than `text`; skip those.
      const path = event.data?.path?.text;
      if (!path) continue;
      const record = byPath.get(path);
      if (!record) continue;

      let hit = hits.get(path);
      if (!hit) {
        hit = { session: record, matchCount: 0, snippets: [] };
        hits.set(path, hit);
      }
      hit.matchCount += 1;
      if (hit.snippets.length < MAX_SNIPPETS_PER_SESSION) {
        const snippet = snippetFrom(event.data?.lines?.text ?? "", query);
        if (snippet) hit.snippets.push(snippet);
      }
    }
  }

  const sorted = [...hits.values()].sort((a, b) =>
    b.session.updatedAt.localeCompare(a.session.updatedAt),
  );
  return options.maxSessions ? sorted.slice(0, options.maxSessions) : sorted;
}

/**
 * A matching JSONL line is one enormous JSON record. Showing it raw would be
 * unreadable, so we show a window of text around the match itself.
 */
export function snippetFrom(line: string, query: string, window = 90): string | null {
  const at = line.toLowerCase().indexOf(query.toLowerCase());
  const centre = at === -1 ? 0 : at;
  const start = Math.max(0, centre - Math.floor(window / 3));
  const slice = line.slice(start, start + window);
  const cleaned = slice
    .replace(/\\n/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return cleaned === "" ? null : truncate(cleaned, window);
}

/**
 * Split paths into groups that each fit comfortably inside argv.
 * A single path longer than the cap still gets its own batch — dropping it
 * silently would mean a session that can never be searched.
 */
export function batchPaths(paths: readonly string[], maxBytes: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let bytes = 0;

  for (const path of paths) {
    const size = Buffer.byteLength(path) + 1;
    if (current.length > 0 && bytes + size > maxBytes) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(path);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

interface RgEvent {
  type: string;
  data?: { path?: { text?: string }; lines?: { text?: string } };
}

function runRipgrep(args: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));

    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new MissingDependencyError(
            "rg",
            "Install ripgrep: `brew install ripgrep` (macOS) or `apt install ripgrep` (Debian/Ubuntu).",
          ),
        );
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      // rg exits 1 when there are simply no matches. That is not an error.
      if (code === 0 || code === 1) {
        resolve(stdout.split("\n").filter((l) => l !== ""));
        return;
      }
      reject(new Error(`ripgrep exited with code ${code}: ${stderr.trim()}`));
    });
  });
}
