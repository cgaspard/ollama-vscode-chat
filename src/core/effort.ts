/**
 * Reasoning-effort ("thinking effort") math, shared by the OpenCode server
 * config, the bridge (send path) and the webview (picker). Pure so it is
 * unit-testable and browser-safe.
 *
 * This is a sibling of the LM Studio version, NOT a copy — the transport is
 * identical but the capability model and the safety rule are not. All of the
 * below was wire-verified against Ollama 0.32.4 + OpenCode 1.17.18.
 *
 *   UI level ──▶ PromptBody.variant ──▶ provider.ollama.models.<id>.variants
 *                                                  │
 *                                                  ▼
 *                         Ollama /v1/chat/completions { "reasoning_effort": … }
 *                         (its OpenAI shim maps that to the native `think`)
 *
 * Three facts shape this module:
 *
 * 1. The variant option key MUST be camelCase `reasoningEffort`. That is the AI
 *    SDK provider-option name, which the openai-compatible provider renames to
 *    the wire field `reasoning_effort`. Declaring snake_case is *silently
 *    dropped* — the request goes out with no effort field and the feature looks
 *    like it works while doing nothing. This is a property of the AI SDK, not of
 *    any one model server, so it bites here exactly as it does on LM Studio.
 *
 * 2. ⚠️ THE INVERTED RULE. On LM Studio, sending an effort a model doesn't
 *    support is a harmless no-op, so unknown capability means "offer
 *    everything". On Ollama it is a HARD 400 that fails the whole turn:
 *
 *      reasoning_effort:"high" → llama3.2:1b → 400 "does not support thinking"
 *      reasoning_effort:"none" → llama3.2:1b → 200
 *
 *    So here, unknown or unsupported means offer NOTHING, and only `none` is
 *    universally safe. Never send speculatively.
 *
 * 3. Ollama exposes no per-model granularity list (no `allowed_options`). But it
 *    passes `.ThinkLevel` into model templates, so a model accepts graded effort
 *    iff its /api/show template references `.ThinkLevel` — true for gpt-oss,
 *    false for qwen3 and deepseek-r1. Corroborated empirically: qwen3:0.6b
 *    produced byte-identical output across low/medium/high/max at temp 0, so
 *    binary is the *correct* UI for it, not a limitation.
 */

/** What the user picks. `auto` = send nothing, let the model use its default. */
export type EffortLevel = 'auto' | 'off' | 'low' | 'medium' | 'high';

/**
 * Ollama's accepted `reasoning_effort` values (from its own 400 body:
 * `must be "high","medium","low","max","none"`). Note this differs from LM
 * Studio's set — no `minimal`, no `xhigh`, but it has `max`.
 */
export type ApiEffort = 'none' | 'low' | 'medium' | 'high' | 'max';

/**
 * Reasoning support for one model, derived in src/ollama/client.ts:
 * `supported` ← /api/show capabilities includes 'thinking';
 * `granular`  ← the model template references `.ThinkLevel`.
 * `undefined` means we never got /api/show for it — treated as UNSUPPORTED
 * here, because a speculative send is a hard error on Ollama.
 */
export interface ReasoningCapability {
  supported: boolean;
  granular: boolean;
}

/** Every level we know how to express, in ascending order of effort. */
export const ALL_LEVELS: EffortLevel[] = ['auto', 'off', 'low', 'medium', 'high'];

/**
 * The variant table we declare for every model in the OpenCode config.
 *
 * Declared unconditionally for all models — declaring a variant a model cannot
 * use is harmless, only *sending* it errors — which is what lets effort changes
 * avoid a server restart. The gate lives in levelsForModel/resolveLevel, which
 * decide what may be sent.
 *
 * There is deliberately no `auto` entry — auto means "omit `variant`".
 */
export function variantsForModel(): Record<string, { reasoningEffort: ApiEffort }> {
  return {
    off: { reasoningEffort: 'none' },
    low: { reasoningEffort: 'low' },
    medium: { reasoningEffort: 'medium' },
    high: { reasoningEffort: 'high' },
  };
}

/**
 * Which levels to show for a model, derived from its declared capabilities.
 *
 * - no capability / not supported -> [] (hide the control; sending would 400)
 * - supported + granular          -> auto/off/low/medium/high
 * - supported, not granular       -> auto/off/on
 */
export function levelsForModel(reasoning: ReasoningCapability | undefined | null): EffortLevel[] {
  // Unknown is treated as unsupported — the inverse of the LM Studio rule, and
  // the single most important behavioral difference in this module.
  if (!reasoning || !reasoning.supported) {
    return [];
  }
  if (reasoning.granular) {
    return [...ALL_LEVELS];
  }
  // Thinking-capable but ungraded: it can think or not, and that is the scale.
  return ['auto', 'off', 'high'];
}

/** True when a model collapses every "on" level to the same thing (so the UI says On, not High). */
export function isBinary(reasoning: ReasoningCapability | undefined | null): boolean {
  return !!reasoning && reasoning.supported && !reasoning.granular;
}

/** Label for a level, given the model's shape. Binary models say On rather than High. */
export function levelLabel(level: EffortLevel, reasoning?: ReasoningCapability | null): string {
  if (level === 'high' && isBinary(reasoning)) {
    return 'On';
  }
  switch (level) {
    case 'auto':
      return 'Auto';
    case 'off':
      return 'Off';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Med';
    case 'high':
      return 'High';
  }
}

/**
 * The `variant` to put on the prompt body, or `undefined` to omit the field.
 * `auto` omits; everything else names one of the variants we declared.
 */
export function variantForLevel(level: EffortLevel): string | undefined {
  return level === 'auto' ? undefined : level;
}

/**
 * Clamp a stored/requested level to what the model actually offers, so a level
 * carried over from a previous model can never be sent to one that lacks it.
 *
 * On Ollama this is a correctness guard, not a nicety: anything but `auto`/`off`
 * reaching a non-thinking model is a 400 that fails the turn.
 */
export function resolveLevel(
  requested: EffortLevel | undefined,
  reasoning: ReasoningCapability | undefined | null,
): EffortLevel {
  const available = levelsForModel(reasoning);
  if (available.length === 0) {
    return 'auto'; // non-thinking model: omit the field entirely
  }
  if (requested && available.includes(requested)) {
    return requested;
  }
  if (!requested) {
    return 'auto';
  }
  // Degrade downward to the highest supported level ≤ requested, never upward.
  const order: EffortLevel[] = ['off', 'low', 'medium', 'high'];
  const want = order.indexOf(requested);
  if (want >= 0) {
    for (let i = want; i >= 0; i--) {
      if (available.includes(order[i])) {
        return order[i];
      }
    }
  }
  return 'auto';
}

/**
 * Prompt-text fallback for models that cannot take the parameter.
 *
 * On Ollama this is the PRIMARY path rather than a rare fallback: most models
 * have no `thinking` capability at all, so text is the only lever. Returns ''
 * whenever the parameter path is available, so we never do both.
 */
export function fallbackPromptText(
  level: EffortLevel,
  reasoning: ReasoningCapability | undefined | null,
): string {
  if (reasoning?.supported) {
    return ''; // the variant does the work; do not also nudge with text
  }
  if (level === 'off') {
    return 'Answer directly and concisely. Do not produce private chain-of-thought or <think> reasoning blocks.';
  }
  if (level === 'high') {
    return 'Think carefully and thoroughly before answering. Work through the problem step by step.';
  }
  return '';
}
