import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { clampContext } from '../core/context';
import { clampKeepAlive } from '../core/keepAlive';
import { humanizeError } from '../core/errors';
import { pickModel } from '../core/models';
import { ServerRegistry } from '../connection';
import { OllamaClient, OllamaModel } from '../ollama/client';
import { log, logError } from '../logger';
import { OpencodeClient } from '../opencode/client';
import { OpencodeEvent, PromptBody } from '../opencode/protocol';
import { OpencodeServerManager } from '../opencode/serverManager';
import { Prefs } from '../prefs';
import { HostToWebview, UiImage, UiModel, UiSession, WebviewToHost } from '../shared';

export interface BridgeDeps {
  context: vscode.ExtensionContext;
  server: OpencodeServerManager;
  ollama: OllamaClient;
  servers: ServerRegistry;
  prefs: Prefs;
}

/**
 * Connects one webview (sidebar view or editor tab) to the OpenCode server.
 * Owns the conversation state for that webview and relays the SSE event stream.
 */
export class ChatBridge {
  private client: OpencodeClient | undefined;
  private currentSessionID: string | null = null;
  private currentModel: string | null = null;
  private agent: 'build' | 'plan';
  private eventAbort: AbortController | undefined;
  private disposed = false;
  private connected = false;
  private connecting = false;
  private currentTitle = '';
  private agentsWarned = false;
  private activeFile: { abs: string; rel: string; chars: number } | null = null;
  private editorSub: vscode.Disposable | undefined;
  private messageSub: vscode.Disposable | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private healthTicks = 0;
  private titleSink: ((t: string) => void) | undefined;
  /** Model ids with a load currently in flight → cancel handle. While any load
   * is in flight the keep-warm refresh is paused (it would contend with the
   * busy server and can stall the load). */
  private readonly loadsInFlight = new Map<string, AbortController>();

  constructor(
    private readonly webview: vscode.Webview,
    private readonly deps: BridgeDeps,
  ) {
    this.agent = getConfig().agent;
    this.messageSub = webview.onDidReceiveMessage((m: WebviewToHost) => this.onMessage(m));
    this.editorSub = vscode.window.onDidChangeActiveTextEditor((e) => this.updateActiveFile(e));
  }

  dispose(): void {
    this.disposed = true;
    this.messageSub?.dispose();
    this.eventAbort?.abort();
    this.editorSub?.dispose();
    for (const ctrl of this.loadsInFlight.values()) {
      ctrl.abort(); // stop any readiness-poll loops
    }
    this.loadsInFlight.clear();
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
  }

  /**
   * Poll Ollama so the panel self-heals: when the server comes online after
   * being down we auto-connect (no manual Retry), and while connected we
   * periodically refresh the model list so newly loaded/pulled models appear.
   */
  private startHealthPoll(): void {
    if (this.healthTimer || this.disposed) {
      return;
    }
    this.healthTimer = setInterval(async () => {
      if (this.disposed || this.connecting) {
        return;
      }
      let ok = false;
      try {
        ok = await this.deps.ollama.checkConnection();
      } catch {
        ok = false;
      }
      if (ok && !this.connected) {
        await this.init(); // came online → full setup + model load
      } else if (ok && this.connected) {
        // Pause the model refresh + keep-warm while a load is in flight: the
        // server is busy loading (possibly for minutes) and an extra listModels
        // (/api/ps + parallel /api/show) would contend with — and can stall —
        // the load. The load's own readiness poll drives state meanwhile.
        if (this.loadsInFlight.size === 0 && ++this.healthTicks % 3 === 0) {
          const list = await this.refreshModelsToWebview().catch(() => [] as OllamaModel[]); // ~every 15s
          await this.keepWarm(list).catch(() => undefined);
        }
      } else if (!ok && this.connected) {
        this.connected = false;
        this.postServers(false); // went offline → show the banner
      }
    }, 5000);
  }

