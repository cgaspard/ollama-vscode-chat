import { marked } from 'marked';
import {
  CompactionState,
  isCompactionPart,
  isSyntheticText,
  markCompaction,
  newCompactionState,
  shouldSuppressMessage,
} from '../core/compaction';
import { matchSlashPrefix, mergeSlashCommands, parseSlashInput } from '../core/commands';
import { computeWindow, contextPresets, formatTokens } from '../core/context';
import {
  formatLoadElapsed,
  formatModelDate,
  isModelReady,
  mergeModelLoadedState,
  modelDisambiguator,
  modelIdentity,
} from '../core/models';
import { isTodoCardCollapsed, summarizeTodos, Todo } from '../core/todos';
import { buildAnswers, isEmptyAnswer, parseQuestionBlob, QInfo } from '../core/question';
import type { MessageWithParts, OpencodeEvent, Part } from '../opencode/protocol';
import type { HostToWebview, UiCommand, UiGoal, UiImage, UiMcpServer, UiModel, UiServer, UiSession, UiSkill, WebviewToHost } from '../shared';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
};
// Injected by esbuild `define`: true in test builds, false in production (where
// the test hook below is then dead-code-eliminated).
declare const __TEST__: boolean;

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
  keepAlive: string;
  realTokens: number;
  compacted: boolean;
  compacting: boolean; // a /compact run is in flight — input is blocked
  pendingCompaction: boolean; // compacted; true size is unknown until the next turn
  loadingModels: Set<string>;
  loadStartedAt: Map<string, number>; // modelID -> Date.now() when load began (elapsed timer)
  servers: UiServer[];
  activeServerId: string;
  activeFile: { path: string; chars: number } | null;
  includeActiveFile: boolean;
  activeSelection: { path: string; startLine: number; endLine: number; chars: number } | null;
  activeGoal: UiGoal | null;
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
  keepAlive: '30m',
  realTokens: 0,
  compacted: false,
  compacting: false,
  pendingCompaction: false,
  loadingModels: new Set<string>(),
  loadStartedAt: new Map<string, number>(),
  servers: [],
  activeServerId: '',
  activeFile: null,
  includeActiveFile: persisted.includeActiveFile ?? true,
  activeSelection: null,
  activeGoal: null,
};

// Live rendering bookkeeping (keyed by ids so events and history both upsert).
const messageEls = new Map<string, { el: HTMLElement; partsEl: HTMLElement; role: string }>();
const partState = new Map<string, { el: HTMLElement; buffer: string; type: string }>();
const roleByMessage = new Map<string, string>();
const permissionEls = new Map<string, HTMLElement>();
const questionEls = new Map<string, HTMLElement>();
const toolCollapsed = new Map<string, boolean>(); // partID -> collapsed?
// The agent's todowrite tool is rendered as ONE live checklist per assistant
// message (it calls todowrite repeatedly, replacing the whole list). Keyed by
// messageID so repeated calls update one card in place instead of stacking.
const todoCards = new Map<string, HTMLElement>(); // messageID -> checklist card el
const todoCollapsed = new Map<string, boolean>(); // messageID -> user-forced collapse (unset = auto)
let turnTruncated = false; // the current turn hit its output-token budget (finish reason 'length')
let closeMenuOnLoad = false; // user hit Load from the menu — close it once the load returns
// Generation-speed tracking. We estimate tokens/sec from the streamed output
// (chars/4) and our own elapsed time, so the live rate works while streaming.
let turnOutputChars = 0; // streamed output chars this turn
let turnFirstTokenAt = 0; // when the first output token arrived (Date.now), for an accurate rate
// Compaction bookkeeping. OpenCode's summarize ("/compact") writes a user
// message with a `compaction` part, then streams the summarizer model's own
// reasoning + the summary template as an ordinary assistant turn. Neither is a
// real chat turn, so we collapse the marker to a chip and suppress that turn.
// Decision logic lives in ../core/compaction (pure + unit-tested).
const compaction: CompactionState = newCompactionState();
let lastCompactionChip: HTMLElement | null = null; // so the summary can be attached when it arrives

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
const icon = {
  plus: `<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M8.5 2.5v5h5v1h-5v5h-1v-5h-5v-1h5v-5z"/></svg>`,
  history: `<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5h-1A5.5 5.5 0 1 1 8 2.5V1.5zM7.5 4v4.2l3.1 1.8.5-.86L8.5 7.7V4z"/><path fill="currentColor" d="M8 1.5 5.4 3.2 8 4.9z"/></svg>`,
  window: `<svg viewBox="0 0 16 16" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M2.6 3.5h10.8a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z"/><path fill="currentColor" d="M1.6 5.4h12.8v1H1.6z"/></svg>`,
  target: `<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1" fill="currentColor"/></svg>`,
  dots: `<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="3" cy="8" r="1.4" fill="currentColor"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/><circle cx="13" cy="8" r="1.4" fill="currentColor"/></svg>`,
  pencil: `<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M11.5 1.6a1.4 1.4 0 0 1 2 0l.9.9a1.4 1.4 0 0 1 0 2l-8.2 8.2-3.5 1 1-3.5zM10.6 3.9l1.5 1.5 1.2-1.2-1.5-1.5z"/></svg>`,
  pause: `<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M4.5 2.8h2.4v10.4H4.5zM9.1 2.8h2.4v10.4H9.1z"/></svg>`,
  play: `<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M4.5 2.5 13 8l-8.5 5.5z"/></svg>`,
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
  download: `<svg viewBox="0 0 16 16" width="15" height="15"><path fill="currentColor" d="M7.5 1v7.6L5.2 6.3l-.7.7L8 10.4l3.5-3.4-.7-.7-2.3 2.3V1zM3 12.5h10v1H3z"/></svg>`,
  checklist: `<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M2 3h2v2H2zM6 3.5h8v1H6zM2 7h2v2H2zM6 7.5h8v1H6zM2 11h2v2H2zM6 11.5h8v1H6z"/></svg>`,
  // Flat monochrome capability glyphs for the model list (currentColor, no fill colors).
  eye: `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="1.8" fill="currentColor"/></svg>`,
  wrench: `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M11.5 1.5a3.5 3.5 0 0 0-3.4 4.4L1.7 12.3l1.9 1.9 6.4-6.4A3.5 3.5 0 1 0 11.5 1.5z"/></svg>`,
  spinner: `<svg viewBox="0 0 16 16" width="13" height="13" class="spin" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M8 1.6a6.4 6.4 0 1 1-6.2 4.8" /></svg>`,
};

// ---------------------------------------------------------------------------
// DOM scaffolding
// ---------------------------------------------------------------------------
// Stick-to-bottom autoscroll. While `autoScrollEnabled` is true, streamed
// content keeps the view pinned to the bottom; once the user scrolls up past
// the threshold it turns off so they can read back mid-generation.
const STICK_TO_BOTTOM_THRESHOLD = 120; // px from the bottom that still counts as "at bottom"
let autoScrollEnabled = true;
let messagesEl!: HTMLElement;
let welcomeEl!: HTMLElement;
let inputEl!: HTMLTextAreaElement;
let slashMenuEl!: HTMLElement;
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
let goalBarEl!: HTMLElement;
let goalTextEl!: HTMLElement;
let goalMetaEl!: HTMLElement;
let goalPauseBtn!: HTMLButtonElement;
let goalTicker: ReturnType<typeof setInterval> | undefined;
let overflowBtn!: HTMLButtonElement;
let overflowMenuEl!: HTMLElement;
/** Composer controls that may collapse into the ⋯ menu, in hide-order (first
 * entries overflow first). `anchor` marks each control's home position so it
 * can be restored to exactly where it came from when space returns. */
let overflowItems: Array<{ el: HTMLElement; home: HTMLElement; anchor: Node }> = [];
let attachmentsEl!: HTMLElement;
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
// Ticks the elapsed label on loading model rows while any load is in flight.
let modelLoadTimer: ReturnType<typeof setInterval> | undefined;

