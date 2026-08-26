/**
 * The ask fallback ladder.
 *
 * These are not tests of the new feature — they are tests that the new feature
 * is invisible to everyone who cannot use it. The split chat needs
 * `$FZF_INPUT_STATE` (fzf 0.59.0); everything below that floor keeps exactly
 * what shipped before it, and the tiers are the promise that it does.
 *
 * The stakes are asymmetric, which is why the file exists at all. An fzf flag
 * leaked into a tier that does not understand it makes fzf exit non-zero at
 * startup: the picker is not degraded, it is gone — for precisely the users the
 * fallback protects, and for nobody developing on a current fzf.
 */

import { describe, expect, it } from "vitest";

import { askTier, fzfArgs, supportsSplitChat, type AskTier, type FzfSpec } from "../src/cli/picker.js";

/** Everything present: the ladder's answer is then the version's alone. */
const ready = {
  hasFzf: true,
  askAvailable: true,
  selfCommand: "node /repo/dist/main.js",
};

const tierFor = (fzfVersion: number[] | null): AskTier => askTier({ ...ready, fzfVersion });

describe("askTier", () => {
  /**
   * The floor is the max over every action the bindings use, and the oracle is
   * the whole cost: `transform` is 0.45, `$FZF_QUERY` 0.46, `--with-shell`
   * 0.51, and `$FZF_INPUT_STATE` — which is how a binding knows whether it is
   * in ask mode — is 0.59.0.
   */
  it("gives 0.59.0 the split chat", () => {
    expect(tierFor([0, 59, 0])).toBe("split");
  });

  it("gives 0.58.x the execute REPL", () => {
    // One patch under the floor. The mode oracle is absent, so ctrl-o would be
    // a dead key and enter would never resume.
    expect(tierFor([0, 58, 9])).toBe("execute");
  });

  it("gives anything newer the split chat", () => {
    expect(tierFor([0, 59, 1])).toBe("split");
    expect(tierFor([0, 74, 0])).toBe("split");
    expect(tierFor([1, 0, 0])).toBe("split");
  });

  it("gives an ancient fzf the execute REPL rather than nothing", () => {
    // Some distros still ship ~0.44. Nothing anyone has today is taken away.
    expect(tierFor([0, 44, 0])).toBe("execute");
  });

  it("gives an unreadable version the safe tier, not the new one", () => {
    // `fzf --version` unparseable. Degrading to an older UI is a worse UI;
    // degrading to the split chat is a broken one — fzf would reject the flags
    // and the picker would not open at all.
    expect(tierFor(null)).toBe("execute");
  });

  it("gives no fzf the numbered list's `a` key", () => {
    expect(askTier({ ...ready, hasFzf: false, fzfVersion: null })).toBe("prompt");
  });

  it("keeps the `a` key when this build cannot address itself", () => {
    // The numbered fallback calls back into this process, so unlike every fzf
    // tier it needs no shell command to re-invoke `gm`.
    expect(askTier({ ...ready, hasFzf: false, fzfVersion: null, selfCommand: null })).toBe("prompt");
  });

  it("offers nothing when there is no provider", () => {
    // The user chose "no model calls", or never installed what they chose. A
    // key that opens a chat which dies instantly is worse than no key.
    for (const hasFzf of [true, false]) {
      expect(askTier({ ...ready, hasFzf, fzfVersion: [0, 74, 0], askAvailable: false })).toBe("none");
    }
  });

  it("offers nothing in fzf when this build cannot address itself", () => {
    // fzf runs `gm` through a shell; with no way to name this build there is no
    // command to bind, at any version.
    expect(askTier({ ...ready, fzfVersion: [0, 74, 0], selfCommand: null })).toBe("none");
    expect(askTier({ ...ready, fzfVersion: [0, 46, 0], selfCommand: null })).toBe("none");
  });
});

describe("supportsSplitChat", () => {
  it("is its own gate, not multiline's", () => {
    // `MULTILINE_FZF` claims 0.46 and is wrong — multi-line landed in 0.53. The
    // chat must not change tiers on the day someone fixes it.
    expect(supportsSplitChat([0, 53, 0])).toBe(false);
    expect(supportsSplitChat([0, 59, 0])).toBe(true);
  });

  it("refuses a version it could not read", () => {
    expect(supportsSplitChat(null)).toBe(false);
  });
});

describe("the fallback tiers' fzf arguments", () => {
  const spec = (overrides: Partial<FzfSpec> = {}): FzfSpec => ({
    multiline: true,
    preview: "gm show {1} --no-color",
    reloadCmd: "gm __picker-rows --width 44",
    askCmd: "gm ask --focus {1}",
    tier: "execute",
    ...overrides,
  });

  /**
   * The one that catches a real regression.
   *
   * Every flag here is 0.59+, or an action an older fzf parses as a typo and
   * ignores while the flag carrying it kills the process. This test exists
   * before the code that could leak one, which is the point of landing the gate
   * first.
   */
  it("leaks no 0.59-only flag into the execute tier", () => {
    const args = fzfArgs(spec()).join(" ");

    for (const flag of ["--listen", "disable-search", "--chat", "FZF_INPUT_STATE", "--with-shell"]) {
      expect(args).not.toContain(flag);
    }
  });

  it("keeps today's full-screen REPL on the execute tier", () => {
    // `execute` suspends fzf and hands the child the terminal, restoring the
    // list when it exits. That is what 0.46-0.58 has and keeps.
    expect(fzfArgs(spec())).toContain("--bind=ctrl-o:execute(gm ask --focus {1})");
  });

  it("binds no ctrl-o on the tiers that have none", () => {
    // `prompt` has no fzf to bind in; `none` has nothing to bind to. A tier
    // that reaches fzf with a stale askCmd must still not get the key.
    for (const tier of ["prompt", "none"] as const) {
      const args = fzfArgs(spec({ tier })).join(" ");
      expect(args).not.toContain("ctrl-o");
    }
  });

  it("never binds a plain letter, in any tier", () => {
    // fzf's query line eats plain letter keys, so a lettered binding types a
    // letter instead of firing.
    for (const tier of ["split", "execute", "prompt", "none"] as const) {
      expect(fzfArgs(spec({ tier })).join(" ")).not.toMatch(/--bind=[A-Za-z]:/);
    }
  });

  it("leaves browsing identical across every tier", () => {
    // The ask tier decides what ctrl-o does and nothing else. Someone with no
    // provider gets the same list, preview and refresh as everyone else.
    const browse = (tier: AskTier): string[] =>
      fzfArgs(spec({ tier }))
        .filter((a) => !a.startsWith("--bind=ctrl-o"))
        .map((a) => a.replace("   ctrl-o: ask", ""));

    for (const tier of ["split", "prompt", "none"] as const) {
      expect(browse(tier)).toEqual(browse("execute"));
    }
  });
});
