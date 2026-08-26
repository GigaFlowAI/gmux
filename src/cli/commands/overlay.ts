import type { Command } from "commander";

import type { AskProvider, SessionView } from "../../core/types.js";
import { buildAskContext, buildAskPrompt, defaultAskProvider } from "../../services/ask.js";
import { inProgressIds, maybeAutoSummarize } from "../../services/auto-summarize.js";
import { mapLimit } from "../../services/concurrency.js";
import { prunePaneLinks } from "../../services/pane-links.js";
import { defaultSummaryProvider, summarizeBatch } from "../../services/summarize.js";
import { listAllPanes, listPanes } from "../../services/tmux.js";
import { resolvePanesLive, type ResolvedPane } from "../../services/tmux-resolve.js";
import { attachSummaries, loadCachedRecords, loadRecords } from "../../services/views.js";
import { renderOverlay, type OverlayCell } from "../overlay.js";
import { ASK_BOX_HEIGHT, askBoxLines, askCursorColumn } from "../overlay-ask.js";

/** How often the overlay repaints while it waits, to fold in landed refreshes. */
const REPAINT_MS = 1000;
const CLEAR = "\x1b[2J\x1b[H";

/** A question broadcast to every pane, and the per-session answers as they land. */
export interface AskBroadcast {
  question: string;
  answers: Map<string, string>;
}

/**
 * Pair each resolved pane with its summary view and the in-flight refresh set —
 * and, when a question has been broadcast, this pane's own answer (or the
 * `asking…` state until it lands). Pure, so the pairing is tested without a terminal.
 */
export function buildCells(
  resolved: readonly ResolvedPane[],
  views: readonly SessionView[],
  refreshingIds: ReadonlySet<string>,
  ask?: AskBroadcast | null,
): OverlayCell[] {
  const bySession = new Map(views.map((v) => [v.record.sessionId, v]));
  return resolved.map(({ pane, record }) => {
    const cell: OverlayCell = {
      pane,
      view: record ? bySession.get(record.sessionId) ?? { record, summary: null } : null,
      refreshing: record ? refreshingIds.has(record.sessionId) : false,
    };
    if (ask && record) {
      cell.answer = ask.answers.get(record.sessionId) ?? null;
      cell.asking = cell.answer == null;
    }
    return cell;
  });
}

/**
 * The keys that dismiss the overlay.
 *
 * ctrl-g (`\x07`) is here so the same key that opens the popup also closes it —
 * a toggle, which is what a peek key should feel like. Since the ask box landed
 * every other key types into it, so a close key has to be spelled out; without
 * ctrl-g listed it would fall through and be swallowed as un-printable input.
 * Esc, ctrl-c and ctrl-d are the long-standing exits, kept exactly.
 */
export function isCloseKey(s: string): boolean {
  return s === "\x1b" || s === "\x03" || s === "\x04" || s === "\x07";
}

const rows = (): number => process.stdout.rows || 24;
const cols = (): number => process.stdout.columns || 80;

/** The card frame for the resolved panes — re-reads only the (small) summaries. */
async function cardsFrame(
  resolved: readonly ResolvedPane[],
  ask: AskBroadcast | null,
  forcing: ReadonlySet<string>,
): Promise<string> {
  const present = resolved
    .map((r) => r.record)
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const views = await attachSummaries(present);
  const refreshing = new Set([...(await inProgressIds()), ...forcing]);
  return renderOverlay(buildCells(resolved, views, refreshing, ask));
}

/**
 * Resolve the window's panes with GLOBAL de-duplication, so a fresh pane can't
 * claim a session another window's pane already owns. Resolves every pane in the
 * server, then keeps just this window's.
 */
async function resolveWindow(
  windowId: string,
  records: Awaited<ReturnType<typeof loadCachedRecords>>,
): Promise<ResolvedPane[]> {
  const all = await listAllPanes();
  const links = await prunePaneLinks(all.map((p) => p.paneId));
  const windowPaneIds = new Set((await listPanes(windowId)).map((p) => p.paneId));
  const resolvedAll = await resolvePanesLive(all, records, links);
  return resolvedAll.filter((r) => windowPaneIds.has(r.pane.paneId));
}

/** The ask box drawn across the bottom rows, with the cursor left in the field. */
function boxFrame(input: string): string {
  const top = rows() - ASK_BOX_HEIGHT + 1; // 1-based first box row
  let out = "";
  askBoxLines(input, cols()).forEach((line, i) => {
    out += `\x1b[${top + i};1H${line}`;
  });
  out += `\x1b[${top + 1};${askCursorColumn(input, cols())}H`; // cursor into the input line
  return out;
}

/** One concise answer per session — asked in parallel, but bounded. */
const ASK_CONCURRENCY = 6;

