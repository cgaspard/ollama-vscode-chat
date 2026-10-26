// OpenCode 2 → the bundled Ollama provider: where per-model options land.
//
// OpenCode 2 hands a provider its per-model settings and reasoning variants as
// `providerOptions[<engine provider id>]`. The patched ollama-ai-provider reads
// `providerOptions.ollama` only (its zod parse drops everything else), and the
// id `ollama` belongs to OpenCode 2's built-in Ollama plugin (see
// providerIds.ts), so the panel's provider runs under another id. The provider
// wrapper (scripts/provider/ollama-panel.mjs) runs every call through this, so
// `options.num_ctx` and `think` reach Ollama. Measured without it: the model
// loads at the server's default window and reasoning cannot be switched.
//
// Pure, and bundled into opencode-provider/ollama.mjs by
// scripts/bundle-provider.js.

/** The key the provider parses its options from. */
export const OLLAMA_OPTIONS_KEY = 'ollama';

type ProviderOptions = Record<string, Record<string, unknown>>;

/**
 * Move `providerOptions[name]` onto `providerOptions.ollama`. The nested
 * `options` object (num_ctx and friends) is merged key by key, so a model's
 * window and a variant's settings combine instead of replacing each other; an
 * explicit `ollama` entry wins on conflicts.
 */
export function remapProviderOptions<T extends { providerOptions?: ProviderOptions }>(callOptions: T, name: string | undefined): T {
  const all = callOptions?.providerOptions;
  if (!all || !name || name === OLLAMA_OPTIONS_KEY || !all[name]) {
    return callOptions;
  }
  const { [name]: mine, ...rest } = all;
  const theirs = rest[OLLAMA_OPTIONS_KEY] ?? {};
  const merged: Record<string, unknown> = { ...mine, ...theirs };
  if (mine.options || theirs.options) {
    merged.options = { ...(mine.options as object | undefined), ...(theirs.options as object | undefined) };
  }
  return { ...callOptions, providerOptions: { ...rest, [OLLAMA_OPTIONS_KEY]: merged } };
}
