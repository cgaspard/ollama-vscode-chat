import { marked } from 'marked';
import type { MessageWithParts, OpencodeEvent, Part } from '../opencode/protocol';
import type { HostToWebview, UiImage, UiModel, UiServer, UiSession, WebviewToHost } from '../shared';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
};

const vscode = acquireVsCodeApi();
function post(msg: WebviewToHost): void {
  vscode.postMessage(msg);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
interface State {
  models: UiModel[];
  currentModel: string | null;
  agent: 'build' | 'plan';
  sessions: UiSession[];
  currentSessionID: string | null;
  busy: boolean;
  serverReady: boolean;
  ollamaConnected: boolean;
  thinking: boolean;
  pendingImages: UiImage[];
  minContext: number;
  realTokens: number;
  compacted: boolean;
  loadingModels: Set<string>;
  servers: UiServer[];
  activeServerId: string;
  activeFile: { path: string; chars: number } | null;
  includeActiveFile: boolean;
}
const persisted = (vscode.getState() as { thinking?: boolean; includeActiveFile?: boolean }) ?? {};
const state: State = {
  models: [],
  currentModel: null,
  agent: 'build',
  sessions: [],
  currentSessionID: null,
  busy: false,
  serverReady: false,
  ollamaConnected: false,
  thinking: persisted.thinking ?? true,
  pendingImages: [],
  minContext: 32768,
  realTokens: 0,
  compacted: false,
  loadingModels: new Set<string>(),
  servers: [],
  activeServerId: '',
  activeFile: null,
  includeActiveFile: persisted.includeActiveFile ?? true,
};

// Live rendering bookkeeping (keyed by ids so events and history both upsert).
const messageEls = new Map<string, { el: HTMLElement; partsEl: HTMLElement; role: string }>();
const partState = new Map<string, { el: HTMLElement; buffer: string; type: string }>();
const roleByMessage = new Map<string, string>();
const permissionEls = new Map<string, HTMLElement>();
const toolCollapsed = new Map<string, boolean>(); // partID -> collapsed?

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
const icon = {
  plus: `<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M8.5 2.5v5h5v1h-5v5h-1v-5h-5v-1h5v-5z"/></svg>`,
  history: `<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5h-1A5.5 5.5 0 1 1 8 2.5V1.5zM7.5 4v4.2l3.1 1.8.5-.86L8.5 7.7V4z"/><path fill="currentColor" d="M8 1.5 5.4 3.2 8 4.9z"/></svg>`,
  send: `<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M1.7 14.3 15 8 1.7 1.7l-.2 4.8L10 8l-8.5 1.5z"/></svg>`,
  stop: `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor"/></svg>`,
  trash: `<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M6 1.5h4l.5 1H14v1H2v-1h3.5zM3.5 4.5h9l-.7 9.2a1 1 0 0 1-1 .8H5.2a1 1 0 0 1-1-.8z"/></svg>`,
  close: `<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4"/></svg>`,
  spark: `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" fill-rule="evenodd" d="M7.905 1.09c.216.085.411.225.588.41.295.306.544.744.734 1.263.191.522.315 1.1.362 1.68a5.054 5.054 0 012.049-.636l.051-.004c.87-.07 1.73.087 2.48.474.101.053.2.11.297.17.05-.569.172-1.134.36-1.644.19-.52.439-.957.733-1.264a1.67 1.67 0 01.589-.41c.257-.1.53-.118.796-.042.401.114.745.368 1.016.737.248.337.434.769.561 1.287.23.934.27 2.163.115 3.645l.053.04.026.019c.757.576 1.284 1.397 1.563 2.35.435 1.487.216 3.155-.534 4.088l-.018.021.002.003c.417.762.67 1.567.724 2.4l.002.03c.064 1.065-.2 2.137-.814 3.19l-.007.01.01.024c.472 1.157.62 2.322.438 3.486l-.006.039a.651.651 0 01-.747.536.648.648 0 01-.54-.742c.167-1.033.01-2.069-.48-3.123a.643.643 0 01.04-.617l.004-.006c.604-.924.854-1.83.8-2.72-.046-.779-.325-1.544-.8-2.273a.644.644 0 01.18-.886l.009-.006c.243-.159.467-.565.58-1.12a4.229 4.229 0 00-.095-1.974c-.205-.7-.58-1.284-1.105-1.683-.595-.454-1.383-.673-2.38-.61a.653.653 0 01-.632-.371c-.314-.665-.772-1.141-1.343-1.436a3.288 3.288 0 00-1.772-.332c-1.245.099-2.343.801-2.67 1.686a.652.652 0 01-.61.425c-1.067.002-1.893.252-2.497.703-.522.39-.878.935-1.066 1.588a4.07 4.07 0 00-.068 1.886c.112.558.331 1.02.582 1.269l.008.007c.212.207.257.53.109.785-.36.622-.629 1.549-.673 2.44-.05 1.018.186 1.902.719 2.536l.016.019a.643.643 0 01.095.69c-.576 1.236-.753 2.252-.562 3.052a.652.652 0 01-1.269.298c-.243-1.018-.078-2.184.473-3.498l.014-.035-.008-.012a4.339 4.339 0 01-.598-1.309l-.005-.019a5.764 5.764 0 01-.177-1.785c.044-.91.278-1.842.622-2.59l.012-.026-.002-.002c-.293-.418-.51-.953-.63-1.545l-.005-.024a5.352 5.352 0 01.093-2.49c.262-.915.777-1.701 1.536-2.269.06-.045.123-.09.186-.132-.159-1.493-.119-2.73.112-3.67.127-.518.314-.95.562-1.287.27-.368.614-.622 1.015-.737.266-.076.54-.059.797.042zm4.116 9.09c.936 0 1.8.313 2.446.855.63.527 1.005 1.235 1.005 1.94 0 .888-.406 1.58-1.133 2.022-.62.375-1.451.557-2.403.557-1.009 0-1.871-.259-2.493-.734-.617-.47-.963-1.13-.963-1.845 0-.707.398-1.417 1.056-1.946.668-.537 1.55-.849 2.485-.849zm0 .896a3.07 3.07 0 00-1.916.65c-.461.37-.722.835-.722 1.25 0 .428.21.829.61 1.134.455.347 1.124.548 1.943.548.799 0 1.473-.147 1.932-.426.463-.28.7-.686.7-1.257 0-.423-.246-.89-.683-1.256-.484-.405-1.14-.643-1.864-.643zm.662 1.21l.004.004c.12.151.095.37-.056.49l-.292.23v.446a.375.375 0 01-.376.373.375.375 0 01-.376-.373v-.46l-.271-.218a.347.347 0 01-.052-.49.353.353 0 01.494-.051l.215.172.22-.174a.353.353 0 01.49.051zm-5.04-1.919c.478 0 .867.39.867.871a.87.87 0 01-.868.871.87.87 0 01-.867-.87.87.87 0 01.867-.872zm8.706 0c.48 0 .868.39.868.871a.87.87 0 01-.868.871.87.87 0 01-.867-.87.87.87 0 01.867-.872zM7.44 2.3l-.003.002a.659.659 0 00-.285.238l-.005.006c-.138.189-.258.467-.348.832-.17.692-.216 1.631-.124 2.782.43-.128.899-.208 1.404-.237l.01-.001.019-.034c.046-.082.095-.161.148-.239.123-.771.022-1.692-.253-2.444-.134-.364-.297-.65-.453-.813a.628.628 0 00-.107-.09L7.44 2.3zm9.174.04l-.002.001a.628.628 0 00-.107.09c-.156.163-.32.45-.453.814-.29.794-.387 1.776-.23 2.572l.058.097.008.014h.03a5.184 5.184 0 011.466.212c.086-1.124.038-2.043-.128-2.722-.09-.365-.21-.643-.349-.832l-.004-.006a.659.659 0 00-.285-.239h-.004z"/></svg>`,
  sparkLarge: `<svg viewBox="0 0 24 24" width="44" height="44"><path fill="currentColor" fill-rule="evenodd" d="M7.905 1.09c.216.085.411.225.588.41.295.306.544.744.734 1.263.191.522.315 1.1.362 1.68a5.054 5.054 0 012.049-.636l.051-.004c.87-.07 1.73.087 2.48.474.101.053.2.11.297.17.05-.569.172-1.134.36-1.644.19-.52.439-.957.733-1.264a1.67 1.67 0 01.589-.41c.257-.1.53-.118.796-.042.401.114.745.368 1.016.737.248.337.434.769.561 1.287.23.934.27 2.163.115 3.645l.053.04.026.019c.757.576 1.284 1.397 1.563 2.35.435 1.487.216 3.155-.534 4.088l-.018.021.002.003c.417.762.67 1.567.724 2.4l.002.03c.064 1.065-.2 2.137-.814 3.19l-.007.01.01.024c.472 1.157.62 2.322.438 3.486l-.006.039a.651.651 0 01-.747.536.648.648 0 01-.54-.742c.167-1.033.01-2.069-.48-3.123a.643.643 0 01.04-.617l.004-.006c.604-.924.854-1.83.8-2.72-.046-.779-.325-1.544-.8-2.273a.644.644 0 01.18-.886l.009-.006c.243-.159.467-.565.58-1.12a4.229 4.229 0 00-.095-1.974c-.205-.7-.58-1.284-1.105-1.683-.595-.454-1.383-.673-2.38-.61a.653.653 0 01-.632-.371c-.314-.665-.772-1.141-1.343-1.436a3.288 3.288 0 00-1.772-.332c-1.245.099-2.343.801-2.67 1.686a.652.652 0 01-.61.425c-1.067.002-1.893.252-2.497.703-.522.39-.878.935-1.066 1.588a4.07 4.07 0 00-.068 1.886c.112.558.331 1.02.582 1.269l.008.007c.212.207.257.53.109.785-.36.622-.629 1.549-.673 2.44-.05 1.018.186 1.902.719 2.536l.016.019a.643.643 0 01.095.69c-.576 1.236-.753 2.252-.562 3.052a.652.652 0 01-1.269.298c-.243-1.018-.078-2.184.473-3.498l.014-.035-.008-.012a4.339 4.339 0 01-.598-1.309l-.005-.019a5.764 5.764 0 01-.177-1.785c.044-.91.278-1.842.622-2.59l.012-.026-.002-.002c-.293-.418-.51-.953-.63-1.545l-.005-.024a5.352 5.352 0 01.093-2.49c.262-.915.777-1.701 1.536-2.269.06-.045.123-.09.186-.132-.159-1.493-.119-2.73.112-3.67.127-.518.314-.95.562-1.287.27-.368.614-.622 1.015-.737.266-.076.54-.059.797.042zm4.116 9.09c.936 0 1.8.313 2.446.855.63.527 1.005 1.235 1.005 1.94 0 .888-.406 1.58-1.133 2.022-.62.375-1.451.557-2.403.557-1.009 0-1.871-.259-2.493-.734-.617-.47-.963-1.13-.963-1.845 0-.707.398-1.417 1.056-1.946.668-.537 1.55-.849 2.485-.849zm0 .896a3.07 3.07 0 00-1.916.65c-.461.37-.722.835-.722 1.25 0 .428.21.829.61 1.134.455.347 1.124.548 1.943.548.799 0 1.473-.147 1.932-.426.463-.28.7-.686.7-1.257 0-.423-.246-.89-.683-1.256-.484-.405-1.14-.643-1.864-.643zm.662 1.21l.004.004c.12.151.095.37-.056.49l-.292.23v.446a.375.375 0 01-.376.373.375.375 0 01-.376-.373v-.46l-.271-.218a.347.347 0 01-.052-.49.353.353 0 01.494-.051l.215.172.22-.174a.353.353 0 01.49.051zm-5.04-1.919c.478 0 .867.39.867.871a.87.87 0 01-.868.871.87.87 0 01-.867-.87.87.87 0 01.867-.872zm8.706 0c.48 0 .868.39.868.871a.87.87 0 01-.868.871.87.87 0 01-.867-.87.87.87 0 01.867-.872zM7.44 2.3l-.003.002a.659.659 0 00-.285.238l-.005.006c-.138.189-.258.467-.348.832-.17.692-.216 1.631-.124 2.782.43-.128.899-.208 1.404-.237l.01-.001.019-.034c.046-.082.095-.161.148-.239.123-.771.022-1.692-.253-2.444-.134-.364-.297-.65-.453-.813a.628.628 0 00-.107-.09L7.44 2.3zm9.174.04l-.002.001a.628.628 0 00-.107.09c-.156.163-.32.45-.453.814-.29.794-.387 1.776-.23 2.572l.058.097.008.014h.03a5.184 5.184 0 011.466.212c.086-1.124.038-2.043-.128-2.722-.09-.365-.21-.643-.349-.832l-.004-.006a.659.659 0 00-.285-.239h-.004z"/></svg>`,
  file: `<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M4 1.5h5L13 5.5V14a.5.5 0 0 1-.5.5h-8A.5.5 0 0 1 4 14zM9 2v3h3z"/></svg>`,
  tool: `<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M11.5 1.5a3.5 3.5 0 0 0-3.4 4.4L1.7 12.3l1.9 1.9 6.4-6.4A3.5 3.5 0 1 0 11.5 1.5z"/></svg>`,
  brain: `<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M6 1.6a2.1 2.1 0 0 0-2 1.5 2 2 0 0 0-1.3 3.2A2.1 2.1 0 0 0 3.6 10c.1 1 1 1.9 2.1 1.9.3 0 .3.1.3.4v1.7h1V3.8c0-.5.1-.7.4-1a2.1 2.1 0 0 0-1.4-1.2zm4 0a2.1 2.1 0 0 1 2 1.5 2 2 0 0 1 1.3 3.2A2.1 2.1 0 0 1 12.4 10c-.1 1-1 1.9-2.1 1.9-.3 0-.3.1-.3.4v1.7H9V3.8c0-.5-.1-.7-.4-1A2.1 2.1 0 0 1 10 1.6z"/></svg>`,
  paperclip: `<svg viewBox="0 0 16 16" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="1.3" d="M11.5 6.5 6.8 11.2a2 2 0 0 1-2.8-2.8l5-5a3 3 0 0 1 4.2 4.2l-5.1 5.1a4 4 0 0 1-5.6-5.6l4.8-4.8"/></svg>`,
  refresh: `<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M13.65 3.85A6 6 0 1 0 14 8h-1.5a4.5 4.5 0 1 1-1.2-3.35L9 6.5h5V1.5z"/></svg>`,
  caret: `<svg viewBox="0 0 16 16" width="10" height="10"><path fill="currentColor" d="M4 6l4 4 4-4z"/></svg>`,
};

// ---------------------------------------------------------------------------
// DOM scaffolding
// ---------------------------------------------------------------------------
let messagesEl!: HTMLElement;
let welcomeEl!: HTMLElement;
let inputEl!: HTMLTextAreaElement;
let sendBtn!: HTMLButtonElement;
let modelBtn!: HTMLButtonElement;
let modelMenu!: HTMLElement;
let modelMenuList!: HTMLElement;
let serverBtn!: HTMLButtonElement;
let serverMenu!: HTMLElement;
let serverMenuList!: HTMLElement;
let connBanner!: HTMLElement;
let ctxFileBtn!: HTMLButtonElement;
let ctxFileName!: HTMLElement;
let agentSelect!: HTMLSelectElement;
let statusEl!: HTMLElement;
let historyOverlay!: HTMLElement;
let historyList!: HTMLElement;
let thumbsEl!: HTMLElement;
let thinkBtn!: HTMLButtonElement;
let fileInput!: HTMLInputElement;
let ctxMeterEl!: HTMLElement;
let ctxFillEl!: HTMLElement;
let ctxLabelEl!: HTMLElement;
let workingEl!: HTMLElement;
let workingLabelEl!: HTMLElement;
let workingElapsedEl!: HTMLElement;
let workingStart = 0;
let workingTimer: ReturnType<typeof setInterval> | undefined;

function build(): void {
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <div id="conn-banner" class="conn-banner hidden"></div>
    <div id="messages" class="messages">
      <div id="welcome" class="welcome">
        <div class="welcome-logo">${icon.sparkLarge}</div>
        <div class="welcome-title">Ollama Code</div>
        <div class="welcome-sub">Local agentic coding, powered by OpenCode.</div>
        <div class="welcome-hint">Pick a model below and describe a task.</div>
      </div>
    </div>
    <div id="status" class="status"></div>
    <div id="working" class="working hidden">
      <span class="spinner"></span>
      <span class="working-label">Working…</span>
      <span class="working-elapsed"></span>
    </div>
    <div id="ctx-meter" class="ctx-meter" title="Context window usage">
      <div class="ctx-bar"><div class="ctx-fill"></div></div>
      <span class="ctx-label"></span>
    </div>
    <div class="composer">
      <div class="composer-box">
        <div id="thumbs" class="thumbs"></div>
        <textarea id="input" rows="1" placeholder="Ask anything, paste an image, or describe a task…"></textarea>
        <div class="composer-row">
          <div class="composer-tools">
            <button id="server-btn" class="tool-pill" title="Ollama server — switch / add">
              <span class="model-dot"></span><span id="server-name">Server</span>
            </button>
            <button id="btn-attach" class="tool-pill icon-only" title="Attach image">${icon.paperclip}</button>
            <button id="btn-think" class="tool-pill" title="Toggle thinking">${icon.brain}<span>Thinking</span></button>
            <button id="ctxfile" class="tool-pill ctxfile hidden" title="Include the open file as context">${icon.file}<span id="ctxfile-name"></span></button>
          </div>
          <div class="composer-right">
            <button id="model-btn" class="model-btn" title="Model — load / eject">
              <span class="model-dot"></span>
              <span class="model-btn-label">Model</span>
              <span class="caret">${icon.caret}</span>
            </button>
            <select id="agent-select" class="picker agent" title="Agent">
              <option value="build">build</option>
              <option value="plan">plan</option>
            </select>
            <button id="send" class="send-btn" title="Send">${icon.send}</button>
          </div>
        </div>
      </div>
      <input id="file-input" type="file" accept="image/*" multiple hidden />
    </div>
    <div id="model-menu" class="model-menu hidden">
      <div class="model-menu-head">
        <span>Ollama models</span>
        <button id="model-refresh" class="icon-btn" title="Rescan models">${icon.refresh}</button>
      </div>
      <div id="model-menu-list" class="model-menu-list"></div>
      <div class="model-menu-foot">
        <span class="ctx-foot-label">Context window</span>
        <div id="ctx-presets" class="ctx-presets"></div>
      </div>
    </div>
    <div id="server-menu" class="model-menu hidden">
      <div class="model-menu-head"><span>Ollama servers</span></div>
      <div id="server-menu-list" class="model-menu-list"></div>
      <div class="server-add">
        <input id="server-add-name" class="server-input" placeholder="Name (e.g. Workstation)" />
        <input id="server-add-url" class="server-input" placeholder="http://192.168.1.50:1234" />
        <button id="server-add-btn" class="model-action load">Add server</button>
      </div>
    </div>
    <div id="history-overlay" class="overlay hidden">
      <div class="overlay-card">
        <div class="overlay-head">
          <span>Session history</span>
          <div class="overlay-head-actions">
            <button id="history-clear" class="clear-all-btn">Clear all</button>
            <button id="history-close" class="icon-btn">${icon.close}</button>
          </div>
        </div>
        <div id="history-list" class="history-list"></div>
      </div>
    </div>
  `;

  messagesEl = document.getElementById('messages')!;
  welcomeEl = document.getElementById('welcome')!;
  inputEl = document.getElementById('input') as HTMLTextAreaElement;
  sendBtn = document.getElementById('send') as HTMLButtonElement;
  modelBtn = document.getElementById('model-btn') as HTMLButtonElement;
  modelMenu = document.getElementById('model-menu')!;
  modelMenuList = document.getElementById('model-menu-list')!;
  serverBtn = document.getElementById('server-btn') as HTMLButtonElement;
  serverMenu = document.getElementById('server-menu')!;
  serverMenuList = document.getElementById('server-menu-list')!;
  connBanner = document.getElementById('conn-banner')!;
  ctxFileBtn = document.getElementById('ctxfile') as HTMLButtonElement;
  ctxFileName = document.getElementById('ctxfile-name')!;
  agentSelect = document.getElementById('agent-select') as HTMLSelectElement;
  statusEl = document.getElementById('status')!;
  historyOverlay = document.getElementById('history-overlay')!;
  historyList = document.getElementById('history-list')!;
  thumbsEl = document.getElementById('thumbs')!;
  thinkBtn = document.getElementById('btn-think') as HTMLButtonElement;
  fileInput = document.getElementById('file-input') as HTMLInputElement;
  ctxMeterEl = document.getElementById('ctx-meter')!;
  ctxFillEl = ctxMeterEl.querySelector('.ctx-fill') as HTMLElement;
  ctxLabelEl = ctxMeterEl.querySelector('.ctx-label') as HTMLElement;
  workingEl = document.getElementById('working')!;
  workingLabelEl = workingEl.querySelector('.working-label') as HTMLElement;
  workingElapsedEl = workingEl.querySelector('.working-elapsed') as HTMLElement;

  document.getElementById('history-close')!.addEventListener('click', closeHistory);
  const clearBtn = document.getElementById('history-clear') as HTMLButtonElement;
  let clearArmed = false;
  let clearTimer: ReturnType<typeof setTimeout> | undefined;
  clearBtn.addEventListener('click', () => {
    if (!clearArmed) {
      clearArmed = true;
      clearBtn.textContent = 'Confirm clear all?';
      clearBtn.classList.add('armed');
      clearTimer = setTimeout(() => {
        clearArmed = false;
        clearBtn.textContent = 'Clear all';
        clearBtn.classList.remove('armed');
      }, 3000);
      return;
    }
    if (clearTimer) {
      clearTimeout(clearTimer);
    }
    clearArmed = false;
    clearBtn.textContent = 'Clear all';
    clearBtn.classList.remove('armed');
    post({ type: 'clearAllSessions' });
    closeHistory();
  });
  historyOverlay.addEventListener('click', (e) => {
    if (e.target === historyOverlay) {
      closeHistory();
    }
  });

  sendBtn.addEventListener('click', onSend);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!state.busy) {
        onSend();
      }
    }
  });
  inputEl.addEventListener('input', autoGrow);

  // Thinking toggle
  thinkBtn.addEventListener('click', () => {
    state.thinking = !state.thinking;
    persist();
    applyThinking();
  });
  applyThinking();

  // Active-file context toggle
  ctxFileBtn.addEventListener('click', () => {
    state.includeActiveFile = !state.includeActiveFile;
    persist();
    renderActiveFile();
    renderMeter();
  });

  // Image attach / paste / drop
  document.getElementById('btn-attach')!.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files) {
      for (const f of Array.from(fileInput.files)) {
        void addImage(f);
      }
    }
    fileInput.value = '';
  });
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) {
      return;
    }
    for (const it of Array.from(items)) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) {
          void addImage(f);
        }
      }
    }
  });
  const composer = document.querySelector('.composer')!;
  composer.addEventListener('dragover', (e) => {
    e.preventDefault();
    composer.classList.add('dragover');
  });
  composer.addEventListener('dragleave', () => composer.classList.remove('dragover'));
  composer.addEventListener('drop', (e) => {
    e.preventDefault();
    composer.classList.remove('dragover');
    const files = (e as DragEvent).dataTransfer?.files;
    if (files) {
      for (const f of Array.from(files)) {
        if (f.type.startsWith('image/')) {
          void addImage(f);
        }
      }
    }
  });

  modelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleModelMenu();
  });
  document.getElementById('model-refresh')!.addEventListener('click', (e) => {
    e.stopPropagation();
    post({ type: 'refreshModels' });
  });
  serverBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleServerMenu();
  });
  document.getElementById('server-add-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    const nameEl = document.getElementById('server-add-name') as HTMLInputElement;
    const urlEl = document.getElementById('server-add-url') as HTMLInputElement;
    if (urlEl.value.trim()) {
      post({ type: 'addServer', name: nameEl.value, url: urlEl.value });
      nameEl.value = '';
      urlEl.value = '';
    }
  });
  document.addEventListener('click', (e) => {
    const t = e.target as Node;
    if (!modelMenu.classList.contains('hidden') && !modelMenu.contains(t) && !modelBtn.contains(t)) {
      closeModelMenu();
    }
    if (!serverMenu.classList.contains('hidden') && !serverMenu.contains(t) && !serverBtn.contains(t)) {
      closeServerMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModelMenu();
      closeServerMenu();
    }
  });
  agentSelect.addEventListener('change', () => {
    state.agent = agentSelect.value as 'build' | 'plan';
    post({ type: 'selectAgent', agent: state.agent });
    renderMeter();
  });
}

function autoGrow(): void {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
function onSend(): void {
  if (state.busy) {
    post({ type: 'abort' });
    return;
  }
  const text = inputEl.value.trim();
  if (!text && !state.pendingImages.length) {
    return;
  }
  if (!state.ollamaConnected) {
    setStatus('Not connected to Ollama — check the server banner above.', 'warn');
    return;
  }
  if (!state.serverReady) {
    setStatus('Server not ready yet…', 'warn');
    return;
  }
  const images = state.pendingImages.slice();
  inputEl.value = '';
  state.pendingImages = [];
  renderThumbs();
  autoGrow();
  post({
    type: 'send',
    text,
    thinking: state.thinking,
    images,
    includeActiveFile: !!(state.activeFile && state.includeActiveFile),
  });
}

function applyThinking(): void {
  thinkBtn.classList.toggle('active', state.thinking);
  document.body.classList.toggle('hide-reasoning', !state.thinking);
  thinkBtn.title = state.thinking ? 'Thinking: on' : 'Thinking: off';
}

function persist(): void {
  vscode.setState({ thinking: state.thinking, includeActiveFile: state.includeActiveFile });
}

function renderActiveFile(): void {
  if (!state.activeFile) {
    ctxFileBtn.classList.add('hidden');
    return;
  }
  ctxFileBtn.classList.remove('hidden');
  ctxFileName.textContent = state.activeFile.path.split('/').pop() || state.activeFile.path;
  ctxFileBtn.classList.toggle('active', state.includeActiveFile);
  ctxFileBtn.title = state.includeActiveFile
    ? `Including ${state.activeFile.path} as context — click to exclude`
    : `${state.activeFile.path} excluded — click to include as context`;
}

function addImage(file: File): Promise<void> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      state.pendingImages.push({
        mime: file.type || 'image/png',
        dataUrl: String(reader.result),
        name: file.name || 'pasted-image',
      });
      renderThumbs();
      resolve();
    };
    reader.onerror = () => resolve();
    reader.readAsDataURL(file);
  });
}

function renderThumbs(): void {
  thumbsEl.innerHTML = '';
  thumbsEl.style.display = state.pendingImages.length ? 'flex' : 'none';
  state.pendingImages.forEach((img, i) => {
    const chip = document.createElement('div');
    chip.className = 'thumb';
    const im = document.createElement('img');
    im.src = img.dataUrl;
    const rm = document.createElement('button');
    rm.className = 'thumb-rm';
    rm.innerHTML = icon.close;
    rm.title = 'Remove';
    rm.addEventListener('click', () => {
      state.pendingImages.splice(i, 1);
      renderThumbs();
    });
    chip.appendChild(im);
    chip.appendChild(rm);
    thumbsEl.appendChild(chip);
  });
}

// ---------------------------------------------------------------------------
// Model / agent pickers
// ---------------------------------------------------------------------------
function renderModels(): void {
  agentSelect.value = state.agent;
  const cur = state.models.find((m) => m.id === state.currentModel);
  const dot = modelBtn.querySelector('.model-dot') as HTMLElement;
  const label = modelBtn.querySelector('.model-btn-label') as HTMLElement;
  dot.classList.toggle('loaded', !!cur?.loaded);
  if (cur) {
    const ctx = cur.contextLength ? ` · ${formatTokens(cur.contextLength)}` : '';
    label.textContent = cur.name + ctx;
  } else {
    label.textContent = state.models.length ? 'Select model' : 'No models';
  }
  if (!modelMenu.classList.contains('hidden')) {
    renderModelMenu();
  }
}

function renderModelMenu(): void {
  modelMenuList.innerHTML = '';
  if (!state.models.length) {
    modelMenuList.innerHTML = `<div class="model-empty">No models found. Start Ollama's server and download a model.</div>`;
    return;
  }
  for (const m of state.models) {
    const row = document.createElement('div');
    row.className = 'model-row' + (m.id === state.currentModel ? ' active' : '');
    const loading = state.loadingModels.has(m.id);
    const badges = `${m.vision ? '👁 ' : ''}${m.toolUse ? '🔧' : ''}`.trim();
    const ctx = m.loaded
      ? `${formatTokens(m.contextLength || 0)} / ${formatTokens(m.maxContextLength || 0)}`
      : `max ${formatTokens(m.maxContextLength || 0)}`;
    row.innerHTML = `
      <span class="model-dot${m.loaded ? ' loaded' : ''}"></span>
      <span class="model-info">
        <span class="model-name">${escapeHtml(m.name)}</span>
        <span class="model-meta">${m.loaded ? 'loaded · ' : ''}${ctx}${badges ? ' · ' + badges : ''}</span>
      </span>
      <button class="model-action ${loading ? 'busy' : m.loaded ? 'eject' : 'load'}" ${loading ? 'disabled' : ''}>
        ${loading ? 'Working…' : m.loaded ? 'Eject' : 'Load'}
      </button>`;
    // Row click selects the model as active.
    row.addEventListener('click', () => {
      state.currentModel = m.id;
      post({ type: 'selectModel', modelID: m.id });
      renderModels();
      renderMeter();
      closeModelMenu();
    });
    // Action button loads / ejects without selecting.
    const action = row.querySelector('.model-action') as HTMLButtonElement;
    action.addEventListener('click', (e) => {
      e.stopPropagation();
      if (loading) {
        return;
      }
      state.loadingModels.add(m.id);
      post({ type: m.loaded ? 'unloadModel' : 'loadModel', modelID: m.id });
      renderModelMenu();
    });
    modelMenuList.appendChild(row);
  }
  renderCtxPresets();
}

