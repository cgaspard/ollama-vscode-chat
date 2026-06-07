import * as vscode from 'vscode';
import { normalizeOllamaUrl, ollamaRestRoot } from './core/url';

// Re-exported from the pure core module so existing importers keep working
// while the implementation stays unit-testable without vscode.
export { normalizeOllamaUrl, ollamaRestRoot };

export interface ExtensionConfig {
  ollamaBaseUrl: string; // Ollama host root, e.g. http://127.0.0.1:11434 (no /v1)
  opencodePath: string;
  serverPort: number;
  defaultModel: string;
  agent: 'build' | 'plan';
  autoEnsureContext: boolean;
  minContextLength: number;
  keepAlive: string; // Ollama keep_alive, e.g. "30m"
}

export function getConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration('ollamaCode');
  return {
    ollamaBaseUrl: normalizeOllamaUrl(cfg.get<string>('ollamaBaseUrl') ?? 'http://127.0.0.1:11434'),
    opencodePath: (cfg.get<string>('opencodePath') ?? '').trim(),
    serverPort: cfg.get<number>('serverPort') ?? 0,
    defaultModel: (cfg.get<string>('defaultModel') ?? '').trim(),
    agent: (cfg.get<string>('agent') as 'build' | 'plan') ?? 'build',
    autoEnsureContext: cfg.get<boolean>('autoEnsureContext') ?? true,
    minContextLength: cfg.get<number>('minContextLength') ?? 32768,
    keepAlive: (cfg.get<string>('keepAlive') ?? '30m').trim(),
  };
}
