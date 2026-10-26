import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ExtensionConfig, getConfig } from '../config';
import { augmentedPath, toEngineMcp, withLocalEnvironment } from '../core/mcp';
import { opencodePermission } from '../core/permission';
import { toEngineProviderID } from '../core/providerIds';
import { OllamaClient } from '../ollama/client';
import { log, logError } from '../logger';
import { discoverMcpServers } from '../mcp/discovery';
import { Prefs } from '../prefs';
import { createHost, type SdkHost } from './embedded';
import { OLLAMA_PROVIDER_ID, ollamaProviderConfig, providerModuleUrl, type ProviderModel } from './ollamaProvider';
import { BUILD_PROMPT, PLAN_PROMPT } from './prompts';
import { OpencodeV2Client } from './v2client';

export interface ServerStartResult {
  /** Where the engine runs, for logs only: there is no network address. */
  baseUrl: string;
  client: OpencodeV2Client;
}

export interface Disposable {
  dispose(): void;
}

/** Shown in logs where a server URL used to be. */
const EMBEDDED_URL = 'embedded://opencode';

/**
 * Owns the embedded OpenCode engine (OpenCode 2, running in-process through
 * @opencode/sdk), configured to talk to the active Ollama server through the
 * bundled provider. Config is handed to the engine in memory, so nothing is
 * written to the user's workspace or global config.
 *
 * Still named a "server" manager: the bridge's lifecycle (start, dispose,
 * restart) is unchanged, only what it starts is.
 */
export class OpencodeServerManager {
  private host: SdkHost | undefined;
  private client: OpencodeV2Client | undefined;
  private starting: Promise<ServerStartResult> | undefined;
  /**
   * The previous engine's shutdown. A new host must not open the same database
   * and folders while the old one is still closing (two engines in one
   * process over one SQLite file), so a start waits for this first.
   */
  private closing: Promise<void> = Promise.resolve();
  /** Model id → the context window (num_ctx) the running engine's config declares for it. */
  private declared = new Map<string, number>();
  /** Bumped by dispose(), so a start that was in flight when it ran can tell it is stale. */
  private generation = 0;
  private readonly exitListeners = new Set<() => void>();

  constructor(
    private readonly cfg: ExtensionConfig,
    private readonly ollama: OllamaClient,
    private readonly prefs: Prefs,
    /** Extension install dir — holds the engine (`opencode-sdk/`) and provider (`opencode-provider/`). */
    private readonly extensionPath: string,
    /** Private data dir for the engine, isolated from the user's own OpenCode. */
    private readonly dataDir: string,
  ) {}

  get isRunning(): boolean {
    return !!this.client;
  }

  /**
   * Whether `client` is the running engine's client. After a restart a new
   * engine is running (isRunning is true again) but a panel can still hold
   * the old, stopped client.
   */
  isCurrent(client: OpencodeV2Client | undefined): boolean {
    return !!client && client === this.client;
  }

  /**
   * Whether the running engine's config declares `modelID` — at context window
   * `numCtx`, when given. Both are baked in when the engine starts: a model
   * pulled since is unknown to it, and a context chosen since (a per-model
   * pick, a minContextLength change) would not be what reaches Ollama, which
   * would then reload the model at the old window. The bridge rebuilds the
   * engine before sending in either case.
   */
  declares(modelID: string, numCtx?: number): boolean {
    const declared = this.declared.get(modelID);
    return declared !== undefined && (numCtx === undefined || declared === numCtx);
  }

  /**
   * Register a callback fired whenever the engine stops unexpectedly.
   * Multiple bridges (sidebar + secondary + editor tabs) share one manager, so
   * each registers its own listener and disposes it on teardown. An in-process
   * engine has no process to die, so this only fires if a future engine
   * reports a fatal stop; settings changes and restarts are intentional.
   */
  addExitListener(cb: () => void): Disposable {
    this.exitListeners.add(cb);
    return { dispose: () => this.exitListeners.delete(cb) };
  }

  /** Start (or return the in-flight start of) the engine. Idempotent. */
  async start(): Promise<ServerStartResult> {
    if (this.client) {
      return { baseUrl: EMBEDDED_URL, client: this.client };
    }
    if (this.starting) {
      return this.starting;
    }
    const starting = this.doStart().finally(() => {
      if (this.starting === starting) {
        this.starting = undefined;
      }
    });
    this.starting = starting;
    return starting;
  }

  private async doStart(): Promise<ServerStartResult> {
    const generation = this.generation;
    await this.closing;
    const { content, models } = await this.buildConfigContent();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const version = this.engineVersion();
    log(`starting embedded opencode ${version} (cwd=${cwd}, ollama=${this.ollama.getBaseUrl()})`);
    const host = await createHost(this.extensionPath, { root: this.dataDir }, content);
    if (generation !== this.generation) {
      // Disposed while starting (a settings change, a restart): this engine is
      // already stale. Close it rather than hand it out.
      await host.close().catch((err: unknown) => logError('closing a superseded engine', err));
      throw new Error('OpenCode engine stopped');
    }
    this.host = host;
    this.client = new OpencodeV2Client(host, cwd, version);
    this.declared = new Map(models);
    log('embedded opencode ready');
    return { baseUrl: EMBEDDED_URL, client: this.client };
  }