function renderCtxPresets(): void {
  const el = document.getElementById('ctx-presets');
  if (!el) {
    return;
  }
  const m = state.models.find((x) => x.id === state.currentModel);
  const max = m?.maxContextLength || 131072;
  const presets = [8192, 16384, 32768, 65536, 131072, 262144].filter((v) => v <= max);
  if (max && !presets.includes(max)) {
    presets.push(max);
  }
  el.innerHTML = '';
  for (const v of presets) {
    const b = document.createElement('button');
    b.className = 'ctx-preset' + (v === state.minContext ? ' active' : '');
    b.textContent = formatTokens(v);
    b.title = v.toLocaleString() + ' tokens';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (v === state.minContext) {
        return;
      }
      state.minContext = v;
      renderCtxPresets();
      renderMeter();
      post({ type: 'setContextSize', tokens: v });
    });
    el.appendChild(b);
  }
}

function toggleModelMenu(): void {
  if (modelMenu.classList.contains('hidden')) {
    openModelMenu();
  } else {
    closeModelMenu();
  }
}

function openModelMenu(): void {
  renderModelMenu();
  modelMenu.classList.remove('hidden');
  // Anchor above the model button, opening upward.
  const r = modelBtn.getBoundingClientRect();
  const width = Math.min(380, window.innerWidth - 16);
  let left = r.left;
  if (left + width > window.innerWidth - 8) {
    left = window.innerWidth - width - 8;
  }
  modelMenu.style.left = Math.max(8, left) + 'px';
  modelMenu.style.width = width + 'px';
  modelMenu.style.bottom = window.innerHeight - r.top + 6 + 'px';
}

