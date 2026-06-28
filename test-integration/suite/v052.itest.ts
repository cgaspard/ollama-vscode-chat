// Integration tests for the v0.5.2 webview features, driven against a real
// (headless) VS Code + the live webview via the test hook. A fake OpenCode
// event stream is injected so the tests are deterministic and need no Ollama.
import * as assert from 'node:assert';
import * as helpers from './helpers';

const { openPanel, post, text, count, classes, click, waitFor } = helpers;

const MODELS = [
  { id: 'qwen3:27b', name: 'qwen3:27b', loaded: false, maxContextLength: 262144, publisher: 'qwen3', format: 'GGUF', quantization: 'Q8_0' },
  { id: 'llama3.3:70b', name: 'llama3.3:70b', loaded: false, maxContextLength: 131072, publisher: 'llama', format: 'GGUF', quantization: 'Q4_K_M' },
];

function init() {
  return post({ type: 'init', models: MODELS, currentModel: null, agent: 'build', cwd: '/tmp', serverReady: true, ollamaConnected: true, minContext: 32768, keepAlive: '30m' });
}

// Stream `chars` characters of assistant text over the fake event stream, then
// go idle — exercising the tokens/sec path end to end.
async function streamAssistant(messageID: string, chars: number, partId = 'p1') {
  await post({ type: 'event', event: { type: 'message.updated', properties: { info: { id: messageID, role: 'assistant', time: { created: Date.now() } } } } });
  await post({ type: 'event', event: { type: 'message.part.updated', properties: { part: { id: partId, messageID, sessionID: 's', type: 'text', text: '' } } } });
  const chunk = 'x'.repeat(20);
  for (let i = 0; i < chars; i += 20) {
    await post({ type: 'event', event: { type: 'message.part.delta', properties: { partID: partId, field: 'text', delta: chunk } } });
  }
  await post({ type: 'event', event: { type: 'session.idle', properties: { sessionID: 's' } } });
}

describe('v0.5.2 webview features', function () {
  this.timeout(30000);

  before(async () => {
    await openPanel();
    await init();
  });

  describe('tokens/sec', () => {
    it('shows an estimated gen-stat under a finished assistant turn', async () => {
      await post({ type: 'busy', busy: true }); // turn starts → counters reset
      await streamAssistant('m1', 400); // 400 chars ≈ 100 tokens
      await waitFor('.gen-stat', (n) => n >= 1);
      const stat = await text('.gen-stat');
      assert.ok(stat, 'gen-stat should be present');
      assert.match(stat!, /tok\/s/, 'stat should report a token rate');
      assert.match(stat!, /^~/, 'estimate should be prefixed with ~');
      assert.match(stat!, /~100 tokens/, 'should estimate ~100 tokens from 400 chars');
    });

    it('shows NO gen-stat for a tool-only turn (no streamed text)', async () => {
      await post({ type: 'busy', busy: true });
      await post({ type: 'event', event: { type: 'message.updated', properties: { info: { id: 'm2', role: 'assistant', time: { created: Date.now() } } } } });
      await post({ type: 'event', event: { type: 'message.part.updated', properties: { part: { id: 'tp', messageID: 'm2', sessionID: 's', type: 'tool', tool: 'read', state: { status: 'completed' } } } } });
      await post({ type: 'event', event: { type: 'session.idle', properties: { sessionID: 's' } } });
      const total = await count('.gen-stat');
      assert.strictEqual(total, 1, 'only the earlier text turn should have a gen-stat');
    });
  });

  describe('model picker', () => {
    it('disambiguates models and shows the identity line', async () => {
      await click('#model-btn');
      await waitFor('.model-row', (n) => n >= 2);
      const idents = await classes('.model-ident');
      assert.ok(idents.length >= 1, 'identity lines should render');
      const firstIdent = await text('.model-ident');
      assert.match(firstIdent!, /GGUF/, 'identity line should include the format');
    });

    // NOTE: the full Load lifecycle (spinner, completion, cancel, ps behavior)
    // is exercised against a fake Ollama server in fakeOllama.itest.ts — that
    // drives the real bridge→client→fetch path with realistic API timing, which
    // is more meaningful than injecting a synthetic `models` message here.
  });
});