function build(): void {
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <div id="titlebar-actions" class="titlebar-actions">
      <button id="ta-new" class="ta-btn" title="New chat">${icon.plus}</button>
      <button id="ta-history" class="ta-btn" title="Session history">${icon.history}</button>
      <button id="ta-tab" class="ta-btn" title="Open chat in editor tab">${icon.window}</button>
    </div>
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
      <div id="goal-bar" class="goal-bar hidden">
        <span class="goal-ico">${icon.target}</span>
        <span class="goal-label">Pursuing goal</span>
        <span id="goal-text" class="goal-text"></span>
        <span id="goal-meta" class="goal-meta"></span>
        <span class="goal-actions">
          <button id="goal-edit" class="goal-btn" title="Edit goal">${icon.pencil}</button>
          <button id="goal-pause" class="goal-btn" title="Pause goal">${icon.pause}</button>
          <button id="goal-clear" class="goal-btn" title="Clear goal">${icon.trash}</button>
        </span>
      </div>
      <div class="composer-box">
        <div id="slash-menu" class="slash-menu hidden"></div>
        <div id="attachments" class="attachments hidden">
          <div id="thumbs" class="thumbs"></div>
        </div>
        <textarea id="input" rows="1" placeholder="Ask anything, paste an image, or describe a task…"></textarea>
        <div class="composer-row">
          <div class="composer-tools">
            <button id="server-btn" class="tool-pill" title="Ollama server — switch / add">
              <span class="model-dot"></span><span id="server-name">Server</span>
            </button>
            <button id="btn-attach" class="tool-pill icon-only" title="Attach image">${icon.paperclip}</button>
            <button id="btn-think" class="tool-pill" title="Toggle thinking">${icon.brain}<span>Thinking</span></button>
            <button id="btn-goal" class="tool-pill icon-only" title="Pursue a goal until it's met">${icon.target}</button>
            <span class="tool-sep" id="tool-sep"></span>
            <button id="ctxfile" class="ctxref hidden" title="Include the open file as context">${icon.file}<span id="ctxfile-name"></span></button>
          </div>
          <div class="composer-right">
            <button id="overflow-btn" class="tool-pill icon-only hidden" title="More options">${icon.dots}</button>
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
        <span class="ctx-foot-label">Context window <span id="ctx-foot-model" class="ctx-foot-model"></span></span>
        <div id="ctx-presets" class="ctx-presets"></div>
        <span class="ctx-foot-label">Keep models loaded</span>
        <div id="ka-presets" class="ctx-presets"></div>
      </div>
    </div>
    <div id="overflow-menu" class="model-menu overflow-menu hidden"></div>
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
  // Stick-to-bottom: stop forcing the view down once the user scrolls up to
  // read back, and re-engage when they return near the bottom. Without this,
  // every streamed token would yank the scroll position to the bottom.
  messagesEl.addEventListener('scroll', () => {
    const distanceFromBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    autoScrollEnabled = distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD;
  });
  welcomeEl = document.getElementById('welcome')!;
  inputEl = document.getElementById('input') as HTMLTextAreaElement;
  slashMenuEl = document.getElementById('slash-menu')!;
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
  attachmentsEl = document.getElementById('attachments')!;
  goalBarEl = document.getElementById('goal-bar')!;
  goalTextEl = document.getElementById('goal-text')!;
  goalMetaEl = document.getElementById('goal-meta')!;
  goalPauseBtn = document.getElementById('goal-pause') as HTMLButtonElement;

  // Goal bar controls + the composer Goal button.
  document.getElementById('btn-goal')!.addEventListener('click', () => {
    prefillGoalInput(state.activeGoal?.objective ?? '');
  });
  document.getElementById('goal-edit')!.addEventListener('click', () => {
    prefillGoalInput(state.activeGoal?.objective ?? '');
  });
  goalPauseBtn.addEventListener('click', () => {
    if (!state.activeGoal) {
      return;
    }
    post({ type: state.activeGoal.state === 'paused' ? 'resumeGoal' : 'pauseGoal' });
  });
  document.getElementById('goal-clear')!.addEventListener('click', () => post({ type: 'clearGoal' }));

  // Composer overflow: lower-priority controls collapse into the ⋯ menu when
  // the panel is narrow, and return when there's room — nothing gets pushed
  // off-screen. Hide-order: first entries collapse first.
  overflowBtn = document.getElementById('overflow-btn') as HTMLButtonElement;
  overflowMenuEl = document.getElementById('overflow-menu')!;
  overflowItems = ['server-btn', 'agent-select', 'btn-goal', 'btn-think', 'tool-sep', 'btn-attach', 'ctxfile']
    .map((id) => document.getElementById(id))
    .filter((el): el is HTMLElement => !!el)
    .map((el) => {
      const anchor = document.createComment('overflow-home');
      el.parentElement!.insertBefore(anchor, el);
      return { el, home: el.parentElement as HTMLElement, anchor };
    });
  overflowBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleOverflowMenu();
  });
  const composerRow = document.querySelector('.composer-row') as HTMLElement;
  new ResizeObserver(() => layoutComposer()).observe(composerRow);
  layoutComposer();
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

  // Floating top-right actions (mirror the old native title-bar buttons).
  document.getElementById('ta-new')!.addEventListener('click', () => post({ type: 'newChat' }));
  document.getElementById('ta-history')!.addEventListener('click', () => openHistory());
  document.getElementById('ta-tab')!.addEventListener('click', () => post({ type: 'openInTab' }));

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

  // The button is context-sensitive: while a turn runs it SHOWS a stop icon, so
  // clicking it always aborts — steering mid-turn is done with Enter instead.
  sendBtn.addEventListener('click', () => {
    if (state.busy) {
      post({ type: 'abort' });
      return;
    }
    onSend();
  });
  inputEl.addEventListener('keydown', (e) => {
    // While the slash-command menu is open it owns the arrow / tab / esc keys.
    if (slashMenuOpen()) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveSlashSelection(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveSlashSelection(-1);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        acceptSlashCommand();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSlashMenu();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Runs while busy too: Enter with text STEERS the in-flight turn
      // (onSend handles it); Enter on an empty box does nothing.
      onSend();
    }
  });
  inputEl.addEventListener('input', () => {
    autoGrow();
    updateSlashMenu();
  });
  inputEl.addEventListener('blur', () => closeSlashMenu());

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
    // The send button can act as a "Load a model" CTA that OPENS this menu, so a
    // click on it must not also be treated as an outside-click that closes it.
    if (
      !modelMenu.classList.contains('hidden') &&
      !modelMenu.contains(t) &&
      !modelBtn.contains(t) &&
      !sendBtn.contains(t)
    ) {
      closeModelMenu();
    }
    if (!serverMenu.classList.contains('hidden') && !serverMenu.contains(t) && !serverBtn.contains(t)) {
      closeServerMenu();
    }
    if (
      !overflowMenuEl.classList.contains('hidden') &&
      !overflowMenuEl.contains(t) &&
      !overflowBtn.contains(t)
    ) {
      closeOverflowMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.getElementById('lightbox')) {
        closeLightbox();
        return;
      }
      closeModelMenu();
      closeServerMenu();
      closeOverflowMenu();
    }
  });
  agentSelect.addEventListener('change', () => {
    state.agent = agentSelect.value as 'build' | 'plan';
    post({ type: 'selectAgent', agent: state.agent });
    renderMeter();
  });
  // Paint the composer button in its correct mode before any message arrives —
  // otherwise it defaults to an active Send with no model loaded.
  syncSendEnabled();
}