function closeModelMenu(): void {
  modelMenu.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Servers (multi-server + offline handling)
// ---------------------------------------------------------------------------
function renderServers(): void {
  const dot = serverBtn.querySelector('.model-dot') as HTMLElement;
  const name = document.getElementById('server-name')!;
  const active = state.servers.find((s) => s.id === state.activeServerId);
  dot.classList.toggle('loaded', state.ollamaConnected);
  dot.classList.toggle('err', !state.ollamaConnected);
  name.textContent = active ? active.name : 'Server';
  serverBtn.title = active ? `Ollama: ${active.url}` : 'Ollama server';
  if (!serverMenu.classList.contains('hidden')) {
    renderServerMenu();
  }
  renderConnection();
}

function renderServerMenu(): void {
  serverMenuList.innerHTML = '';
  for (const s of state.servers) {
    const isActive = s.id === state.activeServerId;
    const row = document.createElement('div');
    row.className = 'model-row' + (isActive ? ' active' : '');
    row.innerHTML = `
      <span class="model-dot${isActive && state.ollamaConnected ? ' loaded' : ''}"></span>
      <span class="model-info">
        <span class="model-name">${escapeHtml(s.name)}${isActive ? ' ·  active' : ''}</span>
        <span class="model-meta">${escapeHtml(s.url)}</span>
      </span>
      <button class="model-action eject" title="Remove server">✕</button>`;
    row.addEventListener('click', () => {
      if (!isActive) {
        post({ type: 'switchServer', id: s.id });
      }
      closeServerMenu();
    });
    (row.querySelector('.model-action') as HTMLButtonElement).addEventListener('click', (e) => {
      e.stopPropagation();
      post({ type: 'removeServer', id: s.id });
    });
    serverMenuList.appendChild(row);
  }
}

function toggleServerMenu(): void {
  if (serverMenu.classList.contains('hidden')) {
    openServerMenu();
  } else {
    closeServerMenu();
  }
}

function openServerMenu(): void {
  post({ type: 'listServers' });
  renderServerMenu();
  serverMenu.classList.remove('hidden');
  const r = serverBtn.getBoundingClientRect();
  const width = Math.min(380, window.innerWidth - 16);
  let left = r.left;
  if (left + width > window.innerWidth - 8) {
    left = window.innerWidth - width - 8;
  }
  serverMenu.style.left = Math.max(8, left) + 'px';
  serverMenu.style.width = width + 'px';
  serverMenu.style.bottom = window.innerHeight - r.top + 6 + 'px';
}

function closeServerMenu(): void {
  serverMenu.classList.add('hidden');
}

function renderConnection(): void {
  if (state.ollamaConnected) {
    connBanner.classList.add('hidden');
    connBanner.innerHTML = '';
    return;
  }
  const active = state.servers.find((s) => s.id === state.activeServerId);
  connBanner.classList.remove('hidden');
  connBanner.innerHTML = `
    <span class="conn-ico"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2a10 10 0 100 20 10 10 0 000-20zm-1 5h2v7h-2V7zm0 9h2v2h-2v-2z"/></svg></span>
    <span class="conn-text">
      <span class="conn-title">Can't reach Ollama</span>
      <span class="conn-sub"><code>${escapeHtml(active?.url ?? '')}</code> isn't responding — start the server or switch.</span>
    </span>
    <span class="conn-actions">
      <button class="conn-btn" id="conn-retry">Retry</button>
      <button class="conn-btn primary" id="conn-servers">Servers</button>
    </span>`;
  connBanner.querySelector('#conn-retry')!.addEventListener('click', () => post({ type: 'retryConnect' }));
  connBanner.querySelector('#conn-servers')!.addEventListener('click', (e) => {
    e.stopPropagation();
    openServerMenu();
  });
}

// ---------------------------------------------------------------------------
// Context usage meter
// ---------------------------------------------------------------------------
function currentWindow(): number {
  const m = state.models.find((x) => x.id === state.currentModel);
  if (!m) {
    return state.minContext || 0;
  }
  // If loaded, show the actual loaded window; otherwise the window we'd load it
  // at: min(configured minContext, the model's own max) — so it changes per model.
  if (m.contextLength) {
    return m.contextLength;
  }
  if (m.maxContextLength) {
    return Math.min(state.minContext || m.maxContextLength, m.maxContextLength);
  }
  return state.minContext || 0;
}

function formatTokens(n: number): string {
  // 1024-base so context windows read as 32K / 64K / 128K (not 33K).
  if (n >= 1024 * 1024) {
    return (n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (n >= 1024) {
    return Math.round(n / 1024) + 'K';
  }
  return String(n);
}

function tokensUsed(t: any): number {
  if (!t) {
    return 0;
  }
  return (t.input || 0) + (t.output || 0) + (t.reasoning || 0);
}

// OpenCode's openai-compatible provider doesn't report token usage for LM
// Studio, so estimate locally. Calibrated against a proxy measurement: the
// build agent's system prompt + tool definitions are ~11k tokens; plan is
// lighter. Plus ~1 token / 4 chars of visible conversation, plus images.
function estimateUsed(): number {
  let chars = 0;
  for (const ps of partState.values()) {
    chars += ps.buffer.length;
  }
  const overhead = state.agent === 'plan' ? 6000 : 11000;
  const images = document.querySelectorAll('.msg-img').length + state.pendingImages.length;
  const fileTokens =
    state.activeFile && state.includeActiveFile ? Math.ceil(state.activeFile.chars / 4) : 0;
  return overhead + Math.ceil(chars / 4) + images * 700 + fileTokens;
}

function renderMeter(): void {
  if (!ctxMeterEl) {
    return;
  }
  ctxMeterEl.style.display = state.serverReady ? 'flex' : 'none';
  const win = currentWindow();
  const estimated = state.realTokens <= 0;
  const used = estimated ? estimateUsed() : state.realTokens;
  const pct = win > 0 ? Math.min(100, (used / win) * 100) : 0;
  ctxFillEl.style.width = pct.toFixed(1) + '%';
  ctxMeterEl.classList.toggle('warn', pct >= 70 && pct < 90);
  ctxMeterEl.classList.toggle('crit', pct >= 90);
  const winLabel = win ? formatTokens(win) : '—';
  let label = `${estimated ? '~' : ''}${formatTokens(used)} / ${winLabel} context · ${Math.round(pct)}%`;
  if (state.compacted) {
    label += ' · compacted';
  }
  ctxLabelEl.textContent = label;
  ctxMeterEl.title = estimated
    ? 'Estimated context usage (includes the agent system prompt + tools). Ollama does not report exact token usage to OpenCode.'
    : 'Context window usage';
}

// ---------------------------------------------------------------------------
// Message + part rendering
// ---------------------------------------------------------------------------
function clearConversation(): void {
  messageEls.clear();
  partState.clear();
  roleByMessage.clear();
  permissionEls.clear();
  hideWorking();
  messagesEl.querySelectorAll('.msg, .perm-card, .sys-chip, .error-bubble').forEach((n) => n.remove());
  state.realTokens = 0;
  state.compacted = false;
  toggleWelcome();
}

function toggleWelcome(): void {
  const hasContent = messagesEl.querySelector('.msg, .perm-card, .error-bubble');
  welcomeEl.style.display = hasContent ? 'none' : 'flex';
}

function ensureMessageEl(messageID: string, role: string): { partsEl: HTMLElement } {
  let entry = messageEls.get(messageID);
  if (!entry) {
    const el = document.createElement('div');
    el.className = `msg ${role === 'user' ? 'user' : 'assistant'}`;
    const partsEl = document.createElement('div');
    partsEl.className = 'parts';
    el.appendChild(partsEl);
    messagesEl.appendChild(el);
    entry = { el, partsEl, role };
    messageEls.set(messageID, entry);
    toggleWelcome();
  } else if (role && entry.role !== role) {
    entry.role = role;
    entry.el.className = `msg ${role === 'user' ? 'user' : 'assistant'}`;
  }
  return entry;
}

function mdToHtml(src: string): string {
  const raw = marked.parse(src ?? '', { async: false, gfm: true, breaks: true }) as string;
  const tpl = document.createElement('template');
  tpl.innerHTML = raw;
  tpl.content.querySelectorAll('script,iframe,object,embed,link,meta,style').forEach((n) => n.remove());
  tpl.content.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) {
        el.removeAttribute(attr.name);
      }
      if ((attr.name === 'href' || attr.name === 'src') && /^\s*javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return tpl.innerHTML;
}

// Render a text or reasoning part from its buffer. Empty parts are hidden so
// they don't leave a stray timeline dot.
function renderTextLike(ps: { el: HTMLElement; buffer: string; type: string }): void {
  const has = ps.buffer.trim().length > 0;
  ps.el.style.display = has ? '' : 'none';
  if (!has) {
    ps.el.innerHTML = '';
    return;
  }
  if (ps.type === 'reasoning') {
    if (!ps.el.querySelector('.reasoning-body')) {
      ps.el.innerHTML =
        '<details class="reasoning" open><summary><span class="chev"></span>Thinking</summary><div class="reasoning-body"></div></details>';
    }
    (ps.el.querySelector('.reasoning-body') as HTMLElement).innerHTML = mdToHtml(ps.buffer);
  } else {
    ps.el.innerHTML = mdToHtml(ps.buffer);
    enhanceCode(ps.el);
  }
}

function enhanceCode(container: HTMLElement): void {
  container.querySelectorAll('pre').forEach((pre) => {
    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
      try {
        void navigator.clipboard?.writeText(code);
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = 'Copy'), 1200);
      } catch {
        /* ignore */
      }
    });
    pre.appendChild(btn);
  });
}

