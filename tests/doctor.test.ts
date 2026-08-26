import { describe, expect, it } from "vitest";

import { leftoverTmuxCheck, muxDoctorChecks } from "../src/cli/commands/doctor.js";
import { jsonEnvelope } from "../src/cli/format.js";
import { SCHEMA_VERSION } from "../src/core/types.js";

describe("muxDoctorChecks", () => {
  it("reports missing binary and down socket with a fix", () => {
    const checks = muxDoctorChecks({
      binaryPath: null,
      socketPath: "/tmp/mux.sock",
      socketUp: false,
      lock: null,
      pidAlive: () => false,
    });
    const binary = checks.find((c) => c.name.startsWith("gmuxd"));
    const sock = checks.find((c) => c.name === "mux.sock");
    expect(binary?.ok).toBe(false);
    expect(binary?.fix).toMatch(/cargo build -p gmuxd/);
    expect(sock?.ok).toBe(false);
    expect(sock?.fix).toMatch(/gmux attach/);
  });

  it("is ok when binary, live pid, and socket agree", () => {
    const checks = muxDoctorChecks({
      binaryPath: "/repo/target/debug/gmuxd",
      socketPath: "/tmp/mux.sock",
      socketUp: true,
      lock: { muxPid: 42, intelPid: 43 },
      pidAlive: (pid) => pid === 42 || pid === 43,
    });
    expect(checks.find((c) => c.name.startsWith("gmuxd"))?.ok).toBe(true);
    expect(checks.find((c) => c.name === "mux.sock")?.ok).toBe(true);
    expect(checks.find((c) => c.name === "intel sidecar")?.ok).toBe(true);
  });

  it("notes the host-emulator ctrl+t conflict", () => {
    const note = muxDoctorChecks({
      binaryPath: null,
      socketPath: "/tmp/mux.sock",
      socketUp: false,
      lock: null,
      pidAlive: () => false,
    }).find((c) => c.name.includes("ctrl+t"));
    expect(note?.ok).toBe(true);
    expect(note?.detail).toMatch(/Ghostty|iTerm/);
  });

  it("leftover tmux copy says finish, uninstall, attach — never overlay available", () => {
    const present = leftoverTmuxCheck({ raw: "3.4" });
    expect(present.detail).toMatch(/Finish work in tmux/i);
    expect(present.detail).toMatch(/gmux tmux uninstall/);
    expect(present.detail).toMatch(/gmux attach/);
    expect(present.detail).not.toMatch(/overlay/i);
    expect(present.fix).toMatch(/gmux tmux uninstall/);
    expect(present.fix).toMatch(/gmux attach/);

    const missing = leftoverTmuxCheck(null);
    expect(missing.detail).toMatch(/gmux attach/);
    expect(missing.detail).not.toMatch(/overlay/i);
  });

  it("keeps doctor --json on SCHEMA_VERSION 1", () => {
    expect(SCHEMA_VERSION).toBe(1);
    const parsed = JSON.parse(jsonEnvelope(SCHEMA_VERSION, { checks: [] })) as {
      schemaVersion: number;
      data: { checks: unknown[] };
    };
    expect(parsed.schemaVersion).toBe(1);
  });
});
