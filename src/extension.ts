import * as vscode from 'vscode';
import { getConfig } from './config';
import { ServerRegistry } from './connection';
import { OllamaClient } from './ollama/client';
import { initLogger, log, showLogs } from './logger';
import { OpencodeServerManager } from './opencode/serverManager';
import { BridgeDeps } from './panel/bridge';
import { ChatViewProvider, openChatPanel } from './panel/chatViewProvider';
import { Prefs } from './prefs';

let server: OpencodeServerManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  initLogger(context);
  log('activating Ollama Code');

  const cfg = getConfig();
  const servers = new ServerRegistry(context, cfg.ollamaBaseUrl);
  const ollama = new OllamaClient(servers.active().url);
  const prefs = new Prefs(context);
  server = new OpencodeServerManager(cfg, ollama, prefs);

  const deps: BridgeDeps = { context, server, ollama, servers, prefs };

  // The `secondarySidebar` viewsContainers slot needs VS Code >= 1.106. On
  // older builds, flip this context key so the activitybar fallback shows
  // instead (same approach the Claude Code / Codex extensions use).
  const [major, minor] = vscode.version.split('.').map((n) => Number(n));
  const supportsSecondarySidebar = major > 1 || (major === 1 && minor >= 106);
  if (!supportsSecondarySidebar) {
    void vscode.commands.executeCommand(
      'setContext',
      'ollamaCode:doesNotSupportSecondarySidebar',
      true,
    );
  }

  // Register a provider for both the activitybar fallback view and the
  // secondary-sidebar view; only one is active at a time via `when` clauses.
  const providerPrimary = new ChatViewProvider(context.extensionUri, deps);
  const providerSecondary = new ChatViewProvider(context.extensionUri, deps);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('ollamaCode.chat', providerPrimary, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider('ollamaCode.chatSecondary', providerSecondary, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  const provider = { newChat: () => { providerPrimary.newChat(); providerSecondary.newChat(); }, showHistory: () => { providerPrimary.showHistory(); providerSecondary.showHistory(); } };

  context.subscriptions.push(
    vscode.commands.registerCommand('ollamaCode.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('ollamaCode.history', () => provider.showHistory()),
    vscode.commands.registerCommand('ollamaCode.focus', () =>
      vscode.commands.executeCommand('ollamaCode.chat.focus'),
    ),
    vscode.commands.registerCommand('ollamaCode.openInTab', () =>
      openChatPanel(context.extensionUri, deps),
    ),
    vscode.commands.registerCommand('ollamaCode.showLogs', () => showLogs()),
    vscode.commands.registerCommand('ollamaCode.restartServer', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Restarting OpenCode server…' },
        async () => {
          try {
            if (!server) {
              throw new Error('Extension is not fully activated yet.');
            }
            await server.restart();
            vscode.window.showInformationMessage('Ollama Code: OpenCode server restarted.');
          } catch (err) {
            vscode.window.showErrorMessage(
              `Ollama Code: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      );
    }),
  );

  // Restart the server if relevant settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('ollamaCode.ollamaBaseUrl') ||
        e.affectsConfiguration('ollamaCode.opencodePath') ||
        e.affectsConfiguration('ollamaCode.serverPort')
      ) {
        log('relevant configuration changed; restarting server on next use');
        server?.dispose();
      }
    }),
  );
}

export function deactivate(): void {
  server?.dispose();
}
