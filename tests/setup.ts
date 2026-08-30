/**
 * Global test setup.
 *
 * Non-negotiable #3 says no test reads the real home directory. Config made
 * that easy to break: `readConfig()` is called deep inside `maybeAutoSummarize`
 * and `defaultSummaryProvider`, so a test that never mentions config can still
 * end up reading `~/.config/gigamanage/config.json` — and then pass or fail
 * depending on whether the person running it happens to have run `gm setup`.
 *
 * A per-test `beforeEach` would fix the tests that remember. This fixes the
 * ones that don't: every run gets throwaway XDG dirs before any test file is
 * imported, so the real ones are unreachable by construction. Tests that care
 * still point them at their own temp dir on top.
 *
 * Both XDG roots, not just config: `cacheDir()` honours XDG_CACHE_HOME, and the
 * cache is the half gigamanage *writes* — index and summaries. Left unset, a
 * test that touches the index path clobbers the developer's real
 * `~/.cache/gigamanage` rather than merely reading it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

let configRoot: string;
let cacheRoot: string;

beforeAll(async () => {
  configRoot = await mkdtemp(join(tmpdir(), "gigamanage-config-"));
  cacheRoot = await mkdtemp(join(tmpdir(), "gigamanage-cache-"));
  process.env.XDG_CONFIG_HOME = configRoot;
  process.env.XDG_CACHE_HOME = cacheRoot;
});

afterAll(async () => {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CACHE_HOME;
  await rm(configRoot, { recursive: true, force: true });
  await rm(cacheRoot, { recursive: true, force: true });
});
