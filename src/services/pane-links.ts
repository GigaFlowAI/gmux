/**
 * The pane→session links `gm run` records, so the overlay maps a live pane to
 * the exact session it launched rather than guessing. Cache, disposable, pruned
 * to the live pane set on every overlay render.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { paneLinksPath } from "../core/paths.js";
import type { PaneLink } from "../core/types.js";

function isPaneLink(value: unknown): value is PaneLink {
  const link = value as PaneLink;
  return (
    !!link &&
    typeof link.paneId === "string" &&
    typeof link.harness === "string" &&
    typeof link.sessionId === "string"
  );
}

export async function readPaneLinks(): Promise<PaneLink[]> {
  try {
    const parsed = JSON.parse(await readFile(paneLinksPath(), "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isPaneLink) : [];
  } catch {
    return [];
  }
}

async function persist(links: readonly PaneLink[]): Promise<void> {
  const path = paneLinksPath();
  await mkdir(dirname(path), { recursive: true });
  // Write-then-rename: a killed `gm run` must never leave a half-written pane-links.json.
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(links), "utf8");
  await rename(temp, path);
}

export async function writePaneLink(link: PaneLink): Promise<void> {
  const links = (await readPaneLinks()).filter((l) => l.paneId !== link.paneId);
  links.push(link);
  await persist(links);
}

export async function prunePaneLinks(livePaneIds: Iterable<string>): Promise<PaneLink[]> {
  const live = new Set(livePaneIds);
  const kept = (await readPaneLinks()).filter((l) => live.has(l.paneId));
  await persist(kept);
  return kept;
}

export function linkForPane(links: readonly PaneLink[], paneId: string): PaneLink | null {
  return links.find((l) => l.paneId === paneId) ?? null;
}
