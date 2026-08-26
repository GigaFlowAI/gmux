/**
 * Workspace template catalog types. Pure — no I/O.
 *
 * v1 always spawns an idle `$SHELL` titled tests / logs / review. The captured
 * agent command is a match key, never argv.
 */

export const TEMPLATE_IDS = ["tests", "logs", "review"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export function isTemplateId(value: string): value is TemplateId {
  return (TEMPLATE_IDS as readonly string[]).includes(value);
}

export interface PaneTemplate {
  id: TemplateId;
  title: string;
  match: TemplateMatch;
  spawn: {
    argv: "idle-shell";
    focus: false;
  };
}

export type TemplateMatch =
  | { kind: "tool-command-start"; pattern: string }
  | { kind: "dev-server-start"; pattern: string }
  | { kind: "review-start"; pattern: string };

export interface LiveTemplate {
  templateId: string;
  workspaceId: string;
}

export interface TemplateAct {
  templateId: TemplateId;
  title: string;
  argv: string[];
  workspaceId: string;
  paneId: string;
  callId: string;
  focus: false;
}

/** 60 s per (workspaceId, templateId) after the live pane closes. */
export const TEMPLATE_COOLDOWN_MS = 60_000;

/** Seen-callId ring so a duplicate start cannot tab-storm. */
export const TEMPLATE_SEEN_RING = 256;
