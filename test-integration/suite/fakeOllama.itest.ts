// End-to-end load test against a FAKE Ollama HTTP server that replays the
// behavior captured from a real server (.10.10):
//   - /api/generate (load) BLOCKS, then returns {done:true, done_reason:"load"}
//     — this is the authoritative completion signal.
//   - /api/ps stays EMPTY for a freshly-loaded model (the real server lagged
//     >90s), so the UI must NOT gate readiness on ps.
// This exercises the real bridge → OllamaClient → fetch → HTTP load path and
// proves the redesign: a Load completes (Send becomes ready) even though ps
// never reports the model.
import * as assert from 'node:assert';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as helpers from './helpers';

const { useServer, openPanel, click, count, attr, waitFor } = helpers;

const MODEL = 'qwen3:27b';

// Toggles so individual tests can shape the fake server's responses.
let loadDelayMs = 300; // how long /api/generate "blocks" before returning
let loadStatus = 200; // status for the load call (500 → simulate a failed load)
let psReportsModel = false; // current /api/ps state (model listed?)
let psAppearsAfterLoad = true; // realistic: ps lists the model once the load returns

function startFakeOllama(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? '';
    if (url.startsWith('/api/version')) {
      return send(200, { version: '0.0.0-fake' });
    }
    if (url.startsWith('/api/tags')) {
      return send(200, { models: [{ name: MODEL, model: MODEL, modified_at: '2026-06-01T00:00:00Z', details: { family: 'qwen3', format: 'gguf', quantization_level: 'Q8_0' } }] });
    }
    if (url.startsWith('/api/show')) {
      return send(200, { capabilities: ['tools'], model_info: { 'qwen3.context_length': 262144 } });
    }
    if (url.startsWith('/api/ps')) {
      // The crux: a freshly-loaded model does NOT appear here (mirrors reality).
      return send(200, { models: psReportsModel ? [{ name: MODEL, model: MODEL, context_length: 32768 }] : [] });
    }
    if (url.startsWith('/api/generate')) {
      // The load is now a tiny REAL generation (prompt + num_predict:1): it
      // blocks, then returns a token (done_reason:"length") — positive proof the
      // model can serve. Mirrors reality: once it returns, the model becomes
      // visible in /api/ps UNLESS a test pins psAppearsAfterLoad=false to
      // simulate the transient-ps-miss anomaly (and prove UI resilience).
      setTimeout(() => {
        if (loadStatus !== 200) {
          return send(loadStatus, { error: `model '${MODEL}' not found` });
        }
        if (psAppearsAfterLoad) {
          psReportsModel = true;
        }
        send(200, { model: MODEL, created_at: '2026-06-01T00:00:00Z', response: '.', done: true, done_reason: 'length' });
      }, loadDelayMs);
      return;
    }
    send(404, { error: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('load against a fake Ollama (real captured behavior)', function () {
  this.timeout(40000);
  let fake: { url: string; close: () => Promise<void> };

  before(async () => {
    fake = await startFakeOllama();
    await useServer(fake.url);
    await openPanel();
  });

  after(async () => {
    await fake?.close();
  });

  it('a Load completes and Send becomes ready (ps reports the model after the load returns)', async () => {
    loadDelayMs = 400;
    loadStatus = 200;
    psReportsModel = false;
    psAppearsAfterLoad = true; // realistic: ps lists it once the load returns

    // Open the model menu (rows only render while it's open), then click Load.
    await click('#model-btn');
    await waitFor('.model-row', (n) => n >= 1, 8000);
    await click('.model-row .model-action.load');
    // Spinner while the load request blocks…
    await waitFor('.model-action.busy', (n) => n >= 1, 5000);
    // …then a ready Send once the load completes (done_reason:"load").
    await waitFor('.send-btn.cta', (n) => n === 0, 12000);
    assert.strictEqual(await count('.send-btn.cta'), 0, 'no CTA — the model loaded');
    assert.strictEqual(await attr('.send-btn', 'title'), 'Send', 'Send is ready after the load returns');
    assert.strictEqual(await count('.model-action.busy'), 0, 'the spinner cleared');
  });

  it('stays ready even if /api/ps never reports the model (transient-ps-miss resilience)', async () => {
    loadDelayMs = 400;
    loadStatus = 200;
    psReportsModel = false;
    psAppearsAfterLoad = false; // simulate the anomaly: ps keeps omitting the model

    await openPanel(); // fresh state
    await click('#model-btn');
    await waitFor('.model-row', (n) => n >= 1, 8000);
    await click('.model-row .model-action.load');
    await waitFor('.model-action.busy', (n) => n >= 1, 5000);
    // The load returning is authoritative — Send must become ready even though
    // ps never lists the model (loadSettled marks it loaded; mergeModels keeps it).
    await waitFor('.send-btn.cta', (n) => n === 0, 12000);
    assert.strictEqual(await count('.send-btn.cta'), 0, 'load-return is authoritative; ps miss must not block readiness');
    assert.strictEqual(await attr('.send-btn', 'title'), 'Send', 'Send ready despite ps omission');
  });

  it('a failed load (500) surfaces and does not get stuck spinning', async () => {
    loadDelayMs = 300;
    loadStatus = 500; // server rejects the load (e.g. corrupt blobs)
    psReportsModel = false;
    psAppearsAfterLoad = false;
    await openPanel(); // fresh panel/state
    await click('#model-btn');
    await waitFor('.model-row', (n) => n >= 1, 8000);
    await click('.model-row .model-action.load');
    await waitFor('.model-action.busy', (n) => n >= 1, 5000);
    // The spinner must clear (load settled with an error) rather than hang.
    await waitFor('.model-action.busy', (n) => n === 0, 12000);
    assert.strictEqual(await count('.model-action.busy'), 0, 'failed load releases the spinner');
  });
});
