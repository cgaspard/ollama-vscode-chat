import * as vscode from 'vscode';
import { ALL_LEVELS, type EffortLevel } from './core/effort';

/** Settings.json is hand-editable, so an unknown level must not reach the wire. */
function normalizeEffort(value: unknown): EffortLevel {
  return typeof value === 'string' && (ALL_LEVELS as string[]).includes(value)
    ? (value as EffortLevel)
    : 'auto';
}
import { normalizeOllamaUrl, ollamaRestRoot } from './core/url';

// Re-exported from the pure core module so existing importers keep working
// while the implementation stays unit-testable without vscode.
export { normalizeOllamaUrl, ollamaRestRoot };

export interface ExtensionConfig {
  ollamaBaseUrl: string; // Ollama host root, e.g. http://127.0.0.1:11434 (no /v1)
  opencodePath: string;
  serverPort: number;
  defaultModel: string;
  /** Starting reasoning effort for models with no per-model choice stored. */
  defaultThinkingEffort: EffortLevel;
  /** Default agent name. Free-form: user-defined agents are discovered at runtime. */
  agent: string;
  autoEnsureContext: boolean;
  minContextLength: number;
  keepAlive: string; // Ollama keep_alive, e.g. "30m"
  /**
   * Connected-state health/model poll cadence, seconds. Clamped 5–120: the
   * keep-warm ping must fit comfortably inside the 5-minute minimum
   * keep_alive, so the ceiling is lower than LM Studio Code's.
   */
  healthCheckSeconds: number;
}

export function getConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration('ollamaCode');
  return {
    ollamaBaseUrl: normalizeOllamaUrl(cfg.get<string>('ollamaBaseUrl') ?? 'http://127.0.0.1:11434'),
    opencodePath: (cfg.get<string>('opencodePath') ?? '').trim(),
    serverPort: cfg.get<number>('serverPort') ?? 0,
    defaultModel: (cfg.get<string>('defaultModel') ?? '').trim(),
    agent: (cfg.get<string>('agent') ?? 'build').trim() || 'build',
    defaultThinkingEffort: normalizeEffort(cfg.get<string>('defaultThinkingEffort')),
    autoEnsureContext: cfg.get<boolean>('autoEnsureContext') ?? true,
    minContextLength: cfg.get<number>('minContextLength') ?? 32768,
    keepAlive: (cfg.get<string>('keepAlive') ?? '30m').trim(),
    healthCheckSeconds: clampSeconds(cfg.get<number>('healthCheckSeconds'), 30, 5, 120),
  };
}

/**
 * Clamp a user-supplied seconds value. `get<number>()` does not validate — a
 * hand-edited settings.json can deliver a string/NaN, and NaN sailing through
 * Math.min/max would become setTimeout(cb, NaN) ≈ a 1ms hot loop.
 */
function clampSeconds(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}
