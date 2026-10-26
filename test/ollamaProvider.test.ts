import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { toEngineProviderID } from '../src/core/providerIds';
import { OLLAMA_OPTIONS_KEY, remapProviderOptions } from '../src/core/providerOptions';
import { OLLAMA_PROVIDER_ID, PROVIDER_MODULE, contextFor, ollamaProviderConfig, providerModuleUrl } from '../src/opencode/ollamaProvider';

const ENGINE = toEngineProviderID(OLLAMA_PROVIDER_ID);

test('the panel provider never runs under the id the built-in ollama plugin owns', () => {
  assert.notEqual(ENGINE, 'ollama');
  const cfg = ollamaProviderConfig({ baseUrl: 'http://h:11434', npm: 'file:///x/ollama.mjs', models: [], defaultCtx: 32768 });
  assert.deepEqual(Object.keys(cfg), [ENGINE]);
});

test('the provider talks to the native /api endpoint through the bundled module', () => {
  const p = ollamaProviderConfig({ baseUrl: 'http://h:11434/v1', npm: 'file:///x/ollama.mjs', models: [], defaultCtx: 32768 })[ENGINE] as any;
  assert.equal(p.options.baseURL, 'http://h:11434/api', 'a stray /v1 is dropped: /v1 cannot carry num_ctx');
  assert.equal(p.npm, 'file:///x/ollama.mjs');
  assert.equal(p.models, undefined, 'no models block when none were enumerated');
});

test('each model declares one window: num_ctx on the wire = limit.context', () => {
  const p = ollamaProviderConfig({
    baseUrl: 'http://h:11434',
    npm: 'file:///x',
    defaultCtx: 32768,
    ctxOverride: (id) => (id === 'big' ? 65536 : undefined),
    models: [
      { id: 'small', maxContextLength: 8192, vision: false, reasoning: true },
      { id: 'big', maxContextLength: 131072, vision: true, toolUse: false },
      { id: 'plain' },
    ],
  })[ENGINE] as any;
  assert.deepEqual(p.models.small.options, { options: { num_ctx: 8192 } }, 'clamped to the model max');
  assert.equal(p.models.small.limit.context, 8192);
  assert.equal(p.models.small.reasoning, true);
  assert.deepEqual(p.models.big.options, { options: { num_ctx: 65536 } }, 'per-model override');
  assert.deepEqual(p.models.big.modalities.input, ['text', 'image']);
  assert.equal(p.models.big.attachment, true);
  assert.equal(p.models.big.tool_call, false);
  assert.equal(p.models.plain.limit.context, 32768);
  assert.equal(p.models.plain.limit.output, 8192);
  assert.deepEqual(Object.keys(p.models.plain.variants), ['off', 'low', 'medium', 'high']);
  assert.equal(contextFor({ id: 'x', maxContextLength: 4096 }, 32768), 4096);
});

test('providerModuleUrl points at the bundled module, or nothing when it is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'));
  try {
    assert.equal(providerModuleUrl(dir), undefined);
    fs.mkdirSync(path.join(dir, path.dirname(PROVIDER_MODULE)), { recursive: true });
    fs.writeFileSync(path.join(dir, PROVIDER_MODULE), '');
    assert.match(providerModuleUrl(dir)!, /^file:\/\/.*opencode-provider\/ollama\.mjs$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remap: engine-keyed options move to the key the provider reads', () => {
  const out = remapProviderOptions({ prompt: 1, providerOptions: { [ENGINE]: { options: { num_ctx: 8192 }, think: 'high' } } } as any, ENGINE);
  assert.deepEqual(out.providerOptions, { [OLLAMA_OPTIONS_KEY]: { options: { num_ctx: 8192 }, think: 'high' } });
  assert.equal((out as any).prompt, 1, 'the rest of the call is untouched');
});

test('remap: nested options merge, an explicit ollama entry wins', () => {
  const out = remapProviderOptions(
    { providerOptions: { [ENGINE]: { options: { num_ctx: 8192, temperature: 0.1 }, think: false }, ollama: { options: { temperature: 0.7 } }, other: { a: 1 } } },
    ENGINE,
  );
  assert.deepEqual(out.providerOptions, { other: { a: 1 }, ollama: { options: { num_ctx: 8192, temperature: 0.7 }, think: false } });
});

test('remap: no-ops when there is nothing to move', () => {
  const call = { providerOptions: { ollama: { think: true } } };
  assert.equal(remapProviderOptions(call, ENGINE), call);
  assert.equal(remapProviderOptions(call, 'ollama'), call);
  assert.equal(remapProviderOptions(call, undefined), call);
  const none = {};
  assert.equal(remapProviderOptions(none, ENGINE), none);
});
