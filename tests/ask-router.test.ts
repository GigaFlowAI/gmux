/**
 * The ask-box intent router.
 *
 * No real LLM — the provider is a `node -e` script (the same trick
 * `provider-process.test.ts` and `organize.test.ts` use): deterministic, no
 * model, no network. The property under test is the SAFE DEFAULT: everything
 * that is not an unambiguous "ORGANIZE" resolves to "ask".
 */

import { describe, expect, it } from "vitest";

import { buildClassifyPrompt, classifyIntent, parseIntent } from "../src/services/ask-router.js";
import { liveIntelHandlers } from "../src/services/mux-client.js";
import { HeuristicOrganizePlanner } from "../src/services/organize.js";

function providerArgv(script: string): string[] {
  return [process.execPath, "-e", script];
}

/** A provider that prints a fixed reply, ignoring its stdin prompt. */
function replyWith(text: string): string[] {
  return providerArgv(`process.stdout.write(${JSON.stringify(text)})`);
}

describe("parseIntent", () => {
  it("reads an unambiguous ORGANIZE (any case, trailing punctuation) as organize", () => {
    expect(parseIntent("ORGANIZE")).toBe("organize");
    expect(parseIntent("organize\n")).toBe("organize");
    expect(parseIntent("Organize.")).toBe("organize");
  });

  it("reads ASK as ask", () => {
    expect(parseIntent("ASK")).toBe("ask");
    expect(parseIntent("ask\n")).toBe("ask");
  });

  it("defaults to ask for prose, empty, or anything not leading with organize", () => {
    expect(parseIntent("")).toBe("ask");
    expect(parseIntent("The user wants to organize their panes")).toBe("ask");
    expect(parseIntent("I think this is a question")).toBe("ask");
    expect(parseIntent("42")).toBe("ask");
  });
});

describe("classifyIntent", () => {
  it("returns organize when the provider says ORGANIZE", async () => {
    expect(await classifyIntent("group these by project", { command: replyWith("ORGANIZE") })).toBe("organize");
  });

  it("returns ask when the provider says ASK", async () => {
    expect(await classifyIntent("what is broken?", { command: replyWith("ASK") })).toBe("ask");
  });

  it("defaults to ask on a garbage reply", async () => {
    expect(await classifyIntent("do the thing", { command: replyWith("maybe? not sure") })).toBe("ask");
  });

  it("defaults to ask when the provider exits nonzero", async () => {
    expect(await classifyIntent("do the thing", { command: providerArgv("process.exit(1)") })).toBe("ask");
  });

  it("defaults to ask with no provider configured (command: null)", async () => {
    expect(await classifyIntent("group by project", { command: null })).toBe("ask");
  });

  it("returns ask for an empty prompt WITHOUT spawning anything", async () => {
    // The command would crash if run; an empty prompt must short-circuit first.
    expect(await classifyIntent("   ", { command: providerArgv("process.exit(1)") })).toBe("ask");
  });

  it("passes the prompt through to the classifier prompt body", () => {
    expect(buildClassifyPrompt("tidy the tabs")).toContain("Message: tidy the tabs");
    expect(buildClassifyPrompt("x")).toContain("exactly one word");
    expect(buildClassifyPrompt("x")).toContain("tabs");
  });
});

describe("liveIntelHandlers", () => {
  it("classify.intent defaults to ask on the injected classifier", async () => {
    const handlers = liveIntelHandlers({ classify: async () => "ask" });
    await expect(handlers["classify.intent"]!({ prompt: "what is broken?" })).resolves.toEqual({ intent: "ask" });
  });

  it("classify.intent returns organize only when the classifier says so", async () => {
    const handlers = liveIntelHandlers({ classify: async () => "organize" });
    await expect(handlers["classify.intent"]!({ prompt: "group these by project" })).resolves.toEqual({
      intent: "organize",
    });
  });

  it("organize.plan returns schemaVersion 2 with grouping ops only", async () => {
    const handlers = liveIntelHandlers({ planner: new HeuristicOrganizePlanner() });
    const plan = (await handlers["organize.plan"]!({
      prompt: "group by project",
      panes: [
        {
          paneId: "p_A",
          tabId: null,
          cwd: "/r/web",
          command: "claude",
          harness: "claude-code",
          state: "working",
          label: null,
          active: false,
        },
      ],
    })) as { schemaVersion: number; steps: Array<{ op: string }> };
    expect(plan.schemaVersion).toBe(2);
    expect(plan.steps.every((s) => ["new-tab", "rename-tab", "move-pane", "break-pane"].includes(s.op))).toBe(true);
  });
});
