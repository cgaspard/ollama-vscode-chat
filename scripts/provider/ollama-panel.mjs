// The Ollama provider as the embedded OpenCode 2 engine loads it.
//
// scripts/bundle-provider.js bundles this file, the patched provider it wraps
// (vendor/ollama-ai-provider-cgaspard) and that provider's dependencies into
// one ES module, opencode-provider/ollama.mjs. The engine imports it from a
// file:// URL (serverManager.ts) and calls the first `create*` export with the
// provider's settings.
//
// Why a wrapper at all: OpenCode 2 hands the provider its per-model options
// under the engine's provider id, and the provider only reads the `ollama`
// key. src/core/providerOptions.ts explains, and does the remap.
import { createOllama } from 'ollama-ai-provider-cgaspard';
import { remapProviderOptions } from '../../src/core/providerOptions';

function wrapModel(model, name) {
  return new Proxy(model, {
    get(target, prop) {
      if (prop === 'doStream' || prop === 'doGenerate') {
        return (options) => target[prop](remapProviderOptions(options, name));
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Provider factory the engine calls with `{ name, baseURL, headers, fetch, ... }`. */
export function createOllamaPanel(options = {}) {
  const { name, baseURL, headers, fetch } = options;
  const inner = createOllama({ baseURL, headers, fetch });
  const provider = (modelId) => wrapModel(inner(modelId), name);
  provider.specificationVersion = inner.specificationVersion;
  provider.languageModel = (modelId) => wrapModel(inner.languageModel(modelId), name);
  provider.chat = provider.languageModel;
  provider.embeddingModel = inner.embeddingModel;
  provider.textEmbeddingModel = inner.textEmbeddingModel;
  provider.imageModel = inner.imageModel;
  return provider;
}