function autoGrow(): void {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------
interface SlashCommand {
  name: string;
  hint: string;
  /** Local UI commands run a callback (given any trailing args the user typed);
   * server commands carry their kind in `server` instead. */
  run?: (args?: string) => void;
  /** Set for server-provided commands/skills (invoked via runCommand). */
  server?: { command: string; source: 'command' | 'skill'; takesArgs: boolean };
}

// Built-in UI commands (handled entirely in the webview/host, not the model).
const LOCAL_COMMANDS: SlashCommand[] = [
  { name: '/clear', hint: 'Clear the conversation and start fresh', run: clearChatCommand },
  { name: '/compact', hint: 'Summarize the conversation to free up context', run: compactCommand },
  { name: '/file', hint: 'Toggle including the open file as context', run: toggleFileCommand },
  { name: '/mcp', hint: 'Show connected MCP servers and their status', run: mcpCommand },
  { name: '/skills', hint: 'Show the skills available to the model', run: skillsCommand },
  { name: '/goal', hint: 'Pursue a goal until it is met — /goal <objective>, /goal clear', run: goalCommand },
  { name: '/help', hint: 'List the available slash commands', run: helpCommand },
];

// Server-provided commands + skills (from GET /command), populated on connect.
let serverCommands: SlashCommand[] = [];

// The full slash list: local UI commands first, then server commands/skills,
// de-duplicated by name (a local command wins over a server one of the same
// name, e.g. our /compact).
function allCommands(): SlashCommand[] {
  // Merge + dedupe is pure — see core/commands. A local command of the same
  // name wins over a server one.
  return mergeSlashCommands(LOCAL_COMMANDS, serverCommands);
}

function setServerCommands(cmds: UiCommand[]): void {
  serverCommands = cmds.map((c) => ({
    name: '/' + c.name,
    hint: c.description || (c.source === 'skill' ? 'Skill' : 'Command'),
    server: { command: c.name, source: c.source, takesArgs: c.takesArgs },
  }));
}

function clearChatCommand(): void {
  post({ type: 'clearAllSessions' });
}

function compactCommand(): void {
  post({ type: 'compact' });
}

function toggleFileCommand(): void {
  if (!state.activeFile) {
    addSysChip('No open file to include as context.');
    return;
  }
  state.includeActiveFile = !state.includeActiveFile;
  persist();
  renderActiveFile();
  renderMeter();
  addSysChip(`Open file ${state.includeActiveFile ? 'included in' : 'excluded from'} context.`);
}

// Request the live MCP server status from the host. The result arrives as an
// `mcpStatus` message and is rendered by showMcpStatus() into a status chip.
function mcpCommand(): void {
  addSysChip('Checking MCP servers…');
  post({ type: 'requestMcpStatus' });
}

// Request the discovered skills from the host (GET /skill). Rendered by
// showSkills() so the user can confirm their project/global skills are found.
function skillsCommand(): void {
  addSysChip('Checking skills…');
  post({ type: 'requestSkills' });
}

// /goal <objective> starts an autonomous goal loop; /goal clear ends it; bare
// /goal prefills the input so the user can type the objective.
function goalCommand(args?: string): void {
  const a = (args ?? '').trim();
  if (!a) {
    prefillGoalInput(state.activeGoal?.objective ?? '');
    return;
  }
  if (a.toLowerCase() === 'clear' || a.toLowerCase() === 'stop') {
    post({ type: 'clearGoal' });
    addSysChip('Goal cleared.');
    return;
  }
  post({ type: 'setGoal', objective: a });
}

// Put "/goal <current-or-empty>" in the composer so the user can type/edit the
// objective and press Enter — the same pattern as arg-taking server commands.
function prefillGoalInput(existing: string): void {
  inputEl.value = existing ? `/goal ${existing}` : '/goal ';
  inputEl.focus();
  autoGrow();
}

// Render the discovered skills as an inline panel — one row per skill with its
// name, a source tag (project / global / built-in), a 'slash' badge when it can
// be invoked as a command, and its description. Reuses the /mcp panel styling.
function showSkills(skills: UiSkill[]): void {
  const el = document.createElement('div');
  el.className = 'sys-chip mcp-panel';

  if (!skills.length) {
    el.innerHTML =
      '<div class="mcp-head">Skills</div>' +
      '<div class="mcp-empty">No skills found. Add one as <code>.opencode/skill/&lt;name&gt;/SKILL.md</code> ' +
      'or <code>.claude/skills/&lt;name&gt;/SKILL.md</code> in your workspace (or <code>~/.claude/skills/</code> globally). ' +
      'The model invokes a skill automatically when your request matches its description.</div>';
    messagesEl.appendChild(el);
    toggleWelcome();
    forceScrollToBottom();
    return;
  }

  const sourceClass = (src: string) => (src === 'project' ? 'ok' : src === 'global' ? 'pending' : 'off');
  const rows = skills
    .map((s) => {
      const dot = sourceClass(s.source);
      const slash = s.slash ? `<span class="mcp-transport">/${escapeHtml(s.name)}</span>` : '';
      const desc = s.description ? `<div class="skill-desc">${escapeHtml(s.description)}</div>` : '';
      const where = s.path ? `<div class="skill-path">${escapeHtml(s.path)}</div>` : '';
      return (
        `<div class="mcp-row">` +
        `<span class="mcp-dot ${dot}"></span>` +
        `<div class="mcp-row-body">` +
        `<div class="mcp-row-top"><span class="mcp-name">${escapeHtml(s.name)}</span>${slash}` +
        `<span class="mcp-status-label ${dot}">${escapeHtml(s.source)}</span></div>` +
        desc +
        where +
        `</div></div>`
      );
    })
    .join('');

  el.innerHTML =
    `<div class="mcp-head">Skills <span class="mcp-count">${skills.length} available</span></div>` +
    `<div class="mcp-list">${rows}</div>`;
  messagesEl.appendChild(el);
  toggleWelcome();
  forceScrollToBottom();
}

function helpCommand(): void {
  const lines = allCommands()
    .map((c) => `${c.name} — ${c.hint}${c.server?.source === 'skill' ? ' (skill)' : ''}`)
    .join('\n');
  addSysChip(`Slash commands:\n${lines}`);
}

// Render the MCP server status as an inline panel in the message stream — one
// row per server with a colored status dot, transport label, and (for failures)
// the error reason. Mirrors how Claude Code's /mcp prints into the conversation.
function showMcpStatus(servers: UiMcpServer[]): void {
  const el = document.createElement('div');
  el.className = 'sys-chip mcp-panel';

  if (!servers.length) {
    el.innerHTML =
      '<div class="mcp-head">MCP servers</div>' +
      '<div class="mcp-empty">No MCP servers configured. Add one in the <code>ollamaCode.mcpServers</code> setting, ' +
      'or a <code>.mcp.json</code> / <code>.vscode/mcp.json</code> file in your workspace.</div>';
    messagesEl.appendChild(el);
    toggleWelcome();
    forceScrollToBottom();
    return;
  }

  const connected = servers.filter((s) => s.status === 'connected').length;
  const rows = servers
    .map((s) => {
      const dot = mcpStatusClass(s.status);
      const transport = s.transport
        ? `<span class="mcp-transport">${s.transport === 'remote' ? 'remote' : 'local'}</span>`
        : '';
      const detail = s.detail ? `<div class="mcp-detail">${escapeHtml(s.detail)}</div>` : '';
      const error =
        s.status === 'failed' && s.error
          ? `<div class="mcp-error">${escapeHtml(s.error)}</div>`
          : '';
      return (
        `<div class="mcp-row">` +
        `<span class="mcp-dot ${dot}"></span>` +
        `<div class="mcp-row-body">` +
        `<div class="mcp-row-top"><span class="mcp-name">${escapeHtml(s.name)}</span>${transport}` +
        `<span class="mcp-status-label ${dot}">${escapeHtml(s.status)}</span></div>` +
        detail +
        error +
        `</div></div>`
      );
    })
    .join('');

  el.innerHTML =
    `<div class="mcp-head">MCP servers <span class="mcp-count">${connected}/${servers.length} connected</span></div>` +
    `<div class="mcp-list">${rows}</div>`;
  messagesEl.appendChild(el);
  toggleWelcome();
  forceScrollToBottom();
}

// Map an MCP status string to the dot/label color class.
function mcpStatusClass(status: string): string {
  switch (status) {
    case 'connected':
      return 'ok';
    case 'failed':
      return 'err';
    case 'disabled':
      return 'off';
    default:
      return 'pending';
  }
}

// Marks where the conversation was compacted. Rendered in place of the noisy
// summarizer turn; collapsed by default since the summary is internal context.
// The summary text arrives later (via the `compacting` done message) and gets
// attached, making the chip expandable.
function showCompactionChip(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sys-chip compaction-chip';
  const head = document.createElement('button');
  head.className = 'compaction-head';
  head.type = 'button';
  head.innerHTML =
    '<span class="compaction-chev"></span><span>⊘ Conversation compacted to free up context</span>';
  const body = document.createElement('div');
  body.className = 'compaction-body';
  el.appendChild(head);
  el.appendChild(body);
  // No summary yet → nothing to expand. attachCompactionSummary() flips this on.
  head.disabled = true;
  head.addEventListener('click', () => {
    if (head.disabled) {
      return;
    }
    el.classList.toggle('open');
  });
  messagesEl.appendChild(el);
  lastCompactionChip = el;
  toggleWelcome();
  scrollToBottom();
  return el;
}

// Attach the summary markdown OpenCode produced to the most recent chip, making
// it expandable. Called when the bridge reports the compaction finished.
function attachCompactionSummary(summary: string): void {
  const chip = lastCompactionChip;
  if (!chip || !summary.trim()) {
    return;
  }
  const head = chip.querySelector('.compaction-head') as HTMLButtonElement | null;
  const body = chip.querySelector('.compaction-body') as HTMLElement | null;
  if (!head || !body) {
    return;
  }
  body.innerHTML = mdToHtml(summary);
  head.disabled = false;
}

// A small inline note from the extension UI itself (not the model).
function addSysChip(text: string): void {
  const el = document.createElement('div');
  el.className = 'sys-chip';
  el.textContent = text;
  messagesEl.appendChild(el);
  toggleWelcome();
  forceScrollToBottom();
}

// --- Autocomplete menu ---
// Index of the highlighted row while the menu is open, or -1 when closed.
let slashActiveIndex = -1;

function slashMenuOpen(): boolean {
  return !slashMenuEl.classList.contains('hidden');
}

// Commands matching the current input. Only offered while the line is a bare
// `/token` (no spaces yet) — once the user moves past the command name we stop
// suggesting so normal prompts starting with "/" aren't hijacked.
function matchingCommands(): SlashCommand[] {
  return matchSlashPrefix(inputEl.value, allCommands());
}

function updateSlashMenu(): void {
  const matches = matchingCommands();
  if (!matches.length) {
    closeSlashMenu();
    return;
  }
  if (slashActiveIndex < 0 || slashActiveIndex >= matches.length) {
    slashActiveIndex = 0;
  }
  slashMenuEl.innerHTML = '';
  matches.forEach((cmd, i) => {
    const row = document.createElement('div');
    row.className = `slash-item${i === slashActiveIndex ? ' active' : ''}`;
    const badge = cmd.server?.source === 'skill' ? '<span class="slash-badge">skill</span>' : '';
    row.innerHTML =
      `<span class="slash-left"><span class="slash-name">${escapeHtml(cmd.name)}</span>${badge}</span>` +
      `<span class="slash-hint">${escapeHtml(cmd.hint)}</span>`;
    row.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus in the textarea
      acceptSlashCommand(cmd);
    });
    slashMenuEl.appendChild(row);
  });
  slashMenuEl.classList.remove('hidden');
}

function closeSlashMenu(): void {
  slashMenuEl.classList.add('hidden');
  slashMenuEl.innerHTML = '';
  slashActiveIndex = -1;
}

function moveSlashSelection(delta: number): void {
  const matches = matchingCommands();
  if (!matches.length) {
    return;
  }
  slashActiveIndex = (slashActiveIndex + delta + matches.length) % matches.length;
  updateSlashMenu();
}

// Execute a chosen command. Local UI commands run their callback; server
// commands/skills are sent to the host to run via OpenCode (with any args).
function executeCommand(cmd: SlashCommand, args = ''): void {
  if (cmd.server) {
    post({ type: 'runCommand', command: cmd.server.command, ...(args.trim() ? { arguments: args.trim() } : {}) });
  } else {
    cmd.run?.(args);
  }
}

// Run the highlighted (or given) command straight from the menu.
function acceptSlashCommand(cmd?: SlashCommand): void {
  const matches = matchingCommands();
  const chosen = cmd ?? matches[slashActiveIndex];
  closeSlashMenu();
  if (!chosen) {
    return;
  }
  // A server command that takes arguments: don't fire yet — fill the input so
  // the user can type the arguments, then press Enter.
  if (chosen.server?.takesArgs) {
    inputEl.value = chosen.name + ' ';
    inputEl.focus();
    autoGrow();
    return;
  }
  inputEl.value = '';
  autoGrow();
  executeCommand(chosen);
}

