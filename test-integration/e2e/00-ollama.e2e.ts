// What only Ollama Code has, through the real panel against a real Ollama:
// the context window you pick is the one Ollama runs (GET /api/ps), thinking
// switches off and on, keep-alive reaches the loaded model, a model the
// engine was not started with works without a restart, and several servers
// can be added, switched, edited, lost and removed.
import * as assert from 'node:assert';
import {
  ask,
  CTX,
  closeMenus,
  connect,
  freshChat,
  h,
  OLLAMA,
  openModelMenu,
  ps,
  MODEL,
  setEffort,
  THINKING_MODEL,
  sleep,
  until,
} from './lib';

/** Reasoning blocks in the transcript (a fresh chat holds one turn). */
const reasoningBlocks = () => h.count('.msg.assistant .part-reasoning');

/** Rows of the model menu's Server section, by name. */
async function serverNames(): Promise<string[]> {
  await openModelMenu({ servers: true });
  return (await h.allText('#server-menu-list .model-row .model-name')).map((n) => n.replace(/\s*·\s*active$/, '').trim());
}

async function clickServer(name: string, selector = ''): Promise<void> {
  const i = (await serverNames()).indexOf(name);
  assert.ok(i >= 0, `server ${name} is listed`);
  await h.click(`#server-menu-list .model-row:nth-child(${i + 1})${selector ? ` ${selector}` : ''}`);
}

async function addServer(name: string, url: string): Promise<void> {
  const before = (await serverNames()).length;
  await h.click('#server-add-toggle');
  await h.fill('#server-add-name', name);
  await h.fill('#server-add-url', url);
  await h.click('#server-add-btn');
  await until(async () => (await serverNames()).length === before + 1, 15_000, `${name} to be added`);
}

/** Wait until the model menu lists models from the active server. */
async function modelsListed(): Promise<void> {
  await until(async () => (await h.allText('#model-menu-list .model-row .model-name')).includes(MODEL), 60_000, 'the model list');
}

/** The server the run started on, so a failed test cannot strand the rest of the suite elsewhere. */
let home = '';
const activeServer = async () => (await h.allText('#server-menu-list .model-row.active .model-name'))[0]?.replace(/\s*·\s*active$/, '').trim();