function upsertPart(part: Part): void {
  const role = roleByMessage.get(part.messageID) ?? 'assistant';
  const { partsEl } = ensureMessageEl(part.messageID, role);
  if (role !== 'user' && state.busy) {
    if (part.type === 'reasoning') {
      setWorkingLabel('Thinking…');
    } else if (part.type === 'tool') {
      const st = (part as any).state;
      const status = st?.status;
      setWorkingLabel(
        status === 'running' || status === 'pending'
          ? `Running ${(part as any).tool}…`
          : 'Working…',
      );
    } else if (part.type === 'text') {
      setWorkingLabel('Responding…');
    }
  }

  let ps = partState.get(part.id);
  if (!ps) {
    const el = document.createElement('div');
    el.className = `part part-${part.type}`;
    partsEl.appendChild(el);
    ps = { el, buffer: '', type: part.type };
    partState.set(part.id, ps);
  }

  switch (part.type) {
    case 'text':
    case 'reasoning': {
      ps.buffer = (part as any).text ?? ps.buffer;
      renderTextLike(ps);
      break;
    }
    case 'tool': {
      renderTool(ps.el, part as any, part.id);
      break;
    }
    case 'file': {
      const f = part as any;
      const mime: string = f.mime ?? '';
      const url: string = f.url ?? '';
      if (mime.startsWith('image/') || /^data:image\//.test(url)) {
        ps.el.innerHTML = `<img class="msg-img" alt="${escapeHtml(f.filename ?? 'image')}" />`;
        (ps.el.querySelector('img.msg-img') as HTMLImageElement).src = url;
      } else {
        ps.el.innerHTML = `<div class="file-chip">${icon.file}<span>${escapeHtml(f.filename ?? url ?? 'file')}</span></div>`;
      }
      break;
    }
    case 'step-start':
    case 'step-finish':
    case 'snapshot':
    case 'patch':
      ps.el.remove();
      partState.delete(part.id);
      break;
    default:
      ps.el.remove();
      partState.delete(part.id);
  }
  renderMeter();
  scrollToBottom();
}

