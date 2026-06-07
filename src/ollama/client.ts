import { ollamaRestRoot } from '../config';
import { logError } from '../logger';

export interface OllamaModel {
  id: string; // model name:tag, e.g. "llama3.2:1b"
  displayName: string;
  type: string; // llm | vlm
  state?: string; // loaded | not-loaded
  maxContextLength?: number;
  loadedContextLength?: number;
  toolUse?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  quantization?: string;
  family?: string;
}

const TIMEOUT = (ms: number) => AbortSignal.timeout(ms);

/** Discovery + lifecycle helper for an Ollama server. */
export class OllamaClient {
  constructor(private baseUrl: string) {}

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }
  getBaseUrl(): string {
    return this.baseUrl;
  }
  private get rest(): string {
    return ollamaRestRoot(this.baseUrl);
  }

  async checkConnection(): Promise<boolean> {
    try {
      const res = await fetch(`${this.rest}/api/version`, { signal: TIMEOUT(4000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** List chat-capable models (embeddings filtered out) with capabilities. */
  async listModels(): Promise<OllamaModel[]> {
    let tagModels: any[] = [];
    try {
      const res = await fetch(`${this.rest}/api/tags`, { signal: TIMEOUT(8000) });
      if (!res.ok) {
        return [];
      }
      tagModels = ((await res.json()) as { models?: any[] }).models ?? [];
    } catch (err) {
      logError('listModels /api/tags failed', err);
      return [];
    }

    // Loaded models + their loaded context length.
    const loaded = new Map<string, number>();
    try {
      const res = await fetch(`${this.rest}/api/ps`, { signal: TIMEOUT(5000) });
      if (res.ok) {
        for (const m of ((await res.json()) as { models?: any[] }).models ?? []) {
          loaded.set(m.name ?? m.model, m.context_length ?? 0);
        }
      }
    } catch {
      // /api/ps optional
    }

    // Per-model capabilities + max context via /api/show (parallel).
    const detailed = await Promise.all(
      tagModels.map(async (m) => {
        const info = await this.showModel(m.name).catch(() => null);
        const caps: string[] = (info?.capabilities as string[]) ?? [];
        return { m, caps, maxCtx: maxContextFromInfo(info?.model_info) };
      }),
    );

    return detailed
      .filter(({ caps, m }) => !caps.includes('embedding') && !/embed/i.test(m.name ?? ''))
      .map(({ m, caps, maxCtx }): OllamaModel => ({
        id: m.name,
        displayName: prettyName(m.name),
        type: caps.includes('vision') ? 'vlm' : 'llm',
        state: loaded.has(m.name) ? 'loaded' : 'not-loaded',
        loadedContextLength: loaded.get(m.name),
        maxContextLength: maxCtx,
        toolUse: caps.includes('tools'),
        vision: caps.includes('vision'),
        reasoning: caps.includes('thinking'),
        quantization: m.details?.quantization_level,
        family: m.details?.family,
      }));
  }

  async showModel(modelId: string): Promise<any> {
    const res = await fetch(`${this.rest}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelId }),
      signal: TIMEOUT(8000),
    });
    if (!res.ok) {
      throw new Error(`/api/show ${res.status}`);
    }
    return res.json();
  }

  async getModel(modelId: string): Promise<OllamaModel | undefined> {
    return (await this.listModels()).find((m) => m.id === modelId);
  }

  /**
   * Ensure `modelId` is loaded with at least `minContext` tokens of context.
   * Ollama loads a model instance with the `num_ctx` from the request, so we
   * (re)load via /api/generate when the loaded context is too small. Never throws.
   */
  async ensureContext(
    modelId: string,
    minContext: number,
    keepAlive: string,
    onProgress?: (msg: string) => void,
  ): Promise<{ reloaded: boolean; context?: number; note?: string }> {
    try {
      const model = await this.getModel(modelId);
      if (!model) {
        return { reloaded: false, note: 'model not found in Ollama' };
      }
      const target = Math.min(minContext, model.maxContextLength ?? minContext);
      const ctx = model.loadedContextLength ?? 0;
      if (model.state === 'loaded' && ctx >= target) {
        return { reloaded: false, context: ctx };
      }
      onProgress?.(`Loading ${model.displayName} with ${target.toLocaleString()} context…`);
      const loaded = await this.loadModel(modelId, target, keepAlive);
      return { reloaded: true, context: loaded.contextLength ?? target };
    } catch (err) {
      logError('ensureContext failed', err);
      return { reloaded: false, note: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Load (or warm) a model with a context window via /api/generate. */
  async loadModel(
    modelId: string,
    contextLength: number,
    keepAlive = '30m',
  ): Promise<{ contextLength?: number }> {
    const res = await fetch(`${this.rest}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        keep_alive: coerceKeepAlive(keepAlive),
        options: { num_ctx: contextLength },
      }),
      signal: TIMEOUT(600000),
    });
    if (!res.ok) {
      throw new Error(`/api/generate(load) ${res.status}: ${await res.text().catch(() => '')}`);
    }
    await res.json().catch(() => undefined);
    return { contextLength };
  }

  /** Unload a model from memory (keep_alive: 0). */
  async unloadModel(modelId: string): Promise<void> {
    await fetch(`${this.rest}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelId, keep_alive: 0 }),
      signal: TIMEOUT(30000),
    }).catch(() => undefined);
  }

  /** Compat with the bridge: an Ollama "instance" is just the model name. */
  async unloadInstance(modelId: string): Promise<void> {
    return this.unloadModel(modelId);
  }

  async loadedInstanceIds(modelId: string): Promise<string[]> {
    try {
      const res = await fetch(`${this.rest}/api/ps`, { signal: TIMEOUT(5000) });
      if (!res.ok) {
        return [];
      }
      const arr = ((await res.json()) as { models?: any[] }).models ?? [];
      return arr.some((m) => m.name === modelId || m.model === modelId) ? [modelId] : [];
    } catch {
      return [];
    }
  }
}

function prettyName(id: string): string {
  return id.replace(/:latest$/, '');
}

/**
 * Ollama's keep_alive accepts a duration string ("5m", "1h") OR a number of
 * seconds, where -1 means "forever" and 0 means "unload now". Its duration
 * parser rejects bare integers like "-1"/"0" as strings, so coerce integer-like
 * values to numbers; pass real durations through unchanged.
 */
function coerceKeepAlive(v: string | number): string | number {
  if (typeof v === 'number') {
    return v;
  }
  const s = v.trim();
  return /^-?\d+$/.test(s) ? Number(s) : s;
}

/** model_info has a key like "llama.context_length" / "qwen3.context_length". */
function maxContextFromInfo(modelInfo: Record<string, unknown> | undefined): number | undefined {
  if (!modelInfo) {
    return undefined;
  }
  const key = Object.keys(modelInfo).find((k) => /\.context_length$/.test(k));
  const val = key ? modelInfo[key] : undefined;
  return typeof val === 'number' ? val : undefined;
}
