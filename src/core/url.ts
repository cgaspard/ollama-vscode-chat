/**
 * Ollama URL helpers. Pure so they can be shared (config, connection registry)
 * and unit-tested without vscode. Unlike LM Studio, Ollama's REST API lives at
 * the host root (no /v1 suffix), so we normalize to the bare host.
 */

/**
 * Normalize a user-entered Ollama host URL to its root: adds a scheme if
 * missing, strips trailing slashes, and removes an accidental /vN suffix.
 * Empty input falls back to the local default.
 */
export function normalizeOllamaUrl(raw: string, fallback = 'http://127.0.0.1:11434'): string {
  let u = (raw || '').trim().replace(/\/+$/, '');
  if (!u) {
    return fallback;
  }
  if (!/^https?:\/\//i.test(u)) {
    u = 'http://' + u;
  }
  u = u.replace(/\/v\d+$/, ''); // strip an accidental /v1
  return u;
}

/** Ollama REST root (already the root for Ollama; strips a stray /vN defensively). */
export function ollamaRestRoot(baseUrl: string): string {
  return (baseUrl || '').replace(/\/v\d+$/, '');
}