describe('e2e · Ollama', function () {
  before(async () => {
    await connect();
    await openModelMenu({ servers: true });
    home = (await activeServer()) ?? '';
    await closeMenus();
  });

  afterEach(async () => {
    await openModelMenu({ servers: true }).catch(() => undefined);
    if (home && (await activeServer()) !== home) {
      await clickServer(home).catch(() => undefined);
      await until(async () => (await h.count('#conn-banner:not(.hidden)')) === 0, 60_000, 'the run’s server').catch(() => undefined);
    }
    await closeMenus();
  });

  it('a context window picked in the model menu is the one Ollama runs', async () => {
    await freshChat({ model: MODEL });
    await openModelMenu();
    const presets = await h.allText('#ctx-presets .ctx-preset');
    const i = presets.indexOf('16K');
    assert.ok(i >= 0, `a 16K preset is offered (${presets.join(', ')})`);
    await h.click('#ctx-presets .ctx-preset', i);
    await closeMenus();
    // The engine was started with CTX for this model; the pick must reach
    // Ollama anyway (the panel rebuilds the engine before sending).
    assert.match(await ask('Reply with exactly: WINDOW-OK'), /WINDOW-OK/);
    const loaded = await ps(MODEL);
    assert.strictEqual(loaded?.context_length, 16384, `GET /api/ps reports ${MODEL} at ${loaded?.context_length}`);
    // Back to the run's window for the rest of the suite.
    await h.postToHost({ type: 'setModelCtxPref', modelID: MODEL, numCtx: CTX });
  });

  it('thinking switched off sends no reasoning; switched on, it streams a thinking block', async () => {
    await freshChat({ model: THINKING_MODEL });
    await setEffort('off', { required: true });
    assert.match(await ask('What is 6 * 7? Answer with just the number.'), /42/);
    assert.strictEqual(await reasoningBlocks(), 0, 'no thinking block with thinking off');

    await freshChat({ model: THINKING_MODEL });
    await setEffort('high', { required: true });
    assert.match(await ask('What is 6 * 8? Answer with just the number.'), /48/);
    assert.ok((await reasoningBlocks()) > 0, 'a thinking block with thinking on');
  });

  it('/effort sets the thinking level from the composer', async () => {
    await freshChat({ model: THINKING_MODEL });
    await h.setInput('/effort off');
    await h.keydown('Enter');
    await sleep(300);
    assert.match(await ask('What is 5 * 9? Answer with just the number.'), /45/);
    assert.strictEqual(await reasoningBlocks(), 0, '/effort off turned thinking off');
  });

  it('a keep-alive picked in the model menu reaches the loaded model', async () => {
    await freshChat({ model: MODEL });
    await openModelMenu();
    const presets = await h.allText('#ka-presets .ctx-preset');
    await h.click('#ka-presets .ctx-preset', presets.indexOf('1h'));
    const want = Date.now() + 3600_000;
    await until(
      async () => Math.abs(Date.parse(String((await ps(MODEL))?.expires_at)) - want) < 5 * 60_000,
      30_000,
      'Ollama to keep the model for an hour',
    );
    await h.click('#ka-presets .ctx-preset', presets.indexOf('30m'));
    await closeMenus();
  });

  it('a model Ollama gained after the engine started works without a restart', async () => {
    // A new tag of an installed model: instant, no download, removed after.
    // It shares the model's weights, and Ollama names a runner after whichever
    // tag loaded it — a runner the alias started would stay listed under the
    // deleted alias, and the panel would show the model as not loaded. So the
    // model is loaded under its own name first, at the window the alias will
    // ask for, and the alias reuses that runner.
    await freshChat({ model: MODEL });
    await setEffort('off');
    assert.match(await ask('Reply with exactly: WARM'), /WARM/);
    const alias = `e2e-alias-${process.pid}:latest`;
    const api = (path: string, method: string, body: unknown) =>
      fetch(`${OLLAMA}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok((await api('/api/copy', 'POST', { source: MODEL, destination: alias })).ok, 'ollama copy');
    try {
      await connect();
      await openModelMenu();
      await h.click('#model-refresh');
      await until(async () => (await h.allText('#model-menu-list .model-row .model-name')).includes(alias.replace(/:latest$/, '')), 60_000, 'the new model in the menu');
      await closeMenus();
      await freshChat({ model: alias.replace(/:latest$/, '') });
      await setEffort('off');
      // The engine was started without this model; the panel rebuilds it
      // before sending, so the model is declared with its window like any
      // other (the log says "…is not what the running engine declares").
      assert.match(await ask('Reply with exactly: NEW-MODEL-OK'), /NEW-MODEL-OK/);
      assert.strictEqual(await h.count('.error-bubble'), 0, 'no error');
    } finally {
      await api('/api/delete', 'DELETE', { model: alias });
    }
    assert.ok(await ps(MODEL), `${MODEL} is still listed under its own name (GET /api/ps)`);
  });

  it('a server added in the menu can be switched to, edited, and removed', async () => {
    await addServer('Loopback', 'http://localhost:11434');
    await clickServer('Loopback');
    await until(async () => /Loopback/.test(String(await h.text('#models-head-label'))), 30_000, 'the switch');
    await modelsListed();
    await closeMenus();
    await freshChat({ model: MODEL });
    await setEffort('off');
    assert.match(await ask('Reply with exactly: LOOPBACK-OK'), /LOOPBACK-OK/);

    // Edit it: a new name and URL, applied to the live connection.
    await clickServer('Loopback', '.server-edit');
    await until(async () => (await h.count('#server-edit-overlay:not(.hidden)')) > 0, 5000, 'the edit form');
    await h.fill('#server-edit-name', 'Loopback v4');
    await h.fill('#server-edit-url', 'http://127.0.0.1:11434');
    await h.click('#server-edit-save');
    await until(async () => (await serverNames()).includes('Loopback v4'), 15_000, 'the rename');
    await modelsListed();
    await closeMenus();
    await freshChat({ model: MODEL });
    assert.match(await ask('Reply with exactly: EDITED-OK'), /EDITED-OK/);

    // Back to where the run started, and the extra entry removed.
    await clickServer(home);
    await until(async () => !/Loopback/.test(String(await h.text('#models-head-label'))), 30_000, 'the switch back');
    await clickServer('Loopback v4', '.eject');
    await until(async () => !(await serverNames()).includes('Loopback v4'), 15_000, 'the removal');
    await closeMenus();
  });

  it('an unreachable server shows the offline banner, and switching back recovers', async () => {
    await addServer('Nowhere', 'http://127.0.0.1:9');
    await clickServer('Nowhere');
    await until(async () => (await h.count('#conn-banner:not(.hidden)')) > 0, 60_000, 'the offline banner');
    assert.match(String(await h.text('#conn-banner')), /Can't reach Ollama/);
    await clickServer(home);
    await until(async () => (await h.count('#conn-banner:not(.hidden)')) === 0, 60_000, 'the banner to clear');
    await clickServer('Nowhere', '.eject');
    await until(async () => !(await serverNames()).includes('Nowhere'), 15_000, 'the removal');
    await closeMenus();
    await freshChat({ model: MODEL });
    await setEffort('off');
    assert.match(await ask('Reply with exactly: BACK-ONLINE'), /BACK-ONLINE/);
  });
});
