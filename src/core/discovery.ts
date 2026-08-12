/**
 * Model-discovery decisions for the Ollama listing path. Pure so it is
 * unit-testable and browser-safe.
 *
 * Since Ollama 0.30.0, `/api/tags` carries `capabilities` and
 * `details.context_length` inline — everything the picker needs for badges and
 * context math except reasoning granularity. Older servers report neither, and
 * there is no version negotiation on the wire, so the presence of the
 * `capabilities` array on a tags row IS the feature detection: rows that have
 * it can skip the per-model `/api/show` fan-out entirely, rows that lack it
 * get the pre-0.30 behavior (show for every model). This keeps the periodic
 * health tick at two requests on modern servers instead of 2+N.
 */

/** The subset of an `/api/tags` row that discovery decisions read. */
export interface TagRow {
  name?: string;
  digest?: string;
  capabilities?: unknown;
  details?: { context_length?: unknown };
}

/** What a cached (or fresh) `/api/show` answer contributes per model. */
export interface ShowDetail {
  caps: string[];
  granular: boolean;
  maxCtx?: number;
}

/** Whether this tags row carries inline capabilities (Ollama ≥ 0.30). */
export function tagsCarryCapabilities(m: TagRow | undefined): boolean {
  return Array.isArray(m?.capabilities);
}

/** `details.context_length` from a tags row, if the server provides it (≥ 0.30). */
export function contextFromTags(m: TagRow | undefined): number | undefined {
  const ctx = m?.details?.context_length;
  return typeof ctx === 'number' && ctx > 0 ? ctx : undefined;
}

/**
 * Whether a model still needs an `/api/show` call this listing.
 *
 * - legacy row (no inline capabilities): always — show is the only source of
 *   capabilities, context and granularity on pre-0.30 servers.
 * - modern row: only for thinking-capable models (granularity is not in tags)
 *   or when tags omitted the context length; and only until a cached answer
 *   exists for this name@digest.
 */
export function needsShow(args: {
  modern: boolean;
  thinking: boolean;
  hasContext: boolean;
  cached: boolean;
}): boolean {
  if (args.cached) {
    return false;
  }
  if (!args.modern) {
    return true;
  }
  return args.thinking || !args.hasContext;
}

/**
 * Whether a model accepts GRADED thinking effort (low/medium/high) rather than
 * just on/off, from its `/api/show` payload.
 *
 * Primary oracle (verified on the wire): the prompt template referencing
 * `.ThinkLevel`, which Ollama only renders for level-graded models. gpt-oss
 * uses it; qwen3 / deepseek-r1 do not.
 *
 * New-generation models ship a built-in `renderer`/`parser` instead of a Go
 * template (the `template` field comes back empty), so the template oracle
 * cannot see them. The gpt-oss family — the one graded family in the wild —
 * is identified there by its renderer/parser name ("gptoss"/"harmony"
 * spellings observed across releases).
 */
export function granularFromShow(
  info:
    | { template?: unknown; renderer?: unknown; parser?: unknown }
    | null
    | undefined,
): boolean {
  if (!info) {
    return false;
  }
  const template = typeof info.template === 'string' ? info.template : '';
  if (template.includes('.ThinkLevel')) {
    return true;
  }
  const rp = `${typeof info.renderer === 'string' ? info.renderer : ''} ${
    typeof info.parser === 'string' ? info.parser : ''
  }`.toLowerCase();
  return /gpt[-_]?oss|harmony/.test(rp);
}

/** Cache key for one model's show answer: content-addressed by digest, so a
 * re-pulled model (new digest) refreshes itself and nothing else ever expires. */
export function showCacheKey(m: TagRow): string {
  return `${m.name ?? ''}@${m.digest ?? ''}`;
}
