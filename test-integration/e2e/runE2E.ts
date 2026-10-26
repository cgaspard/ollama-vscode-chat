// End-to-end suite: the real panel, the embedded OpenCode 2 engine, a real
// local model, and a workspace with files, agents, commands, skills and an MCP
// server. Every README feature gets exercised through the actual UI.
//
//   npm run test:e2e
//
// Needs Ollama (default http://127.0.0.1:11434, override with E2E_OLLAMA) with
// one small model with tools and vision (E2E_MODEL, default qwen3-vl:2b), plus
// a small thinking model for the thinking on/off tests (E2E_THINKING_MODEL,
// default qwen3:0.6b). Each run gets a fresh copy of
// test-integration/e2e/workspace, so edits the agent makes never touch the repo.
// Ollama is shared hardware: run it under the model lock.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  delete process.env.ELECTRON_RUN_AS_NODE;
  const repo = path.resolve(__dirname, '..', '..', '..');
  const fixture = path.join(repo, 'test-integration', 'e2e', 'workspace');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-e2e-ws-'));
  fs.cpSync(fixture, workspace, { recursive: true });
  try {
    await runTests({
      version: process.env.VSCODE_TEST_VERSION ?? '1.130.0',
      extensionDevelopmentPath: repo,
      extensionTestsPath: path.resolve(__dirname, 'index.js'),
      // A fresh profile per run, so a previous run's sessions and settings
      // cannot make a test pass.
      launchArgs: [workspace, '--disable-extensions', `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'ol-e2e-profile-'))}`],
      extensionTestsEnv: {
        E2E_WORKSPACE: workspace,
        OLLAMA_CODE_LOG_STDOUT: '1',
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('E2E_')) as Array<[string, string]>),
      },
    });
  } catch {
    console.error('E2E tests failed.');
    process.exitCode = 1;
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

void main();
