// Message protocol shared between the extension host and the webview.
import type { MessageWithParts, OpencodeEvent, PermissionResponse } from './opencode/protocol';

export interface UiModel {
  id: string;
  name: string;
  loaded?: boolean; // true=resident, false=not loaded, undefined=unknown (ps didn't answer)
  contextLength?: number; // actually-loaded num_ctx (from /api/ps)
  maxContextLength?: number;
  numCtx?: number; // effective configured num_ctx (override or global default, clamped to max)
  toolUse?: boolean;
  vision?: boolean;
  publisher?: string; // disambiguates same-named models (for Ollama: the model family, e.g. "llama")
  quantization?: string; // e.g. "Q4_K_M", "Q8_0"
  format?: string; // runtime format, e.g. "GGUF"
  created?: string; // when the model was pulled/created locally (ISO-8601)
}

export interface UiSession {
  id: string;
  title: string;
  updated: number;
}

export interface UiServer {
  id: string;
  name: string;
  url: string;
}

/** One MCP server's status, as shown in the /mcp panel. */
export interface UiMcpServer {
  name: string;
  /** 'connected' | 'disabled' | 'failed' | 'pending' (or any future status). */
  status: string;
  /** Failure reason, when status is 'failed'. */
  error?: string;
  /** 'local' (stdio) or 'remote' (http/sse), when known from the config. */
  transport?: 'local' | 'remote';
  /** The command (local) or url (remote) it was configured with, for display. */
  detail?: string;
}

// ---- Host -> Webview -----------------------------------------------------
export type HostToWebview =
  | {
      type: 'init';
      models: UiModel[];
      currentModel: string | null;
      agent: 'build' | 'plan';
      cwd: string;
      serverReady: boolean;
      ollamaConnected: boolean;
      minContext: number;
      keepAlive: string;
    }
  | { type: 'models'; models: UiModel[]; currentModel: string | null }
  | { type: 'servers'; servers: UiServer[]; activeId: string; connected: boolean }
  | { type: 'sessions'; sessions: UiSession[]; currentSessionID: string | null }
  | { type: 'sessionLoaded'; sessionID: string; title: string; messages: MessageWithParts[] }
  | { type: 'cleared' }
  | { type: 'event'; event: OpencodeEvent }
  | { type: 'busy'; busy: boolean }
  // A load/eject for `modelID` has settled (succeeded or failed) — the webview
  // stops its per-model spinner regardless of outcome. `error` is set when the
  // operation failed. `mode` says whether it was a load (success ⇒ model is now
  // loaded) or an eject (success ⇒ model is now unloaded).
  | { type: 'loadSettled'; modelID: string; mode: 'load' | 'eject'; error?: string }
  // Periodic progress for an in-flight (possibly multi-minute) load or eject:
  // elapsed seconds + a note. Lets the UI show "Loading… 2:47" / "Ejecting…"
  // with a live timer instead of looking hung.
  | { type: 'loadProgress'; modelID: string; elapsedSec: number; note?: string; mode: 'load' | 'eject' }
  // A /compact run is in flight (block input) or has finished (with the summary
  // text, if OpenCode produced one). `summary` is only set when active === false.
  | { type: 'compacting'; active: boolean; summary?: string }
  | { type: 'activeFile'; path: string | null; chars: number }
  | { type: 'status'; text: string; kind?: 'info' | 'warn' | 'error' }
  | { type: 'command'; command: 'history' | 'newChat' | 'focusInput' }
  // Result of a /mcp request: the configured MCP servers and their live status.
  // `servers` is empty when none are configured.
  | { type: 'mcpStatus'; servers: UiMcpServer[] }
  | { type: 'error'; message: string };

// ---- Webview -> Host -----------------------------------------------------
export interface UiImage {
  mime: string;
  dataUrl: string;
  name?: string;
}

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'send'; text: string; thinking: boolean; images?: UiImage[]; includeActiveFile?: boolean }
  | { type: 'selectModel'; modelID: string }
  | { type: 'loadModel'; modelID: string }
  | { type: 'reloadModel'; modelID: string } // eject + load at the model's chosen context
  | { type: 'cancelLoad'; modelID: string }
  | { type: 'unloadModel'; modelID: string }
  | { type: 'setModelCtx'; modelID: string; numCtx: number } // persist + rebuild OpenCode budget
  | { type: 'setModelCtxPref'; modelID: string; numCtx: number } // persist desired ctx only (no reload/rebuild)
  | { type: 'setKeepAlive'; value: string }
  | { type: 'refreshModels' }
  | { type: 'listServers' }
  | { type: 'addServer'; name: string; url: string }
  | { type: 'updateServer'; id: string; name: string; url: string }
  | { type: 'removeServer'; id: string }
  | { type: 'switchServer'; id: string }
  | { type: 'selectAgent'; agent: 'build' | 'plan' }
  | { type: 'newChat' }
  | { type: 'loadSessions' }
  | { type: 'loadSession'; sessionID: string }
  | { type: 'deleteSession'; sessionID: string }
  | { type: 'clearAllSessions' }
  | { type: 'compact' }
  | { type: 'abort' }
  | { type: 'permission'; sessionID: string; permissionID: string; response: PermissionResponse }
  | { type: 'questionReply'; requestID: string; answers: string[][] }
  | { type: 'questionReject'; requestID: string }
  | { type: 'openFile'; path: string }
  | { type: 'requestMcpStatus' }
  | { type: 'retryConnect' };
