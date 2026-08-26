/**
 * `gmux organize [intent...]`: turn the live tmux pane set into a plan that
 * groups panes into per-project windows, print it as a numbered dry-run
 * preview, and — only with `--apply` — execute it against real tmux.
 *
 * Dry-run is the default (see the organize spec's design invariant): sensing
 * panes and building a plan never touches tmux. `RealTmuxGateway` is
 * constructed, and `applyPlan` called, only inside the `--apply` branch.
 */

import type { Command } from "commander";

import type { OrganizePane, OrganizePlan, OrganizePlanner } from "../../core/organize-types.js";
import type { PaneEntry, PaneIdentity } from "../../core/gmux-types.js";
import { readSnapshotFile } from "../../services/daemon-client.js";
import { HeuristicOrganizePlanner, LlmOrganizePlanner, applyPlan } from "../../services/organize.js";
import { PaneRegistry } from "../../services/pane-registry.js";
import { RealTmuxGateway } from "../../services/tmux-gateway.js";
import { dim, green, yellow } from "../format.js";

/** A daemon `PaneEntry` (rich: state + label), flattened to `OrganizePane`.
 *  Exported so the ctrl-g cockpit plans from the same snapshot shape. */
export function fromPaneEntry(entry: PaneEntry): OrganizePane {
  return {
    paneId: entry.identity.paneId,
    windowId: entry.identity.windowId,
    cwd: entry.identity.cwd,
    command: entry.identity.command,
    harness: entry.identity.harness,
    state: entry.state,
    label: entry.semantics?.label ?? null,
    active: entry.identity.active,
  };
}

/** A live registry `PaneIdentity` (lean: no daemon around to know state/label). */
function fromPaneIdentity(identity: PaneIdentity): OrganizePane {
  return {
    paneId: identity.paneId,
    windowId: identity.windowId,
    cwd: identity.cwd,
    command: identity.command,
    harness: identity.harness,
    state: null,
    label: null,
    active: identity.active,
  };
}

/**
 * Sense the current panes. Prefers the daemon snapshot (richer: state +
 * semantic label) when one is on disk; falls back to a live registry diff
 * against a fresh `RealTmuxGateway` when no daemon is around. Never mutates
 * tmux — `PaneRegistry.diff()` only calls `listPanes()`.
 */
async function sensePanes(): Promise<OrganizePane[]> {
  const snap = await readSnapshotFile();
  if (snap) {
    return snap.snapshot.panes.filter((entry) => !entry.gone).map(fromPaneEntry);
  }
  const { present } = await new PaneRegistry(new RealTmuxGateway()).diff();
  return present.map(fromPaneIdentity);
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
    .description("reorganize the tmux workspace into per-project windows (dry-run by default)")
    .option("--apply", "execute the plan instead of printing it", false)
    .option("--json", "print the plan as JSON")
    .option("--heuristic", "force the deterministic planner, ignoring any intent/provider")
    .action(async (intentWords: string[], opts: { apply?: boolean; json?: boolean; heuristic?: boolean }) => {
      const panes = await sensePanes();
      const intent = intentWords.join(" ").trim();

      const planner: OrganizePlanner =
        opts.heuristic || intent === "" ? new HeuristicOrganizePlanner() : new LlmOrganizePlanner();
      const plan = await planner.plan(panes, intent === "" ? undefined : intent);

      if (!opts.apply) {
        if (opts.json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
        else process.stdout.write(`${renderOrganizePreview(plan)}\n`);
        return; // Dry-run: no gateway constructed, no tmux mutation.
      }

      const gateway = new RealTmuxGateway();
      const { applied, skipped } = await applyPlan(plan, gateway);

      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ applied, skipped }, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${green(`${applied.length} applied`)} / ${yellow(`${skipped.length} skipped`)}\n`);
      for (const { step, reason } of skipped) {
        process.stdout.write(`${dim(`  skipped: ${step.description} — ${reason}`)}\n`);
      }
    });
}
