// Shared setup for the live tests: the engine config the extension builds for
// a real Ollama, through the bundled provider (src/opencode/ollamaProvider.ts).
import * as path from 'node:path';
import { toEngineProviderID } from '../src/core/providerIds';
import { OllamaClient } from '../src/ollama/client';
import { OLLAMA_PROVIDER_ID, ollamaProviderConfig, providerModuleUrl } from '../src/opencode/ollamaProvider';

export const REPO = path.resolve(__dirname, '..');
export const OLLAMA = process.env.LIVE_OLLAMA ?? 'http://127.0.0.1:11434';
/**
 * One small model for every live check — Ollama is shared hardware, and a
 * single resident model keeps the runs from evicting each other. qwen3-vl:4b-instruct
 * covers tools and vision, without thinking.
 */
export const MODEL = process.env.LIVE_MODEL ?? 'qwen3-vl:4b-instruct';
/** The model for the agent-style checks (override with LIVE_AGENT_MODEL). */
export const AGENT_MODEL = process.env.LIVE_AGENT_MODEL ?? MODEL;
export const PROVIDER = OLLAMA_PROVIDER_ID;
export const ENGINE_PROVIDER = toEngineProviderID(OLLAMA_PROVIDER_ID);

/**
 * `{ enabled_providers, provider }` for the given installed models, exactly as
 * the extension declares them. Throws when the provider bundle is missing.
 */
export async function ollamaConfig(
  modelIds: string[],
  opts: { ctx?: number; baseUrl?: string; ctxOverride?: (id: string) => number | undefined } = {},
): Promise<Record<string, unknown>> {
  const npm = providerModuleUrl(REPO);
  if (!npm) {
    throw new Error('opencode-provider/ollama.mjs is missing: run npm run bundle:provider');
  }
  const all = await new OllamaClient(OLLAMA).listModels();
  const models = all.filter((m) => modelIds.includes(m.id));
  const missing = modelIds.filter((id) => !models.some((m) => m.id === id));
  if (missing.length) {
    throw new Error(`not installed in Ollama: ${missing.join(', ')}`);
  }
  return {
    enabled_providers: [ENGINE_PROVIDER],
    provider: ollamaProviderConfig({
      baseUrl: opts.baseUrl ?? OLLAMA,
      npm,
      models,
      defaultCtx: opts.ctx ?? 32768,
      ctxOverride: opts.ctxOverride,
    }),
  };
}
