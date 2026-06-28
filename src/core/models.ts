/**
 * Model-selection logic, extracted so reconnect/init paths pick a sensible
 * model deterministically and it can be unit-tested without vscode.
 */

export interface SelectableModel {
  id: string;
  loaded?: boolean;
}

/**
 * Pick the model to use, in priority order:
 *   1. an explicit configured default (`defaultModel`), if it exists — honor
 *      the user's deliberate choice above all;
 *   2. a currently-LOADED/resident model — if something is already loaded, open
 *      straight into it (ready to chat) rather than a stale last-used pick that
 *      isn't loaded;
 *   3. the next existing preference (stored / last-used / current);
 *   4. the first available model.
 * Returns undefined when there are no models. Empty/null preferences are
 * skipped, so callers can pass `[defaultModel, stored, current]` unfiltered;
 * `preferences[0]` is treated as the explicit default.
 */
export function pickModel<T extends SelectableModel>(
  preferences: Array<string | null | undefined>,
  models: T[],
): string | undefined {
  const exists = (id: string | null | undefined): boolean => !!id && models.some((m) => m.id === id);

  // 1. explicit configured default
  const explicitDefault = preferences[0];
  if (exists(explicitDefault)) {
    return explicitDefault as string;
  }
  // 2. a currently-loaded model beats a non-loaded stored/last-used pick
  const loaded = models.find((m) => m.loaded);
  if (loaded) {
    return loaded.id;
  }
  // 3. the next existing preference (stored / current)
  for (const pref of preferences.slice(1)) {
    if (exists(pref)) {
      return pref as string;
    }
  }
  // 4. first available
  return models[0]?.id;
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

// ---------------------------------------------------------------------------
// Load-state logic (pure) — shared by the webview and unit tests.
//
// Ollama load-state comes from /api/ps, which can fail/time out while the
// server is busy loading a big model. A failed ps must read as "unknown"
// (loaded === undefined), NOT "unloaded" (false) — otherwise a transient miss
// flips a resident model to not-loaded and breaks the Send gate.
// ---------------------------------------------------------------------------

export interface LoadStateModel {
  id: string;
  /** true = resident, false = definitely not loaded, undefined = unknown. */
  loaded?: boolean;
}

/**
 * Merge an incoming model list with the previous one, preserving the previously
 * known `loaded` value whenever the incoming value is undefined ("unknown").
 * A definite true/false in the incoming list always wins.
 */
export function mergeModelLoadedState<T extends LoadStateModel>(prev: T[], incoming: T[]): T[] {
  const before = new Map(prev.map((m) => [m.id, m.loaded]));
  return incoming.map((m) =>
    m.loaded === undefined ? { ...m, loaded: before.get(m.id) } : m,
  );
}

/**
 * Is the selected model ready to receive a prompt? Only when it exists, is
 * definitely loaded (true — not unknown), and isn't mid-load. `loadingIds` are
 * models with a load in flight.
 */
export function isModelReady(
  currentModel: string | null,
  models: LoadStateModel[],
  loadingIds: ReadonlySet<string>,
): boolean {
  if (!currentModel) {
    return false;
  }
  const m = models.find((x) => x.id === currentModel);
  return !!m && m.loaded === true && !loadingIds.has(currentModel);
}

/**
 * Elapsed-time label for an in-flight load: "" under 1s, "18s" under a minute,
 * "2:47" beyond — so a multi-minute load reads naturally.
 */
export function formatLoadElapsed(seconds: number): string {
  const s = Math.floor(seconds);
  if (!(s > 0)) {
    return '';
  }
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
