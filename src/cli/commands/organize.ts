/**
 * `gmux organize [intent...]`: turn the live mux pane set into a plan that
 * groups panes into per-project tabs, print it as a numbered dry-run
 * preview, and — only with `--apply` — execute it against mux.
 *
 * Dry-run is the default: sensing panes and building a plan never mutates
 * layout. A MuxGateway is constructed, and `applyPlan` called, only inside
 * the `--apply` branch. Classify+plan never run on a timer.
 */

import { basename } from "node:path";

import type { Command } from "commander";

import type { OrganizePane, OrganizePlan, OrganizePlanner } from "../../core/organize-types.js";
import type { PaneEntry, PaneIdentity } from "../../core/gmux-types.js";
import { isPaneState } from "../../core/gmux-types.js";
import type { GmuxPane } from "../../core/mux-types.js";
import { MuxClient } from "../../services/mux-client.js";
import { HeuristicOrganizePlanner, LlmOrganizePlanner, applyPlan } from "../../services/organize.js";
import { dim, green, yellow } from "../format.js";
import { ensureMuxd } from "./spawn.js";

/** A snapshot pane (rich: state + label), flattened to `OrganizePane`. */
export function fromPaneEntry(entry: PaneEntry): OrganizePane {
  return {
    paneId: entry.identity.paneId,
    tabId: entry.identity.tabId ?? entry.identity.windowId,
    cwd: entry.identity.cwd,
    command: entry.identity.command,
    harness: entry.identity.harness,
    state: entry.state,
    label: entry.semantics?.label ?? null,
    active: entry.identity.active,
  };
}

/** A live mux pane. Extra snapshot fields (state/semantics) are optional. */
export function fromMuxPane(
  pane: GmuxPane & { state?: string | null; semantics?: { label?: string } | null },
): OrganizePane {
  const cmd = pane.argv[0] ? basename(pane.argv[0]) : "";
  return {
    paneId: pane.paneId,
    tabId: pane.tabId,
    cwd: pane.cwd,
    command: cmd,
    harness: pane.harness,
    state: pane.state && isPaneState(pane.state) ? pane.state : null,
    label: pane.semantics?.label ?? null,
    active: false,
  };
}

/** A live registry `PaneIdentity` (lean: no snapshot around to know state/label). */
export function fromPaneIdentity(identity: PaneIdentity): OrganizePane {
  return {
    paneId: identity.paneId,
    tabId: identity.tabId ?? identity.windowId,
    cwd: identity.cwd,
    command: identity.command,
    harness: identity.harness,
    state: null,
    label: null,
    active: identity.active,
  };
}

/**
 * Sense the current mux panes. Never mutates layout — `listPanes()` only.
 */
async function sensePanes(client: MuxClient): Promise<OrganizePane[]> {
  const panes = (await client.listPanes()) as Array<
    GmuxPane & { state?: string | null; semantics?: { label?: string } | null }
  >;
  return panes.map(fromMuxPane);
}

/** Pure. Renders a plan as the numbered dry-run preview printed to stdout. */
export function renderOrganizePreview(plan: OrganizePlan): string {
  const lines = [plan.summary];
  plan.steps.forEach((step, i) => lines.push(`${i + 1}. ${step.description}`));
  lines.push(dim("run with --apply to execute"));
  return lines.join("\n");
}

export function registerOrganize(program: Command): void {
  program
    .command("organize [intent...]")
    .description("reorganize the mux workspace into per-project tabs (dry-run by default)")
    .option("--apply", "execute the plan instead of printing it", false)
    .option("--json", "print the plan as JSON")
    .option("--heuristic", "force the deterministic planner, ignoring any intent/provider")
    .action(async (intentWords: string[], opts: { apply?: boolean; json?: boolean; heuristic?: boolean }) => {
      await ensureMuxd();
      const client = await MuxClient.connectCli();
      try {
        const panes = await sensePanes(client);
        const intent = intentWords.join(" ").trim();

        const planner: OrganizePlanner =
          opts.heuristic || intent === "" ? new HeuristicOrganizePlanner() : new LlmOrganizePlanner();
        const plan = await planner.plan(panes, intent === "" ? undefined : intent);

        if (!opts.apply) {
          if (opts.json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
          else process.stdout.write(`${renderOrganizePreview(plan)}\n`);
          return; // Dry-run: no mux mutation.
        }

        const { applied, skipped } = await applyPlan(plan, client);

        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ applied, skipped }, null, 2)}\n`);
          return;
        }
        process.stdout.write(`${green(`${applied.length} applied`)} / ${yellow(`${skipped.length} skipped`)}\n`);
        for (const { step, reason } of skipped) {
          process.stdout.write(`${dim(`  skipped: ${step.description} — ${reason}`)}\n`);
        }
      } finally {
        await client.close().catch(() => {});
      }
    });
}
