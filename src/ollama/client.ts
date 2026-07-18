import { ollamaRestRoot } from '../config';
import { ProbeStatus } from '../core/health';
import { logError } from '../logger';

/**
 * Whether a fetch failure came from our own AbortSignal.timeout rather than a
 * connection-level error. Undici surfaces the signal's DOMException directly
 * (TimeoutError) or wrapped as the `cause` of a "fetch failed" TypeError.
 */
function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const e = err as { name?: string; cause?: { name?: string } };
  return (
    e.name === 'TimeoutError' ||
    e.name === 'AbortError' ||
    e.cause?.name === 'TimeoutError' ||
    e.cause?.name === 'AbortError'
  );
}

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
  quantization?: string; // e.g. "Q4_K_M", "Q8_0" (details.quantization_level)
  family?: string; // model family, e.g. "llama", "qwen3" (details.family)
  publisher?: string; // disambiguator slot — for Ollama this is the family
  format?: string; // runtime format badge, e.g. "GGUF" (from details.format)
  created?: string; // when the model was pulled/created locally (/api/tags modified_at, ISO-8601)
}

const TIMEOUT = (ms: number) => AbortSignal.timeout(ms);

/** Discovery + lifecycle helper for an Ollama server. */
export class OllamaClient {
  /** Cached probe result so sibling panels' health ticks share one request. */
  private probe: { startedAt: number; promise: Promise<ProbeStatus> } | undefined;
  /** In-flight model listing, shared by concurrent callers. */
  private listing: Promise<OllamaModel[]> | undefined;

  constructor(private baseUrl: string) {}

  setBaseUrl(url: string): void {
    if (url !== this.baseUrl) {
      // A different server: forget everything we learned about the old one.
      this.probe = undefined;
      this.listing = undefined;
    }
    this.baseUrl = url;
  }
  getBaseUrl(): string {
    return this.baseUrl;
  }
  private get rest(): string {
    return ollamaRestRoot(this.baseUrl);
  }

  /**
   * Probe the server via the tiny `/api/version` endpoint. 'timeout' means it
   * didn't answer in time — a saturated server mid-generation or mid-load can
   * look like this, so callers must not treat it as proof the server is gone.
   * Deliberately does not log.
   */
  async checkConnectionStatus(): Promise<ProbeStatus> {
    try {
      const res = await fetch(`${this.rest}/api/version`, { signal: TIMEOUT(4000) });
      return res.ok ? 'ok' : 'unreachable';
    } catch (err) {
      return isTimeoutError(err) ? 'timeout' : 'unreachable';
    }
  }

  async checkConnection(): Promise<boolean> {
    return (await this.checkConnectionStatus()) === 'ok';
  }

  /**
   * Cheap probe for the periodic health loop. `maxAgeMs` shares one probe
   * across near-simultaneous callers (every open panel runs its own health
   * tick against this shared client): a result younger than maxAgeMs —
   * including one still in flight — is reused instead of issuing another
   * request. Pass 0 (default) to force a fresh probe.
   */
  async probeHealth(maxAgeMs = 0): Promise<ProbeStatus> {
    const now = Date.now();
    if (this.probe && now - this.probe.startedAt <= maxAgeMs) {
      return this.probe.promise;
    }
    this.probe = { startedAt: now, promise: this.checkConnectionStatus() };
    return this.probe.promise;
  }