// Run a slash command if the input is one. Returns true when handled (so the
// caller should NOT send it to the model). An unknown /command is reported and
// also swallowed, so a typo never gets sent to the model verbatim.
function runSlashCommand(text: string): boolean {
  const parsed = parseSlashInput(text);
  if (!parsed) {
    return false;
  }
  const { name, args } = parsed;
  const cmd = allCommands().find((c) => c.name.toLowerCase() === name);
  if (cmd) {
    inputEl.value = '';
    autoGrow();
    executeCommand(cmd, args);
    return true;
  }
  addSysChip(`Unknown command "${name}". Type /help to see what's available.`);
  inputEl.value = '';
  autoGrow();
  return true;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
function onSend(): void {
  if (state.compacting) {
    return; // input is blocked while a /compact runs
  }
  const text = inputEl.value.trim();
  if (state.busy) {
    // Mid-generation: Enter with text STEERS — OpenCode injects the message at
    // the agent's next step boundary, so the model reads it and factors it into
    // the work already in flight (verified live: an instruction injected between
    // tool steps changed the ongoing task). Enter on an empty box is a no-op;
    // aborting belongs to the stop button. For a long single generation with no
    // tool steps the injection lands when that step finishes — same behavior as
    // Claude Code / Codex.
    if (!text && !state.pendingImages.length) {
      return;
    }
    if (!text.startsWith('/')) {
      setStatus('Steering — the agent will pick this up at its next step.');
    }
  }
  // Slash commands run regardless of model state — check before the model gate.
  if (text && runSlashCommand(text)) {
    return; // /compact, /new, …
  }
  // CTA mode: no usable model. The button's job here is to OPEN THE MODEL MENU
  // (and load), not to send — do that even with an empty input, and tell the
  // user why. Covers not-yet-loaded, load-in-progress, failed, and evicted.
  if (!selectedModelReady()) {
    const m = state.models.find((x) => x.id === state.currentModel);
    const loadingSel = !!state.currentModel && state.loadingModels.has(state.currentModel);
    setStatus(
      loadingSel
        ? `Loading ${m?.name ?? 'model'}… it'll be ready shortly.`
        : 'Pick a model and press Load to start chatting.',
      'warn',
    );
    if (!loadingSel) {
      openModelMenu();
    }
    return;
  }
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
  autoScrollEnabled = true; // a new turn follows the response, even if scrolled up before
  post({
    type: 'send',
    text,
    thinking: state.thinking,
    images,
    includeActiveFile: !!(state.activeFile && state.includeActiveFile),
    // The current selection is always attached silently when present.
    includeSelection: !!state.activeSelection,
  });
}

function applyThinking(): void {
  thinkBtn.classList.toggle('active', state.thinking);
  document.body.classList.toggle('hide-reasoning', !state.thinking);
  thinkBtn.title = state.thinking ? 'Thinking: on' : 'Thinking: off';
}

function persist(): void {
  vscode.setState({
    thinking: state.thinking,
    includeActiveFile: state.includeActiveFile,
  });
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
  layoutComposer(); // pill visibility changes the row's width needs
}

// Render the editor-selection reference pill. Mirrors the active-file pill so
// The pinned goal bar (Codex-style): "🎯 Pursuing goal <objective> • round n/N
// · elapsed" with edit / pause-resume / clear controls. Hidden when no goal.
function renderGoalBar(): void {
  const g = state.activeGoal;
  if (!g) {
    goalBarEl.classList.add('hidden');
    if (goalTicker) {
      clearInterval(goalTicker);
      goalTicker = undefined;
    }
    return;
  }
  goalBarEl.classList.remove('hidden');
  goalBarEl.classList.toggle('paused', g.state === 'paused');
  goalBarEl.querySelector('.goal-label')!.textContent =
    g.state === 'paused' ? 'Goal paused' : 'Pursuing goal';
  goalTextEl.textContent = g.objective;
  goalTextEl.title = g.objective;
  goalMetaEl.textContent =
    `• round ${g.iteration}/${g.maxIterations} · ${formatElapsed(Date.now() - g.startedAt)}`;
  goalPauseBtn.innerHTML = g.state === 'paused' ? icon.play : icon.pause;
  goalPauseBtn.title = g.state === 'paused' ? 'Resume goal' : 'Pause goal';
  // Tick the elapsed display once a second while a goal is pinned.
  if (!goalTicker) {
    goalTicker = setInterval(() => {
      const cur = state.activeGoal;
      if (cur) {
        goalMetaEl.textContent =
          `• round ${cur.iteration}/${cur.maxIterations} · ${formatElapsed(Date.now() - cur.startedAt)}`;
      }
    }, 1000);
  }
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
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

// Render pasted/attached images as compact chips (thumbnail + name + dimensions)
// in the attachments row above the input, matching Claude's composer. Clicking
// a chip opens the image in a lightbox over the chat. The whole attachments row
// is hidden when there's nothing to show, so it costs no vertical space.
function renderThumbs(): void {
  thumbsEl.innerHTML = '';
  state.pendingImages.forEach((img, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    chip.title = 'Click to preview';

    const im = document.createElement('img');
    im.className = 'attach-thumb';
    im.src = img.dataUrl;

    const meta = document.createElement('span');
    meta.className = 'attach-meta';
    const name = document.createElement('span');
    name.className = 'attach-name';
    name.textContent = img.name || 'image.png';
    const dims = document.createElement('span');
    dims.className = 'attach-dims';
    // Fill in real pixel dimensions once the image decodes.
    im.addEventListener('load', () => {
      dims.textContent = im.naturalWidth && im.naturalHeight ? `${im.naturalWidth}×${im.naturalHeight}` : '';
    });
    meta.appendChild(name);
    meta.appendChild(dims);

    const rm = document.createElement('button');
    rm.className = 'attach-rm';
    rm.innerHTML = icon.close;
    rm.title = 'Remove';
    rm.addEventListener('click', (e) => {
      e.stopPropagation(); // don't open the lightbox when removing
      state.pendingImages.splice(i, 1);
      renderThumbs();
    });

    chip.addEventListener('click', () => openLightbox(img.dataUrl, img.name || 'image.png'));

    chip.appendChild(im);
    chip.appendChild(meta);
    chip.appendChild(rm);
    thumbsEl.appendChild(chip);
  });
  // The attachments row holds image chips today; show it only when non-empty.
  attachmentsEl.classList.toggle('hidden', state.pendingImages.length === 0);
}

// A full-bleed image preview over the chat output area (like Claude's). Click
// the backdrop, press Escape, or hit the close button to dismiss.
function openLightbox(src: string, alt: string): void {
  closeLightbox();
  const overlay = document.createElement('div');
  overlay.className = 'lightbox';
  overlay.id = 'lightbox';
  const img = document.createElement('img');
  img.className = 'lightbox-img';
  img.src = src;
  img.alt = alt;
  const close = document.createElement('button');
  close.className = 'lightbox-close';
  close.innerHTML = icon.close;
  close.title = 'Close (Esc)';
  overlay.appendChild(img);
  overlay.appendChild(close);
  overlay.addEventListener('click', (e) => {
    // Close on a backdrop click, or anywhere inside the close button — including
    // its inner <svg>/<path>, which is the actual e.target when the visible X
    // glyph is clicked (an identity check against the button would miss it).
    const t = e.target as Node;
    if (t === overlay || close.contains(t)) {
      closeLightbox();
    }
  });
  document.body.appendChild(overlay);
}

function closeLightbox(): void {
  document.getElementById('lightbox')?.remove();
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
  layoutComposer(); // the model label's width changed — refit the row
}

/**
 * Merge an incoming model list with the current one, preserving the known
 * loaded-state when the refresh reports it as undefined ("unknown" — e.g.
 * /api/ps didn't answer this round). Without this, a transient ps failure
 * during a keep-warm refresh would flip a resident model to "not loaded" and
 * desync the Send gate / model pill. A definite true/false always wins.
 */
function mergeModels(incoming: UiModel[]): UiModel[] {
  return mergeModelLoadedState(state.models, incoming);
}

/** Is the selected model confirmed loaded (resident) and ready to receive a prompt? */
function selectedModelReady(): boolean {
  return isModelReady(state.currentModel, state.models, state.loadingModels);
}

// Whether each in-flight op is a load or an eject, so the row shows the right
// verb ("Loading…" vs "Ejecting…").
const loadModeById = new Map<string, 'load' | 'eject'>();

/** Begin tracking a load/eject: record its start time and start the tick timer. */
function beginModelLoad(modelID: string, mode: 'load' | 'eject' = 'load'): void {
  state.loadingModels.add(modelID);
  state.loadStartedAt.set(modelID, Date.now());
  loadModeById.set(modelID, mode);
  ensureModelLoadTimer();
}

/**
 * Drop loading state for any tracked model that has settled in the fresh list
 * (now loaded, or no longer present). Does NOT clear models still mid-load, so
 * an unrelated keep-warm refresh can't prematurely hide a load in progress.
 */
function reconcileLoadingState(models: UiModel[]): void {
  for (const id of [...state.loadingModels]) {
    const m = models.find((x) => x.id === id);
    if (!m || m.loaded) {
      state.loadingModels.delete(id);
      state.loadStartedAt.delete(id);
      loadModeById.delete(id);
    }
  }
  if (!state.loadingModels.size && modelLoadTimer) {
    clearInterval(modelLoadTimer);
    modelLoadTimer = undefined;
  }
}

/** Tick loading rows once a second so their elapsed timer stays live. */
function ensureModelLoadTimer(): void {
  if (modelLoadTimer) {
    return;
  }
  modelLoadTimer = setInterval(() => {
    if (!state.loadingModels.size) {
      clearInterval(modelLoadTimer);
      modelLoadTimer = undefined;
      return;
    }
    if (!modelMenu.classList.contains('hidden')) {
      renderModelMenu();
    }
  }, 1000);
}

/** Elapsed label for a loading model (leading space), via the pure formatter. */
function loadElapsedLabel(modelID: string): string {
  const started = state.loadStartedAt.get(modelID);
  if (!started) {
    return '';
  }
  const label = formatLoadElapsed((Date.now() - started) / 1000);
  return label ? ` ${label}` : '';
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
    const caps = [
      m.vision ? `<span class="model-cap" title="Vision">${icon.eye}</span>` : '',
      m.toolUse ? `<span class="model-cap" title="Tool use">${icon.wrench}</span>` : '',
    ].join('');
    const ctx = m.loaded
      ? `${formatTokens(m.contextLength || 0)} / ${formatTokens(m.maxContextLength || 0)}`
      : `max ${formatTokens(m.maxContextLength || 0)}`;
    // A loaded model whose chosen context (numCtx) differs from what it's
    // actually loaded at (contextLength) → the action becomes "Reload" (apply
    // the new context via eject+load). We never change a loaded model's context
    // automatically; this is the explicit affordance for it.
    const reloadPending =
      !!m.loaded && !!m.contextLength && !!m.numCtx && m.numCtx !== m.contextLength;
    // Identity line: publisher (family) / format / quant / pull date — the
    // fields that tell apart same-named models. Only shown when present.
    const ident = modelIdentity({ ...m, date: formatModelDate(m.created) });
    // Disambiguate the name itself when it isn't unique in the list.
    const tag = modelDisambiguator(m, state.models);
    // An id tag is long and case-sensitive; a publisher tag is a short label.
    const tagIsId = tag === m.id;
    const nameTag = tag
      ? `<span class="model-name">${escapeHtml(m.name)}</span><span class="model-pub-tag${tagIsId ? ' id' : ''}">${escapeHtml(tag)}</span>`
      : `<span class="model-name">${escapeHtml(m.name)}</span>`;
    // Build the action area. While loading it's a single busy/cancel button.
    // Otherwise: a not-loaded model shows "Load"; a loaded model shows "Eject",
    // and ALSO "Reload" when its chosen context differs (both available — Reload
    // applies the new context, Eject unloads — they're distinct actions).
    const ejectMode = loadModeById.get(m.id) === 'eject';
    let actionsHtml: string;
    if (loading) {
      actionsHtml = ejectMode
        ? `<button class="model-action busy" aria-busy="true">${icon.spinner}<span>Ejecting…${loadElapsedLabel(m.id)}</span></button>`
        : `<button class="model-action busy" aria-busy="true" title="Cancel loading">${icon.spinner}<span>Loading…${loadElapsedLabel(m.id)}</span><span class="cancel-x">✕</span></button>`;
    } else if (!m.loaded) {
      actionsHtml = `<button class="model-action load" data-act="load">Load</button>`;
    } else {
      const reloadBtn = reloadPending
        ? `<button class="model-action reload" data-act="reload" title="Reload at ${formatTokens(m.numCtx || 0)} context">Reload</button>`
        : '';
      actionsHtml = `${reloadBtn}<button class="model-action eject" data-act="eject">Eject</button>`;
    }
    row.innerHTML = `
      <span class="model-dot${m.loaded ? ' loaded' : ''}"></span>
      <span class="model-info">
        <span class="model-name-row">${nameTag}</span>
        ${ident ? `<span class="model-ident">${escapeHtml(ident)}</span>` : ''}
        <span class="model-meta">${m.loaded ? 'loaded · ' : ''}${ctx}${caps ? ' · <span class="model-caps">' + caps + '</span>' : ''}</span>
      </span>
      <span class="model-actions">${actionsHtml}</span>`;
    // While LOADING (not ejecting), show a reassurance line so a multi-minute
    // load doesn't look hung.
    if (loading && !ejectMode) {
      const hint = document.createElement('div');
      hint.className = 'model-load-hint';
      hint.textContent = 'Large models can take a few minutes to load — you can keep typing.';
      (row.querySelector('.model-info') as HTMLElement).appendChild(hint);
    }
    // Row click selects the model as active.
    row.addEventListener('click', () => {
      state.currentModel = m.id;
      post({ type: 'selectModel', modelID: m.id });
      renderModels();
      renderMeter();
      syncSendEnabled(); // a newly-selected model may not be loaded → gate Send
      closeModelMenu();
    });
    const doLoad = () => {
      if (!m.loaded) {
        state.currentModel = m.id;
        post({ type: 'selectModel', modelID: m.id });
        renderMeter();
        closeMenuOnLoad = true; // dismiss the menu once this load completes
      }
      beginModelLoad(m.id, 'load');
      post({ type: 'loadModel', modelID: m.id });
      renderModelMenu();
      syncSendEnabled();
    };
    const doEject = () => {
      beginModelLoad(m.id, 'eject');
      post({ type: 'unloadModel', modelID: m.id });
      renderModelMenu();
      syncSendEnabled();
    };
    const doReload = () => {
      // Apply the chosen context by reloading at it (persist, then reload).
      state.currentModel = m.id;
      post({ type: 'selectModel', modelID: m.id });
      post({ type: 'setModelCtx', modelID: m.id, numCtx: m.numCtx as number });
      beginModelLoad(m.id, 'load');
      post({ type: 'reloadModel', modelID: m.id });
      renderModelMenu();
      syncSendEnabled();
    };
    const doCancel = () => {
      post({ type: 'cancelLoad', modelID: m.id });
      state.loadingModels.delete(m.id);
      state.loadStartedAt.delete(m.id);
      loadModeById.delete(m.id);
      renderModelMenu();
      syncSendEnabled();
    };
    row.querySelectorAll('.model-action').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (loading) {
          if (!ejectMode) {
            doCancel(); // an eject in flight can't be cancelled
          }
          return;
        }
        const act = (btn as HTMLElement).dataset.act;
        if (act === 'load') {
          doLoad();
        } else if (act === 'eject') {
          doEject();
        } else if (act === 'reload') {
          doReload();
        }
      });
    });
    modelMenuList.appendChild(row);
  }
  renderCtxPresets();
  renderKeepAlive();
}

