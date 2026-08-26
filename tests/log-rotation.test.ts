import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { rotateIfLarge, pruneLog } from "../src/services/log-rotation.js";

describe("log rotation", () => {
  it("keeps only the tail when over the cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-"));
    const p = join(dir, "pane.log");
    writeFileSync(p, "X".repeat(100) + "TAIL");
    const rotated = await rotateIfLarge(p, 4);
    expect(rotated).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("TAIL");
  });
  it("does nothing under the cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-"));
    const p = join(dir, "pane.log");
    writeFileSync(p, "small");
    expect(await rotateIfLarge(p, 1024)).toBe(false);
  });
  it("prune removes the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-"));
    const p = join(dir, "pane.log");
    writeFileSync(p, "x");
    await pruneLog(p);
    expect(existsSync(p)).toBe(false);
  });
});
