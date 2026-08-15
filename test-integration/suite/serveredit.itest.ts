// Integration tests for editing a registered Ollama server: the per-row pencil
// button, the edit overlay's prefilled Name/URL fields, and its close/cancel
// affordances. Driven against the live webview via the test hook; the server
// list is injected, so no Ollama instance or real registry state is needed.
import * as assert from 'node:assert';
import * as helpers from './helpers';

const { openPanel, post, count, click, attr, waitFor } = helpers;

const SERVERS = [
  { id: 'srv_a', name: 'Local', url: 'http://127.0.0.1:11434' },
  { id: 'srv_b', name: 'Workstation', url: 'http://192.168.10.10:11434' },
];

function postServers() {
  return post({ type: 'servers', servers: SERVERS, activeId: 'srv_a', connected: true });
}

describe('server editing', function () {
  this.timeout(30000);

  before(async () => {
    await openPanel();
    await post({
      type: 'init',
      models: [],
      currentModel: null,
      agent: 'build',
      cwd: '/tmp',
      serverReady: true,
      ollamaConnected: true,
      minContext: 32768,
    });
    await postServers();
    // The menu list only renders while the menu is open.
    assert.ok(await click('#model-btn'), 'model & server menu button should be clickable');
    await waitFor('#model-menu:not(.hidden)', (n) => n === 1);
    await postServers(); // re-render rows now that the menu is open
  });

  it('every server row has an edit button', async () => {
    await waitFor('#server-menu-list .model-row', (n) => n === 2);
    assert.strictEqual(await count('#server-menu-list .server-edit'), 2);
  });

  it('the row keeps its remove button alongside the new edit button', async () => {
    assert.strictEqual(await count('#server-menu-list .eject'), 2);
  });

  it('edit opens the overlay prefilled with the row it was clicked on', async () => {
    assert.ok(await click('#server-menu-list .model-row:nth-child(2) .server-edit'), 'edit click should land');
    await waitFor('#server-edit-overlay:not(.hidden)', (n) => n === 1);
    assert.strictEqual(await attr('#server-edit-name', 'value'), 'Workstation');
    assert.strictEqual(await attr('#server-edit-url', 'value'), 'http://192.168.10.10:11434');
  });

  it('opening the overlay closes the combined model menu behind it', async () => {
    assert.strictEqual(await count('#model-menu:not(.hidden)'), 0);
  });

  it('cancel closes the overlay', async () => {
    assert.ok(await click('#server-edit-cancel'));
    await waitFor('#server-edit-overlay:not(.hidden)', (n) => n === 0);
  });

  it('editing another row reuses the overlay with that row values', async () => {
    assert.ok(await click('#server-menu-list .model-row:nth-child(1) .server-edit'));
    await waitFor('#server-edit-overlay:not(.hidden)', (n) => n === 1);
    assert.strictEqual(await attr('#server-edit-name', 'value'), 'Local');
    assert.strictEqual(await attr('#server-edit-url', 'value'), 'http://127.0.0.1:11434');
  });

  it('the close button dismisses the overlay', async () => {
    assert.ok(await click('#server-edit-close'));
    await waitFor('#server-edit-overlay:not(.hidden)', (n) => n === 0);
  });
});
