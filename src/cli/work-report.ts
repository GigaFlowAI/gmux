/**
 * The work report: the wide-angle bottom of gm's attention funnel. A pure
 * assembly of per-session cards into one self-contained HTML page — no external
 * references of any kind. Each model-generated fragment is UNTRUSTED and is
 * embedded via a sandboxed <iframe srcdoc>, which is the trust boundary: bad
 * markup can only affect its own card, never the shell or a sibling.
 */

export interface WorkReportCard {
  /** Pane/project label — trusted chrome, escaped. */
  label: string;
  /** Session summary headline, if one exists — trusted chrome, escaped. */
  headline: string | null;
  /** The model fragment. null → render `note` instead. */
  html: string | null;
  /** Shown when there is no fragment (no provider, or generation failed). */
  note: string | null;
}

/**
 * Escape text into our own HTML — element content OR a double-quoted attribute,
 * including a `srcdoc`. Escaping `<`/`>` here is correct, not corrupting: the
 * browser attribute-unescapes `srcdoc` (`&lt;`→`<`) BEFORE parsing its value as
 * a document, so `&lt;svg&gt;` and a literal `<svg>` render identically — and
 * full escaping keeps the attribute well-formed. The sandbox contains the
 * fragment's behavior; this escaping keeps our page well-formed around it.
 */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }
  header { padding: 12px 20px; border-bottom: 1px solid GrayText; font-weight: 600; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; padding: 20px; }
  section.card { border: 1px solid GrayText; border-radius: 8px; overflow: hidden; }
  section.card > h2 { margin: 0; padding: 10px 14px; font-size: 14px; border-bottom: 1px solid GrayText; }
  section.card > .headline { margin: 0; padding: 6px 14px; opacity: 0.75; font-size: 13px; }
  iframe { width: 100%; min-height: 240px; border: 0; background: Canvas; }
  p.note { margin: 0; padding: 16px; opacity: 0.7; }
`;

function card(c: WorkReportCard): string {
  const head =
    `<h2>${esc(c.label)}</h2>` +
    (c.headline ? `<p class="headline">${esc(c.headline)}</p>` : "");
  const body = c.html
    ? `<iframe sandbox srcdoc="${esc(c.html)}"></iframe>`
    : `<p class="note">${esc(c.note ?? "no work view")}</p>`;
  return `<section class="card">${head}${body}</section>`;
}

export function renderWorkReportHtml(cards: readonly WorkReportCard[], now: number): string {
  const when = new Date(now).toISOString();
  const title = `gm work report · ${cards.length} session${cards.length === 1 ? "" : "s"} · ${when}`;
  const main = cards.length === 0
    ? `<main><p class="note">No sessions to report.</p></main>`
    : `<main>${cards.map(card).join("")}</main>`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>gm work report</title><style>${STYLE}</style></head>` +
    `<body><header>${esc(title)}</header>${main}</body></html>`
  );
}