function renderCtxPresets(): void {
  const el = document.getElementById('ctx-presets');
  const label = document.getElementById('ctx-foot-model');
  if (!el) {
    return;
  }
  const m = state.models.find((x) => x.id === state.currentModel);
  if (label) {
    label.textContent = m ? `· ${m.name}` : '';
  }
  if (!m) {
    el.innerHTML = '<span class="ctx-foot-hint">Select a model</span>';
    return;
  }
  const current = m.numCtx || state.minContext;
  const presets = contextPresets(m.maxContextLength);
  el.innerHTML = '';
  for (const v of presets) {
    const b = document.createElement('button');
    b.className = 'ctx-preset' + (v === current ? ' active' : '');
    b.textContent = formatTokens(v);
    b.title = m.loaded
      ? `Set context to ${v.toLocaleString()} — press Reload to apply`
      : `Load ${m.name} with a ${v.toLocaleString()}-token context window`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (v === current || !state.currentModel) {
        return;
      }
      // Just record the desired context. We do NOT reload a loaded model here —
      // changing the chip turns its action button into "Reload" (apply on
      // click). For a not-loaded model it's simply the context the next Load
      // will use. Persist the choice so it sticks (no server rebuild now).
      m.numCtx = v; // optimistic
      post({ type: 'setModelCtxPref', modelID: state.currentModel, numCtx: v });
      renderModelMenu(); // re-render so the Reload affordance appears
      renderMeter();
    });
    el.appendChild(b);
  }
}

// No "Off"/0 option: keep_alive:0 unloads the model immediately after each call,
// which in an interactive chat tool just makes a model you loaded vanish. The
// minimum is 5m (the host also clamps any value to ≥5m defensively).
const KEEP_ALIVE_PRESETS: { label: string; value: string }[] = [
  { label: '5m', value: '5m' },
  { label: '30m', value: '30m' },
  { label: '1h', value: '1h' },
  { label: '8h', value: '8h' },
  { label: 'Forever', value: '8760h' },
];

