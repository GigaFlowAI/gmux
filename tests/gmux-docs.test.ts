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
});
