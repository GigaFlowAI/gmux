import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readSnapshotFile } from "../src/services/daemon-client.js";

describe("readSnapshotFile", () => {
  it("returns null when the file is missing", async () => {
    expect(await readSnapshotFile(join(tmpdir(), "nope-gm.json"))).toBeNull();
  });
  it("parses a snapshot and reports its age", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-"));
    const p = join(dir, "snap.json");
    writeFileSync(p, JSON.stringify({ version: 1, updatedAt: 0, panes: [], hostPressure: null, guardianLog: [] }));
    const res = await readSnapshotFile(p);
    expect(res).not.toBeNull();
    expect(res!.snapshot.version).toBe(1);
    expect(res!.ageMs).toBeGreaterThanOrEqual(0);
  });
});
