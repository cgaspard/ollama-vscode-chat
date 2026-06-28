/**
 * Model-selection logic, extracted so reconnect/init paths pick a sensible
 * model deterministically and it can be unit-tested without vscode.
 */

export interface SelectableModel {
  id: string;
  loaded?: boolean;
}

/**
 * Pick the model to use: the first preference that exists, else a currently
 * loaded model, else the first available. Returns undefined when there are no
 * models. Empty / null preferences are skipped so callers can pass
 * `[defaultModel, stored, current]` without pre-filtering.
 */
export function pickModel<T extends SelectableModel>(
  preferences: Array<string | null | undefined>,
  models: T[],
): string | undefined {
  for (const pref of preferences) {
    if (pref && models.some((m) => m.id === pref)) {
      return pref;
    }
  }
  const loaded = models.find((m) => m.loaded);
  return loaded?.id ?? models[0]?.id;
}

export interface NamedModel {
  id: string;
  name: string;
  publisher?: string;
}

/**
 * When several models share a display `name`, return a short tag that tells a
 * given model apart from its namesakes; null when the name is already unique.
 *
 * Prefers the publisher (for Ollama: the model family, e.g. "llama" vs "qwen3").
 * If the namesakes also share a publisher (e.g. a bare id and a namespaced id of
 * the same model), falls back to the full id, which is always unique.
 */
export function modelDisambiguator(model: NamedModel, all: NamedModel[]): string | null {
  const sameName = all.filter((m) => m.name === model.name);
  if (sameName.length <= 1) {
    return null;
  }
  const samePublisher = sameName.filter(
    (m) => (m.publisher ?? '') === (model.publisher ?? ''),
  ).length;
  return samePublisher > 1 ? model.id : (model.publisher ?? model.id);
}

/**
 * Format a model's local create/pull date for the picker as a short absolute
 * date: "May 12" within the current year, "May 2026" for older years. Returns
 * '' for missing/invalid input. `now` is injectable so the year boundary is
 * deterministically testable.
 */
export function formatModelDate(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) {
    return '';
  }
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    return '';
  }
  const month = d.toLocaleString('en-US', { month: 'short' });
  return d.getFullYear() === now.getFullYear()
    ? `${month} ${d.getDate()}`
    : `${month} ${d.getFullYear()}`;
}

/**
 * Identity line for a model row: "publisher · format · quant · date" (present
 * fields only). `date` should already be formatted (see formatModelDate).
 */
export function modelIdentity(parts: {
  publisher?: string;
  format?: string;
  quantization?: string;
  date?: string;
}): string {
  return [parts.publisher, parts.format, parts.quantization, parts.date]
    .filter(Boolean)
    .join(' · ');
}
