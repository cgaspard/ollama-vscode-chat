/**
 * Reasoning-effort ("thinking effort") math, shared by the OpenCode server
 * config, the bridge (send path) and the webview (picker). Pure so it is
 * unit-testable and browser-safe.
 *
 * This is a sibling of the LM Studio version, NOT a copy — the transport is
 * identical but the capability model and the safety rule are not. Wire-verified
 * against Ollama 0.32.6 + OpenCode 1.18.4 + ollama-ai-provider-v2 4.0.1.
 *
 *   UI level ──▶ PromptBody.variant ──▶ provider.ollama.models.<id>.variants
 *                                                  │
 *                                                  ▼
 *                          Ollama /api/chat { "think": true | false }
 *
 * Three facts shape this module:
 *
 * 1. The variant option key is `think`, and it is a BOOLEAN. We used to send
 *    `reasoningEffort` through Ollama's OpenAI shim; the native provider takes
 *    `providerOptions.ollama`, whose schema is `{ think?: boolean, options?: {
 *    num_ctx, … } }` — anything else is silently stripped by its zod parse.
 *    Verified: `{think:true}` produced 38,745 reasoning chars from qwen3:0.6b,
 *    `{think:false}` produced 0, and `{reasoningEffort:'high'}` produced 0.
 *
 * 2. ⚠️ THERE IS NO GRADED EFFORT ON THIS TRANSPORT. Ollama itself grades via
 *    `.ThinkLevel`, but ollama-ai-provider-v2 flattens every non-'none' effort
 *    to `think: true` (it even emits the warning "Ollama only supports on/off
 *    thinking"). So gpt-oss's low/medium/high cannot be expressed here, and
 *    offering them would be a lie. Every thinking model is binary.
 *
 * 3. ⚠️ THE INVERTED RULE. On LM Studio, sending an effort a model doesn't
 *    support is a harmless no-op, so unknown capability means "offer
 *    everything". On Ollama, thinking on a model without the capability fails
 *    the turn. So here, unknown or unsupported means offer NOTHING. (`think:
 *    false` is safe — the provider always sends it — and was verified against
 *    non-thinking llama3.2:1b.)
 */

/** What the user picks. `auto` = send nothing, let the model use its default. */
export type EffortLevel = 'auto' | 'off' | 'low' | 'medium' | 'high';

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
 * Two entries, because the transport has two states. Declared unconditionally
 * for all models — declaring a variant a model cannot use is harmless, only
 * *sending* it errors — which is what lets effort changes avoid a server
 * restart. The gate lives in levelsForModel/resolveLevel.
 *
 * There is deliberately no `auto` entry — auto means "omit `variant`", which
 * leaves the model's own default thinking behavior alone.
 */
export function variantsForModel(): Record<string, { think: boolean }> {
  return {
    off: { think: false },
    high: { think: true },
  };
}

/**
 * Which levels to show for a model, derived from its declared capabilities.
 *
 * - no capability / not supported -> [] (hide the control; sending would fail)
 * - supported                     -> auto/off/on
 *
 * `granular` is still detected from the model template (see the client) but is
 * deliberately NOT offered: the provider flattens every graded effort to a
 * boolean, so a low/medium/high picker would send identical requests and lie
 * about the difference. See fact 2 in the module docblock.
 */
export function levelsForModel(reasoning: ReasoningCapability | undefined | null): EffortLevel[] {
  // Unknown is treated as unsupported — the inverse of the LM Studio rule, and
  // the single most important behavioral difference in this module.
  if (!reasoning || !reasoning.supported) {
    return [];
  }
  // Thinking-capable: it can think or not, and on this transport that is the
  // entire scale — for graded models too.
  return ['auto', 'off', 'high'];
}

/**
 * True when a model collapses every "on" level to the same thing (so the UI
 * says On, not High). On this transport that is every thinking model, graded or
 * not, because the provider only carries a boolean.
 */
export function isBinary(reasoning: ReasoningCapability | undefined | null): boolean {
  return !!reasoning && reasoning.supported;
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