function renderKeepAlive(): void {
  const el = document.getElementById('ka-presets');
  if (!el) {
    return;
  }
  el.innerHTML = '';
  for (const p of KEEP_ALIVE_PRESETS) {
    const b = document.createElement('button');
    b.className = 'ctx-preset' + (p.value === state.keepAlive ? ' active' : '');
    b.textContent = p.label;
    b.title = `Keep models loaded for ${p.label.toLowerCase()}`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (p.value === state.keepAlive) {
        return;
      }
      state.keepAlive = p.value;
      renderKeepAlive();
      post({ type: 'setKeepAlive', value: p.value });
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

// ---- Composer overflow (⋯) -------------------------------------------------

/**
 * Fit the composer row: restore every collapsible control to its home spot,
 * then move them (in hide-order) into the ⋯ menu until nothing overflows. The
 * separator is just hidden rather than moved (it'd look odd in a menu). The ⋯
 * button is revealed on the first move so its own width is part of the math.
 */
function layoutComposer(): void {
  const row = document.querySelector('.composer-row') as HTMLElement | null;
  if (!row || !overflowItems.length) {
    return;
  }
  for (const it of overflowItems) {
    if (it.el.id === 'tool-sep') {
      it.el.classList.remove('hidden');
    } else if (it.el.parentElement !== it.home) {
      it.home.insertBefore(it.el, it.anchor.nextSibling);
    }
  }
  let moved = 0;
  for (const it of overflowItems) {
    if (row.scrollWidth <= row.clientWidth) {
      break;
    }
    if (it.el.id === 'tool-sep') {
      it.el.classList.add('hidden');
      continue;
    }
    overflowMenuEl.appendChild(it.el);
    if (++moved === 1) {
      overflowBtn.classList.remove('hidden'); // now its width counts too
    }
  }
  if (moved === 0) {
    overflowBtn.classList.add('hidden');
    closeOverflowMenu();
  }
}

function toggleOverflowMenu(): void {
  if (overflowMenuEl.classList.contains('hidden')) {
    const r = overflowBtn.getBoundingClientRect();
    const width = Math.min(240, window.innerWidth - 16);
    let left = r.right - width;
    if (left < 8) {
      left = 8;
    }
    overflowMenuEl.style.left = left + 'px';
    overflowMenuEl.style.width = width + 'px';
    overflowMenuEl.style.bottom = window.innerHeight - r.top + 6 + 'px';
    overflowMenuEl.classList.remove('hidden');
  } else {
    closeOverflowMenu();
  }
}

function closeOverflowMenu(): void {
  overflowMenuEl.classList.add('hidden');
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
  // Loaded window if loaded, else this model's configured num_ctx (override or
  // global default) clamped to the model's max. Shared with the host + tests.
  const m = state.models.find((x) => x.id === state.currentModel);
  return computeWindow(m, m?.numCtx || state.minContext);
}

function tokensUsed(t: any): number {
  if (!t) {
    return 0;
  }
  return (t.input || 0) + (t.output || 0) + (t.reasoning || 0);
}

// The native ollama provider doesn't report token usage, so estimate locally.
// Calibrated against a measured request: our build agent prompt + tool
// definitions are ~9k tokens; plan is lighter. Plus ~1 token / 4 chars of
// visible conversation, plus images.
function estimateUsed(): number {
  let chars = 0;
  for (const ps of partState.values()) {
    chars += ps.buffer.length;
  }
  const overhead = state.agent === 'plan' ? 6000 : 9000;
  const images = document.querySelectorAll('.msg-img').length + state.pendingImages.length;
  const fileTokens =
    state.activeFile && state.includeActiveFile ? Math.ceil(state.activeFile.chars / 4) : 0;
  const selTokens = state.activeSelection ? Math.ceil(state.activeSelection.chars / 4) : 0;
  return overhead + Math.ceil(chars / 4) + images * 700 + fileTokens + selTokens;
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
  let label: string;
  if (state.pendingCompaction) {
    // The reduced size only becomes known on the next real turn (the summarizer
    // turn reports no usable usage), so don't show a number we can't measure.
    label = `compacted · updates on next message / ${winLabel} context`;
  } else {
    label = `${estimated ? '~' : ''}${formatTokens(used)} / ${winLabel} context · ${Math.round(pct)}%`;
    if (state.compacted) {
      label += ' · compacted';
    }
  }
  ctxLabelEl.textContent = label;
  ctxMeterEl.title = state.pendingCompaction
    ? 'Conversation was compacted. The exact reduced size shows after your next message.'
    : estimated
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
  questionEls.clear();
  toolCollapsed.clear();
  compaction.suppressed.clear();
  compaction.pending = false;
  lastCompactionChip = null;
  state.pendingCompaction = false;
  todoCards.clear();
  todoCollapsed.clear();
  hideWorking();
  messagesEl
    .querySelectorAll('.msg, .perm-card, .question-card, .sys-chip, .error-bubble')
    .forEach((n) => n.remove());
  state.realTokens = 0;
  state.compacted = false;
  autoScrollEnabled = true; // fresh conversation starts pinned to the bottom
  toggleWelcome();
}

function toggleWelcome(): void {
  const hasContent = messagesEl.querySelector('.msg, .perm-card, .question-card, .error-bubble');
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
    // Fallback: a model that printed the AskUserQuestion JSON as text instead
    // of calling the `question` tool. Once the blob parses, render the picker
    // in place of the raw JSON (requestID null → answers go back as a message).
    const qs = parseQuestionBlob(ps.buffer);
    if (qs && !ps.el.dataset.questionRendered) {
      ps.el.dataset.questionRendered = '1';
      ps.el.style.display = 'none';
      ps.el.innerHTML = '';
      renderQuestion(null, qs);
      return;
    }
    if (ps.el.dataset.questionRendered) {
      return; // already swapped for a picker — ignore further deltas
    }
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
  // A compaction marker: collapse it to a chip and mark the summarizer turn
  // that follows for suppression. Handle before ensureMessageEl so the marker's
  // own (user) message never produces an empty bubble.
  if (isCompactionPart(part.type)) {
    markCompaction(compaction, part.messageID);
    showCompactionChip();
    return;
  }
  // Synthetic text is OpenCode's own context injection — the attached file's
  // contents, tool-call framing ("Called the Read tool with…"), etc. It is sent
  // to the model but was never typed by the user, so it must not render as a
  // chat bubble. The visible affordance for an attachment is its file chip.
  if (isSyntheticText(part)) {
    return;
  }
  const role = roleByMessage.get(part.messageID) ?? 'assistant';
  // The first assistant turn after a compaction marker is the summarizer
  // generating the summary — suppress it (its reasoning + template aren't chat).
  if (shouldSuppressMessage(compaction, part.messageID, role)) {
    return; // summarizer-internal output; never render as a chat turn
  }
  const { partsEl } = ensureMessageEl(part.messageID, role);
  // The agent's todo list (todowrite) renders as one live checklist per turn,
  // not a generic JSON tool card. Route it here and return BEFORE partState so
  // it never enters partState (no meter inflation) and never duplicates.
  if (part.type === 'tool' && (part as { tool?: string }).tool === 'todowrite') {
    if (role !== 'user' && state.busy) {
      setWorkingLabel('Updating plan…');
    }
    renderTodos(part as Part & { messageID: string; state?: any }, partsEl);
    renderMeter();
    scrollToBottom();
    return;
  }
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
    case 'step-finish':
      // `reason: 'length'` means the model hit its output-token budget mid-turn
      // (common with reasoning models that think at length). Remember it so the
      // turn-end handler can tell the user it was truncated rather than just
      // stopping silently — which reads like a freeze/crash.
      if ((part as { reason?: string }).reason === 'length') {
        turnTruncated = true;
      }
      ps.el.remove();
      partState.delete(part.id);
      break;
    case 'step-start':
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
  // Count streamed output for the generation-speed estimate. Stamp the first
  // token so the rate measures generation, not the prompt-processing wait.
  if (delta && (ps.type === 'text' || ps.type === 'reasoning')) {
    if (!turnFirstTokenAt) {
      turnFirstTokenAt = Date.now();
    }
    turnOutputChars += delta.length;
  }
  ps.buffer += delta;
  renderTextLike(ps);
  scrollToBottom();
}

// Estimated generation rate for the current turn, or null if not measurable yet.
// Tokens are estimated as chars/4; the rate is over the time since the first
// token (excludes prompt-processing latency).
function currentGenRate(): { tokens: number; seconds: number; tps: number } | null {
  if (!turnFirstTokenAt || turnOutputChars <= 0) {
    return null;
  }
  const seconds = (Date.now() - turnFirstTokenAt) / 1000;
  const tokens = Math.round(turnOutputChars / 4);
  if (seconds <= 0) {
    return null;
  }
  return { tokens, seconds, tps: tokens / seconds };
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
// Todo checklist (the agent's todowrite tool)
// ---------------------------------------------------------------------------
// Render/replace the single live checklist for this assistant message. Each
// todowrite call carries the full list (replace semantics), so we just rewrite
// one card's contents in place.
function renderTodos(part: { messageID: string; state?: any }, partsEl: HTMLElement): void {
  const mid = part.messageID;
  const todos: Todo[] = Array.isArray(part.state?.input?.todos) ? part.state.input.todos : [];
  let card = todoCards.get(mid);
  if (!todos.length) {
    // Empty / pre-input call: don't leave an empty card flashing.
    card?.remove();
    todoCards.delete(mid);
    return;
  }
  if (!card) {
    card = document.createElement('div');
    card.className = 'part part-todo';
    partsEl.appendChild(card); // append only on first create → updates mutate in place
    todoCards.set(mid, card);
  }
  card.innerHTML = buildTodoHtml(todos, mid);
  const head = card.querySelector('.tool-head') as HTMLElement | null;
  const inner = card.querySelector('.todo-card') as HTMLElement | null;
  head?.addEventListener('click', () => {
    const nowCollapsed = !inner?.classList.contains('collapsed');
    inner?.classList.toggle('collapsed', nowCollapsed);
    todoCollapsed.set(mid, nowCollapsed); // user choice overrides the auto rule
  });
}

function buildTodoHtml(todos: Todo[], mid: string): string {
  const { done, total, anyInProgress, allDone, cardStatus, currentLabel } = summarizeTodos(todos);
  const collapsed = isTodoCardCollapsed(anyInProgress, todoCollapsed.get(mid));
  const mark = (s: Todo['status']): string =>
    s === 'in_progress'
      ? icon.spinner
      : s === 'completed'
        ? '✓'
        : s === 'cancelled'
          ? '⊘'
          : '▢';
  const rows = todos
    .map(
      (t) =>
        `<div class="todo-item is-${t.status}"><span class="todo-mark">${mark(t.status)}</span><span class="todo-text">${escapeHtml(t.content)}</span></div>`,
    )
    .join('');
  return `
    <div class="tool-card todo-card status-${cardStatus}${collapsed ? ' collapsed' : ''}">
      <button class="tool-head" type="button">
        <span class="tool-chev"></span>
        <span class="tool-ico">${icon.checklist}</span>
        <span class="tool-name">Plan</span>
        <span class="todo-current">${escapeHtml(currentLabel)}</span>
        <span class="todo-count">${done}/${total}${allDone ? ' ✓' : ''}</span>
      </button>
      <div class="tool-body todo-list">${rows}</div>
    </div>`;
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
  forceScrollToBottom(); // a permission prompt must be visible to be actioned
}

function resolvePermission(id: string): void {
  const card = permissionEls.get(id);
  if (card && !card.classList.contains('resolved')) {
    card.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    card.classList.add('resolved');
  }
}

// ---------------------------------------------------------------------------
// Questions (the built-in `question`/ask tool — and a text fallback)
// ---------------------------------------------------------------------------
/**
 * Render an interactive picker for a question request and reply over the
 * /question API. `requestID` null means this came from the text fallback
 * (a model that printed the JSON instead of calling the tool) — in that case
 * we send the chosen labels back as a normal follow-up message instead.
 */
function renderQuestion(requestID: string | null, questions: QInfo[]): void {
  const key = requestID ?? `local-${questions.map((q) => q.question).join('|')}`;
  if (questionEls.has(key)) {
    return;
  }
  const card = document.createElement('div');
  card.className = 'question-card';

  // Per-question selection state: a Set of chosen labels + the custom text.
  const picks = questions.map(() => ({ chosen: new Set<string>(), custom: '' }));
  const tabbed = questions.length > 1;
  let active = 0;

  // A single question auto-advances on a single-select pick only when there's
  // no free-text input to fill in. Multi-select or "type your own" needs Next.
  const autoAdvances = (qi: number): boolean => {
    const q = questions[qi];
    const allowCustom = q.custom !== false || (q.options ?? []).length === 0;
    return !q.multiple && !allowCustom;
  };
  const isAnswered = (qi: number): boolean =>
    picks[qi].chosen.size > 0 || picks[qi].custom.trim().length > 0;

  // --- Tab strip (only when there's more than one question) ------------------
  let tabsEl: HTMLElement | undefined;
  if (tabbed) {
    tabsEl = document.createElement('div');
    tabsEl.className = 'question-tabs';
    questions.forEach((q, qi) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'question-tab';
      tab.dataset.qi = String(qi);
      tab.innerHTML = `<span class="question-tab-num">${qi + 1}</span><span class="question-tab-label">${escapeHtml(
        q.header || `Q${qi + 1}`,
      )}</span><span class="question-tab-check">✓</span>`;
      tab.addEventListener('click', () => show(qi));
      tabsEl!.appendChild(tab);
    });
    card.appendChild(tabsEl);
  }

  // --- Question panels (one shown at a time) ---------------------------------
  const panels: HTMLElement[] = questions.map((q, qi) => {
    const block = document.createElement('div');
    block.className = 'question-block';
    const hasOptions = (q.options ?? []).length > 0;
    // Force the free-text input on when there are no options, so the picker is
    // never a dead end (only "Skip") regardless of what the model sends.
    const allowCustom = q.custom !== false || !hasOptions;
    const multiple = !!q.multiple;
    block.innerHTML = `
      ${q.header ? `<div class="question-chip">${escapeHtml(q.header)}</div>` : ''}
      <div class="question-text">${escapeHtml(q.question)}</div>
      <div class="question-options"></div>
      ${allowCustom ? `<input class="question-custom" type="text" placeholder="Type a custom answer…" />` : ''}`;
    const optsEl = block.querySelector('.question-options') as HTMLElement;
    (q.options ?? []).forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'question-opt';
      btn.innerHTML = `<span class="question-opt-label">${escapeHtml(opt.label)}</span>${
        opt.description ? `<span class="question-opt-desc">${escapeHtml(opt.description)}</span>` : ''
      }`;
      btn.addEventListener('click', () => {
        if (card.classList.contains('resolved')) {
          return;
        }
        const sel = picks[qi].chosen;
        if (multiple) {
          if (sel.has(opt.label)) {
            sel.delete(opt.label);
            btn.classList.remove('selected');
          } else {
            sel.add(opt.label);
            btn.classList.add('selected');
          }
        } else {
          sel.clear();
          optsEl.querySelectorAll('.question-opt').forEach((b) => b.classList.remove('selected'));
          sel.add(opt.label);
          btn.classList.add('selected');
        }
        syncChrome();
        // Single-select with no custom field → jump straight to the next tab.
        if (autoAdvances(qi) && qi < questions.length - 1) {
          show(qi + 1);
        }
      });
      optsEl.appendChild(btn);
    });
    if (allowCustom) {
      const input = block.querySelector('.question-custom') as HTMLInputElement;
      input.addEventListener('input', () => {
        picks[qi].custom = input.value;
        syncChrome();
      });
    }
    card.appendChild(block);
    return block;
  });

  // --- Footer: Back / Next / Submit / Skip -----------------------------------
  const actions = document.createElement('div');
  actions.className = 'question-actions';
  actions.innerHTML = `
    ${tabbed ? '<button class="question-back" type="button">Back</button>' : ''}
    ${tabbed ? '<button class="question-next" type="button">Next</button>' : ''}
    <button class="question-submit" type="button">Send answer</button>
    <button class="question-skip" type="button">Skip</button>`;
  card.appendChild(actions);
  const backBtn = actions.querySelector('.question-back') as HTMLButtonElement | null;
  const nextBtn = actions.querySelector('.question-next') as HTMLButtonElement | null;
  const submitBtn = actions.querySelector('.question-submit') as HTMLButtonElement;

  // Reflect current tab + answered-state across the strip and footer buttons.
  function syncChrome(): void {
    panels.forEach((p, qi) => (p.style.display = qi === active ? '' : 'none'));
    if (tabsEl) {
      tabsEl.querySelectorAll('.question-tab').forEach((t) => {
        const qi = Number((t as HTMLElement).dataset.qi);
        t.classList.toggle('active', qi === active);
        t.classList.toggle('answered', isAnswered(qi));
      });
    }
    if (backBtn) {
      backBtn.style.display = active > 0 ? '' : 'none';
    }
    const onLast = active === questions.length - 1;
    if (nextBtn) {
      nextBtn.style.display = onLast ? 'none' : '';
    }
    // Submit only on the last tab (or always when not tabbed), enabled once
    // every question has an answer.
    submitBtn.style.display = tabbed && !onLast ? 'none' : '';
    submitBtn.disabled = questions.some((_, qi) => !isAnswered(qi));
  }

  function show(qi: number): void {
    if (card.classList.contains('resolved')) {
      return;
    }
    active = Math.max(0, Math.min(questions.length - 1, qi));
    syncChrome();
    const input = panels[active].querySelector('.question-custom') as HTMLInputElement | null;
    input?.focus();
    forceScrollToBottom(); // user navigated between question pages — keep it in view
  }

  backBtn?.addEventListener('click', () => show(active - 1));
  nextBtn?.addEventListener('click', () => show(active + 1));

  const lock = (note: string) => {
    card.querySelectorAll('button, input').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    card.classList.add('resolved');
    const n = document.createElement('div');
    n.className = 'question-resolved';
    n.textContent = note;
    card.appendChild(n);
  };

  const submit = () => {
    if (card.classList.contains('resolved')) {
      return;
    }
    // One answer array per question: chosen labels + any custom text.
    const answers = buildAnswers(picks);
    if (isEmptyAnswer(answers)) {
      return; // nothing chosen — keep the card open
    }
    if (requestID) {
      post({ type: 'questionReply', requestID, answers });
    } else {
      // Fallback path: no real request to reply to — echo the picks as a message.
      const text = questions
        .map((q, i) => `${q.header || q.question}: ${answers[i].join(', ')}`)
        .join('\n');
      post({ type: 'send', text, thinking: false });
    }
    lock(`Answered: ${answers.map((a) => a.join(', ')).filter(Boolean).join(' · ')}`);
  };

  submitBtn.addEventListener('click', submit);
  actions.querySelector('.question-skip')!.addEventListener('click', () => {
    if (card.classList.contains('resolved')) {
      return;
    }
    if (requestID) {
      post({ type: 'questionReject', requestID });
    }
    lock('Skipped');
  });

  messagesEl.appendChild(card);
  questionEls.set(key, card);
  syncChrome();
  toggleWelcome();
  forceScrollToBottom(); // a question prompt must be visible to be answered
}

