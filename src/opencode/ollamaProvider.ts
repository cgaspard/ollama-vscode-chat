// The Ollama provider block of the embedded engine's config. Pure (no vscode),
// so the live tests build exactly the config the extension does.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { clampContext } from '../core/context';
import { variantsForModel } from '../core/effort';
import { toEngineProviderID } from '../core/providerIds';
import { ollamaRestRoot } from '../core/url';

/** The provider id the panel, its settings and its stored selections use. */
export const OLLAMA_PROVIDER_ID = 'ollama';

/**
 * The bundled provider module (scripts/bundle-provider.js): the patched
 * ollama-ai-provider fork plus the wrapper that hands it OpenCode 2's
 * per-model options. Relative to the extension root.
 */
export const PROVIDER_MODULE = path.join('opencode-provider', 'ollama.mjs');

/** What the config needs to know about one installed model. */
export interface ProviderModel {
  id: string;
  displayName?: string;
  maxContextLength?: number;
  toolUse?: boolean;
  vision?: boolean;
  reasoning?: boolean;
}

/**
 * The `npm` value for the provider: a file:// URL to the bundled module.
 * OpenCode 2 imports a file:// specifier directly (it ignores the 1.x package
 * cache this extension used to pre-seed), so nothing is ever fetched from npm.
 * Undefined when the module is missing (a corrupt install).
 */
export function providerModuleUrl(extensionPath: string): string | undefined {
  const file = path.join(extensionPath, PROVIDER_MODULE);
  return fs.existsSync(file) ? pathToFileURL(file).href : undefined;
}

/**
 * The context window to run one model at: the user's per-model override, else
 * the global minimum, clamped to the model's real maximum. This single number
 * is both sent to Ollama as `num_ctx` and declared as OpenCode's
 * `limit.context`, so the window the runner holds and the budget OpenCode
 * packs against cannot drift apart.
 */
export function contextFor(model: ProviderModel, defaultCtx: number, override?: number): number {
  return clampContext(override ?? defaultCtx, model.maxContextLength);
}

/**
 * `{ <engine id>: { ... } }` for the config's `provider` map.
 *
 * Uses Ollama's NATIVE /api endpoint through the bundled provider, never the
 * OpenAI-compatible /v1 one (which is what OpenCode 2's built-in `ollama`
 * plugin uses): /v1 has no field for a context window, and Ollama re-loads the
 * model at its own default on every /v1 request — measured, a model loaded at
 * 4096 came back at 40960 after one /v1 chat. The native endpoint takes
 * `num_ctx` (and `think`) per request, so the window we ask for is the window
 * we get.
 *
 * The id goes through toEngineProviderID: the built-in `ollama` plugin owns
 * that id and would replace this provider's models and options with its own
 * auto-discovered /v1 ones.
 */
export function ollamaProviderConfig(input: {
  baseUrl: string;
  npm: string;
  models: ProviderModel[];
  defaultCtx: number;
  ctxOverride?: (modelId: string) => number | undefined;
}): Record<string, unknown> {
  const models: Record<string, Record<string, unknown>> = {};
  for (const m of input.models) {
    const ctx = contextFor(m, input.defaultCtx, input.ctxOverride?.(m.id));
    models[m.id] = {
      name: m.displayName ?? m.id,
      attachment: !!m.vision,
      reasoning: !!m.reasoning,
      tool_call: m.toolUse ?? true,
      modalities: {
        input: m.vision ? ['text', 'image'] : ['text'],
        output: ['text'],
      },
      // Output budget: generous enough for reasoning models that emit long
      // <think> blocks before answering (8192 truncated them mid-thought),
      // but still a fraction of the window so input isn't crowded out.
      limit: { context: ctx, output: Math.min(32768, Math.floor(ctx / 4)) },
      // Sent to Ollama as /api/chat `options.num_ctx`. The nesting is load-
      // bearing: the provider parses its options as `{ think?, options? }`, so
      // a flat `{ num_ctx }` is silently dropped. OpenCode 2 hands these to the
      // provider under the engine id; the bundled wrapper moves them to the
      // `ollama` key the provider reads (scripts/provider/ollama-panel.mjs).
      options: { options: { num_ctx: ctx } },
      // Reasoning-effort levels, selectable per message via the variant.
      // Declared unconditionally for every model — declaring a variant a model
      // can't use is harmless (only *sending* it errors), and unconditional
      // declaration keeps effort changes from needing an engine restart. The
      // gate lives in core/effort.ts, which decides what may be sent.
      variants: variantsForModel(),
    };
  }
  return {
    [toEngineProviderID(OLLAMA_PROVIDER_ID)]: {
      npm: input.npm,
      name: 'Ollama',
      options: { baseURL: `${ollamaRestRoot(input.baseUrl)}/api` },
      ...(Object.keys(models).length ? { models } : {}),
    },
  };
}