  /** The bundled engine's version, from the stamp the build writes. */
  private engineVersion(): string {
    try {
      return fs.readFileSync(path.join(this.extensionPath, 'opencode-sdk', 'version'), 'utf8').split('\n')[0].trim();
    } catch {
      return 'unknown';
    }
  }

  /** Build the engine config: the Ollama provider, MCP servers, permissions, agents. */
  private async buildConfigContent(): Promise<{ content: string; models: Array<[string, number]> }> {
    // Read fresh so context-size and permission changes apply on the next start.
    const cfg = getConfig();

    let models: ProviderModel[] = [];
    try {
      models = await this.ollama.listModels();
    } catch (err) {
      // Ollama down at start: the provider is still declared, and the bridge
      // rebuilds the engine before sending to a model it does not declare.
      logError('could not enumerate Ollama models for config', err);
    }

    const npm = providerModuleUrl(this.extensionPath);
    if (!npm) {
      throw new Error(
        'The bundled Ollama provider is missing (opencode-provider/ollama.mjs). Reinstall the extension.',
      );
    }

    // The bundled provider against Ollama's native /api endpoint, with each
    // model's context window as `num_ctx` (see ollamaProvider.ts for why not
    // the built-in provider or /v1).
    //
    // Accepted costs, unchanged from 1.x:
    //   - `keep_alive` is embedding-only in this provider, so chat requests
    //     still cannot carry it. It stays applied out-of-band by the bridge's
    //     keep-warm poll via /api/generate.
    const provider = ollamaProviderConfig({
      baseUrl: this.ollama.getBaseUrl(),
      npm,
      models,
      defaultCtx: cfg.minContextLength,
      ctxOverride: (id) => this.prefs.ctxOverride(id),
    });

    // MCP servers discovered from .mcp.json / .vscode/mcp.json / VS Code user
    // settings / our own `ollamaCode.mcpServers`. Tokens like ${VAR} are already
    // resolved to literals (the injected config is not substituted by
    // OpenCode), so what we inject is ready to spawn as-is. Their tools flow
    // through OpenCode's existing tool-call + permission machinery for free.
    let mcp: ReturnType<typeof discoverMcpServers>['map'] = {};
    try {
      // stdio servers inherit the extension host's environment. When VS Code
      // was launched from a GUI context its PATH can be minimal (the #1 reason
      // npx/uvx-based servers fail to start), so add the usual install
      // locations; existing entries stay first so the user's toolchain wins.
      mcp = withLocalEnvironment(discoverMcpServers().map, {
        PATH: augmentedPath(process.env.PATH, os.homedir(), path.delimiter),
      });
    } catch (err) {
      logError('could not discover MCP servers', err);
    }

    const config = {
      $schema: 'https://opencode.ai/config.json',
      // Only our provider. OpenCode would otherwise also enable any provider it
      // can find a key for in the environment (an exported OPENAI_API_KEY) and
      // its own auto-discovering `ollama` plugin — and its internal
      // title/summary agents could then run on a model the user never chose.
      enabled_providers: [toEngineProviderID(OLLAMA_PROVIDER_ID)],
      // Tool-approval posture (default / strict / bypass), read fresh so a
      // mode change applies on restart. Every mode keeps the built-in
      // `question` tool at "allow": the picker is the interaction (the bridge
      // relays `question.asked` and replies through the form API), so an
      // approval gate in front of it would be redundant.
      permission: opencodePermission(cfg.permissionMode),
      // Override the build/plan agent prompts so the model identifies as
      // "OpenCode Agent" instead of OpenCode's built-in "You are opencode…".
      agent: {
        build: { prompt: BUILD_PROMPT },
        plan: { prompt: PLAN_PROMPT },
      },
      // OpenCode 2 ships its todo tool behind a flag; the panel's live todo
      // list renders from it.
      experimental: { todo: true },
      provider,
      // Native shape, with Code Mode off (see toEngineMcp).
      ...(Object.keys(mcp).length ? { mcp: toEngineMcp(mcp) } : {}),
    };
    const declared = Object.entries(provider).flatMap(([, p]) =>
      Object.entries(((p as { models?: Record<string, { limit: { context: number } }> }).models ?? {})).map(
        ([id, m]) => [id, m.limit.context] as [string, number],
      ),
    );
    return { content: JSON.stringify(config), models: declared };
  }

  async restart(): Promise<ServerStartResult> {
    this.dispose();
    return this.start();
  }

  dispose(): void {
    if (this.client) {
      log('stopping embedded opencode');
    }
    this.client?.dispose();
    const host = this.host;
    this.host = undefined;
    this.client = undefined;
    this.declared = new Map();
    this.generation++;
    // Drop any in-flight start so a dispose mid-startup (e.g. restart()) can't
    // have its stale promise returned by the next start() — forces a fresh one.
    this.starting = undefined;
    // Closing releases the engine's watchers, MCP children and database. The
    // next start waits for it (see `closing`).
    if (host) {
      const previous = this.closing;
      this.closing = previous
        .then(() => host.close())
        .catch((err: unknown) => logError('closing embedded opencode', err));
    }
  }
}
