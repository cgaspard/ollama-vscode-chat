import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ExtensionConfig, getConfig } from '../config';
import { clampContext } from '../core/context';
import { OllamaClient } from '../ollama/client';
import { log, logError } from '../logger';
import { Prefs } from '../prefs';
import { OpencodeClient } from './client';
import { BUILD_PROMPT, PLAN_PROMPT } from './prompts';

export interface ServerStartResult {
  baseUrl: string;
  client: OpencodeClient;
}

export interface Disposable {
  dispose(): void;
}

/**
 * Owns the lifecycle of a headless `opencode serve` process, configured to talk
 * to the local Ollama server. Config is injected via OPENCODE_CONFIG_CONTENT
 * so nothing is written to the user's workspace or global config.
 */
export class OpencodeServerManager {
  private proc: ChildProcess | undefined;
  private baseUrl: string | undefined;
  private client: OpencodeClient | undefined;
  private starting: Promise<ServerStartResult> | undefined;
  private readonly exitListeners = new Set<() => void>();
  /** Procs we killed on purpose, so their `exit` doesn't trigger reconnects. */
  private readonly killed = new WeakSet<ChildProcess>();

  constructor(
    private readonly cfg: ExtensionConfig,
    private readonly ollama: OllamaClient,
    private readonly prefs: Prefs,
  ) {}

  get isRunning(): boolean {
    return !!this.proc && !this.proc.killed;
  }

  /**
   * Register a callback fired whenever the server process exits unexpectedly.
   * Multiple bridges (sidebar + secondary + editor tabs) share one manager, so
   * each registers its own listener and disposes it on teardown.
   */
  addExitListener(cb: () => void): Disposable {
    this.exitListeners.add(cb);
    return { dispose: () => this.exitListeners.delete(cb) };
  }

