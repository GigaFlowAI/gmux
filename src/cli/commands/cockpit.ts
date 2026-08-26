import { basename } from "node:path";
import { writeFile } from "node:fs/promises";

import type { Command } from "commander";

import { workReportPath } from "../../core/paths.js";
import type { OrganizePlan } from "../../core/organize-types.js";
import type { WorkspaceSnapshot } from "../../core/gmux-types.js";
import type { SessionRecord } from "../../core/types.js";
import { buildAskContext, buildAskPrompt, defaultAskProvider } from "../../services/ask.js";
import { classifyIntent } from "../../services/ask-router.js";
import { mapLimit } from "../../services/concurrency.js";
import { readSnapshotFile, subscribe } from "../../services/daemon-client.js";
import { HeuristicOrganizePlanner, LlmOrganizePlanner, applyPlan } from "../../services/organize.js";
import { RealTmuxGateway } from "../../services/tmux-gateway.js";
import { attachSummaries, loadCachedRecords } from "../../services/views.js";
import { buildWorkViews, defaultWorkViewProvider } from "../../services/work-view.js";
import { renderCockpit, type CockpitAsk, type RenderCockpitOptions } from "../gmux-render.js";
import { confirmFrameLines, confirmKey, makeGeneration } from "../organize-confirm.js";
import { askBoxLines, askCursorColumn } from "../overlay-ask.js";
import { fromPaneEntry } from "./organize.js";
import { renderWorkReportHtml, type WorkReportCard } from "../work-report.js";

const CLEAR = "\x1b[2J\x1b[H";

/** The cockpit prompt does both jobs; the box caption names both. */
const ASK_LABEL = "organize · ask · Enter · ^V report · ^G/Esc close";

/** One concise answer per session — asked in parallel, but bounded. */
const ASK_CONCURRENCY = 6;

/** Clear screen + home, then the cockpit grid — CRLF-joined for raw-mode stdout. */
export function buildFrame(snapshot: WorkspaceSnapshot, now: number, opts?: RenderCockpitOptions): string {
  return CLEAR + renderCockpit(snapshot, now, opts).join("\r\n");
}

/** Collapse an LLM answer to a single line — the cockpit renders answers terse. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The panes that have a resolvable session, paired with their record. Pure so
 * the pairing is tested without a daemon: matches on `identity.sessionId`, skips
 * session-less and unmatched panes, and dedupes a session claimed by two panes.
 */
export function sessionsForSnapshot(
  snapshot: WorkspaceSnapshot,
  records: readonly SessionRecord[],
): { label: string; record: SessionRecord }[] {
  const byId = new Map(records.map((r) => [r.sessionId, r]));
  const seen = new Set<string>();
  const out: { label: string; record: SessionRecord }[] = [];
  for (const p of snapshot.panes) {
    const sid = p.identity.sessionId;
    if (!sid || seen.has(sid)) continue;
    const record = byId.get(sid);
    if (!record) continue;
    seen.add(sid);
    out.push({ label: p.identity.cwd ? basename(p.identity.cwd) : p.identity.command, record });
  }
  return out;
}

/** A broadcast question in flight: the sessions to answer and their answers as they land. */
interface AskState {
  question: string;
  entries: { label: string; sessionId: string }[];
  answers: Map<string, string>;
}

/**
 * The whole-workspace cockpit: paint the last known snapshot immediately, then
 * stay live off the daemon socket. A prompt line at the bottom takes free text;
 * a quick classify routes it — a question broadcasts to every session and
 * answers inline, a reorganization request is planned from the panes on screen
 * and previewed for confirmation (never auto-applied). `ctrl-v` builds a
 * per-session HTML work report and shows a file:// link in the status banner.
 */
