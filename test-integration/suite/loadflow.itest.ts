// Integration tests for the model-load gating flow and the compaction chip —
// the interactive behaviours that are easy to regress (and where bugs have hidden,
// e.g. the CTA click being swallowed by the outside-click menu-close). Driven
// against a real headless VS Code + the live webview, with a fake event stream.
import * as assert from 'node:assert';
import * as helpers from './helpers';

const { openPanel, post, text, count, attr, click, waitFor } = helpers;

const MODELS = [
  { id: 'qwen3:27b', name: 'qwen3:27b', loaded: false, maxContextLength: 262144, publisher: 'qwen3', format: 'GGUF', quantization: 'Q8_0' },
  { id: 'llama3.3:70b', name: 'llama3.3:70b', loaded: false, maxContextLength: 131072, publisher: 'llama', format: 'GGUF', quantization: 'Q4_K_M' },
];

function init(currentModel: string | null, loadedIds: string[] = []) {
  return post({
    type: 'init',
    models: MODELS.map((m) => ({ ...m, loaded: loadedIds.includes(m.id) })),
    currentModel,
    agent: 'build',
    cwd: '/tmp',
    serverReady: true,
    ollamaConnected: true,
    minContext: 32768,
    keepAlive: '30m',
  });
}

describe('Send gating + Load CTA', function () {
  this.timeout(30000);

  before(async () => {
    await openPanel();
  });

  it('shows a "Load a model" CTA (not a plain Send) when nothing is loaded', async () => {
    await init('qwen3:27b', []); // selected but not loaded
    await waitFor('.send-btn.cta', (n) => n === 1);
    const label = await text('.send-btn.cta');
    assert.match(label!, /Load a model/, 'the composer button should invite loading a model');
    // It must remain clickable (it opens the menu) — not a disabled dead button.
    assert.strictEqual(await attr('.send-btn', 'disabled'), null, 'CTA must not be disabled');
  });

  it('opens the model menu when the CTA is clicked (regression: outside-click race)', async () => {
    assert.strictEqual(await count('#model-menu:not(.hidden)'), 0, 'menu starts closed');
    await click('.send-btn.cta');
    await waitFor('#model-menu:not(.hidden)', (n) => n === 1);
    assert.strictEqual(
      await count('#model-menu:not(.hidden)'),
      1,
      'the CTA click must OPEN the menu and not be swallowed by the outside-click close',
    );
  });

  it('reverts to a normal Send once a model is loaded', async () => {
    await post({ type: 'models', models: MODELS.map((m) => ({ ...m, loaded: m.id === 'qwen3:27b' })), currentModel: 'qwen3:27b' });
    await waitFor('.send-btn.cta', (n) => n === 0);
    assert.strictEqual(await count('.send-btn.cta'), 0, 'no CTA once a model is ready');
    assert.strictEqual(await count('.send-btn'), 1, 'the Send button is present');
    assert.strictEqual(await attr('.send-btn', 'title'), 'Send', 'button title is Send when ready');
  });

  it('does NOT drop to a CTA when a refresh reports loaded-state as unknown', async () => {
    // Regression: a keep-warm refresh during a busy server can report loaded as
    // undefined (e.g. /api/ps didn't answer). The gate must keep its prior belief
    // (loaded) rather than falsely flipping to the "Load a model" CTA.
    await post({ type: 'models', models: MODELS.map((m) => ({ ...m, loaded: m.id === 'qwen3:27b' })), currentModel: 'qwen3:27b' });
    await waitFor('.send-btn.cta', (n) => n === 0);
    // Now an "unknown" refresh (loaded omitted/undefined for the resident model).
    await post({ type: 'models', models: MODELS.map((m) => ({ ...m, loaded: undefined })), currentModel: 'qwen3:27b' });
    // Give the UI a beat, then assert it did NOT become a CTA.
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(await count('.send-btn.cta'), 0, 'unknown refresh must not flip a loaded model to CTA');
    // A DEFINITE not-loaded (real eviction) still gates.
    await post({ type: 'models', models: MODELS.map((m) => ({ ...m, loaded: false })), currentModel: 'qwen3:27b' });
    await waitFor('.send-btn.cta', (n) => n === 1);
    assert.strictEqual(await count('.send-btn.cta'), 1, 'a definite not-loaded still gates Send');
  });

  it('shows progress + a cancel control during a long load', async () => {
    await post({ type: 'init', models: MODELS, currentModel: 'qwen3:27b', agent: 'build', cwd: '/tmp', serverReady: true, ollamaConnected: true, minContext: 32768, keepAlive: '30m' });
    await click('#model-btn');
    await waitFor('.model-row', (n) => n >= 2);
    await click('.model-row .model-action.load');
    // Host streams progress for an in-flight (minutes-long) load.
    await post({ type: 'loadProgress', modelID: 'qwen3:27b', elapsedSec: 95, note: 'Large models can take a few minutes to load.' });
    await waitFor('.model-action.busy', (n) => n >= 1);
    // The busy action must expose a cancel affordance and stay non-disabled.
    assert.ok((await count('.cancel-x')) >= 1, 'a cancel ✕ should be shown while loading');
    assert.strictEqual(await attr('.model-action.busy', 'disabled'), null, 'loading action must remain clickable to cancel');
    assert.ok((await count('.model-load-hint')) >= 1, 'a reassurance hint should be shown');
    // Cancelling clears the spinner.
    await click('.model-action.busy');
    await waitFor('.model-action.busy', (n) => n === 0);
    assert.strictEqual(await count('.model-action.busy'), 0, 'cancel clears the loading state');
  });

  it('re-gates to a CTA if the selected model is switched to an unloaded one', async () => {
    // qwen is loaded; switch selection to the unloaded llama via its row.
    await click('#model-btn');
    await waitFor('.model-row', (n) => n >= 2);
    // The second row is llama3.3:70b (unloaded). Click it to select.
    await helpers.post({ type: 'models', models: MODELS.map((m) => ({ ...m, loaded: m.id === 'qwen3:27b' })), currentModel: 'llama3.3:70b' });
    await waitFor('.send-btn.cta', (n) => n === 1);
    assert.strictEqual(await count('.send-btn.cta'), 1, 'selecting an unloaded model re-gates Send');
  });

  it('changing a loaded model context offers Reload alongside Eject (both available, not auto-applied)', async () => {
    await openPanel(); // fresh webview state (prior tests leave loading state)
    // A model loaded at 32K (contextLength) and selected.
    await helpers.post({
      type: 'models',
      models: [{ id: 'qwen3:27b', name: 'qwen3:27b', loaded: true, contextLength: 32768, maxContextLength: 262144, numCtx: 32768 }],
      currentModel: 'qwen3:27b',
    });
    await click('#model-btn');
    await waitFor('.model-row', (n) => n >= 1);
    // Initially the loaded model shows only Eject, no Reload.
    assert.strictEqual(await count('.model-action.reload'), 0, 'no Reload while ctx matches what is loaded');
    assert.strictEqual(await count('.model-action.eject'), 1, 'loaded model shows Eject');
    // Pick a DIFFERENT context chip — scope to #ctx-presets (keep-alive chips
    // reuse .ctx-preset, so an unscoped selector is ambiguous).
    await click('#ctx-presets .ctx-preset:not(.active)');
    // Reload appears — the change is offered, NOT auto-applied — and Eject stays.
    await waitFor('.model-action.reload', (n) => n === 1);
    assert.strictEqual(await count('.model-action.reload'), 1, 'changing ctx offers Reload');
    assert.strictEqual(await count('.model-action.eject'), 1, 'Eject remains available alongside Reload');
  });
});

