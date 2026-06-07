import * as vscode from 'vscode';

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

/** Normalize an Ollama host URL to its root (no trailing slash, no /v1). */
export function normalizeOllamaUrl(raw: string): string {
  let u = (raw || '').trim().replace(/\/+$/, '');
  if (!u) {
    return 'http://127.0.0.1:11434';
  }
  if (!/^https?:\/\//i.test(u)) {
    u = 'http://' + u;
  }
  u = u.replace(/\/v\d+$/, ''); // strip an accidental /v1
  return u;
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

/** Ollama REST root (already the root for Ollama). */
export function ollamaRestRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v\d+$/, '');
}
