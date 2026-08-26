import { describe, expect, it } from "vitest";
import { resolveGigamanageConfig } from "../src/services/config.js";
import { DEFAULT_GIGAMANAGE_CONFIG } from "../src/core/workspace-types.js";

describe("resolveGigamanageConfig", () => {
  it("defaults to auto-broadcast when unset", () => {
    expect(resolveGigamanageConfig(null)).toEqual(DEFAULT_GIGAMANAGE_CONFIG);
  });
  it("honors a stored policy and fills the rest", () => {
    const cfg = {
      version: 1,
      provider: null,
      autoSummarize: false,
      gigamanage: { guardianPolicy: "off" as const, memoryThreshold: 0.8, cooldownSeconds: 120, tickMs: 2000 },
    };
    expect(resolveGigamanageConfig(cfg).guardianPolicy).toBe("off");
    expect(resolveGigamanageConfig(cfg).memoryThreshold).toBe(0.8);
  });
  it("fills defaults for a partial gm block", () => {
    const cfg = {
      version: 1,
      provider: null,
      autoSummarize: false,
      gigamanage: { guardianPolicy: "notify" as const } as any,
    };
    const r = resolveGigamanageConfig(cfg);
    expect(r.guardianPolicy).toBe("notify");
    expect(r.cooldownSeconds).toBe(DEFAULT_GIGAMANAGE_CONFIG.cooldownSeconds);
  });
});