  /** Start (or return the in-flight start of) the server. Idempotent. */
  async start(): Promise<ServerStartResult> {
    if (this.client && this.baseUrl) {
      return { baseUrl: this.baseUrl, client: this.client };
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.doStart().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async doStart(): Promise<ServerStartResult> {
    const bin = await this.resolveBinary();
    if (!bin) {
      throw new Error(
        'opencode binary not found. Install it (e.g. `brew install sst/tap/opencode` or `npm i -g opencode-ai`) or set "ollamaCode.opencodePath".',
      );
    }

    const configContent = await this.buildConfigContent();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

    log(`starting opencode server: ${bin} serve --port ${this.cfg.serverPort} (cwd=${cwd})`);

    const proc = spawn(
      bin,
      ['serve', '--port', String(this.cfg.serverPort), '--hostname', '127.0.0.1'],
      {
        cwd,
        env: {
          ...process.env,
          OPENCODE_CONFIG_CONTENT: configContent,
          // Point OpenCode's native ollama provider at the active server.
          OLLAMA_HOST: this.ollama.getBaseUrl(),
          NO_COLOR: '1',
        },
      },
    );
    this.proc = proc;

    const baseUrl = await this.awaitListening(proc);
    this.baseUrl = baseUrl;
    log(`opencode server listening at ${baseUrl}`);

    const client = new OpencodeClient(baseUrl);
    // Confirm health before declaring ready.
    await this.waitHealthy(client);
    this.client = client;

    proc.on('exit', (code, signal) => {
      const intentional = this.killed.has(proc);
      log(`opencode server exited (code=${code}, signal=${signal}${intentional ? ', intentional' : ''})`);
      this.killed.delete(proc);
      if (this.proc === proc) {
        this.proc = undefined;
        this.baseUrl = undefined;
        this.client = undefined;
      }
      // Only notify on an *unexpected* exit so bridges can self-heal; a dispose
      // / restart we triggered ourselves must not kick a reconnect storm.
      if (!intentional) {
        for (const cb of [...this.exitListeners]) {
          try {
            cb();
          } catch (err) {
            logError('exit listener threw', err);
          }
        }
      }
    });

    return { baseUrl, client };
  }

  /** Resolve a URL from the server's stdout/stderr "listening on ..." line. */
  private awaitListening(proc: ChildProcess): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const urlRe = /listening on\s+(https?:\/\/[^\s]+)/i;

      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        log(`[opencode] ${text.trimEnd()}`);
        const m = text.match(urlRe);
        if (m && !settled) {
          settled = true;
          cleanup();
          resolve(m[1].replace(/\/+$/, ''));
        }
      };
      const onErr = (err: Error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      };
      const onExit = (code: number | null) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error(`opencode server exited before listening (code=${code})`));
        }
      };
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error('timed out waiting for opencode server to start (30s)'));
        }
      }, 30000);

      const cleanup = () => {
        clearTimeout(timer);
        proc.stdout?.off('data', onData);
        proc.stderr?.off('data', onData);
        proc.off('error', onErr);
        proc.off('exit', onExit);
      };

      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      proc.on('error', onErr);
      proc.on('exit', onExit);
    });
  }

  private async waitHealthy(client: OpencodeClient): Promise<void> {
    for (let i = 0; i < 20; i++) {
      try {
        const h = await client.health();
        if (h.healthy) {
          return;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('opencode server did not become healthy');
  }

  /** Build the OPENCODE_CONFIG_CONTENT JSON injecting the Ollama provider. */
  private async buildConfigContent(): Promise<string> {
    // Read fresh so context-size changes apply on the next restart.
    const cfg = getConfig();
    const defaultCtx = cfg.minContextLength;

    const models: Record<string, Record<string, unknown>> = {};
    try {
      const list = await this.ollama.listModels();
      for (const m of list) {
        // Per-model context budget: the user's override, else the global
        // minContextLength, clamped to the model's real maximum. With the /v1
        // provider this drives OpenCode's `limit.context` — how much context it
        // packs before compacting, and the meter denominator. It does NOT resize
        // the Ollama runner itself: Ollama's /v1 endpoint ignores num_ctx and
        // loads at the server's OLLAMA_CONTEXT_LENGTH. (The native /api provider
        // honored num_ctx but emits an object finishReason that fails OpenCode's
        // validation and loops the model, so we can't use it.)
        const target = this.prefs.ctxOverride(m.id) ?? defaultCtx;
        const ctx = clampContext(target, m.maxContextLength);
        models[m.id] = {
          name: m.displayName,
          attachment: !!m.vision,
          reasoning: !!m.reasoning,
          tool_call: m.toolUse ?? true,
          modalities: {
            input: m.vision ? ['text', 'image'] : ['text'],
            output: ['text'],
          },
          limit: { context: ctx, output: Math.min(8192, Math.floor(ctx / 2)) },
        };
      }
    } catch (err) {
      logError('could not enumerate Ollama models for config', err);
    }

    // Use OpenCode's bundled `@ai-sdk/openai-compatible` provider against
    // Ollama's OpenAI-compatible /v1 endpoint.
    //
    // We pin `options.baseURL` to the active server's `/v1` because the bundled
    // provider hardcodes http://localhost:11434/v1 and ignores OLLAMA_HOST for
    // API calls — without this, remote/multi-server hosts 404 with "model not
    // found" (discovery hits the right host but chat hits localhost).
    // `includeUsage` makes Ollama stream real token counts (drives the meter).
    //
    // NOTE: we deliberately do NOT use the native `ollama-ai-provider-v2`
    // (/api). It would honor per-model num_ctx, but this opencode build rejects
    // its object-shaped `finishReason` (ZodError in session.processor), which
    // breaks turn completion and makes the agent loop re-run the model several
    // times per prompt (duplicate replies). /v1 returns a clean string
    // finishReason. Consequence: the runner window is set by the Ollama server's
    // OLLAMA_CONTEXT_LENGTH, not by us; our per-model context drives only
    // OpenCode's `limit.context` (compaction budget + meter). keep_alive is
    // applied out-of-band by the bridge's keep-warm poll via /api/generate.
    const config = {
      $schema: 'https://opencode.ai/config.json',
      // Let the model ask the user clarifying questions via the built-in
      // `question` tool. "allow" surfaces the picker immediately (the picker is
      // the interaction; no redundant approval gate). The bridge relays the
      // `question.asked` event and replies via the /question API.
      permission: { question: 'allow' as const },
      agent: {
        build: { prompt: BUILD_PROMPT },
        plan: { prompt: PLAN_PROMPT },
      },
      provider: {
        ollama: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Ollama',
          options: { baseURL: `${this.ollama.getBaseUrl()}/v1`, includeUsage: true },
          ...(Object.keys(models).length ? { models } : {}),
        },
      },
    };
    return JSON.stringify(config);
  }

  /** Find the opencode binary: setting -> known install path -> PATH. */
  private async resolveBinary(): Promise<string | null> {
    if (this.cfg.opencodePath && fs.existsSync(this.cfg.opencodePath)) {
      return this.cfg.opencodePath;
    }
    const home = os.homedir();
    const candidates =
      process.platform === 'win32'
        ? [path.join(home, '.opencode', 'bin', 'opencode.exe')]
        : [
            path.join(home, '.opencode', 'bin', 'opencode'),
            '/opt/homebrew/bin/opencode',
            '/usr/local/bin/opencode',
          ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return c;
      }
    }
    return new Promise<string | null>((resolve) => {
      const which = process.platform === 'win32' ? 'where' : 'which';
      const child = spawn(which, ['opencode']);
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.on('error', () => resolve(null));
      child.on('close', (code) =>
        resolve(code === 0 && out.trim() ? out.trim().split('\n')[0] : null),
      );
    });
  }

  async restart(): Promise<ServerStartResult> {
    this.dispose();
    return this.start();
  }

  dispose(): void {
    if (this.proc && !this.proc.killed) {
      log('stopping opencode server');
      this.killed.add(this.proc); // mark intentional so exit doesn't trigger reconnect
      this.proc.kill();
    }
    this.proc = undefined;
    this.baseUrl = undefined;
    this.client = undefined;
    // Drop any in-flight start so a dispose mid-startup (e.g. restart()) can't
    // have its stale promise returned by the next start() — forces a fresh one.
    this.starting = undefined;
  }
}