function appendDelta(partID: string, field: string, delta: string): void {
  if (field !== 'text') {
    return;
  }
  const ps = partState.get(partID);
  if (!ps) {
    return;
  }
  ps.buffer += delta;
  renderTextLike(ps);
  scrollToBottom();
}

function renderTool(el: HTMLElement, part: { tool: string; state: any }, partId: string): void {
  const st = part.state ?? {};
  const status = st.status ?? 'pending';
  const input = st.input ?? {};
  const filePath = input.filePath || input.path || input.file;
  const title = st.title && st.title !== part.tool ? st.title : filePath ? String(filePath) : '';
  const statusIcon =
    status === 'completed' ? '✓' : status === 'error' ? '✕' : status === 'running' ? '●' : '·';
  const collapsed = toolCollapsed.get(partId) ?? true;
  el.dataset.status = status;

  el.innerHTML = `
    <div class="tool-card status-${status}${collapsed ? ' collapsed' : ''}">
      <button class="tool-head" type="button">
        <span class="tool-chev"></span>
        <span class="tool-ico">${icon.tool}</span>
        <span class="tool-name">${escapeHtml(part.tool)}</span>
        <span class="tool-title">${escapeHtml(title)}</span>
        <span class="tool-status">${statusIcon}</span>
      </button>
      <div class="tool-body"></div>
    </div>`;
  const card = el.querySelector('.tool-card') as HTMLElement;
  const body = el.querySelector('.tool-body') as HTMLElement;
  (el.querySelector('.tool-head') as HTMLElement).addEventListener('click', () => {
    const next = !card.classList.contains('collapsed');
    card.classList.toggle('collapsed', next);
    toolCollapsed.set(partId, next);
  });

  if (filePath) {
    const fileRow = document.createElement('button');
    fileRow.className = 'tool-file';
    fileRow.innerHTML = `${icon.file}<span>${escapeHtml(String(filePath))}</span>`;
    fileRow.addEventListener('click', () => post({ type: 'openFile', path: String(filePath) }));
    body.appendChild(fileRow);
  }
  const output = status === 'error' ? st.error : st.output;
  if (output) {
    const pre = document.createElement('pre');
    pre.className = 'tool-output';
    pre.textContent = String(output).slice(0, 8000);
    body.appendChild(pre);
  } else if (!filePath && Object.keys(input).length) {
    const pre = document.createElement('pre');
    pre.className = 'tool-output dim';
    pre.textContent = JSON.stringify(input, null, 2).slice(0, 1500);
    body.appendChild(pre);
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------
function renderPermission(req: any): void {
  if (permissionEls.has(req.id)) {
    return;
  }
  const card = document.createElement('div');
  card.className = 'perm-card';
  const meta = req.metadata ?? {};
  const detail = meta.command || meta.filePath || (req.patterns || []).join(', ') || '';
  card.innerHTML = `
    <div class="perm-head">Permission required: <b>${escapeHtml(req.permission ?? 'action')}</b></div>
    ${detail ? `<pre class="perm-detail">${escapeHtml(String(detail))}</pre>` : ''}
    <div class="perm-actions">
      <button class="perm-btn allow-once">Allow once</button>
      <button class="perm-btn allow-always">Allow always</button>
      <button class="perm-btn reject">Deny</button>
    </div>`;
  const respond = (response: 'once' | 'always' | 'reject') => {
    post({ type: 'permission', sessionID: req.sessionID, permissionID: req.id, response });
    card.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    card.classList.add('resolved');
    const note = document.createElement('div');
    note.className = 'perm-resolved';
    note.textContent = response === 'reject' ? 'Denied' : `Allowed (${response})`;
    card.appendChild(note);
  };
  card.querySelector('.allow-once')!.addEventListener('click', () => respond('once'));
  card.querySelector('.allow-always')!.addEventListener('click', () => respond('always'));
  card.querySelector('.reject')!.addEventListener('click', () => respond('reject'));
  messagesEl.appendChild(card);
  permissionEls.set(req.id, card);
  toggleWelcome();
  scrollToBottom();
}

function resolvePermission(id: string): void {
  const card = permissionEls.get(id);
  if (card && !card.classList.contains('resolved')) {
    card.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    card.classList.add('resolved');
  }
}

// ---------------------------------------------------------------------------
// Typing indicator / errors / status
// ---------------------------------------------------------------------------
function showWorking(label = 'Working…'): void {
  workingLabelEl.textContent = label;
  workingEl.classList.remove('hidden');
  workingStart = Date.now();
  workingElapsedEl.textContent = '';
  if (workingTimer) {
    clearInterval(workingTimer);
  }
  workingTimer = setInterval(() => {
    const s = Math.floor((Date.now() - workingStart) / 1000);
    workingElapsedEl.textContent = s > 0 ? `${s}s` : '';
  }, 1000);
}
function setWorkingLabel(label: string): void {
  if (!workingEl.classList.contains('hidden')) {
    workingLabelEl.textContent = label;
  }
}
function hideWorking(): void {
  workingEl.classList.add('hidden');
  if (workingTimer) {
    clearInterval(workingTimer);
    workingTimer = undefined;
  }
}

function showError(message: string): void {
  hideWorking();
  const el = document.createElement('div');
  el.className = 'error-bubble';
  el.textContent = message;
  messagesEl.appendChild(el);
  toggleWelcome();
  scrollToBottom();
}

function setStatus(text: string, kind?: 'info' | 'warn' | 'error'): void {
  statusEl.textContent = text;
  statusEl.className = `status ${kind ?? ''} ${text ? 'show' : ''}`;
}

function setBusy(busy: boolean): void {
  state.busy = busy;
  sendBtn.innerHTML = busy ? icon.stop : icon.send;
  sendBtn.classList.toggle('busy', busy);
  if (busy) {
    showWorking('Working…');
  } else {
    hideWorking();
  }
}

function scrollToBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

// ---------------------------------------------------------------------------
// History overlay
// ---------------------------------------------------------------------------
function openHistory(): void {
  post({ type: 'loadSessions' });
  renderHistory();
  historyOverlay.classList.remove('hidden');
}
function closeHistory(): void {
  historyOverlay.classList.add('hidden');
}
function renderHistory(): void {
  historyList.innerHTML = '';
  if (!state.sessions.length) {
    historyList.innerHTML = `<div class="history-empty">No conversations yet.</div>`;
    return;
  }
  for (const s of state.sessions) {
    const row = document.createElement('div');
    row.className = 'history-row' + (s.id === state.currentSessionID ? ' active' : '');
    row.innerHTML = `
      <button class="history-open">
        <span class="history-title">${escapeHtml(s.title)}</span>
        <span class="history-time">${relativeTime(s.updated)}</span>
      </button>
      <button class="history-del" title="Delete">${icon.trash}</button>`;
    row.querySelector('.history-open')!.addEventListener('click', () => {
      post({ type: 'loadSession', sessionID: s.id });
      closeHistory();
    });
    row.querySelector('.history-del')!.addEventListener('click', (e) => {
      e.stopPropagation();
      post({ type: 'deleteSession', sessionID: s.id });
    });
    historyList.appendChild(row);
  }
}
function relativeTime(ms: number): string {
  if (!ms) {
    return '';
  }
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 1) {
    return 'just now';
  }
  if (m < 60) {
    return `${m}m ago`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `${h}h ago`;
  }
  return `${Math.floor(h / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// History (full conversation) rendering
// ---------------------------------------------------------------------------
function renderConversation(messages: MessageWithParts[]): void {
  clearConversation();
  let lastUsed = 0;
  for (const m of messages) {
    roleByMessage.set(m.info.id, m.info.role);
    ensureMessageEl(m.info.id, m.info.role);
    for (const part of m.parts) {
      upsertPart(part);
    }
    if (m.info.role === 'assistant' && (m.info as any).tokens) {
      const u = tokensUsed((m.info as any).tokens);
      if (u > 0) {
        lastUsed = u;
      }
    }
    if (m.info.error) {
      const err: any = m.info.error;
      showError(err?.data?.message ?? err?.message ?? 'Error');
    }
  }
  state.realTokens = lastUsed;
  renderMeter();
  toggleWelcome();
  scrollToBottom();
}

// ---------------------------------------------------------------------------
// OpenCode event handling
// ---------------------------------------------------------------------------
function handleEvent(event: OpencodeEvent): void {
  const p = event.properties as any;
  switch (event.type) {
    case 'message.updated': {
      const info = p.info;
      if (info?.id) {
        roleByMessage.set(info.id, info.role);
        ensureMessageEl(info.id, info.role);
        if (info.role === 'assistant' && info.tokens) {
          const used = tokensUsed(info.tokens);
          if (used > 0) {
            state.realTokens = used;
            state.compacted = false;
          }
          renderMeter();
        }
        if (info.error) {
          showError(info.error?.data?.message ?? info.error?.message ?? 'Error');
        }
      }
      break;
    }
    case 'session.compacted':
      state.compacted = true;
      renderMeter();
      break;
    case 'message.part.updated':
      if (p.part) {
        upsertPart(p.part as Part);
      }
      break;
    case 'message.part.delta':
      appendDelta(p.partID, p.field, p.delta);
      break;
    case 'message.part.removed': {
      const ps = partState.get(p.partID);
      ps?.el.remove();
      partState.delete(p.partID);
      break;
    }
    case 'permission.asked':
      renderPermission(p);
      break;
    case 'permission.replied':
      resolvePermission(p.id ?? p.permissionID);
      break;
    case 'session.idle':
      setBusy(false);
      renderMeter();
      break;
    case 'session.error': {
      const err = p.error;
      showError(err?.data?.message ?? err?.message ?? 'Session error');
      setBusy(false);
      break;
    }
    case 'file.edited':
      // Subtle chip noting an edited file (deduped per render is not critical).
      break;
  }
}

// ---------------------------------------------------------------------------
// Host messages
// ---------------------------------------------------------------------------
window.addEventListener('message', (e: MessageEvent<HostToWebview>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      state.models = msg.models;
      state.currentModel = msg.currentModel;
      state.agent = msg.agent;
      state.serverReady = msg.serverReady;
      state.ollamaConnected = msg.ollamaConnected;
      state.minContext = msg.minContext;
      renderModels();
      renderMeter();
      renderServers();
      if (!msg.serverReady && msg.ollamaConnected) {
        setStatus('OpenCode server failed to start. See logs.', 'error');
      }
      break;
    case 'servers':
      state.servers = msg.servers;
      state.activeServerId = msg.activeId;
      state.ollamaConnected = msg.connected;
      renderServers();
      break;
    case 'models':
      state.models = msg.models;
      state.currentModel = msg.currentModel;
      state.loadingModels.clear();
      renderModels();
      renderMeter();
      break;
    case 'sessions':
      state.sessions = msg.sessions;
      state.currentSessionID = msg.currentSessionID;
      renderHistory();
      break;
    case 'sessionLoaded':
      state.currentSessionID = msg.sessionID;
      renderConversation(msg.messages);
      break;
    case 'cleared':
      clearConversation();
      renderMeter();
      break;
    case 'event':
      handleEvent(msg.event);
      break;
    case 'busy':
      setBusy(msg.busy);
      break;
    case 'activeFile':
      state.activeFile = msg.path ? { path: msg.path, chars: msg.chars } : null;
      renderActiveFile();
      renderMeter();
      break;
    case 'status':
      setStatus(msg.text, msg.kind);
      break;
    case 'command':
      if (msg.command === 'history') {
        openHistory();
      } else if (msg.command === 'newChat') {
        post({ type: 'newChat' });
      } else if (msg.command === 'focusInput') {
        inputEl.focus();
      }
      break;
    case 'error':
      showError(msg.message);
      setBusy(false);
      break;
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
build();
post({ type: 'ready' });