  /**
   * The currently-loaded context of one model via a single cheap /api/ps call
   * — no /api/tags, no per-model /api/show fan-out. undefined when the model
   * isn't resident (or ps didn't answer). Used by the keep-warm poll, which
   * must never guess: refreshing keep_alive at a wrong context forces a
   * reload.
   */
  async loadedContextFor(modelId: string): Promise<number | undefined> {
    try {
      const res = await fetch(`${this.rest}/api/ps`, { signal: TIMEOUT(5000) });
      if (!res.ok) {
        return undefined;
      }
      const arr = ((await res.json()) as { models?: any[] }).models ?? [];
      const m = arr.find((x) => x.name === modelId || x.model === modelId);
      const ctx = m?.context_length;
      return typeof ctx === 'number' && ctx > 0 ? ctx : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * List chat-capable models (embeddings filtered out) with capabilities.
   * Concurrent callers (health refresh + a user send + a sibling panel) share
   * one in-flight request instead of each triggering the /api/tags + /api/ps
   * + per-model /api/show fan-out.
   */
  async listModels(): Promise<OllamaModel[]> {
    if (this.listing) {
      return this.listing;
    }
    const p = this.doListModels().finally(() => {
      if (this.listing === p) {
        this.listing = undefined;
      }
    });
    this.listing = p;
    return p;
  }

  private async doListModels(): Promise<OllamaModel[]> {
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

    // Loaded models + their loaded context length. Track whether /api/ps
    // actually answered: if it fails/times out (which can happen while a big
    // model is loading and the server is busy), we must NOT conclude that every
    // model is unloaded — that false negative flips the UI's loaded-state and
    // breaks the Send gate. On failure `psOk` stays false → state is reported as
    // undefined ("unknown") so the UI preserves its prior belief.
    const loaded = new Map<string, number>();
    let psOk = false;
    try {
      const res = await fetch(`${this.rest}/api/ps`, { signal: TIMEOUT(5000) });
      if (res.ok) {
        psOk = true;
        for (const m of ((await res.json()) as { models?: any[] }).models ?? []) {
          loaded.set(m.name ?? m.model, m.context_length ?? 0);
        }
      }
    } catch {
      // /api/ps unavailable — leave psOk false (loaded-state unknown this round).
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
      .filter(
        ({ caps, m }) =>
          m && typeof m.name === 'string' && !caps.includes('embedding') && !/embed/i.test(m.name),
      )
      .map(({ m, caps, maxCtx }): OllamaModel => ({
        id: m.name,
        displayName: prettyName(m.name),
        type: caps.includes('vision') ? 'vlm' : 'llm',
        // undefined = unknown (ps didn't answer this round); only assert
        // 'not-loaded' when ps actually succeeded and omitted the model.
        state: psOk ? (loaded.has(m.name) ? 'loaded' : 'not-loaded') : undefined,
        loadedContextLength: loaded.get(m.name),
        maxContextLength: maxCtx,
        toolUse: caps.includes('tools'),
        vision: caps.includes('vision'),
        reasoning: caps.includes('thinking'),
        quantization: m.details?.quantization_level,
        family: m.details?.family,
        // Ollama has no "publisher"; the family is the best same-name
        // disambiguator (e.g. a "coder" tag from llama vs qwen3).
        publisher: m.details?.family,
        format: prettyFormat(m.details?.format),
        // When the model was pulled/created locally. /api/tags only.
        created: typeof m.modified_at === 'string' ? m.modified_at : undefined,
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
   * Ensure `modelId` is loaded before a prompt — but DO NOT change the context
   * of a model that's already loaded. Reloading a resident model just to grow
   * its num_ctx is disruptive (a 20s+ reload that drops the turn, and a much
   * larger VRAM footprint that can evict other models) and surprising — it fired
   * merely from the user typing. So: if the model is already loaded, leave it
   * exactly as-is. Only load (at the target context) when it isn't loaded at all.
   * Changing an already-loaded model's context is an explicit action offered in
   * the load dialog, never an automatic side effect of sending. Never throws.
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
      // Already loaded → respect its current context; do not reload.
      if (model.state === 'loaded') {
        return { reloaded: false, context: model.loadedContextLength };
      }
      const target = Math.min(minContext, model.maxContextLength ?? minContext);
      onProgress?.(`Loading ${model.displayName} with ${target.toLocaleString()} context…`);
      const loaded = await this.loadModel(modelId, target, keepAlive);
      return { reloaded: true, context: loaded.contextLength ?? target };
    } catch (err) {
      logError('ensureContext failed', err);
      return { reloaded: false, note: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Load a model and confirm it can actually serve, via a tiny real generation.
   *
   * We deliberately send a 1-token prompt rather than a bare warm call (empty
   * prompt → done_reason:"load"): measured against a real server, the bare warm
   * call can return "done" while the model is NOT yet serveable (a real request
   * right after hung for 30s+). A prompt that returns an actual token is positive
   * proof the model is loaded AND the generation path is warm — so when this
   * resolves, the model is genuinely ready. Costs one throwaway token.
   */
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
        prompt: 'hi',
        stream: false,
        keep_alive: coerceKeepAlive(keepAlive),
        options: { num_ctx: contextLength, num_predict: 1 },
      }),
      signal: TIMEOUT(600000),
    });
    if (!res.ok) {
      throw new Error(`/api/generate(load) ${res.status}: ${await res.text().catch(() => '')}`);
    }
    await res.json().catch(() => undefined);
    return { contextLength };
  }

  /**
   * Refresh an already-loaded model's keep_alive timer WITHOUT changing it or
   * running inference. A bare warm call (no prompt) at the SAME num_ctx is a
   * no-op on Ollama's side — it just resets the unload timer. Used by the
   * keep-warm poll. `contextLength` MUST be the model's currently-loaded context
   * (passing a different value would force a reload). Never throws.
   */
  async refreshKeepAlive(modelId: string, contextLength: number, keepAlive: string): Promise<void> {
    await fetch(`${this.rest}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        keep_alive: coerceKeepAlive(keepAlive),
        options: { num_ctx: contextLength },
      }),
      signal: TIMEOUT(30000),
    }).catch(() => undefined);
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
  if (!id) {
    return 'unknown';
  }
  return id.replace(/:latest$/, '');
}

// Ollama's `details.format` (e.g. "gguf") → a clean badge label. Unknown values
// are upper-cased as-is so new runtimes still surface something.
function prettyFormat(format?: string): string | undefined {
  if (!format) {
    return undefined;
  }
  const known: Record<string, string> = { gguf: 'GGUF', mlx: 'MLX', safetensors: 'Safetensors' };
  return known[format.toLowerCase()] ?? format.toUpperCase();
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