function resolveQuestion(id: string): void {
  const card = questionEls.get(id);
  if (card && !card.classList.contains('resolved')) {
    card.querySelectorAll('button, input').forEach((b) => ((b as HTMLButtonElement).disabled = true));
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
    const rate = currentGenRate();
    const parts = [];
    if (s > 0) {
      parts.push(`${s}s`);
    }
    if (rate && rate.tps >= 0.5) {
      parts.push(`~${Math.round(rate.tps)} tok/s`);
    }
    workingElapsedEl.textContent = parts.join(' · ');
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

// Append a small estimated generation-speed stat under the just-finished
// assistant turn (e.g. "~340 tokens · 7.5s · ~45 tok/s"). No-op when there's
// nothing measurable (e.g. a tool-only turn with no streamed text).
function appendGenStat(): void {
  const rate = currentGenRate();
  if (!rate || rate.tokens < 1) {
    return;
  }
  const msgs = messagesEl.querySelectorAll('.msg.assistant');
  const last = msgs[msgs.length - 1] as HTMLElement | undefined;
  if (!last || last.querySelector('.gen-stat')) {
    return;
  }
  const el = document.createElement('div');
  el.className = 'gen-stat';
  el.textContent = `~${rate.tokens} tokens · ${rate.seconds.toFixed(1)}s · ~${Math.round(rate.tps)} tok/s`;
  el.title = 'Estimated from the response length.';
  last.appendChild(el);
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
  sendBtn.classList.toggle('busy', busy);
  if (busy) {
    turnTruncated = false; // fresh turn — clear any prior truncation flag
    turnOutputChars = 0; // reset generation-speed tracking for the new turn
    turnFirstTokenAt = 0;
    showWorking('Working…');
  } else {
    hideWorking();
  }
  syncSendEnabled();
}

/**
 * Drive the composer's primary button + input through three modes:
 *  - busy: the button is a Stop control (abort the running turn)
 *  - ready: a loaded model is selected → a normal Send button
 *  - no model: a clear "Load a model" call-to-action that opens the model menu
 *    (a greyed-out Send is too subtle — you can't tell why you can't chat).
 * The input stays editable so you can draft while a model loads; onSend enforces
 * the same gate on Enter. Compaction is owned by setCompacting and bails early.
 */
function syncSendEnabled(): void {
  if (state.compacting) {
    return; // compaction owns the button (disabled + blocked)
  }
  if (state.busy) {
    sendBtn.classList.remove('cta');
    sendBtn.disabled = false;
    sendBtn.innerHTML = icon.stop;
    sendBtn.title = 'Stop';
    inputEl.placeholder = 'Ask anything, paste an image, or describe a task…';
    return;
  }
  const ready = selectedModelReady();
  const loadingSel = !!state.currentModel && state.loadingModels.has(state.currentModel);
  if (ready) {
    sendBtn.classList.remove('cta');
    sendBtn.disabled = false;
    sendBtn.innerHTML = icon.send;
    sendBtn.title = 'Send';
    inputEl.placeholder = 'Ask anything, paste an image, or describe a task…';
    return;
  }
  // No usable model — turn the primary button into a Load CTA.
  const sel = state.models.find((x) => x.id === state.currentModel);
  sendBtn.classList.add('cta');
  sendBtn.disabled = false; // clickable — it opens the model menu
  sendBtn.innerHTML = loadingSel
    ? `${icon.spinner}<span>Loading…</span>`
    : `${icon.download}<span>Load a model</span>`;
  sendBtn.title = loadingSel ? 'Loading model…' : 'Load a model to start chatting';
  inputEl.placeholder = loadingSel
    ? 'Loading model… you can draft your message'
    : 'Load a model to start chatting…';
}

// Block the composer while a /compact runs. Unlike a normal turn (where the send
// button becomes an abort), compaction can't be interrupted, so we disable the
// input + send entirely and show a distinct indicator. Model/server pickers stay
// usable. On completion the meter enters "pending" mode (true size unknown until
// the next turn) — see renderMeter().
function setCompacting(active: boolean): void {
  state.compacting = active;
  inputEl.disabled = active;
  sendBtn.disabled = active;
  document.body.classList.toggle('compacting', active);
  if (active) {
    showWorking('Compacting conversation…');
  } else {
    hideWorking();
    state.pendingCompaction = true; // size now stale until the next real turn lands
    state.compacted = true;
    renderMeter();
    syncSendEnabled(); // restore Send / Load-CTA mode now that input is unblocked
  }
}

// Pin to the bottom only if the user hasn't scrolled up. Used for streamed
// tokens and incremental part updates so reading back mid-generation works.
function scrollToBottom(): void {
  if (!autoScrollEnabled) {
    return;
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Force the view to the bottom and re-engage autoscroll. Used when the user
// just did something that should bring them back (sent a message, new session)
// or when a card needs to be visible to be actionable (permission, question).
function forceScrollToBottom(): void {
  autoScrollEnabled = true;
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
    // Mirror the live path: a message carrying a compaction marker collapses to
    // a chip, and the summarizer turn that follows it is suppressed.
    if (m.parts.some((part) => isCompactionPart(part.type))) {
      markCompaction(compaction, m.info.id);
      showCompactionChip();
      continue;
    }
    if (shouldSuppressMessage(compaction, m.info.id, m.info.role)) {
      // Recover the summary text from the suppressed summarizer turn so the
      // chip stays expandable after a reload (the live path gets it from the
      // bridge instead).
      const summary = m.parts
        .filter((part) => part.type === 'text')
        .map((part) => (part as { text?: string }).text ?? '')
        .join('')
        .trim();
      if (summary) {
        attachCompactionSummary(summary);
      }
      continue; // summarizer-internal turn — not chat
    }
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
  forceScrollToBottom(); // full (re)render of a session lands the user at the bottom
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
        // The summarizer turn that follows a compaction marker isn't a chat
        // turn — don't materialize a bubble or count its tokens.
        if (shouldSuppressMessage(compaction, info.id, info.role)) {
          break;
        }
        // Do NOT eagerly create the bubble here. A message's role/identity is
        // known before its parts stream in, but a message whose only part is a
        // compaction marker (or synthetic text) must never produce a bubble.
        // upsertPart() lazily creates the bubble for the first REAL part, so an
        // empty/marker-only message leaves no stray bubble behind.
        if (info.role === 'assistant') {
          // A real assistant turn after compaction has begun (the summarizer
          // turn was suppressed above), so the post-compaction state is now
          // current. Clear the "pending" flag even when no token usage is
          // reported — otherwise the meter sticks on "compacted" forever.
          state.pendingCompaction = false;
          if (info.tokens) {
            const used = tokensUsed(info.tokens);
            if (used > 0) {
              state.realTokens = used;
              state.compacted = false;
            }
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
      toolCollapsed.delete(p.partID);
      break;
    }
    case 'permission.asked':
      renderPermission(p);
      break;
    case 'permission.replied':
      resolvePermission(p.id ?? p.permissionID);
      break;
    case 'question.asked':
      renderQuestion(p.id, p.questions ?? []);
      break;
    case 'question.replied':
    case 'question.rejected':
      resolveQuestion(p.requestID ?? p.id);
      break;
    case 'session.idle':
      // Capture the generation rate before setBusy(false) clears the counters.
      appendGenStat();
      setBusy(false);
      renderMeter();
      if (turnTruncated) {
        // The turn ended because it ran out of output budget, not because the
        // model was done. Say so — otherwise a cut-off reply looks like a freeze.
        addSysChip(
          '⚠ Response was cut off — it reached the output token limit. Raise the context window (it scales the output budget) or ask the model to be more concise.',
        );
        turnTruncated = false;
      }
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
      state.models = mergeModels(msg.models);
      state.currentModel = msg.currentModel;
      state.agent = msg.agent;
      state.serverReady = msg.serverReady;
      state.ollamaConnected = msg.ollamaConnected;
      state.minContext = msg.minContext;
      state.keepAlive = msg.keepAlive;
      renderModels();
      renderMeter();
      renderServers();
      syncSendEnabled();
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
      state.models = mergeModels(msg.models); // preserve known loaded-state on an "unknown" refresh
      state.currentModel = msg.currentModel;
      // Clear loading state ONLY for models that have settled — a model is done
      // when it's now loaded (or gone from the list). Crucially we do NOT wipe
      // the whole set: a background keep-warm refresh (every ~15s) also lands
      // here, and a blanket clear would drop the spinner on a model that's still
      // mid-load, making a long load look like it "returned early".
      reconcileLoadingState(msg.models);
      renderModels();
      renderMeter();
      syncSendEnabled();
      if (closeMenuOnLoad && !state.loadingModels.size) {
        // The load the user kicked off from the menu has settled — dismiss it.
        closeMenuOnLoad = false;
        closeModelMenu();
      }
      break;
    case 'loadProgress':
      // Host-driven progress for a (possibly multi-minute) load. Ensure the
      // model is tracked as loading and keep the elapsed display ticking.
      if (!state.loadingModels.has(msg.modelID)) {
        state.loadingModels.add(msg.modelID);
        state.loadStartedAt.set(msg.modelID, Date.now() - msg.elapsedSec * 1000);
        ensureModelLoadTimer();
      }
      if (!modelMenu.classList.contains('hidden')) {
        renderModelMenu();
      }
      syncSendEnabled();
      break;
    case 'loadSettled':
      // A load/eject finished — stop this model's spinner.
      state.loadingModels.delete(msg.modelID);
      state.loadStartedAt.delete(msg.modelID);
      loadModeById.delete(msg.modelID);
      // A SUCCESSFUL operation is authoritative about the model's new state:
      // a load → it's now resident; an eject → it's now unloaded. Apply it
      // directly rather than waiting for /api/ps (which lags on both edges).
      if (!msg.error) {
        const m = state.models.find((x) => x.id === msg.modelID);
        if (m) {
          m.loaded = msg.mode === 'load';
        }
      }
      reconcileLoadingState(state.models); // tidy the timer if nothing's left
      renderModels();
      syncSendEnabled();
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
    case 'compacting':
      setCompacting(msg.active);
      if (!msg.active && msg.summary) {
        attachCompactionSummary(msg.summary);
      }
      break;
    case 'activeFile':
      state.activeFile = msg.path ? { path: msg.path, chars: msg.chars } : null;
      renderActiveFile();
      renderMeter();
      break;
    case 'activeSelection':
      // The selection is auto-attached silently (no pill); just track it so the
      // context meter reflects the extra tokens.
      state.activeSelection = msg.selection;
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
    case 'mcpStatus':
      showMcpStatus(msg.servers);
      break;
    case 'skills':
      showSkills(msg.skills);
      break;
    case 'commands':
      setServerCommands(msg.commands);
      break;
    case 'goal':
      state.activeGoal = msg.goal;
      renderGoalBar();
      break;
    case 'goalEvent':
      if (msg.kind === 'checking') {
        setStatus('Checking goal…');
      } else if (msg.kind === 'continued') {
        setStatus(`Goal round ${msg.iteration ?? '?'}: ${msg.reason ?? 'continuing…'}`);
      } else if (msg.kind === 'met') {
        setStatus('');
        addSysChip(`🎯 Goal met — ${msg.reason ?? 'done'}`);
      } else if (msg.kind === 'stopped') {
        setStatus('');
        const why = msg.why === 'stalled' ? 'no progress across several rounds' : 'iteration cap reached';
        addSysChip(`Goal paused (${why}) — ${msg.reason ?? ''}\nResume from the goal bar, or /goal clear to end it.`);
      }
      break;
    case 'error':
      showError(msg.message);
      setBusy(false);
      break;
  }
});

// ---------------------------------------------------------------------------
// Test hook (stripped from production by esbuild — see __TEST__ define)
// ---------------------------------------------------------------------------
// Lets integration tests drive + inspect the webview over the postMessage
// channel: { __test__: 'query', id, selector, prop } reads an element's text or
// attribute; { __test__: 'click', id, selector } dispatches a real click. The
// result is posted back as { __test__: 'result', id, ... }. No eval is exposed.
function installTestHook(): void {
  window.addEventListener('message', (e: MessageEvent<any>) => {
    const m = e.data;
    if (!m || m.__test__ === undefined || m.__test__ === 'result') {
      return;
    }
    const reply = (payload: Record<string, unknown>) =>
      vscode.postMessage({ __test__: 'result', id: m.id, ...payload } as never);
    try {
      if (m.__test__ === 'query') {
        const els = Array.from(document.querySelectorAll(m.selector as string));
        const read = (el: Element) =>
          m.prop === 'text'
            ? (el.textContent ?? '').trim()
            : m.prop === 'class'
              ? el.className
              : el.getAttribute(m.prop as string);
        reply({ count: els.length, value: els[0] ? read(els[0]) : null, values: els.map(read) });
      } else if (m.__test__ === 'click') {
        const el = document.querySelector(m.selector as string) as HTMLElement | null;
        if (el) {
          el.click();
        }
        reply({ ok: !!el });
      } else if (m.__test__ === 'setInput') {
        // Set the composer textarea value and fire the input event, so tests can
        // drive the slash-command autocomplete the way a user typing would.
        inputEl.value = String(m.value ?? '');
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        reply({ ok: true });
      } else {
        reply({ error: `unknown __test__ op: ${m.__test__}` });
      }
    } catch (err) {
      reply({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
build();
if (__TEST__) {
  installTestHook();
}
post({ type: 'ready' });
