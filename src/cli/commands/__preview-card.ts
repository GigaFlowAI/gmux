/**
 * `gm __preview-card` — what fills the picker's preview pane.
 *
 * **Not `gm show --chat <path>`.** `gm show` is a public command and `--chat` is
 * a private IPC channel: it is meaningless to a human at a terminal and exists
 * only because fzf's preview command must be a shell string. So the preview gets
 * a hidden command that calls the same renderer, `__picker-rows`' precedent, and
 * **`gm show`'s flags, output and `--json` schema are exactly as they were.**
 *
 * **It re-runs on EVERY cursor move, and it must never call a model.** That is
 * the hard correctness constraint the whole chat design hangs off: the chat half
 * renders from the transcript file or it does not render. A model call here is a
 * model call per keystroke.
 *
 * Geometry is passed in, never measured. `--pane-lines` carries the pane's
 * height because our stdout is a pipe — `process.stdout.columns` is undefined and
 * `terminalWidth()` would return its 100 default — and because `$LINES` is the
 * TERMINAL, not the pane: verified on a 40x120 terminal, the preview saw
 * `LINES=40` but `FZF_PREVIEW_LINES=32`. Using `$LINES` overestimates by up to 2x.
 * Same rule, same reason as `__picker-rows --width`.
 */

import type { Command } from "commander";

import { readAskTranscript } from "../../services/ask-transcript.js";
import { resolveSession } from "../../services/resolve.js";
import { readSummary } from "../../services/summarize.js";
import { loadRecords } from "../../services/views.js";
import { formatPreview, hasChatContent, splitPreview } from "../preview.js";

/** The hidden command fzf's preview binding runs. Not a thing a person runs. */
export const PREVIEW_CARD_COMMAND = "__preview-card";

/**
 * The pane width when fzf did not say. Not `terminalWidth()`: our stdout is a
 * pipe, so it would answer with its default for the whole TERMINAL — roughly
 * twice the pane, since the preview window is 55% of it.
 */
const ASSUMED_PANE_COLUMNS = 80;

export interface PreviewCardOptions {
  /** The picker's transcript. Absent — or missing on disk — is the empty state. */
  chat?: string;
  paneLines?: string;
}

/**
 * A positive integer out of environment-controlled text, or null.
 *
 * Hostile input, and the `${FZF_PREVIEW_LINES:-0}` in the preview command is the
 * other half of the same rule: a bare `$FZF_PREVIEW_LINES` that expands to
 * nothing makes commander read the NEXT FLAG NAME as the pane height.
 */
function positiveInt(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function renderPreviewCard(
  id: string,
  options: PreviewCardOptions,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<string> {
  // Naming a session explicitly means you want it, whatever kind it is — the
  // same rule `gm show` follows, because this is the same card.
  const records = await loadRecords({ includeSidechains: true, includeAutomated: true });
  const record = resolveSession(records, id);
  const summary = await readSummary(record);

  // ENOENT is a STATE, not an error, and so is a malformed file:
  // `readAskTranscript` returns zero events either way and the card takes the
  // whole pane. That is how the empty state costs no flag and no branch.
  const transcript = options.chat ? await readAskTranscript(options.chat) : null;

  // Read from our own environment rather than passed as a flag: fzf exports it to
  // the preview process, and unlike the height nothing else needs it.
  const width = positiveInt(env["FZF_PREVIEW_COLUMNS"]) ?? ASSUMED_PANE_COLUMNS;
  const split = splitPreview(positiveInt(options.paneLines) ?? 0, hasChatContent(transcript));

  return formatPreview({ record, summary }, transcript, split, width, now);
}

export function registerPreviewCard(program: Command): void {
  program
    .command(`${PREVIEW_CARD_COMMAND} <id>`, { hidden: true })
    .description("internal: render the picker's preview pane (run by fzf on every cursor move)")
    .option("--chat <path>", "the picker's chat transcript, rendered under the card")
    .option("--pane-lines <n>", "the preview pane's height, which we cannot measure")
    .action(async (id: string, options: PreviewCardOptions) => {
      process.stdout.write(`${await renderPreviewCard(id, options)}\n`);
    });
}
