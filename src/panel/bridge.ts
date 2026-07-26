import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { commandTakesArgs } from '../core/commands';
import { clampContext } from '../core/context';
import {
  Goal,
  buildContinuePrompt,
  buildJudgePrompt,
  buildRevisionPrompt,
  decideNext,
  newGoal,
  parseJudgeVerdict,
  parseRevisionVerdict,
} from '../core/goal';
import { clampKeepAlive } from '../core/keepAlive';
import { humanizeError, isConnectionError } from '../core/errors';
import { ConnectResult, SelfHealer } from '../core/reconnect';
import { ProbeStatus } from '../core/health';
import { pickModel } from '../core/models';
import { selectionLabel } from '../core/selection';
import { emptySessionCandidates } from '../core/sessions';
import { classifySkills } from '../core/skills';
import { ServerRegistry } from '../connection';
import { OllamaClient, OllamaModel } from '../ollama/client';
import { log, logError } from '../logger';
import { discoverMcpServers } from '../mcp/discovery';
import { OpencodeClient } from '../opencode/client';
import { OpencodeEvent, PromptBody } from '../opencode/protocol';
import { Disposable, OpencodeServerManager } from '../opencode/serverManager';
import { Prefs } from '../prefs';
import {
  HostToWebview,
  UiCommand,
  UiGoal,
  UiImage,
  UiMcpServer,
  UiModel,
  UiSession,
  UiSkill,
  WebviewToHost,
} from '../shared';

export interface BridgeDeps {
  context: vscode.ExtensionContext;
  server: OpencodeServerManager;
  ollama: OllamaClient;
  servers: ServerRegistry;
  prefs: Prefs;
}

/** globalState flag: the one-time empty-session migration has already run. */
const PRUNED_EMPTIES_KEY = 'ollamaCode.prunedEmptySessions';
/** workspaceState key: the last active session, restored on the next launch. */
const LAST_SESSION_KEY = 'ollamaCode.lastSessionID';
/**
 * Window-scoped claim so only the FIRST bridge to initialize (in practice the
 * sidebar view on launch) restores the persisted session — every panel shares
 * the one workspaceState slot, and siblings must not all open the same
 * conversation.
 */
let sessionRestoreClaimed = false;

/**
 * Health poll cadence while disconnected (ms). Kept fast so a restarted Ollama
 * is picked up promptly; the *connected* cadence is the configurable
 * `ollamaCode.healthCheckSeconds` (default 30s) — a healthy idle panel
 * shouldn't flood Ollama's server log with queries (LM Studio Code issue #7).
 */
const OFFLINE_HEALTH_INTERVAL_MS = 5000;
/** Refresh the model list every N health ticks while connected. */
const REFRESH_EVERY_TICKS = 3;
/** Fast model-list refresh cadence while the model picker is open (ms). */
const PICKER_REFRESH_MS = 4000;
/**
 * Consecutive probe timeouts before we believe Ollama is gone. A single slow
 * probe (server saturated mid-generation or mid-load) must not pop the offline
 * banner; a refused connection still flips immediately.
 */
const OFFLINE_AFTER_TIMEOUTS = 3;
/**
 * Keep-warm cadence (ms): re-assert keep_alive on the selected model this
 * often, independent of the model-list refresh. Must stay comfortably under
 * MIN_KEEP_ALIVE_SECONDS (5 min) or the model unloads between pings — this is
 * also why healthCheckSeconds is clamped to at most 120s.
 */