export function registerCockpit(program: Command): void {
  program
    .command("cockpit")
    .description("pull up the gmux workspace cockpit (used by the tmux ctrl-g binding)")
    .action(async () => {
      let latest: WorkspaceSnapshot | null = null;
      let stale: { ageMs: number } | null = null;
      let status: string | null = null;
      let input = "";
      let mode: "browse" | "confirm" = "browse";
      let plan: OrganizePlan | null = null;
      let ask: AskState | null = null;
      let busy = false; // a classify / plan / broadcast is in flight
      let reportInFlight: Promise<void> | null = null;
      const gen = makeGeneration(); // invalidates an in-flight classify/plan/ask on cancel

      const cols = (): number => process.stdout.columns || 120;

      const askView = (): CockpitAsk | null =>
        ask
          ? { question: ask.question, rows: ask.entries.map((e) => ({ label: e.label, answer: ask!.answers.get(e.sessionId) ?? null })) }
          : null;

      const render = (): void => {
        if (mode === "confirm" && plan) {
          process.stdout.write(CLEAR + confirmFrameLines(plan).join("\r\n"));
          return;
        }
        if (!latest) return;
        const width = cols();
        const grid = renderCockpit(latest, Date.now(), { width, stale, status, ask: askView() });
        const box = askBoxLines(input, width, ASK_LABEL);
        const frame = CLEAR + [...grid, ...box].join("\r\n");
        const cursorRow = grid.length + 2; // the box's middle (input) line, 1-based
        process.stdout.write(frame + `\x1b[${cursorRow};${askCursorColumn(input, width)}H`);
      };

      const initial = await readSnapshotFile();
      if (initial) { latest = initial.snapshot; render(); }

      const onSnapshot = (s: WorkspaceSnapshot): void => { latest = s; stale = null; render(); };
      const paintStale = (): void => {
        readSnapshotFile()
          .then((current) => { if (current) { latest = current.snapshot; stale = { ageMs: current.ageMs }; render(); } })
          .catch(() => { /* keep showing the last snapshot */ });
      };
      const stop = subscribe(onSnapshot, { onError: paintStale });

      /** Build the per-session HTML work report and show its link (ctrl-v). */
      const buildReport = async (): Promise<void> => {
        if (!latest) return;
        busy = true;
        status = "⧗ building work report…";
        render();
        try {
          const sessions = sessionsForSnapshot(latest, await loadCachedRecords());
          if (sessions.length === 0) { status = "no sessions to report"; return; }
          const records = sessions.map((s) => s.record);
          const provider = await defaultWorkViewProvider();
          const built = provider ? await buildWorkViews(records, provider) : null;
          const headlines = new Map(
            (await attachSummaries(records)).map((v) => [v.record.sessionId, v.summary?.headline ?? null]),
          );
          const cards: WorkReportCard[] = sessions.map(({ label, record }) => {
            const headline = headlines.get(record.sessionId) ?? null;
            if (!built) return { label, headline, html: null, note: "no model configured — run `gmux setup`" };
            const view = built.views.get(record.sessionId);
            if (view) return { label, headline, html: view.html, note: null };
            const reason = built.failed.find((f) => f.sessionId === record.sessionId)?.reason ?? "unknown";
            return { label, headline, html: null, note: `generation failed: ${reason}` };
          });
          const path = workReportPath();
          await writeFile(path, renderWorkReportHtml(cards, Date.now()), "utf8");
          status = `✓ work report: file://${path}`;
        } catch (error) {
          status = `⚠ ${(error as Error).message}`;
        } finally {
          busy = false;
          render();
        }
      };

      /** Broadcast a question to every visible session, answering each inline. */
      const broadcast = async (question: string, myGen: number): Promise<void> => {
        const sessions = sessionsForSnapshot(latest!, await loadCachedRecords());
        if (!gen.isCurrent(myGen)) return;
        if (sessions.length === 0) { busy = false; status = "no sessions to ask"; render(); return; }
        const answers = new Map<string, string>();
        ask = { question, entries: sessions.map((s) => ({ label: s.label, sessionId: s.record.sessionId })), answers };
        const provider = await defaultAskProvider();
        if (!provider) {
          for (const s of sessions) answers.set(s.record.sessionId, "No model configured — run `gmux setup`.");
          busy = false; status = null; render();
          return;
        }
        status = "⧗ asking…";
        render();
        const views = await attachSummaries(sessions.map((s) => s.record));
        const byId = new Map(views.map((v) => [v.record.sessionId, v]));
        await mapLimit(sessions, ASK_CONCURRENCY, async (s) => {
          if (!gen.isCurrent(myGen)) return;
          try {
            const view = byId.get(s.record.sessionId);
            const context = buildAskContext(view ? [view] : [], s.record.sessionId, 1);
            answers.set(s.record.sessionId, oneLine(await provider.ask(buildAskPrompt(context, [], question))));
          } catch (error) {
            answers.set(s.record.sessionId, `ask failed: ${(error as Error).message}`);
          }
          if (gen.isCurrent(myGen)) render();
        });
        if (!gen.isCurrent(myGen)) return;
        busy = false; status = null; render();
      };

      /**
       * Route a submitted prompt. A quick LLM classify decides: a question goes
       * to the broadcast; a reorganization request is planned from the panes on
       * screen and previewed for confirmation — never auto-applied. The
       * classifier defaults to "ask" on any uncertainty, so a plain question is
       * never mistaken for a reorg.
       */
      const submit = async (prompt: string): Promise<void> => {
        if (!latest) return;
        const myGen = gen.next();
        busy = true;
        status = "⧗ thinking…";
        render();
        const intent = await classifyIntent(prompt).catch(() => "ask" as const);
        if (!gen.isCurrent(myGen)) return;
        if (intent === "ask") { await broadcast(prompt, myGen); return; }

        status = "⧗ planning…";
        render();
        const panes = latest.panes.filter((p) => !p.gone).map(fromPaneEntry);
        const built = await new LlmOrganizePlanner(new HeuristicOrganizePlanner()).plan(panes, prompt);
        if (!gen.isCurrent(myGen)) return;
        plan = built;
        mode = "confirm";
        busy = false;
        status = null;
        render();
      };

      const stdin = process.stdin;
      if (stdin.isTTY) stdin.setRawMode?.(true);
      stdin.resume();

      await new Promise<void>((done) => {
        stdin.on("data", (buf: Buffer) => {
          void (async () => {
            const s = buf.toString();

            // The confirm screen owns the keyboard: apply, cancel back to the
            // grid, or hard-exit. Handled first so Esc cancels the plan rather
            // than closing the cockpit.
            if (mode === "confirm") {
              switch (confirmKey(s)) {
                case "apply":
                  // applyPlan skips (never throws on) a bad step, but a failure
                  // before its per-step loop — e.g. listPanes() — would escape;
                  // nothing was applied at that point, so a clean close is safe.
                  try {
                    if (plan) await applyPlan(plan, new RealTmuxGateway());
                  } catch (error) {
                    process.stderr.write(`gmux: organize apply failed — ${(error as Error).message}\n`);
                  }
                  return done();
                case "exit":
                  return done();
                case "cancel":
                  mode = "browse"; plan = null; status = null; render();
                  return;
                default:
                  return; // ignore any other key while confirming
              }
            }

            if (s === "\x03" || s === "\x04") return done(); // ctrl-c / ctrl-d always exit

            // While a classify / plan / broadcast / report is in flight, Esc or
            // ctrl-g cancels it (a plan can take a while — no lockout); every
            // other key is ignored. The generation guard drops the late result.
            if (busy) {
              if (s === "\x1b" || s === "\x07") {
                gen.next(); busy = false; status = null; ask = null; render();
              }
              return;
            }

            if (s === "\x16") { // ctrl-v: work report (v itself types into the prompt)
              if (!reportInFlight) reportInFlight = buildReport().finally(() => { reportInFlight = null; });
              return;
            }

            if (s === "\x1b" || s === "\x07") return done(); // Esc / ctrl-g close (idle)
            if (s.startsWith("\x1b")) return; // an arrow or other escape sequence — ignore

            if (s === "\r" || s === "\n") {
              const prompt = input.trim();
              input = "";
              if (!prompt) {
                if (ask) ask = null; // empty Enter clears the answers, back to the grid
                render();
                return;
              }
              await submit(prompt);
              return;
            }

            if (s === "\x7f" || s === "\b") { input = input.slice(0, -1); render(); return; }

            const printable = [...s].filter((c) => c >= " " && c <= "~").join("");
            if (printable) { input += printable; render(); }
          })().catch(() => {});
        });
      });

      await reportInFlight;
      stop();
      if (stdin.isTTY) stdin.setRawMode?.(false);
      process.stdout.write(CLEAR);
      process.exit(0);
    });
}
