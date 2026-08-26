import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";

describe("gmux docs + bindings", () => {
  it("ships a gmux doc covering the guardian consent and memory caveats", () => {
    expect(existsSync("docs/gmux.md")).toBe(true);
    const doc = readFileSync("docs/gmux.md", "utf8");
    expect(doc).toMatch(/guardian/i);
    expect(doc).toMatch(/unattributed/i);
    expect(doc).toMatch(/consent|disclose/i);
  });

  it("README names ~/.tmux.conf.local so Oh My Tmux onboarding does not write through the symlink", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toMatch(/tmux\.conf\.local/);
    expect(readme).toMatch(/gigamanage/);
  });

  it("documents Ghostty/iTerm as the emulator and the experimental peel-fixture gate", () => {
    const readme = readFileSync("README.md", "utf8");
    const doc = readFileSync("docs/gmux.md", "utf8");
    for (const text of [readme, doc]) {
      expect(text).toMatch(/Ghostty/);
      expect(text).toMatch(/iTerm/);
      expect(text).toMatch(/experimental/i);
      expect(text).toMatch(/gmux attach/);
      expect(text).toMatch(/gmux tmux uninstall/);
    }
    expect(readme).toMatch(/fixtures\/grids/);
    expect(readme).toMatch(/synthetic/i);
  });

  it("documents fetch-if-missing gmuxd triples with a checksum pin", () => {
    const readme = readFileSync("README.md", "utf8");
    const doc = readFileSync("docs/gmux.md", "utf8");
    for (const text of [readme, doc]) {
      expect(text).toMatch(/fetch-if-missing/i);
      expect(text).toMatch(/GitHub Releases/);
      expect(text).toMatch(/checksum/i);
      expect(text).toMatch(/aarch64-apple-darwin/);
      expect(text).toMatch(/x86_64-apple-darwin/);
      expect(text).toMatch(/x86_64-unknown-linux-gnu/);
      expect(text).toMatch(/aarch64-unknown-linux-gnu/);
    }
  });
});
