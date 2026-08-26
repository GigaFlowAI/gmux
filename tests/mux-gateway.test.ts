import { describe, expect, it } from "vitest";
import { FakeMuxGateway } from "../src/services/mux-gateway.js";

describe("FakeMuxGateway", () => {
  it("spawn with focus:false does not change thisClient.focusedPaneId", async () => {
    const gw = new FakeMuxGateway();
    const parent = await gw.spawn({ cwd: "/tmp", argv: ["zsh"], tab: { mode: "new", name: "main" }, focus: true });
    gw.setClientFocus("c1", parent.paneId);
    const child = await gw.spawn({
      cwd: "/tmp",
      argv: ["zsh"],
      tab: { mode: "new", name: "new agent" },
      focus: false,
    });
    expect(gw.focusedPaneId("c1")).toBe(parent.paneId);
    expect(child.paneId).not.toBe(parent.paneId);
    expect(child.tabId).not.toBe(parent.tabId);
  });

  it("has no selectLayout or swapPane", () => {
    const gw = new FakeMuxGateway();
    expect("selectLayout" in gw).toBe(false);
    expect("swapPane" in gw).toBe(false);
  });

  it("peel does not await extract", async () => {
    const gw = new FakeMuxGateway();
    const extract = new Promise(() => {}); // never resolves
    const parent = await gw.spawn({ cwd: "/t", argv: ["zsh"], focus: true });
    gw.setClientFocus("c1", parent.paneId);
    const started = Date.now();
    await gw.peel("c1"); // must not take extract
    expect(Date.now() - started).toBeLessThan(50);
    void extract;
  });
});
