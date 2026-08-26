/**
 * The picker's pure units.
 *
 * Both of these exist to be shared: `filterArgs` by every command the picker
 * spawns, `atLeast` by every fzf feature gate. Their bugs are silent — a wrong
 * window answers confidently, and a wrong version gate either hides a feature
 * you have or hands fzf a flag it does not know and kills the picker at startup.
 */

import { describe, expect, it } from "vitest";

import { filterArgs } from "../src/cli/commands/pick.js";
import { atLeast, supportsMultiline } from "../src/cli/picker.js";

describe("filterArgs", () => {
  it("is empty when nothing was filtered", () => {
    expect(filterArgs({})).toEqual([]);
  });

  it("carries every filter, in flags gm parses", () => {
    expect(
      filterArgs({
        harness: "codex",
        project: "webshop",
        branch: "main",
        since: "3d",
        limit: "50",
        includeSidechains: true,
        includeAutomated: true,
      }),
    ).toEqual([
      "--harness",
      "codex",
      "-p",
      "webshop",
      "-b",
      "main",
      "-s",
      "3d",
      "-n",
      "50",
      "--include-sidechains",
      "--include-automated",
    ]);
  });

  it("omits a filter that was not set, rather than passing an empty value", () => {
    // `-p ""` is not "no project filter" downstream; it is a filter that matches
    // nothing.
    expect(filterArgs({ project: "webshop" })).toEqual(["-p", "webshop"]);
  });

  it("treats the sidechain and automated flags as switches, not values", () => {
    // They are `--include-*` with no argument, and only `true` may emit them:
    // `false` means the default, which is to omit the flag entirely.
    expect(filterArgs({ includeSidechains: true, includeAutomated: false })).toEqual([
      "--include-sidechains",
    ]);
  });

  it("does not quote — argv and a shell string want different escaping", () => {
    expect(filterArgs({ project: "web shop" })).toEqual(["-p", "web shop"]);
  });
});

describe("atLeast", () => {
  it("accepts the exact version", () => {
    expect(atLeast([0, 46, 0], [0, 46, 0])).toBe(true);
  });

  it("rejects a lower patch", () => {
    expect(atLeast([0, 46, 0], [0, 46, 1])).toBe(false);
  });

  it("accepts a higher patch", () => {
    expect(atLeast([0, 46, 2], [0, 46, 1])).toBe(true);
  });

  it("accepts a higher minor even when the patch is lower", () => {
    // The comparison is lexicographic, not a per-component AND: 0.59.0 is newer
    // than 0.46.9, and a loop that returned false on the patch would say no.
    expect(atLeast([0, 59, 0], [0, 46, 9])).toBe(true);
  });

  it("rejects a lower minor even when the patch is higher", () => {
    expect(atLeast([0, 46, 9], [0, 59, 0])).toBe(false);
  });

  it("lets a higher major win over everything below it", () => {
    expect(atLeast([1, 0, 0], [0, 59, 0])).toBe(true);
  });

  it("reads a missing component as 0, so a shorter version can still fall short", () => {
    expect(atLeast([0, 46], [0, 46, 1])).toBe(false);
    expect(atLeast([0, 46], [0, 46, 0])).toBe(true);
  });

  it("ignores components beyond what the want names", () => {
    // A four-part version is not something to reject; the want decides how much
    // precision the gate needs.
    expect(atLeast([0, 46, 1, 7], [0, 46])).toBe(true);
  });

  it("says no to a version it could not read", () => {
    // `fzf --version` failing is not permission to assume the feature.
    expect(atLeast(null, [0, 46, 0])).toBe(false);
  });

  it("accepts anything for an empty want", () => {
    expect(atLeast([0, 1, 0], [])).toBe(true);
  });
});

describe("supportsMultiline", () => {
  it("gates on 0.46.0, the first fzf with multi-line items", () => {
    expect(supportsMultiline([0, 45, 9])).toBe(false);
    expect(supportsMultiline([0, 46, 0])).toBe(true);
    expect(supportsMultiline([0, 74, 0])).toBe(true);
  });

  it("falls back to single-line when the version is unreadable", () => {
    expect(supportsMultiline(null)).toBe(false);
  });
});
