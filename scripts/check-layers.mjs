#!/usr/bin/env node
/**
 * Layer check.
 *
 * gigamanage has a strict one-way dependency rule:
 *
 *     core  ←  adapters  ←  services  ←  cli
 *
 * A module may import from its own layer or any layer to its LEFT, never to its
 * right. That is what keeps `core` free of I/O, keeps adapters swappable, and
 * keeps the CLI from becoming the place where logic hides.
 *
 * Hoping contributors follow this is not a strategy — so we check it, in CI and
 * in `npm test`. Violations print the rule and the fix.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

/** Left to right. A layer may import from itself and anything before it. */
const LAYERS = ["core", "adapters", "services", "cli"];

const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

/** The layer a file belongs to, from its path under src/. */
function layerOf(absPath) {
  const rel = relative(SRC, absPath);
  const top = rel.split(/[\\/]/)[0];
  return LAYERS.indexOf(top);
}

const violations = [];

for await (const file of walk(SRC)) {
  const fileLayer = layerOf(file);
  if (fileLayer === -1) continue;

  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(IMPORT)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue; // Third-party and node: builtins are fine.

    const target = resolve(dirname(file), specifier);
    const targetLayer = layerOf(target);
    if (targetLayer === -1) continue;

    if (targetLayer > fileLayer) {
      violations.push({
        file: relative(ROOT, file),
        from: LAYERS[fileLayer],
        to: LAYERS[targetLayer],
        specifier,
      });
    }
  }
}

if (violations.length === 0) {
  console.log(`✓ layers ok  (${LAYERS.join(" ← ")})`);
  process.exit(0);
}

console.error(`✗ ${violations.length} layer violation(s)\n`);
for (const v of violations) {
  console.error(`  ${v.file}`);
  console.error(`    imports "${v.specifier}"`);
  console.error(`    ${v.from} may not import ${v.to}.\n`);
}
console.error(`  The rule: ${LAYERS.join("  ←  ")}`);
console.error("  A module may import its own layer, or any layer to the LEFT. Never to the right.\n");
console.error("  fix: move the shared code down into a lower layer (usually `core`),");
console.error("       or invert the dependency by passing the value in as an argument.");
console.error("       See docs/architecture.md.\n");
process.exit(1);
