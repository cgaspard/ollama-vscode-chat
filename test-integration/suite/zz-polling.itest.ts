// True end-to-end tests for the smarter-polling port (LM Studio Code issue #7):
// a fake Ollama HTTP server runs in-process, the extension connects to it for
// real (including starting the bundled OpenCode server), and the assertions run
// against the fake's request log and the live webview.
//
// Named zz-* so this suite runs LAST: it drives a real connection whose health
// loop keeps running afterwards, and must not disturb the injection-driven
// suites.
import * as assert from 'node:assert';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as vscode from 'vscode';
import * as helpers from './helpers';

const { useServer, openPanel, count, click, waitFor } = helpers;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MODEL = 'e2e-fake:latest';
type Mode = 'ok' | 'hang';

/** Minimal Ollama stand-in: version/tags/ps/show/generate + a request log. */
class FakeOllama {
  private server: http.Server | undefined;
  private sockets = new Set<import('node:net').Socket>();
  private hung: http.ServerResponse[] = [];
  mode: Mode = 'ok';
  port = 0;
  log: { path: string; at: number }[] = [];

  async start(port = 0): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    this.log.push({ path, at: Date.now() });
    if (this.mode === 'hang') {
      this.hung.push(res); // never answer — the client's timeout must fire
      return;
    }
    const json = (body: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    switch (path) {
      case '/api/version':
        return json({ version: '0.0.0-fake' });
      case '/api/tags':
        return json({
          models: [
            {
              name: MODEL,
              model: MODEL,
              modified_at: '2026-07-01T00:00:00Z',
              details: { family: 'llama', format: 'gguf', quantization_level: 'Q4_K_M' },
            },
          ],
        });
      case '/api/show':
        return json({ capabilities: ['tools'], model_info: { 'llama.context_length': 8192 } });
      case '/api/ps':
        return json({ models: [{ name: MODEL, model: MODEL, context_length: 4096 }] });
      case '/api/generate':
        // keep-warm ping (bare warm call) or load — answer instantly.
        return json({ model: MODEL, done: true, done_reason: 'load' });
      default:
        res.statusCode = 404;
        return void res.end('{}');
    }
  }

  countSince(path: string, since: number): number {
    return this.log.filter((e) => e.path === path && e.at >= since).length;
  }

  releaseHung(): void {
    for (const res of this.hung.splice(0)) {
      res.destroy();
    }
  }

  /** Stop listening AND sever pooled keep-alive sockets → ECONNREFUSED next. */
  async stop(): Promise<void> {
    this.releaseHung();
    const server = this.server;
    this.server = undefined;
    for (const s of this.sockets) {
      s.destroy();
    }
    this.sockets.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

async function waitUntil(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) {
      return;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('polling e2e (issue #7 port)', function () {
  this.timeout(120_000);

  const fake = new FakeOllama();

  before(async function () {
    this.timeout(90_000);
    // Earlier suites leave their editor-tab panels (and thus bridges + health
    // loops) alive; their probes share this client's cache and would skew the
    // cadence assertions. Close them so exactly ONE bridge is polling.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await sleep(500);
    await fake.start();
    // 5s connected cadence (the minimum) so cadence assertions run fast.
    await vscode.workspace
      .getConfiguration('ollamaCode')
      .update('healthCheckSeconds', 5, vscode.ConfigurationTarget.Global);
    await useServer(`http://127.0.0.1:${fake.port}`);
    await openPanel();
    // Full real connect: version probe → OpenCode server boot → model listing.
    await waitUntil(
      () => fake.countSince('/api/tags', 0) >= 1,
      60_000,
      'the extension to list models from the fake server (is bin/opencode present?)',
    );
    await waitFor('#model-btn', (n) => n === 1, 10_000);
  });

  after(async () => {
    await vscode.workspace
      .getConfiguration('ollamaCode')
      .update('healthCheckSeconds', undefined, vscode.ConfigurationTarget.Global);
    // Leave the fake server running: the panel's health loop lives until the
    // host exits, and a dead upstream would spam reconnect churn into teardown.
  });

  it('connects via the /api/version probe', () => {
    assert.ok(fake.countSince('/api/version', 0) >= 1, 'doInit must probe /api/version');
  });

  it('probes /api/version on the configured cadence while idle, listing rarely', async () => {
    const since = Date.now();
    await sleep(13_000);
    const probes = fake.countSince('/api/version', since);
    assert.ok(probes >= 2, `expected >=2 version probes in 13s at a 5s cadence, saw ${probes}`);
    const listings = fake.countSince('/api/tags', since);
    assert.ok(listings <= 2, `expected <=2 /api/tags listings in 13s, saw ${listings}`);
  });

  it('re-asserts keep_alive via the cheap /api/ps + /api/generate ping', async () => {
    // keepWarmNow runs on its own wall-clock duty cycle, starting with the
    // first healthy tick — proof the keep-warm decoupling works end-to-end.
    await waitUntil(
      () => fake.countSince('/api/generate', 0) >= 1,
      20_000,
      'a keep-warm /api/generate ping',
    );
    assert.ok(fake.countSince('/api/ps', 0) >= 1, 'keep-warm must read /api/ps, never guess');
  });

  it('fast-polls the model list only while the picker is open', async () => {
    const openSince = Date.now();
    assert.ok(await click('#model-btn'), 'model button should be clickable');
    await waitFor('#model-menu:not(.hidden)', (n) => n === 1, 5_000);
    await sleep(9_500);
    const during = fake.countSince('/api/tags', openSince);
    assert.ok(during >= 2, `picker-open fast poll should list every ~4s, saw ${during} in 9.5s`);

    assert.ok(await click('#model-btn'), 'model button should close the menu');
    await waitFor('#model-menu:not(.hidden)', (n) => n === 0, 5_000);
    const closedSince = Date.now();
    await sleep(6_500);
    const after = fake.countSince('/api/tags', closedSince);
    assert.ok(after <= 1, `closing the picker must stop the fast poll, saw ${after} in 6.5s`);
  });

  it('tolerates slow probes without flipping offline (timeout hysteresis)', async function () {
    this.timeout(90_000);
    fake.mode = 'hang';
    await sleep(7_000);
    assert.strictEqual(
      await count('.conn-title'),
      0,
      'one or two slow probes must NOT pop the offline banner',
    );
    await waitFor('.conn-title', (n) => n >= 1, 45_000);
  });

  it('recovers automatically once the server answers again', async function () {
    this.timeout(60_000);
    fake.mode = 'ok';
    fake.releaseHung();
    await waitFor('.conn-title', (n) => n === 0, 30_000);
  });

  it('flips offline promptly on a refused connection and recovers on restart', async function () {
    this.timeout(60_000);
    const port = fake.port;
    await fake.stop();
    await waitFor('.conn-title', (n) => n >= 1, 20_000);
    await fake.start(port);
    await waitFor('.conn-title', (n) => n === 0, 30_000);
  });
});
