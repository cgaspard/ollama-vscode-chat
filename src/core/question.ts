/**
 * Detection for the AskUserQuestion JSON shape that a model may print as plain
 * text instead of calling the built-in `question` tool. Pure (no DOM/vscode)
 * so it is unit-testable and safe to bundle into the webview.
 *
 * The shape mirrors OpenCode's `question` tool request:
 *   { "questions": [ { "question": str, "header": str,
 *                      "options": [ { "label": str, "description": str } ],
 *                      "multiple"?: bool, "custom"?: bool } ] }
 */

export interface QOption {
  label: string;
  description?: string;
}

export interface QInfo {
  question: string;
  header?: string;
  options: QOption[];
  multiple?: boolean;
  custom?: boolean;
}

/** One question's pick state: the chosen option labels plus any typed text. */
export interface QPick {
  chosen: Iterable<string>;
  custom?: string;
}

/**
 * Build the reply payload for POST /question/{id}/reply from per-question pick
 * state. The server expects one answer array per question, in order, where each
 * is the list of chosen option labels (a typed custom answer is appended).
 * Empty/whitespace custom text is dropped. Pure so the wire shape is testable
 * without the DOM.
 */
export function buildAnswers(picks: QPick[]): string[][] {
  return picks.map((p) => {
    const a = [...p.chosen];
    const custom = (p.custom ?? '').trim();
    if (custom) {
      a.push(custom);
    }
    return a;
  });
}

/** True when no question has any answer (nothing chosen and no custom text). */
export function isEmptyAnswer(answers: string[][]): boolean {
  return answers.every((a) => a.length === 0);
}

/**
 * Parse a text blob into question infos when (and only when) it is a complete,
 * valid AskUserQuestion payload. Tolerates a leading/trailing ```json fence and
 * surrounding prose by extracting the outermost {...}. Returns null otherwise —
 * including for a partial blob mid-stream (it won't parse until complete), so
 * callers can safely re-run it on every streaming delta.
 */
export function parseQuestionBlob(text: string): QInfo[] | null {
  const t = (text ?? '').trim();
  if (!t.includes('"questions"')) {
    return null;
  }
  const body = t.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null; // not (yet) valid JSON — treat as normal text
  }
  const qs = (obj as { questions?: unknown })?.questions;
  if (!Array.isArray(qs) || qs.length === 0) {
    return null;
  }
  const ok = qs.every((q) => {
    const info = q as QInfo;
    return (
      q &&
      typeof info.question === 'string' &&
      Array.isArray(info.options) &&
      // Require at least one option, or an explicit free-text answer path —
      // otherwise the picker has nothing to click and only "Skip" works.
      (info.options.length > 0 || info.custom !== false) &&
      info.options.every((o) => o && typeof o.label === 'string')
    );
  });
  return ok ? (qs as QInfo[]) : null;
}
