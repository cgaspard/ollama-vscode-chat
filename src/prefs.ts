import * as vscode from 'vscode';

const CTX_KEY = 'ollamaCode.modelCtx'; // Record<modelId, num_ctx>
const KEEP_KEY = 'ollamaCode.keepAlivePref'; // string override of config keepAlive

/**
 * User-tunable runtime preferences that live outside settings.json so the
 * webview can change them directly: a global keep_alive override and a
 * per-model context-window (num_ctx) override. Both fall back to the
 * `ollamaCode.*` settings when unset. Persisted in globalState.
 */
export class Prefs {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /** keep_alive override, or undefined to use the `ollamaCode.keepAlive` setting. */
  keepAlive(): string | undefined {
    const v = this.context.globalState.get<string>(KEEP_KEY);
    return v && v.trim() ? v.trim() : undefined;
  }

  async setKeepAlive(value: string): Promise<void> {
    const v = (value || '').trim();
    await this.context.globalState.update(KEEP_KEY, v || undefined);
  }

  /** All per-model num_ctx overrides. */
  ctxOverrides(): Record<string, number> {
    return this.context.globalState.get<Record<string, number>>(CTX_KEY) ?? {};
  }

  /** Per-model num_ctx override, or undefined to use `ollamaCode.minContextLength`. */
  ctxOverride(modelId: string): number | undefined {
    const n = this.ctxOverrides()[modelId];
    return typeof n === 'number' && n > 0 ? n : undefined;
  }

  /** Set (n>0) or clear (n<=0) the num_ctx override for one model. */
  async setCtx(modelId: string, n: number): Promise<void> {
    const map = { ...this.ctxOverrides() };
    if (n && n > 0) {
      map[modelId] = Math.round(n);
    } else {
      delete map[modelId];
    }
    await this.context.globalState.update(CTX_KEY, map);
  }
}