  private updateActiveFile(editor: vscode.TextEditor | undefined): void {
    // Keep the last real file when focus moves to the webview/panel.
    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }
    const abs = editor.document.uri.fsPath;
    this.activeFile = {
      abs,
      rel: vscode.workspace.asRelativePath(abs),
      chars: editor.document.getText().length,
    };
    this.post({ type: 'activeFile', path: this.activeFile.rel, chars: this.activeFile.chars });
  }

  /** Start a fresh conversation (invoked by the New Chat command). */
  async requestNewChat(): Promise<void> {
    if (this.client) {
      await this.newSession();
    }
  }

  /** Ask the webview to run a UI command (e.g. open history overlay). */
  sendCommand(command: 'history' | 'newChat' | 'focusInput'): void {
    this.post({ type: 'command', command });
  }

  /** Provide a callback that sets the host view/tab title (the session name). */
  setTitleSink(fn: (t: string) => void): void {
    this.titleSink = fn;
  }

  private updateTitle(title: string): void {
    this.currentTitle = title || 'New chat';
    this.titleSink?.(this.currentTitle);
  }

  private post(msg: HostToWebview): void {
    if (!this.disposed) {
      void this.webview.postMessage(msg);
    }
  }

  private async onMessage(msg: WebviewToHost): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      switch (msg.type) {
        case 'ready':
          await this.init();
          break;
        case 'send':
          await this.handleSend(msg.text, msg.thinking, msg.images ?? [], msg.includeActiveFile ?? false);
          break;
        case 'selectModel':
          this.currentModel = msg.modelID;
          await this.deps.context.workspaceState.update('ollamaCode.model', msg.modelID);
          break;
        case 'loadModel':
          await this.handleLoadModel(msg.modelID);
          break;
        case 'reloadModel':
          await this.handleReloadModel(msg.modelID);
          break;
        case 'cancelLoad':
          this.cancelLoad(msg.modelID);
          break;
        case 'unloadModel':
          await this.handleUnloadModel(msg.modelID);
          break;
        case 'setModelCtx':
          await this.setModelCtx(msg.modelID, msg.numCtx);
          break;
        case 'setModelCtxPref':
          // Persist the desired context only — no reload, no server rebuild.
          // Applied when the user presses Reload (or on the next explicit load).
          await this.deps.prefs.setCtx(msg.modelID, msg.numCtx);
          break;
        case 'setKeepAlive':
          await this.setKeepAlive(msg.value);
          break;
        case 'refreshModels':
          await this.refreshModelsToWebview();
          break;
        case 'listServers':
          this.postServers(this.connected);
          break;
        case 'addServer':
          await this.deps.servers.add(msg.name, msg.url);
          this.postServers(this.connected);
          break;
        case 'updateServer':
          await this.deps.servers.update(msg.id, msg.name, msg.url);
          if (this.deps.servers.active().id === msg.id) {
            await this.switchServer(msg.id);
          } else {
            this.postServers(this.connected);
          }
          break;
        case 'removeServer': {
          const wasActive = this.deps.servers.active().id === msg.id;
          await this.deps.servers.remove(msg.id);
          if (wasActive) {
            await this.switchServer(this.deps.servers.active().id);
          } else {
            this.postServers(this.connected);
          }
          break;
        }
        case 'switchServer':
          await this.switchServer(msg.id);
          break;
        case 'selectAgent':
          this.agent = msg.agent;
          break;
        case 'newChat':
          await this.newSession();
          break;
        case 'loadSessions':
          await this.sendSessions();
          break;
        case 'loadSession':
          await this.loadSession(msg.sessionID);
          break;
        case 'deleteSession': {
          const wasCurrent = msg.sessionID === this.currentSessionID;
          await this.client?.deleteSession(msg.sessionID);
          if (wasCurrent) {
            this.currentSessionID = null;
            await this.newSession(false);
          }
          await this.sendSessions();
          break;
        }
        case 'clearAllSessions':
          await this.clearAllSessions();
          break;
        case 'compact':
          await this.compactSession();
          break;
        case 'abort':
          if (this.currentSessionID) {
            await this.client?.abort(this.currentSessionID);
          }
          break;
        case 'permission':
          await this.client?.respondPermission(msg.sessionID, msg.permissionID, msg.response);
          break;
        case 'questionReply':
          await this.client?.replyQuestion(msg.requestID, msg.answers);
          break;
        case 'questionReject':
          await this.client?.rejectQuestion(msg.requestID);
          break;
        case 'openFile':
          await this.openFile(msg.path);
          break;
        case 'retryConnect':
          await this.init();
          break;
      }
    } catch (err) {
      logError(`handling ${msg.type}`, err);
      this.post({ type: 'error', message: humanizeError(err, { subject: 'Ollama' }) });
      this.post({ type: 'busy', busy: false });
    }
  }

  private async init(): Promise<void> {
    this.startHealthPoll();
    if (this.connecting) {
      return;
    }
    this.connecting = true;
    try {
      await this.doInit();
    } finally {
      this.connecting = false;
    }
  }

  private async doInit(): Promise<void> {
    const cfg = getConfig();
    const active = this.deps.servers.active();
    this.deps.ollama.setBaseUrl(active.url);
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    this.post({ type: 'status', text: `Connecting to ${active.name}…` });
    this.connected = await this.deps.ollama.checkConnection();
    this.postServers(this.connected);

    // Offline: show the connection screen and wait for retry / switch.
    if (!this.connected) {
      this.post({
        type: 'init',
        models: [],
        currentModel: null,
        agent: this.agent,
        cwd,
        serverReady: false,
        ollamaConnected: false,
        minContext: cfg.minContextLength,
        keepAlive: this.keepAlive(),
      });
      this.post({ type: 'status', text: `Can't reach Ollama at ${active.url}`, kind: 'warn' });
      return;
    }

    this.post({ type: 'status', text: 'Starting OpenCode server…' });
    let started;
    try {
      started = await this.deps.server.start();
    } catch (err) {
      const message = humanizeError(err, { subject: 'the OpenCode server' });
      this.post({ type: 'error', message });
      this.post({
        type: 'init',
        models: [],
        currentModel: null,
        agent: this.agent,
        cwd,
        serverReady: false,
        ollamaConnected: true,
        minContext: cfg.minContextLength,
        keepAlive: this.keepAlive(),
      });
      return;
    }
    this.client = started.client;

    const models = await this.loadModels();
    const stored = this.deps.context.workspaceState.get<string>('ollamaCode.model');
    this.currentModel =
      pickModel([cfg.defaultModel, stored ?? '', this.currentModel ?? ''], models) ?? null;

    this.startEventStream();

    this.post({
      type: 'init',
      models,
      currentModel: this.currentModel,
      agent: this.agent,
      cwd,
      serverReady: true,
      ollamaConnected: true,
      minContext: cfg.minContextLength,
      keepAlive: this.keepAlive(),
    });

    await this.sendSessions();
    if (!this.currentSessionID) {
      await this.newSession(false);
    }
    this.updateActiveFile(vscode.window.activeTextEditor);
    this.warnIfAgentsLarge();
    this.post({ type: 'status', text: '' });
  }

  /** Warn once if AGENTS.md/CLAUDE.md (auto-loaded by OpenCode) is large. */
  private warnIfAgentsLarge(): void {
    if (this.agentsWarned) {
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return;
    }
    let bytes = 0;
    const found: string[] = [];
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      try {
        const st = fs.statSync(path.join(root, name));
        if (st.isFile()) {
          bytes += st.size;
          found.push(name);
        }
      } catch {
        // not present
      }
    }
    if (!found.length) {
      return;
    }
    const estTokens = Math.round(bytes / 4);
    const win = getConfig().minContextLength;
    // Guard against a non-positive context setting making the threshold `>= 0`
    // (which would warn on every workspace that has an AGENTS.md/CLAUDE.md).
    if (win > 0 && estTokens >= win * 0.4) {
      this.agentsWarned = true;
      const pct = Math.round((estTokens / win) * 100);
      const over = estTokens >= win;
      vscode.window.showWarningMessage(
        `Ollama Code: ${found.join(' + ')} is ~${Math.round(estTokens / 1000)}k tokens (~${pct}% of your ${Math.round(win / 1000)}k context)${over ? ' — larger than the context window' : ''}. It's auto-included on every request and may crowd out the conversation. Consider trimming it or raising ollamaCode.minContextLength.`,
      );
    }
  }

  private postServers(connected: boolean): void {
    this.connected = connected;
    this.post({
      type: 'servers',
      servers: this.deps.servers.list().map((s) => ({ id: s.id, name: s.name, url: s.url })),
      activeId: this.deps.servers.active().id,
      connected,
    });
  }

  /**
   * Proof-of-life: we just received a successful response from the server, so it
   * is provably online. If the UI is currently showing offline (a stale health
   * poll, or it never connected), flip it online immediately and trigger a full
   * init so the offline banner can't linger while data is clearly flowing. A
   * no-op when already connected, so it's cheap to call from any success path.
   */
  private noteOnline(): void {
    if (this.connected || this.disposed) {
      return;
    }
    this.connected = true;
    this.postServers(true);
    void this.init(); // re-establish OpenCode + models now that we know it's up
  }

  /** Switch the active Ollama server: tear down OpenCode and re-initialize. */
  private async switchServer(id: string): Promise<void> {
    await this.deps.servers.setActive(id);
    this.eventAbort?.abort();
    this.eventAbort = undefined;
    this.client = undefined;
    this.currentSessionID = null;
    this.deps.server.dispose();
    this.post({ type: 'cleared' });
    await this.init();
  }

  private async refreshModelsToWebview(): Promise<OllamaModel[]> {
    const list = await this.deps.ollama.listModels();
    // A non-empty list is proof the server answered — if we were showing
    // offline, correct that immediately rather than waiting for the next poll.
    if (list.length) {
      this.noteOnline();
    }
    this.post({ type: 'models', models: this.mapModels(list), currentModel: this.currentModel });
    return list;
  }

  /**
   * Re-assert keep_alive on the currently-selected model if it's loaded.
   * OpenCode's chat requests reset Ollama's keep_alive to its ~5min default, so
   * without this the user's keepAlive choice wouldn't stick. Re-loading with the
   * SAME num_ctx is a cheap no-op (just refreshes the timer).
   *
   * CRITICAL: we re-load with the model's ACTUALLY-LOADED context and nothing
   * else. We must never pass a guessed/config context here — doing so (the old
   * `|| ctxFor(...)` fallback) reloaded the model at a DIFFERENT context every
   * 15s, which forced a full reload and stomped the user's chosen context (e.g.
   * back to 256K). If /api/ps doesn't report the loaded context, we SKIP the
   * refresh rather than risk changing it; the model keeps its own keep_alive.
   */
  private async keepWarm(list: OllamaModel[]): Promise<void> {
    if (!this.currentModel) {
      return;
    }
    const m = list.find((x) => x.id === this.currentModel);
    if (!m || m.state !== 'loaded') {
      return;
    }
    const loadedCtx = m.loadedContextLength;
    if (!loadedCtx || loadedCtx <= 0) {
      return; // unknown loaded context → don't touch it (would risk a reload)
    }
    // Bare timer refresh at the SAME context — no reload, no inference.
    await this.deps.ollama.refreshKeepAlive(m.id, loadedCtx, this.keepAlive());
  }

  /** Effective num_ctx for a model: per-model override, else the global default, clamped to the model's max. */
  private ctxFor(modelID: string, maxContextLength?: number): number {
    const target = this.deps.prefs.ctxOverride(modelID) ?? getConfig().minContextLength;
    return clampContext(target, maxContextLength);
  }

  /**
   * Effective keep_alive: UI override, else the `ollamaCode.keepAlive` setting,
   * CLAMPED to a 5-minute minimum. keep_alive:0 ("unload immediately") is a
   * footgun for an interactive chat tool — it makes a model you just loaded
   * vanish — so it can never be sent. (A negative value, "forever", is kept.)
   */
  private keepAlive(): string {
    return clampKeepAlive(this.deps.prefs.keepAlive() ?? getConfig().keepAlive);
  }

  /**
   * Load a model. Ollama loads are a single blocking call with NO progress API
   * and can take MINUTES for a large model. So we don't simply await it: we fire
   * the load AND poll /api/ps for residency, finishing as soon as either the
   * load request returns OR the model shows up resident. While in flight the
   * keep-warm refresh is paused (see startHealthPoll) and the user can cancel.
   */
  private async handleLoadModel(modelID: string): Promise<void> {
    if (this.loadsInFlight.has(modelID)) {
      return; // already loading this one
    }
    const ctrl = new AbortController();
    this.loadsInFlight.set(modelID, ctrl);

    // Fire the (blocking, possibly minutes-long) load via the RAW /api/generate
    // warm call. This call is the AUTHORITATIVE completion signal: Ollama blocks
    // it until the model is actually loaded, then returns done_reason:"load".
    // We do NOT gate on /api/ps — measured against a real server, ps stays empty
    // for a freshly-loaded-but-unused model for well over a minute, so polling it
    // for readiness would clear the spinner long before (or wrongly). Re-issuing
    // a load for an already-resident model is a cheap Ollama no-op, so there's no
    // pre-check either.
    let note: string | undefined;
    try {
      note = await this.awaitLoad(modelID, ctrl.signal);
    } finally {
      this.loadsInFlight.delete(modelID);
    }

    if (ctrl.signal.aborted) {
      this.post({ type: 'status', text: `Cancelled loading ${modelID}.`, kind: 'warn' });
      setTimeout(() => this.post({ type: 'status', text: '' }), 3000);
    } else if (note) {
      this.post({ type: 'status', text: note, kind: 'warn' });
      setTimeout(() => this.post({ type: 'status', text: '' }), 4000);
    } else {
      this.post({ type: 'status', text: '' });
      this.noteOnline(); // a completed load is proof the server is up
    }
    // Refresh model metadata FIRST (picks up real context/loaded from /api/ps,
    // which normally reports the model ~0.1s after the load returns), THEN post
    // loadSettled LAST so that, on success, its authoritative "mark loaded" wins
    // even if that particular ps read transiently missed the just-loaded model.
    // (The load request returning IS proof of residency, independent of ps.)
    await this.refreshModelsToWebview();
    this.post({ type: 'loadSettled', modelID, mode: 'load', error: ctrl.signal.aborted ? 'cancelled' : note });
  }

  /**
   * Reload an already-loaded model to apply a new context size. Ejects first
   * (frees VRAM before reloading at a possibly-larger context, avoiding an OOM /
   * eviction shuffle), then loads at the chosen context (ctxFor reads the
   * override the webview just persisted via setModelCtxPref). Only the explicit
   * Reload affordance reaches here — context is never changed automatically.
   */
  private async handleReloadModel(modelID: string): Promise<void> {
    if (this.loadsInFlight.has(modelID)) {
      return;
    }
    try {
      await this.deps.ollama.unloadModel(modelID); // free VRAM first
    } catch (err) {
      logError(`reload: unload ${modelID}`, err);
    }
    await this.handleLoadModel(modelID); // loads at the new ctxFor() + posts settle
  }

  /**
   * Run the load and resolve when it completes (the /api/generate call returns),
   * fails, or the caller cancels. The load call blocks for the full — possibly
   * multi-minute — load, so we tick `loadProgress` every 2s alongside it for the
   * elapsed display, and resolve as soon as the load settles. Returns an
   * optional problem note (undefined = success).
   */
  private async awaitLoad(modelID: string, signal: AbortSignal): Promise<string | undefined> {
    const model = await this.deps.ollama.getModel(modelID).catch(() => undefined);
    const want = this.ctxFor(modelID, model?.maxContextLength);
    const startedAt = Date.now();

    const tick = setInterval(() => {
      if (!signal.aborted) {
        this.post({
          type: 'loadProgress',
          modelID,
          elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
          note: 'Large models can take a few minutes to load.',
          mode: 'load',
        });
      }
    }, 2000);

    try {
      const result = await Promise.race([
        this.deps.ollama
          .loadModel(modelID, want, this.keepAlive())
          .then(() => ({ kind: 'done' as const, note: undefined as string | undefined }))
          .catch((err) => ({ kind: 'done' as const, note: err instanceof Error ? err.message : String(err) })),
        this.abortSignal(signal).then(() => ({ kind: 'cancel' as const, note: undefined })),
      ]);
      return result.note;
    } finally {
      clearInterval(tick);
    }
  }

  /** A promise that resolves when the signal aborts. */
  private abortSignal(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.resolve();
    }
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  }

  /** Cancel an in-flight load for `modelID` (user pressed Cancel). */
  private cancelLoad(modelID: string): void {
    this.loadsInFlight.get(modelID)?.abort();
  }

  /** Sleep that resolves early if the signal aborts. */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  /**
   * Set a model's context budget. This is OpenCode's `limit.context` (how much
   * it packs before compacting + the meter), baked into the provider config at
   * server start, so restart to apply it. It does not resize the Ollama runner
   * (that's the server's OLLAMA_CONTEXT_LENGTH).
   */
  private async setModelCtx(modelID: string, numCtx: number): Promise<void> {
    await this.deps.prefs.setCtx(modelID, numCtx);
    await this.rebuildServer(`Setting ${modelID} context budget to ${Math.round(numCtx / 1024)}K — restarting…`);
    this.post({ type: 'status', text: '' });
    await this.refreshModelsToWebview();
  }

  /**
   * Set the global keep_alive. This only affects our /api/generate preload and
   * the keep-warm poll (the /v1 chat provider doesn't carry keep_alive), so no
   * server restart is needed — just re-apply to the loaded model now.
   */
  private async setKeepAlive(value: string): Promise<void> {
    await this.deps.prefs.setKeepAlive(value);
    const list = await this.deps.ollama.listModels().catch(() => [] as OllamaModel[]);
    await this.keepWarm(list).catch(() => undefined);
    await this.refreshModelsToWebview();
  }

  /** Tear down and re-initialize OpenCode (rebuilds OPENCODE_CONFIG_CONTENT)
   * while preserving the current session. */
  private async rebuildServer(status: string): Promise<void> {
    this.post({ type: 'status', text: status });
    this.eventAbort?.abort();
    this.eventAbort = undefined;
    this.client = undefined;
    this.deps.server.dispose();
    await this.init();
  }

  /**
   * Eject a model and WAIT for it to actually leave VRAM. The unload request
   * (keep_alive:0) returns near-instantly — but the model lingers in /api/ps for
   * a moment (measured ~1s, longer under load) while it's torn down. So we poll
   * /api/ps until the model is gone (or a timeout) before clearing the spinner,
   * rather than reporting "ejected" while it's still resident.
   */
  private async handleUnloadModel(modelID: string): Promise<void> {
    if (this.loadsInFlight.has(modelID)) {
      return; // a load/eject is already in flight for this model
    }
    const ctrl = new AbortController();
    this.loadsInFlight.set(modelID, ctrl); // pauses keep-warm + powers the spinner
    this.post({ type: 'status', text: `Ejecting ${modelID}…` });
    const startedAt = Date.now();

    const tick = setInterval(() => {
      if (!ctrl.signal.aborted) {
        this.post({
          type: 'loadProgress',
          modelID,
          elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
          note: 'Ejecting…',
          mode: 'eject',
        });
      }
    }, 1000);

    let note: string | undefined;
    try {
      await this.deps.ollama.unloadModel(modelID);
      // Poll until the model is no longer resident (proof it actually unloaded).
      const UNLOAD_TIMEOUT_MS = 30000;
      while (!ctrl.signal.aborted) {
        const stillLoaded = (await this.deps.ollama.loadedInstanceIds(modelID).catch(() => [])).length > 0;
        if (!stillLoaded) {
          break; // gone → done
        }
        if (Date.now() - startedAt > UNLOAD_TIMEOUT_MS) {
          note = 'Eject is taking longer than expected; it may still be unloading.';
          break;
        }
        await this.sleep(1500, ctrl.signal);
      }
    } catch (err) {
      logError(`unload ${modelID}`, err);
      note = err instanceof Error ? err.message : String(err);
    } finally {
      clearInterval(tick);
      this.loadsInFlight.delete(modelID);
    }

    this.post({ type: 'status', text: note ?? '', kind: note ? 'warn' : undefined });
    if (note) {
      setTimeout(() => this.post({ type: 'status', text: '' }), 4000);
    }
    this.post({ type: 'loadSettled', modelID, mode: 'eject', error: note });
    await this.refreshModelsToWebview();
  }

  private async loadModels(): Promise<UiModel[]> {
    return this.mapModels(await this.deps.ollama.listModels());
  }

  private mapModels(list: OllamaModel[]): UiModel[] {
    return list.map((m) => ({
      id: m.id,
      name: m.displayName,
      // undefined state = loaded-state unknown this round (e.g. /api/ps didn't
      // answer); pass it through as undefined so the webview keeps its prior
      // belief instead of falsely flipping a loaded model to "not loaded".
      loaded: m.state === undefined ? undefined : m.state === 'loaded',
      contextLength: m.loadedContextLength,
      maxContextLength: m.maxContextLength,
      numCtx: this.ctxFor(m.id, m.maxContextLength),
      toolUse: m.toolUse,
      vision: m.vision,
      publisher: m.publisher,
      quantization: m.quantization,
      format: m.format,
      created: m.created,
    }));
  }

  private async newSession(announce = true): Promise<void> {
    if (!this.client) {
      throw new Error('OpenCode server is not running.');
    }
    const session = await this.client.createSession('New chat');
    this.currentSessionID = session.id;
    this.updateTitle('New chat');
    this.post({ type: 'cleared' });
    if (announce) {
      await this.sendSessions();
    }
  }

  private async sendSessions(): Promise<void> {
    if (!this.client) {
      return;
    }
    const sessions = await this.client.listSessions();
    const ui: UiSession[] = sessions.map((s) => ({
      id: s.id,
      title: s.title || 'Untitled',
      updated: s.time?.updated ?? 0,
    }));
    const current = ui.find((s) => s.id === this.currentSessionID);
    if (current) {
      this.updateTitle(current.title);
    }
    this.post({ type: 'sessions', sessions: ui, currentSessionID: this.currentSessionID });
  }

  private async clearAllSessions(): Promise<void> {
    if (!this.client) {
      return;
    }
    this.post({ type: 'status', text: 'Clearing sessions…' });
    const sessions = await this.client.listSessions();
    for (const s of sessions) {
      await this.client.deleteSession(s.id).catch(() => undefined);
    }
    this.currentSessionID = null;
    await this.newSession(false);
    this.post({ type: 'cleared' });
    this.post({ type: 'status', text: '' });
    await this.sendSessions();
  }

  /**
   * Compact the current conversation via OpenCode's summarize endpoint — the
   * `/compact` slash command. Blocks input for the duration (`compacting`),
   * then hands the webview the summary text OpenCode produced so it can be shown
   * in the compaction chip. The reduced token count only lands on the next real
   * turn (the summarizer turn reports no usable usage), so we don't fake it here.
   */
  private async compactSession(): Promise<void> {
    if (!this.client || !this.currentSessionID) {
      this.post({ type: 'status', text: 'Nothing to compact yet.', kind: 'warn' });
      return;
    }
    if (!this.currentModel) {
      this.post({ type: 'status', text: 'Select a model before compacting.', kind: 'warn' });
      return;
    }
    this.post({ type: 'compacting', active: true });
    this.post({ type: 'status', text: 'Compacting conversation…' });
    let summary = '';
    try {
      // Same provider id the prompt uses (see handleSend) so the server resolves
      // the summarizer model against the Ollama provider.
      await this.client.summarize(this.currentSessionID, 'ollama', this.currentModel);
      summary = await this.latestSummary(this.currentSessionID);
    } finally {
      // Always release the input, even if summarize threw (onMessage's catch
      // surfaces the error). A stuck "compacting" lock would be worse.
      this.post({ type: 'compacting', active: false, summary });
      this.post({ type: 'status', text: '' });
    }
  }

  /**
   * The summary text from the most recent compaction: the assistant turn that
   * immediately follows a `compaction`-part message. Empty string if none found.
   */
  private async latestSummary(sessionID: string): Promise<string> {
    try {
      const messages = await this.client!.getMessages(sessionID);
      let pending = false;
      let summary = '';
      for (const m of messages) {
        const isMarker = (m.parts ?? []).some((part) => part.type === 'compaction');
        if (isMarker) {
          pending = true;
          continue;
        }
        if (pending && m.info.role === 'assistant') {
          summary = (m.parts ?? [])
            .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
            .map((part) => (part as { text?: string }).text ?? '')
            .join('')
            .trim();
          pending = false;
        }
      }
      return summary;
    } catch {
      return '';
    }
  }

  private async loadSession(sessionID: string): Promise<void> {
    if (!this.client) {
      return;
    }
    this.currentSessionID = sessionID;
    const messages = await this.client.getMessages(sessionID);
    const sessions = await this.client.listSessions();
    const title = sessions.find((s) => s.id === sessionID)?.title ?? 'Chat';
    this.updateTitle(title);
    this.post({ type: 'sessionLoaded', sessionID, title, messages });
  }

  private async handleSend(
    text: string,
    thinking: boolean,
    images: UiImage[],
    includeActiveFile: boolean,
  ): Promise<void> {
    if (!this.client) {
      throw new Error('OpenCode server is not running.');
    }
    if (!this.currentModel) {
      throw new Error('No Ollama model selected.');
    }
    if (!this.currentSessionID) {
      await this.newSession(false);
    }
    const cfg = getConfig();

    if (cfg.autoEnsureContext) {
      const model = await this.deps.ollama.getModel(this.currentModel).catch(() => undefined);
      const result = await this.deps.ollama.ensureContext(
        this.currentModel,
        this.ctxFor(this.currentModel, model?.maxContextLength),
        this.keepAlive(), // floored to ≥5m — never 0
        (m) => this.post({ type: 'status', text: m }),
      );
      if (result.note) {
        log(`ensureContext: ${result.note}`);
      }
      if (result.reloaded) {
        const models = await this.loadModels();
        this.post({ type: 'models', models, currentModel: this.currentModel });
      }
      this.post({ type: 'status', text: '' });
    }

    // Identity: OpenCode's base prompt makes the model call itself "opencode".
    // Our system text is appended, so this overrides the user-facing identity.
    let system =
      'You are "Ollama Code", an agentic coding assistant running on the user\'s machine against their local Ollama models. If asked your name or what you are, identify as "Ollama Code". Never identify yourself as "opencode".';

    // Thinking control. Qwen-family models honor the `/no_think` soft switch
    // (consumed by the chat template); for others fall back to a system hint.
    let promptText = text;
    if (!thinking) {
      if (/qwen/i.test(this.currentModel)) {
        promptText = `${text}\n\n/no_think`;
      } else {
        system += '\n\nAnswer directly and concisely. Do not produce private chain-of-thought or <think> reasoning blocks.';
      }
    }

    const parts: PromptBody['parts'] = [{ type: 'text', text: promptText }];
    for (const img of images) {
      parts.push({ type: 'file', mime: img.mime, url: img.dataUrl, filename: img.name });
    }
    // Attach the currently open file as context (excludable from the UI).
    if (includeActiveFile && this.activeFile) {
      try {
        const MAX = 80 * 1024;
        let content = fs.readFileSync(this.activeFile.abs, 'utf8');
        if (content.length > MAX) {
          content = content.slice(0, MAX) + '\n\n…[truncated]';
        }
        parts.push({
          type: 'file',
          mime: 'text/plain',
          filename: this.activeFile.rel,
          url: `file://${this.activeFile.abs}`,
          source: { type: 'file', path: this.activeFile.abs, text: { value: content, start: 0, end: content.length } },
        });
      } catch (err) {
        logError('attach active file failed', err);
      }
    }

    this.post({ type: 'busy', busy: true });
    await this.client.promptAsync(this.currentSessionID!, {
      model: { providerID: 'ollama', modelID: this.currentModel },
      agent: this.agent,
      ...(system ? { system } : {}),
      parts,
    });

    // Auto-name the session from the first user prompt.
    if ((this.currentTitle === 'New chat' || this.currentTitle === '') && text.trim()) {
      const title = deriveTitle(text);
      if (title) {
        try {
          await this.client.updateSession(this.currentSessionID!, { title });
        } catch (err) {
          logError('auto-title failed', err);
        }
        this.updateTitle(title);
        await this.sendSessions();
      }
    }
  }

  private startEventStream(): void {
    if (this.eventAbort || !this.client) {
      return;
    }
    this.eventAbort = new AbortController();
    void this.client.subscribeEvents((event) => this.relayEvent(event), this.eventAbort.signal);
  }

  /** Forward only events that belong to the active session (plus globals). */
  private relayEvent(event: OpencodeEvent): void {
    const sid = sessionIdOf(event);
    // Drop a session-scoped event unless it's for the active session. Also drop
    // it when no session is active yet (sid set, currentSessionID null) so a
    // stray event mid-init can't leak into the webview.
    if (sid && sid !== this.currentSessionID) {
      return;
    }
    this.post({ type: 'event', event });
  }

  private async openFile(p: string): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      logError(`openFile ${abs}`, err);
    }
  }
}

function sessionIdOf(event: OpencodeEvent): string | undefined {
  const p = event.properties as any;
  return (
    p?.sessionID ??
    p?.info?.sessionID ??
    p?.part?.sessionID ??
    undefined
  );
}

/** Derive a concise session title from the first user prompt. */
function deriveTitle(text: string): string {
  let t = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) {
    return '';
  }
  const firstSentence = t.split(/(?<=[.!?])\s|\n/)[0].trim() || t;
  const words = firstSentence.split(' ').slice(0, 8).join(' ');
  let title = words.length > 52 ? words.slice(0, 52).trim() + '…' : words;
  title = title.replace(/[.,;:]+$/, '');
  return title.charAt(0).toUpperCase() + title.slice(1);
}