describe('compaction chip', function () {
  this.timeout(30000);

  before(async () => {
    await openPanel();
    await init('qwen3:27b', ['qwen3:27b']);
  });

  it('shows a compaction chip and suppresses the summarizer turn', async () => {
    // The server emits: a user message with a `compaction` part (the marker),
    // then an assistant "summarizer" turn. The UI must show ONE chip and must
    // NOT render the summarizer turn as a normal assistant bubble.
    await post({ type: 'event', event: { type: 'message.updated', properties: { info: { id: 'cmark', role: 'user', time: { created: Date.now() } } } } });
    await post({ type: 'event', event: { type: 'message.part.updated', properties: { part: { id: 'cp', messageID: 'cmark', sessionID: 's', type: 'compaction' } } } });
    await post({ type: 'event', event: { type: 'message.updated', properties: { info: { id: 'csum', role: 'assistant', time: { created: Date.now() } } } } });
    await post({ type: 'event', event: { type: 'message.part.updated', properties: { part: { id: 'sp', messageID: 'csum', sessionID: 's', type: 'text', text: 'Summary of the conversation so far.' } } } });
    await post({ type: 'event', event: { type: 'session.idle', properties: { sessionID: 's' } } });

    await waitFor('.compaction-chip', (n) => n >= 1);
    assert.ok((await count('.compaction-chip')) >= 1, 'a compaction chip should render');
    // Both the marker (user) and the summarizer (assistant) turns are suppressed,
    // so the chip should be the only thing rendered — no message bubbles at all.
    assert.strictEqual(
      await count('.msg.assistant'),
      0,
      'the summarizer turn must be suppressed (no assistant bubble)',
    );
    assert.strictEqual(await count('.msg.user'), 0, 'the compaction marker must not render as a user bubble');
  });

  it('a normal user message with a real text part still renders a bubble', async () => {
    // Guards the fix that stopped eagerly creating bubbles on message.updated:
    // a genuine user turn must still appear once its text part streams in.
    const before = await count('.msg.user');
    await post({ type: 'event', event: { type: 'message.updated', properties: { info: { id: 'um1', role: 'user', time: { created: Date.now() } } } } });
    await post({ type: 'event', event: { type: 'message.part.updated', properties: { part: { id: 'up1', messageID: 'um1', sessionID: 's', type: 'text', text: 'hello there' } } } });
    await waitFor('.msg.user', (n) => n === before + 1);
    assert.strictEqual(await count('.msg.user'), before + 1, 'a real user turn must render a bubble');
  });
});
