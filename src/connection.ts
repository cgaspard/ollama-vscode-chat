import * as vscode from 'vscode';
import { normalizeOllamaUrl } from './core/url';

export interface LmServer {
  id: string;
  name: string;
  url: string; // Ollama host root, e.g. http://127.0.0.1:11434
}

let counter = 0;
function genId(): string {
  return 'srv_' + Date.now().toString(36) + (counter++).toString(36);
}

export function normalizeServerUrl(raw: string): string {
  return normalizeOllamaUrl(raw);
}

const SERVERS_KEY = 'ollamaCode.servers';
const ACTIVE_KEY = 'ollamaCode.activeServer';

/** Persisted registry of Ollama servers the user can switch between. */
export class ServerRegistry {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly defaultUrl: string,
  ) {}

  list(): LmServer[] {
    let servers = this.context.globalState.get<LmServer[]>(SERVERS_KEY);
    if (!servers || !servers.length) {
      servers = [{ id: genId(), name: 'Local', url: normalizeServerUrl(this.defaultUrl) }];
      void this.context.globalState.update(SERVERS_KEY, servers);
    }
    return servers;
  }

  active(): LmServer {
    const servers = this.list();
    const id = this.context.globalState.get<string>(ACTIVE_KEY);
    return servers.find((s) => s.id === id) ?? servers[0];
  }

  async setActive(id: string): Promise<void> {
    await this.context.globalState.update(ACTIVE_KEY, id);
  }

  async add(name: string, url: string): Promise<LmServer> {
    const servers = this.list();
    const server: LmServer = { id: genId(), name: (name || '').trim() || 'Server', url: normalizeServerUrl(url) };
    servers.push(server);
    await this.context.globalState.update(SERVERS_KEY, servers);
    return server;
  }

  async update(id: string, name: string, url: string): Promise<void> {
    const servers = this.list().map((s) =>
      s.id === id ? { ...s, name: (name || '').trim() || s.name, url: normalizeServerUrl(url) } : s,
    );
    await this.context.globalState.update(SERVERS_KEY, servers);
  }

  async remove(id: string): Promise<void> {
    let servers = this.list().filter((s) => s.id !== id);
    if (!servers.length) {
      servers = [{ id: genId(), name: 'Local', url: normalizeServerUrl(this.defaultUrl) }];
    }
    await this.context.globalState.update(SERVERS_KEY, servers);
    if (this.active().id === id) {
      await this.setActive(servers[0].id);
    }
  }
}