async function runOverlay(windowId: string): Promise<void> {
  // A peek must feel instant. We reach this command only because `display-popup`
  // launched it, which already proves tmux >= 3.2. Resolve ONCE from the cache;
  // repaints re-read only summaries, so an open overlay is not re-scanning
  // thousands of files every second.
  let resolved = await resolveWindow(windowId, await loadCachedRecords());

  const state: { input: string; ask: AskBroadcast | null } = { input: "", ask: null };
  const forcing = new Set<string>(); // sessions being force-regenerated right now (ctrl-r)
  let busy = false; // a broadcast is in flight
  let provider: AskProvider | null = null;
  void defaultAskProvider()
    .then((p) => (provider = p))
    .catch(() => {});

  // Always cards (with any per-pane answers) above, the ask box below.
  const drawAll = async (): Promise<void> => {
    process.stdout.write(CLEAR + (await cardsFrame(resolved, state.ask, forcing)) + boxFrame(state.input));
  };

  await drawAll();

  // Off the critical path: upgrade to the full index, re-resolve, and kick stale
  // cards to refresh in the background — targeting exactly the panes on screen.
  void (async () => {
    resolved = await resolveWindow(windowId, await loadRecords());
    if (!state.ask && !busy) await drawAll();
    const present = resolved.map((r) => r.record).filter((r): r is NonNullable<typeof r> => r !== null);
    await maybeAutoSummarize({ records: present, force: true });
  })().catch(() => {});

  // Repaint the cards while browsing (not while a broadcast owns the screen).
  const timer = setInterval(() => {
    if (!state.ask && !busy) void drawAll().catch(() => {});
  }, REPAINT_MS);

  /** Broadcast the question to every pane's session, answering each on its card. */
  const broadcast = async (question: string): Promise<void> => {
    const present = resolved.map((r) => r.record).filter((r): r is NonNullable<typeof r> => r !== null);
    const views = await attachSummaries(present);
    const byId = new Map(views.map((v) => [v.record.sessionId, v]));
    const answers = new Map<string, string>();
    state.ask = { question, answers };

    if (!provider) {
      for (const r of present) answers.set(r.sessionId, "No model configured — run `gm setup`.");
      await drawAll();
      return;
    }

    busy = true;
    await drawAll(); // every card shows "asking…"
    await mapLimit(present, ASK_CONCURRENCY, async (record) => {
      try {
        const view = byId.get(record.sessionId);
        const context = buildAskContext(view ? [view] : [], record.sessionId, 1);
        const answer = await provider!.ask(buildAskPrompt(context, [], question));
        answers.set(record.sessionId, answer.trim());
      } catch (error) {
        answers.set(record.sessionId, `ask failed: ${(error as Error).message}`);
      }
      await drawAll(); // this card fills in as its answer lands
    });
    busy = false;
    await drawAll();
  };

  /** ctrl-r: regenerate every visible pane's summary now, ignoring the divergence gate. */
  const forceRefresh = async (): Promise<void> => {
    const present = resolved.map((r) => r.record).filter((r): r is NonNullable<typeof r> => r !== null);
    if (present.length === 0) return;
    present.forEach((r) => forcing.add(r.sessionId));
    await drawAll(); // cards show refreshing…
    try {
      const summaryProvider = await defaultSummaryProvider();
      if (summaryProvider && (await summaryProvider.isAvailable())) {
        await summarizeBatch(present, summaryProvider, { force: true });
      }
    } finally {
      present.forEach((r) => forcing.delete(r.sessionId));
      await drawAll();
    }
  };

  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();

  await new Promise<void>((done) => {
    stdin.on("data", (buf: Buffer) => {
      void (async () => {
        const s = buf.toString();

        if (isCloseKey(s)) return done(); // Esc / ctrl-c / ctrl-d / ctrl-g
        if (s.startsWith("\x1b")) return; // an arrow or other escape sequence — ignore
        if (s === "\x12") return void forceRefresh(); // ctrl-r: force a summary refresh now
        if (busy) return; // a broadcast is landing; ignore keys (Esc handled above)

        if (s === "\r" || s === "\n") {
          const question = state.input.trim();
          state.input = "";
          if (!question) {
            // Empty Enter clears the answers, returning the cards to their summaries.
            if (state.ask) {
              state.ask = null;
              await drawAll();
            }
            return;
          }
          await broadcast(question);
          return;
        }

        if (s === "\x7f" || s === "\b") {
          state.input = state.input.slice(0, -1);
          process.stdout.write(boxFrame(state.input));
          return;
        }

        const printable = [...s].filter((c) => c >= " " && c <= "~").join("");
        if (printable) {
          state.input += printable;
          process.stdout.write(boxFrame(state.input));
        }
      })().catch(() => {});
    });
  });

  clearInterval(timer);
  process.stdout.write("\x1b[2J\x1b[H");
  process.exit(0);
}

export function registerOverlay(program: Command): void {
  program
    .command("overlay <window>")
    .description("draw every pane's summary in place (used by the tmux ctrl-g binding)")
    .action(async (windowId: string) => {
      await runOverlay(windowId);
    });
}