const KEEP_WARM_EVERY_MS = 120_000;

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
  /** In-flight createSession promise, so concurrent first-sends share one. */
  private ensuringSession: Promise<void> | undefined;
  /** Whether this bridge already ran its one launch-time session restore. */
  private restoreAttempted = false;
  /**
   * The active goal loop, or null. `paused` keeps the goal pinned without
   * auto-continuing (user pressed Stop / pause, or a safety cap tripped).
   * Session-scoped: cleared on new chat / session switch.
   */
  private activeGoal: (Goal & { startedAt: number; paused: boolean }) | null = null;
  /** True while a judge check is in flight (prevents concurrent checks). */
  private goalChecking = false;
  /** True while a goal-revision check is in flight (prevents concurrent checks). */
  private revisionChecking = false;
  /** Last time the loop advanced — drives the health-tick watchdog. */
  private lastGoalActivity = 0;
  private activeFile: { abs: string; rel: string; chars: number } | null = null;
  /**
   * The current editor selection, tracked live like the active file. `text` is
   * the exact selected text (from getText, so multi-byte safe); start/end are
   * character offsets (from offsetAt) into the document; lines are 1-based for
   * display. Null whenever there's no non-empty file selection — which also
   * covers Markdown-preview panes (they aren't text editors, so no selection).
   */
  private activeSelection:
    | { abs: string; rel: string; text: string; start: number; end: number; startLine: number; endLine: number }
    | null = null;
  private editorSub: vscode.Disposable | undefined;
  private selectionSub: vscode.Disposable | undefined;
  private messageSub: vscode.Disposable | undefined;
  private serverExitSub: Disposable | undefined;
  /**
   * Pure self-heal policy (reconnect timing, backoff, reload-after-reconnect).
   * Ollama-specific duties stay OUT of here: keep-warm runs on its own wall
   * clock in runHealthTick, because it must be re-asserted well inside its
   * 5-minute minimum even on ticks where no model refresh is due.
   */
  private readonly healer: SelfHealer = new SelfHealer(
    {
      // Share one probe across all panels' ticks: a result younger than ~80% of
      // the cadence IN EFFECT is fresh enough to reuse — while disconnected
      // that cadence is the fast 5s one, so a restarted Ollama is noticed
      // within ~5s.
      probeUpstream: () => {
        const cadence = this.connected ? this.healthIntervalMs() : OFFLINE_HEALTH_INTERVAL_MS;
        return this.deps.ollama.probeHealth(Math.floor(cadence * 0.8));
      },
      serverHealthy: () => this.deps.server.isRunning && !!this.client,
      isConnected: () => this.connected,
      goOffline: () => this.markOffline(),
      connect: () => this.init(),
      // Skip the refresh while a load is in flight: the server is busy (possibly
      // for minutes) and an extra listModels (/api/ps + parallel /api/show)
      // contends with — and can stall — the load.
      reloadModels: async () => {
        if (this.loadsInFlight.size === 0) {
          await this.refreshModelsToWebview('periodic');
        }
      },
    },
    {
      refreshEvery: REFRESH_EVERY_TICKS,
      offlineAfterTimeouts: OFFLINE_AFTER_TIMEOUTS,
      backoff: { base: 2000, max: 30000 },
    },
  );
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private healthTicks = 0;
  /** Next wall-clock time (ms) the upstream probe is due; 0 = due now. */
  private nextProbeDueAt = 0;
  /** Consecutive health-probe timeouts (see OFFLINE_AFTER_TIMEOUTS). */
  private timeoutStreak = 0;
  /** Last time keep_alive was re-asserted on the selected model. */
  private lastKeepWarmAt = 0;
  /** Fast refresh loop while the webview's model picker is open. */
  private pickerTimer: ReturnType<typeof setInterval> | undefined;
  /** Whether this webview is currently visible (hidden panels stay alive). */
  private visible = true;
  /** JSON of the last 'models' payload posted — suppresses no-op refreshes. */
  private lastPostedModelsJson = '';
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
    this.editorSub = vscode.window.onDidChangeActiveTextEditor((e) => {
      this.updateActiveFile(e);
      this.updateSelection(e);
    });
    this.selectionSub = vscode.window.onDidChangeTextEditorSelection((e) =>
      this.updateSelection(e.textEditor),
    );
    // Self-heal when the shared OpenCode server dies unexpectedly. Without this
    // the panel keeps reporting `connected` against a dead client forever.
    this.serverExitSub = this.deps.server.addExitListener(() => this.onServerExit());
  }

  dispose(): void {
    this.disposed = true;
    this.messageSub?.dispose();
    this.eventAbort?.abort();
    this.editorSub?.dispose();
    this.selectionSub?.dispose();
    this.serverExitSub?.dispose();
    for (const ctrl of this.loadsInFlight.values()) {
      ctrl.abort(); // stop any readiness-poll loops
    }
    this.loadsInFlight.clear();
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    if (this.pickerTimer) {
      clearInterval(this.pickerTimer);
      this.pickerTimer = undefined;
    }
  }

  /** The connected-state poll cadence (ms), from user settings. */
  private healthIntervalMs(): number {
    return getConfig().healthCheckSeconds * 1000;
  }

  /**
   * Poll Ollama so the panel self-heals: when the server comes online after
   * being down we auto-connect (no manual Retry), and while connected we
   * periodically refresh the model list so newly loaded/pulled models appear.
   *
   * The timer is a fixed 5s metronome that only PROBES when due: every tick
   * while disconnected, every healthCheckSeconds while connected. A fixed
   * interval (rather than a rescheduled timeout) survives a tick that throws,
   * and reacts within 5s when some out-of-tick path flips us offline —
   * postServers(false) resets the due time. Config changes take effect on the
   * next due probe.
   */
  private startHealthPoll(): void {
    if (this.healthTimer || this.disposed) {
      return;
    }
    this.healthTimer = setInterval(() => void this.runHealthTick(), OFFLINE_HEALTH_INTERVAL_MS);
  }

  private async runHealthTick(): Promise<void> {
    if (this.disposed || this.connecting) {
      return;
    }
    if (Date.now() >= this.nextProbeDueAt) {
      const started = Date.now();
      try {
        await this.healer.tick();
      } finally {
        // While disconnected the next metronome tick (5s) probes again; while
        // connected wait out the configured cadence. Anchor to the tick START
        // (minus slack for timer drift) — anchoring to completion would push
        // the due time past the next tick whenever the cadence equals the
        // metronome period, silently halving the probe rate.
        this.nextProbeDueAt = this.connected ? started + this.healthIntervalMs() - 500 : 0;
      }
    }
    // Keep-warm runs on its own wall clock, decoupled from the (slower,
    // refreshEvery-gated) model refresh the healer drives: keep_alive must be
    // re-asserted well within its 5-minute minimum even for hidden panels, and
    // even on ticks where no refresh is due. Paused while a load is in flight.
    if (
      this.connected &&
      this.loadsInFlight.size === 0 &&
      Date.now() - this.lastKeepWarmAt >= KEEP_WARM_EVERY_MS
    ) {
      this.lastKeepWarmAt = Date.now();
      await this.keepWarmNow().catch(() => undefined);
    }
    // Goal watchdog ("wake up on occasion"): if the loop lost its idle signal
    // (e.g. an error swallowed the event) re-check once things are quiet.
    if (
      this.activeGoal &&
      !this.activeGoal.paused &&
      !this.goalChecking &&
      Date.now() - this.lastGoalActivity > 120_000
    ) {
      this.lastGoalActivity = Date.now(); // back off between watchdog retries
      if (!(await this.isSessionBusy())) {
        void this.runGoalCheck();
      }
    }
  }

  /** LM/Ollama went away — keep the live OpenCode server, just show the banner. */
  private markOffline(): void {
    this.connected = false;
    this.postServers(false);
    this.post({ type: 'status', text: 'Lost connection to Ollama — reconnecting…', kind: 'warn' });
  }

  /** The shared OpenCode server crashed: drop our stale client + stream, reconnect. */
  private onServerExit(): void {
    if (this.disposed) {
      return;
    }
    log('opencode server exited unexpectedly — reconnecting');
    this.teardownConnection(false); // server is already gone
    this.healer.allowImmediate(); // permit an immediate reconnect
    this.post({ type: 'status', text: 'Reconnecting…', kind: 'warn' });
    void this.healer.reconnect(); // reconnects + reloads models on success
  }

  /**
   * Abort the event stream and drop the client so a fresh connect re-subscribes
   * cleanly. Only dispose the *shared* server when asked (and when it is ours to
   * dispose) — other panels may still be using it.
   */
  private teardownConnection(disposeServer: boolean): void {
    this.eventAbort?.abort();
    this.eventAbort = undefined;
    this.client = undefined;
    if (disposeServer) {
      this.deps.server.dispose();
    }
  }

  /** True when Ollama is reachable and we have a live OpenCode client. */
  private isLive(): boolean {
    return this.connected && !!this.client && this.deps.server.isRunning;
  }

  /**
   * Re-establish the connection after a transient failure. If the OpenCode
   * process is gone we fully re-init (which respawns it); otherwise we just
   * re-verify Ollama and reuse the running server. The healer reloads models on
   * success. Returns whether we are live afterwards.
   */
  private async reconnect(): Promise<boolean> {
    if (!this.deps.server.isRunning) {
      this.teardownConnection(false);
    }
    return this.healer.reconnect();
  }

  /**
   * Visibility changed (sidebar collapsed, tab moved to background). Hidden
   * panels keep their slow self-heal poll and keep-warm duty but skip model
   * refreshes; on becoming visible again, catch up immediately.
   */
  setVisible(visible: boolean): void {
    if (visible === this.visible) {
      return;
    }
    this.visible = visible;
    if (visible && this.connected) {
      void this.refreshModelsToWebview('periodic').catch(() => undefined);
    }
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

  /**
   * Track the current editor selection so it can be auto-attached as context,
   * the way Claude Code shares the highlighted code. Cleared (and the pill
   * removed) whenever the selection is empty or the editor isn't a real file —
   * which is also why a Markdown *preview* never produces a selection (it's not
   * a TextEditor). Uses getText() for the exact text (multi-byte safe) and
   * offsetAt() for character offsets, so the range we hand OpenCode lines up
   * with the text even with emoji/accented characters in the document.
   */
  private updateSelection(editor: vscode.TextEditor | undefined): void {
    // Keep the last real selection when focus moves to the webview/panel (the
    // editor goes undefined) — same as updateActiveFile. Otherwise the user's
    // highlighted code would vanish the instant they click into the composer to
    // type, which is the primary "highlight → ask about it" flow.
    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }
    const sel = editor.selection;
    if (!sel || sel.isEmpty) {
      // A real file editor with no (longer a) selection — the user deselected.
      if (this.activeSelection) {
        this.activeSelection = null;
        this.post({ type: 'activeSelection', selection: null });
      }
      return;
    }
    const doc = editor.document;
    const abs = doc.uri.fsPath;
    const text = doc.getText(sel);
    this.activeSelection = {
      abs,
      rel: vscode.workspace.asRelativePath(abs),
      text,
      start: doc.offsetAt(sel.start),
      end: doc.offsetAt(sel.end),
      startLine: sel.start.line + 1, // 1-based for display (App.tsx#14-19)
      endLine: sel.end.line + 1,
    };
    this.post({
      type: 'activeSelection',
      selection: {
        path: this.activeSelection.rel,
        startLine: this.activeSelection.startLine,
        endLine: this.activeSelection.endLine,
        chars: text.length,
      },
    });
  }

  /** Start a fresh conversation (invoked by the New Chat command). */
  async requestNewChat(): Promise<void> {
    await this.newSession();
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
          // A fresh webview always starts with the picker closed — stop any
          // fast-poll loop a previous webview incarnation left running (iframe
          // reloads never send modelMenu open:false).
          this.setModelMenuOpen(false);
          await this.init();
          break;
        case 'send':
          // While a goal is set, quietly check (in the background — the send
          // must not wait on the local model) whether this message changes the
          // goal; if so the user gets a confirm card before it actually does.
          this.maybeOfferGoalRevision(msg.text);
          await this.handleSend(
            msg.text,
            msg.thinking,
            msg.images ?? [],
            msg.includeActiveFile ?? false,
            msg.includeSelection ?? false,
          );
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
        case 'modelMenu':
          this.setModelMenuOpen(msg.open);
          break;
        case 'listServers':
          this.postServers(this.connected);
          break;
        case 'addServer':
          await this.deps.servers.add(msg.name, msg.url);
          this.postServers(this.connected);
          break;
        case 'updateServer': {
          const before = this.deps.servers.list().find((s) => s.id === msg.id);
          await this.deps.servers.update(msg.id, msg.name, msg.url);
          const after = this.deps.servers.list().find((s) => s.id === msg.id);
          // A rename (or no-op Save) must not tear down a live session — only
          // reconnect when the URL the connection is built on actually changed.
          const connectionChanged = !!before && !!after && before.url !== after.url;
          if (this.deps.servers.active().id === msg.id && connectionChanged) {
            await this.switchServer(msg.id);
          } else {
            this.postServers(this.connected);
          }
          break;
        }
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
          // Stop means stop: pause the goal loop BEFORE aborting, so the abort's
          // session.idle event can't race in and immediately re-continue the
          // turn the user just killed (resume from the goal bar).
          if (this.activeGoal && !this.activeGoal.paused) {
            this.activeGoal.paused = true;
            this.postGoal();
            this.post({ type: 'status', text: 'Goal paused — resume from the goal bar.', kind: 'warn' });
          }
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
        case 'openInTab':
          await vscode.commands.executeCommand('ollamaCode.openInTab');
          break;
        case 'requestMcpStatus':
          await this.sendMcpStatus();
          break;
        case 'requestSkills':
          await this.sendSkills();
          break;
        case 'runCommand':
          await this.handleRunCommand(msg.command, msg.arguments);
          break;
        case 'setGoal':
          await this.setGoal(msg.objective);
          break;
        case 'updateGoal': {
          // A confirmed revision: swap the objective in place. The revised goal
          // gets a fresh iteration budget, and old stall reasons no longer
          // apply; elapsed time and paused state carry over.
          const g = this.activeGoal;
          const obj = msg.objective.trim();
          if (g && obj) {
            g.objective = obj;
            g.iteration = 0;
            g.recentReasons = [];
            this.lastGoalActivity = Date.now();
            this.postGoal();
            this.post({ type: 'goalEvent', kind: 'updated', reason: obj });
          }
          break;
        }
        case 'pauseGoal':
          if (this.activeGoal) {
            this.activeGoal.paused = true;
            this.postGoal();
          }
          break;
        case 'resumeGoal':
          await this.resumeGoal();
          break;
        case 'clearGoal':
          this.activeGoal = null;
          this.postGoal();
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

  private async init(): Promise<ConnectResult> {
    this.startHealthPoll();
    if (this.connecting) {
      return this.isLive() ? 'connected' : 'upstream-down';
    }
    this.connecting = true;
    try {
      return await this.doInit();
    } finally {
      this.connecting = false;
    }
  }

  private async doInit(): Promise<ConnectResult> {
    const cfg = getConfig();
    const active = this.deps.servers.active();
    this.deps.ollama.setBaseUrl(active.url);
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    this.post({ type: 'status', text: `Connecting to ${active.name}…` });
    this.connected = await this.deps.ollama.checkConnection();
    this.postServers(this.connected);

    // Offline: show the connection screen and wait for retry / switch.
    if (!this.connected) {
      // The webview now shows models: [] — resync the periodic diff-guard so
      // the next healthy refresh always posts (a stale healthy snapshot here
      // would suppress it and freeze the picker on "No models found").
      this.lastPostedModelsJson = '';
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
      log(`doInit: Ollama unreachable at ${active.url}`);
      // No backoff for this — the poll recovers the moment Ollama answers again.
      return 'upstream-down';
    }

    this.post({ type: 'status', text: 'Starting OpenCode server…' });
    let started;
    try {
      started = await this.deps.server.start();
    } catch (err) {
      // Ollama is fine but OpenCode failed to come up — report 'failed' so the
      // healer backs off instead of respawning a broken server every tick.
      logError('opencode server failed to start', err);
      const message = humanizeError(err, { subject: 'the OpenCode server' });
      this.post({ type: 'error', message });
      this.lastPostedModelsJson = ''; // webview shows models: [] — resync diff-guard
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
      return 'failed';
    }
    this.client = started.client;

    const models = await this.loadModels();
    const stored = this.deps.context.workspaceState.get<string>('ollamaCode.model');
    // The live in-session selection wins over configuration: a self-heal
    // reconnect mid-conversation must never silently switch the user's model
    // back to defaultModel. defaultModel only decides on a fresh panel.
    this.currentModel =
      pickModel([this.currentModel ?? '', cfg.defaultModel, stored ?? ''], models) ?? null;

    this.startEventStream();

    this.lastPostedModelsJson = JSON.stringify({ models, currentModel: this.currentModel });
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
    // Restore the last active conversation — idea contributed by
    // @AlessandroPerazzetta (lmstudio-vscode-chat PR #8), reworked to run only
    // on a bridge's FIRST init: doInit also runs on every self-heal reconnect,
    // where re-posting sessionLoaded would wipe and re-render a live transcript.
    await this.maybeRestoreLastSession();
    // No eager session: a fresh chat stays null until the first message creates
    // it lazily (handleSend), so an empty "New chat" never shows in history.
    if (!this.currentSessionID) {
      this.updateTitle('New chat');
      this.post({ type: 'cleared' });
    }
    // One-time migration: clean up empty sessions created before sessions went
    // lazy. Gated behind a PERSISTED flag (not a per-instance one) so it runs
    // once per install — every panel re-resolve / editor tab spins up a new
    // ChatBridge, and re-running this destructive scan each time is both wasteful
    // and widens the race window against sibling bridges' in-flight sessions.
    if (!this.deps.context.globalState.get(PRUNED_EMPTIES_KEY)) {
      void this.deps.context.globalState.update(PRUNED_EMPTIES_KEY, true);
      void this.pruneEmptySessions();
    }
    // Populate the slash menu with the server's commands + skills.
    void this.sendCommands();
    this.updateActiveFile(vscode.window.activeTextEditor);
    this.updateSelection(vscode.window.activeTextEditor);
    this.warnIfAgentsLarge();
    // Clean connect — clear any reconnect backoff held by the healer.
    this.healer.noteConnected();
    this.post({ type: 'status', text: '' });
    return 'connected';
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

  /**
   * Gather MCP server status for the `/mcp` panel: the live connection state
   * from the server (GET /mcp) cross-referenced with the discovered config so
   * each row also shows its transport + command/url — even a failed or disabled
   * server the live map might report tersely. Posts an `mcpStatus` message;
   * `servers: []` means none are configured.
   */
  private async sendMcpStatus(): Promise<void> {
    // Configured servers (for transport + detail), keyed by name.
    let configured: ReturnType<typeof discoverMcpServers>['map'] = {};
    try {
      configured = discoverMcpServers().map;
    } catch (err) {
      logError('mcp discovery for /mcp panel', err);
    }

    // Live status from the running server, if reachable. Failure to fetch
    // (server down) just means we show the configured set without live state.
    let live: Record<string, { status?: string; error?: string }> = {};
    if (this.client) {
      try {
        live = (await this.client.listMcp()) as typeof live;
      } catch (err) {
        logError('GET /mcp failed', err);
      }
    }

    // Union the two key sets so a configured-but-not-yet-reported server still
    // shows, and a live server we somehow didn't configure isn't hidden.
    const names = new Set<string>([...Object.keys(configured), ...Object.keys(live)]);
    const servers: UiMcpServer[] = [...names].sort().map((name) => {
      const cfg = configured[name];
      const transport: 'local' | 'remote' | undefined = cfg
        ? cfg.type === 'remote'
          ? 'remote'
          : 'local'
        : undefined;
      let detail: string | undefined;
      if (cfg?.type === 'remote') {
        detail = cfg.url;
      } else if (cfg?.type === 'local') {
        detail = cfg.command.join(' ');
      }
      // A configured-but-disabled server may not appear in the live map; reflect
      // its config state so the panel still shows it as disabled.
      const status = live[name]?.status ?? (cfg?.enabled === false ? 'disabled' : 'pending');
      return { name, status, error: live[name]?.error, transport, detail };
    });

    this.post({ type: 'mcpStatus', servers });
  }

  /**
   * Gather the skills OpenCode discovered (GET /skill) for the `/skills` panel,
   * classifying each by where it came from so the user can confirm their
   * project/global/Claude-Code skills are being found. Posts a `skills`
   * message; `skills: []` means none were discovered.
   */
  private async sendSkills(): Promise<void> {
    let skills: UiSkill[] = [];
    if (this.client) {
      try {
        const raw = await this.client.listSkills();
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        // Classification (project / global / built-in) is pure — see core/skills.
        skills = classifySkills(raw, root);
      } catch (err) {
        logError('GET /skill failed', err);
      }
    }
    this.post({ type: 'skills', skills });
  }

  /**
   * Send the server's slash commands (custom/built-in commands AND skills) to
   * the webview so they appear in the composer's slash menu. Skills carry
   * source:'skill' so the menu can badge them.
   */
  private async sendCommands(): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      const raw = await this.client.listCommands();
      const commands: UiCommand[] = raw.map((c) => ({
        name: c.name,
        description: c.description ?? '',
        source: c.source === 'skill' ? 'skill' : 'command',
        takesArgs: commandTakesArgs(c.hints),
      }));
      this.post({ type: 'commands', commands });
    } catch (err) {
      logError('GET /command failed', err);
    }
  }

  /**
   * Run a server command or skill (e.g. the user typed "/fibonacci-helper x").
   * Creates the session lazily if needed (a command is real activity, so it
   * earns a history entry), ensures the model context, then hands off to
   * OpenCode which expands the template and streams the result like a prompt.
   */
  private async handleRunCommand(command: string, args?: string): Promise<void> {
    if (!this.client) {
      throw new Error('OpenCode server is not running.');
    }
    if (!this.currentModel) {
      throw new Error('No Ollama model selected.');
    }
    await this.ensureSession();
    const cfg = getConfig();
    if (cfg.autoEnsureContext) {
      try {
        const model = await this.deps.ollama.getModel(this.currentModel).catch(() => undefined);
        await this.deps.ollama.ensureContext(
          this.currentModel,
          this.ctxFor(this.currentModel, model?.maxContextLength),
          this.keepAlive(),
          (m) => this.post({ type: 'status', text: m }),
        );
      } catch (err) {
        logError('ensureContext for command', err);
      }
      this.post({ type: 'status', text: '' });
    }
    this.post({ type: 'busy', busy: true });
    // `arguments` is a REQUIRED field on POST /session/{id}/command — omitting it
    // 400s ("Missing key … arguments"), which breaks every no-arg command/skill.
    // Always send the key, empty when the command takes no arguments.
    await this.client.runCommand(this.currentSessionID!, {
      command,
      arguments: args ?? '',
      agent: this.agent,
      model: `ollama/${this.currentModel}`,
    });
    await this.sendSessions();
  }

  // ---- Goal loop -----------------------------------------------------------
  // /goal <objective> sets an autonomous goal: after every turn goes idle, an
  // isolated LLM judge decides MET / NOT_MET; NOT_MET auto-continues the agent
  // with the judge's feedback until the goal is met or an unreasonable endpoint
  // is hit (iteration cap or no-progress stall — see core/goal). The judge runs
  // in a throwaway session that is deleted after each check so it never touches
  // the conversation or the history list.

  private postGoal(): void {
    const g = this.activeGoal;
    const goal: UiGoal | null = g
      ? {
          objective: g.objective,
          iteration: g.iteration,
          maxIterations: g.maxIterations,
          startedAt: g.startedAt,
          state: g.paused ? 'paused' : 'active',
        }
      : null;
    this.post({ type: 'goal', goal });
  }

  /** Set (or replace) the goal and kick off pursuit immediately. */
  private async setGoal(objective: string): Promise<void> {
    const obj = objective.trim();
    if (!obj) {
      return;
    }
    this.activeGoal = { ...newGoal(obj), startedAt: Date.now(), paused: false };
    this.lastGoalActivity = Date.now();
    this.postGoal();
    // Kick off right away (like Codex's "Pursuing goal…"): the first turn tells
    // the agent the goal; the idle→judge→continue loop sustains it from there.
    await this.handleSend(
      `Work toward this goal until it is fully met: ${obj}`,
      true,
      [],
      false,
      false,
    );
  }

  /** Un-pause the loop; if the session is already idle, get moving again now. */
  private async resumeGoal(): Promise<void> {
    if (!this.activeGoal) {
      return;
    }
    this.activeGoal.paused = false;
    this.lastGoalActivity = Date.now();
    this.postGoal();
    if (!(await this.isSessionBusy())) {
      void this.runGoalCheck();
    }
  }

  /** Whether the current session has a turn in flight (server-side truth). */
  private async isSessionBusy(): Promise<boolean> {
    try {
      const st = await this.client?.sessionStatus();
      return !!(st && this.currentSessionID && st[this.currentSessionID]);
    } catch {
      return false;
    }
  }

  /** The user-facing identity override (shared by sends + goal continues). */
  private identitySystem(): string {
    return 'You are "Ollama Code", an agentic coding assistant running on the user\'s machine against their local Ollama models. If asked your name or what you are, identify as "Ollama Code". Never identify yourself as "opencode".';
  }

  /** The goal directive appended to the agent's system prompt while active. */
  private goalSystemSuffix(): string {
    const g = this.activeGoal;
    if (!g || g.paused) {
      return '';
    }
    return (
      `\n\nACTIVE GOAL: ${g.objective}\n` +
      'Keep working toward this goal across turns until it is fully met. ' +
      'Prefer taking the next concrete action over asking for confirmation.'
    );
  }

  /** session.idle hook — run one judge check (debounced by the checking flag). */
  private async onTurnIdle(): Promise<void> {
    if (!this.activeGoal || this.activeGoal.paused || this.goalChecking || this.disposed) {
      return;
    }
    await new Promise((r) => setTimeout(r, 600)); // let final parts persist
    void this.runGoalCheck();
  }

  /** One loop step: transcript → judge → met / continue / stop. */
  private async runGoalCheck(): Promise<void> {
    const goal = this.activeGoal;
    if (
      !goal ||
      goal.paused ||
      this.goalChecking ||
      !this.client ||
      !this.currentSessionID ||
      !this.currentModel
    ) {
      return;
    }
    this.goalChecking = true;
    this.post({ type: 'goalEvent', kind: 'checking' });
    try {
      const transcript = await this.transcriptTail(this.currentSessionID);
      const verdict = await this.judgeGoal(goal.objective, transcript);
      // The goal may have been cleared/edited/paused while the judge ran.
      if (this.activeGoal !== goal || goal.paused) {
        return;
      }
      const action = decideNext(goal, verdict);
      this.lastGoalActivity = Date.now();
      if (action.kind === 'met') {
        this.activeGoal = null;
        this.postGoal();
        this.post({ type: 'goalEvent', kind: 'met', reason: action.reason });
      } else if (action.kind === 'continue') {
        goal.iteration = action.iteration;
        goal.recentReasons = [...goal.recentReasons, action.reason].slice(-5);
        this.postGoal();
        this.post({
          type: 'goalEvent',
          kind: 'continued',
          reason: action.reason,
          iteration: action.iteration,
        });
        await this.continueGoal(goal.objective, action.reason);
      } else {
        // Unreasonable endpoint (cap or stall): pause, keep the goal pinned so
        // the user can see why and resume/raise the cap if they want.
        goal.paused = true;
        this.postGoal();
        this.post({ type: 'goalEvent', kind: 'stopped', why: action.why, reason: action.reason });
      }
    } catch (err) {
      logError('goal check failed', err);
    } finally {
      this.goalChecking = false;
    }
  }

  /** Judge in an isolated throwaway session; always delete it afterwards. */
  private async judgeGoal(
    objective: string,
    transcript: string,
  ): Promise<{ met: boolean; reason: string }> {
    const reply = await this.askThrowaway(
      'goal-judge',
      buildJudgePrompt(objective, transcript),
      'You are a strict goal-completion judge. Answer directly and concisely. ' +
        'Do not produce chain-of-thought.',
    );
    if (!reply.trim()) {
      return { met: false, reason: 'judge timed out' };
    }
    return parseJudgeVerdict(reply);
  }

  /**
   * Ask the current model one question in an isolated throwaway session and
   * return its raw reply text ('' on timeout or disposal). The session never
   * touches chat history — it is always deleted afterwards.
   */
  private async askThrowaway(title: string, prompt: string, system: string): Promise<string> {
    const client = this.client!;
    const session = await client.createSession(title);
    try {
      let text = prompt;
      if (/qwen/i.test(this.currentModel!)) {
        text += '\n\n/no_think'; // qwen soft-switch: skip <think> for a fast verdict
      }
      await client.promptAsync(session.id, {
        model: { providerID: 'ollama', modelID: this.currentModel! },
        system,
        parts: [{ type: 'text', text }],
      });
      // Poll for the completed assistant reply (local models can be slow).
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        if (this.disposed) {
          return '';
        }
        const msgs = await client.getMessages(session.id);
        const done = [...msgs]
          .reverse()
          .find((m) => m.info.role === 'assistant' && m.info.time?.completed);
        if (done) {
          return (done.parts ?? [])
            .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
            .map((p) => (p as { text?: string }).text ?? '')
            .join('\n');
        }
      }
      return '';
    } finally {
      void client.deleteSession(session.id).catch(() => undefined);
    }
  }

  /**
   * While a goal is set, ask the model whether a message the user just typed
   * changes the goal itself. If it does, offer the revised objective for
   * confirmation — the goal only changes when the user accepts (updateGoal).
   * Fire-and-forget: the message already went to the agent as a send/steer.
   */
  private maybeOfferGoalRevision(text: string): void {
    const goal = this.activeGoal;
    const trimmed = (text ?? '').trim();
    if (!goal || this.revisionChecking || !this.client || !this.currentModel) {
      return;
    }
    // Slash commands and trivial acks ("ok", "go") can't redefine a goal.
    if (!trimmed || trimmed.startsWith('/') || trimmed.length < 4) {
      return;
    }
    this.revisionChecking = true;
    void (async () => {
      try {
        const reply = await this.askThrowaway(
          'goal-revise',
          buildRevisionPrompt(goal.objective, trimmed),
          'You decide whether a user message changes an agent\'s goal. ' +
            'Answer directly and concisely. Do not produce chain-of-thought.',
        );
        const verdict = parseRevisionVerdict(reply, goal.objective);
        // The goal may have been cleared or replaced while the model thought.
        if (!verdict.revise || !verdict.objective || this.activeGoal !== goal) {
          return;
        }
        this.post({ type: 'goalRevision', proposed: verdict.objective });
      } catch (err) {
        logError('goal revision check failed', err);
      } finally {
        this.revisionChecking = false;
      }
    })();
  }

  /** The tail of the conversation, as plain text for the judge (~4k chars). */
  private async transcriptTail(sessionID: string): Promise<string> {
    const msgs = await this.client!.getMessages(sessionID);
    const lines: string[] = [];
    for (const m of msgs.slice(-8)) {
      const text = (m.parts ?? [])
        .map((p) => {
          if (p.type === 'text') {
            return (p as { text?: string }).text ?? '';
          }
          if (p.type === 'tool') {
            const t = p as { tool?: string; state?: { title?: string } };
            return `[tool: ${t.tool ?? '?'} ${t.state?.title ?? ''}]`;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
      if (text.trim()) {
        lines.push(`${m.info.role.toUpperCase()}:\n${text.trim()}`);
      }
    }
    const full = lines.join('\n\n');
    return full.length > 4000 ? full.slice(-4000) : full;
  }

  /** Auto-continue the working agent with the judge's feedback. */
  private async continueGoal(objective: string, reason: string): Promise<void> {
    this.post({ type: 'busy', busy: true });
    await this.client!.promptAsync(this.currentSessionID!, {
      model: { providerID: 'ollama', modelID: this.currentModel! },
      agent: this.agent,
      system: this.identitySystem() + this.goalSystemSuffix(),
      parts: [{ type: 'text', text: buildContinuePrompt(objective, reason) }],
    });
  }

  private postServers(connected: boolean): void {
    this.connected = connected;
    if (!connected) {
      // Some flips to offline happen outside a health tick (a failed send's
      // reconnect, switching to a dead server) — make the next 5s metronome
      // tick probe immediately instead of waiting out the connected cadence.
      this.nextProbeDueAt = 0;
    }
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
    this.currentSessionID = null;
    this.persistSession(null);
    this.healer.allowImmediate(); // a deliberate switch shouldn't wait on backoff
    this.teardownConnection(true);
    this.post({ type: 'cleared' });
    await this.init();
  }

  /**
   * Push a fresh model list to the webview.
   *
   * 'action' (user did something: load/eject/rescan/settings) always posts —
   * the webview uses the reply to settle load state. 'periodic' (health
   * cadence / picker loop / visibility catch-up) is best-effort: skipped while
   * hidden or disconnected, and suppressed when nothing changed so the webview
   * isn't re-rendered every cycle for no reason.
   */
  private async refreshModelsToWebview(reason: 'action' | 'periodic' = 'action'): Promise<OllamaModel[]> {
    if (reason === 'periodic' && (!this.visible || !this.connected || this.loadsInFlight.size > 0)) {
      // The loadsInFlight gate matters for the picker fast-poll especially:
      // the menu stays open for the whole (possibly multi-minute) load, and an
      // unpaused 4s /api/tags + /api/ps + N×/api/show fan-out would contend
      // with — and can stall — the load (same reason the health tick pauses).
      return [];
    }
    const list = await this.deps.ollama.listModels();
    // A non-empty list is proof the server answered — if we were showing
    // offline, correct that immediately rather than waiting for the next poll.
    if (list.length) {
      this.noteOnline();
    }
    if (reason === 'periodic' && list.length === 0) {
      // A transient listing failure surfaces as [] — never blank a populated
      // picker from a background refresh; an 'action' post stays authoritative.
      return list;
    }
    const payload = { models: this.mapModels(list), currentModel: this.currentModel };
    const json = JSON.stringify(payload);
    if (reason === 'periodic' && json === this.lastPostedModelsJson) {
      return list;
    }
    this.lastPostedModelsJson = json;
    this.post({ type: 'models', ...payload, reason });
    return list;
  }

  /** The webview's model picker opened/closed: run a fast refresh loop while open. */
  private setModelMenuOpen(open: boolean): void {
    if (open) {
      if (!this.pickerTimer && !this.disposed) {
        void this.refreshModelsToWebview('periodic').catch(() => undefined);
        this.pickerTimer = setInterval(
          () => void this.refreshModelsToWebview('periodic').catch(() => undefined),
          PICKER_REFRESH_MS,
        );
      }
    } else if (this.pickerTimer) {
      clearInterval(this.pickerTimer);
      this.pickerTimer = undefined;
    }
  }

  /**
   * Re-assert keep_alive on the selected model via one cheap /api/ps lookup —
   * no /api/tags, no /api/show fan-out. OpenCode's chat requests reset
   * Ollama's keep_alive to its ~5min default, so without this ping the user's
   * keepAlive choice wouldn't stick. Runs on its own cadence, including for
   * hidden panels (a background chat must keep its model warm).
   *
   * CRITICAL: the refresh call must use the model's ACTUALLY-LOADED context
   * from /api/ps and nothing else — a guessed/config context would force a
   * full reload and stomp the user's chosen context. Skips (never guesses)
   * when the model isn't resident or ps doesn't report its context; pinging a
   * model the user ejected elsewhere would resurrect it.
   */
  private async keepWarmNow(): Promise<void> {
    if (!this.currentModel) {
      return;
    }
    const loadedCtx = await this.deps.ollama.loadedContextFor(this.currentModel);
    if (!loadedCtx) {
      return;
    }
    await this.deps.ollama.refreshKeepAlive(this.currentModel, loadedCtx, this.keepAlive());
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
    // One cheap /api/ps ping instead of a full listModels fan-out just to feed
    // the old keepWarm(list) — the 'action' refresh below re-lists anyway.
    this.lastKeepWarmAt = Date.now();
    await this.keepWarmNow().catch(() => undefined);
    await this.refreshModelsToWebview();
  }

  /** Tear down and re-initialize OpenCode (rebuilds OPENCODE_CONFIG_CONTENT)
   * while preserving the current session. */
  private async rebuildServer(status: string): Promise<void> {
    this.post({ type: 'status', text: status });
    this.healer.allowImmediate(); // a deliberate rebuild shouldn't wait on backoff
    this.teardownConnection(true);
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

  /**
   * Start a fresh chat WITHOUT creating a server session yet. The actual
   * OpenCode session is created lazily on the first send (see handleSend), so an
   * untouched "New chat" never lands in history — only conversations with real
   * back-and-forth do. Resets to a null session and clears the view.
   */
  private async newSession(announce = true): Promise<void> {
    this.currentSessionID = null;
    this.persistSession(null);
    // A goal is scoped to its conversation — leaving it ends the loop.
    this.activeGoal = null;
    this.postGoal();
    this.updateTitle('New chat');
    this.post({ type: 'cleared' });
    if (announce) {
      await this.sendSessions();
    }
  }

  /**
   * Ensure a server session exists for the current chat, creating one on demand.
   * Called right before the first prompt of a fresh chat — this is the moment a
   * "New chat" actually becomes a real session (and thus a history entry).
   *
   * Concurrency-safe: webview messages aren't serialized, so two near-simultaneous
   * first-sends (or a send + a /command) can both reach here while currentSessionID
   * is null. We memoize the in-flight create so they share ONE createSession, and
   * we re-check after the await — if the user switched to an existing session
   * (loadSession) while the create was in flight, we keep THAT session and delete
   * the now-orphaned one we just made, rather than clobbering their selection.
   */
  private async ensureSession(): Promise<void> {
    if (this.currentSessionID || !this.client) {
      return;
    }
    if (this.ensuringSession) {
      return this.ensuringSession;
    }
    const client = this.client;
    this.ensuringSession = (async () => {
      try {
        const session = await client.createSession('New chat');
        if (this.currentSessionID) {
          // A concurrent loadSession won the race — don't clobber it; discard
          // the session we just created so it doesn't linger as an empty entry.
          void client.deleteSession(session.id).catch(() => undefined);
          return;
        }
        this.currentSessionID = session.id;
        this.persistSession(session.id);
      } finally {
        this.ensuringSession = undefined;
      }
    })();
    return this.ensuringSession;
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

  /**
   * One-time cleanup of empty sessions left over from before sessions went lazy.
   * Going forward none are created, but a user upgrading has a pile of zero-
   * message "New chat" entries. A session that never had a message keeps
   * time.created === time.updated (verified: the first prompt bumps `updated`);
   * we confirm zero messages before deleting so a real session is never removed.
   *
   * The OpenCode data dir is shared across every workspace and every webview, so
   * the candidate set is scoped (see emptySessionCandidates / PruneScope): only
   * sessions in THIS workspace, and only those older than the in-flight floor,
   * are eligible — so we never delete another workspace's data or a sibling
   * bridge's brand-new session that is mid-send. Best-effort and quiet — failures
   * here must never block startup.
   */
  private async pruneEmptySessions(): Promise<void> {
    if (!this.client) {
      return;
    }
    const directory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    let removed = 0;
    try {
      const sessions = await this.client.listSessions();
      const candidates = emptySessionCandidates(sessions, {
        currentSessionID: this.currentSessionID,
        directory,
        now: Date.now(),
      });
      for (const s of candidates) {
        try {
          const messages = await this.client.getMessages(s.id);
          if (Array.isArray(messages) && messages.length === 0) {
            await this.client.deleteSession(s.id);
            removed++;
          }
        } catch {
          // skip this one — never let cleanup throw
        }
      }
    } catch (err) {
      logError('pruneEmptySessions', err);
    }
    if (removed > 0) {
      log(`pruned ${removed} empty session(s)`);
      await this.sendSessions();
    }
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

  /** Remember (or forget) the active session so the next launch can restore it. */
  private persistSession(id: string | null): void {
    void this.deps.context.workspaceState.update(LAST_SESSION_KEY, id ?? undefined);
  }

  /**
   * On the first init of a fresh bridge, reopen the conversation that was
   * active when the window closed. Never on reconnects (restoreAttempted), and
   * only one panel per window may claim the restore (sessionRestoreClaimed).
   */
  private async maybeRestoreLastSession(): Promise<void> {
    if (this.restoreAttempted || this.currentSessionID || sessionRestoreClaimed || !this.client) {
      this.restoreAttempted = true;
      return;
    }
    this.restoreAttempted = true;
    const stored = this.deps.context.workspaceState.get<string>(LAST_SESSION_KEY);
    if (!stored) {
      return;
    }
    sessionRestoreClaimed = true;
    try {
      // Validate against the real session list — getMessages on a deleted id
      // can return an empty transcript rather than throwing.
      const sessions = await this.client.listSessions();
      const match = sessions.find((s) => s.id === stored);
      if (!match) {
        this.persistSession(null); // deleted elsewhere — forget the stale id
        return;
      }
      const messages = await this.client.getMessages(stored);
      this.currentSessionID = stored;
      const title = match.title || 'Chat';
      this.updateTitle(title);
      this.post({ type: 'sessionLoaded', sessionID: stored, title, messages });
    } catch (err) {
      // Restore is best-effort — fall back to the normal fresh-chat path.
      logError('restore last session', err);
      this.currentSessionID = null;
    }
  }

  private async loadSession(sessionID: string): Promise<void> {
    if (!this.client) {
      return;
    }
    // A goal is scoped to its conversation — switching sessions ends the loop.
    this.activeGoal = null;
    this.postGoal();
    this.currentSessionID = sessionID;
    this.persistSession(sessionID);
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
    includeSelection: boolean,
  ): Promise<void> {
    if (!this.client) {
      throw new Error('OpenCode server is not running.');
    }
    if (!this.currentModel) {
      throw new Error('No Ollama model selected.');
    }
    // Lazily create the server session on the first message of a fresh chat, so
    // an untouched "New chat" never exists server-side (and never shows in
    // history).
    await this.ensureSession();
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
        await this.refreshModelsToWebview('periodic').catch(() => undefined);
      }
      this.post({ type: 'status', text: '' });
    }

    // Identity: OpenCode's base prompt makes the model call itself "opencode".
    // Our system text is appended, so this overrides the user-facing identity.
    let system = this.identitySystem() + this.goalSystemSuffix();

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

    // Attach the current editor selection as context. Surfaced in the composer
    // as a visible, dismissable pill (the webview only sets includeSelection when
    // the user hasn't excluded it), so this is opt-out, not silent. Shared as a
    // file part scoped to the selection's range, so the model sees exactly the
    // highlighted code plus where it lives. The filename carries the line range
    // (e.g. app.js#14-19) so it's self-labeling.
    if (includeSelection && this.activeSelection) {
      const s = this.activeSelection;
      const label = selectionLabel(s.rel, s.startLine, s.endLine);
      // Cap a huge selection (e.g. a select-all on a minified bundle) the same
      // way the active-file attachment is capped, so it can't blow the window.
      // Truncating the value means clamping `end` to stay consistent with it.
      const MAX = 80 * 1024;
      const value = s.text.length > MAX ? s.text.slice(0, MAX) + '\n\n…[truncated]' : s.text;
      const end = s.text.length > MAX ? s.start + MAX : s.end;
      parts.push({
        type: 'file',
        mime: 'text/plain',
        filename: label,
        url: `file://${s.abs}`,
        source: { type: 'file', path: s.abs, text: { value, start: s.start, end } },
      });
    }

    this.post({ type: 'busy', busy: true });
    const body: PromptBody = {
      model: { providerID: 'ollama', modelID: this.currentModel },
      agent: this.agent,
      ...(system ? { system } : {}),
      parts,
    };
    try {
      await this.client.promptAsync(this.currentSessionID!, body);
    } catch (err) {
      // A dead OpenCode client surfaces as a connection error on the very next
      // send. Heal and retry once rather than surfacing a raw fetch failure.
      if (!isConnectionError(err)) {
        throw err;
      }
      logError('prompt failed on a connection error — reconnecting and retrying', err);
      this.post({ type: 'status', text: 'Reconnecting…', kind: 'warn' });
      const live = await this.reconnect();
      if (live && this.client && this.currentSessionID) {
        await this.client.promptAsync(this.currentSessionID, body);
        this.post({ type: 'status', text: '' });
      } else {
        throw new Error(
          'Lost connection to Ollama. It looks offline — start it and try again; I’ll keep reconnecting in the background.',
        );
      }
    }

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
    // Goal loop: a finished turn on the active session triggers one judge check.
    if (event.type === 'session.idle' && sid && sid === this.currentSessionID) {
      void this.onTurnIdle();
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

