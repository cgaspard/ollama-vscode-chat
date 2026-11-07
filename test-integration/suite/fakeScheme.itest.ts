// End-to-end test of the wrong-scheme banner (v0.33): the extension is pointed
// at https:// for a FAKE plain-http Ollama, the way a server saved as
// "https://192.168.x.x:11434" fails against a real one. Exercises the real
// bridge → OllamaClient → fetch path: the TLS handshake fails, the http probe
// answers, the banner names the problem, and "Use http" reconnects.
import * as assert from 'node:assert';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as helpers from './helpers';

const { useServer, openPanel, click, count, text, waitFor } = helpers;

let versionHits = 0;

function startFakeOllama(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? '';
    if (url.startsWith('/api/version')) {
      versionHits++;
      return send(200, { version: '0.0.0-fake' });
    }
    if (url.startsWith('/api/tags')) {
      return send(200, { models: [] });
    }
    if (url.startsWith('/api/ps')) {
      return send(200, { models: [] });
    }
    send(404, { error: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

describe('wrong-scheme banner against a fake Ollama', function () {
  this.timeout(40000);
  let fake: { port: number; close: () => Promise<void> };

  before(async () => {
    fake = await startFakeOllama();
    await useServer(`https://127.0.0.1:${fake.port}`);
    await openPanel();
  });

  after(async () => {
    await fake?.close();
  });

  it('names the scheme problem instead of "can\'t reach"', async () => {
    await waitFor('#conn-fix-scheme', (n) => n === 1, 15000);
    assert.match((await text('#conn-banner .conn-title'))!, /Ollama answers over http, not https/);
    const sub = (await text('#conn-banner .conn-sub'))!;
    assert.ok(sub.includes(`https://127.0.0.1:${fake.port}`), `sub should show the failing URL: ${sub}`);
    assert.ok(sub.includes(`http://127.0.0.1:${fake.port}`), `sub should show the working URL: ${sub}`);
    assert.strictEqual(await text('#conn-fix-scheme'), 'Use http');
  });

  it('"Use http" switches the server to http and connects', async () => {
    const hitsBefore = versionHits;
    assert.ok(await click('#conn-fix-scheme'), 'fix button should be clickable');
    await waitFor('#conn-banner:not(.hidden)', (n) => n === 0, 15000);
    assert.strictEqual(await count('#conn-fix-scheme'), 0, 'banner and fix button are gone');
    assert.ok(versionHits > hitsBefore, 'the extension reached the fake over http');
  });
});
