import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatLoadElapsed,
  formatModelDate,
  isModelReady,
  mergeModelLoadedState,
  modelDisambiguator,
  modelIdentity,
  pickModel,
} from '../src/core/models';

const M = (id: string, loaded = false) => ({ id, loaded });

test('pickModel: explicit default (preferences[0]) wins when it exists', () => {
  assert.equal(pickModel(['c', 'b'], [M('b'), M('c')]), 'c'); // explicit default wins
  // even over a different loaded model — an explicit default is deliberate.
  assert.equal(pickModel(['c', 'b'], [M('b', true), M('c')]), 'c');
});

test('pickModel: a LOADED model beats a stored/last-used pick that is not loaded', () => {
  // preferences[0] (explicit default) absent; stored pref "a" exists but "b" is
  // actually loaded → open into the loaded one. (The bug was opening to a CTA
  // for "a" while "b" sat loaded and ignored.)
  assert.equal(pickModel(['', 'a'], [M('a'), M('b', true)]), 'b');
  assert.equal(pickModel([undefined, 'a'], [M('a'), M('b', true)]), 'b');
});

test('pickModel: falls back to next preference, then first available', () => {
  assert.equal(pickModel(['gone', 'a'], [M('a'), M('b')]), 'a'); // no loaded → stored pref
  assert.equal(pickModel(['gone'], [M('a'), M('b')]), 'a'); // nothing → first
});

test('pickModel skips empty / null / undefined preferences', () => {
  assert.equal(pickModel([null, undefined, '', 'a'], [M('a')]), 'a');
  assert.equal(pickModel(['', '  '], [M('x')]), 'x'); // whitespace-only isn't a real id match
});

test('pickModel returns undefined when there are no models', () => {
  assert.equal(pickModel(['a'], []), undefined);
  assert.equal(pickModel([], []), undefined);
});

test('modelDisambiguator returns null when the name is unique', () => {
  const all = [
    { id: 'qwen3:8b', name: 'qwen3:8b', publisher: 'qwen3' },
    { id: 'gemma3:12b', name: 'gemma3:12b', publisher: 'gemma3' },
  ];
  assert.equal(modelDisambiguator(all[0], all), null);
});

test('modelDisambiguator uses publisher (family) when namesakes differ by publisher', () => {
  // Two models that share a display name but come from different families.
  const all = [
    { id: 'a/coder', name: 'coder', publisher: 'qwen3' },
    { id: 'b/coder', name: 'coder', publisher: 'llama' },
  ];
  assert.equal(modelDisambiguator(all[0], all), 'qwen3');
  assert.equal(modelDisambiguator(all[1], all), 'llama');
});

test('modelDisambiguator falls back to the id when name AND publisher collide', () => {
  // The real case: a bare id and a namespaced id, both the same family.
  const all = [
    { id: 'qwen3:8b', name: 'qwen3', publisher: 'qwen3' },
    { id: 'hf.co/unsloth/qwen3:8b', name: 'qwen3', publisher: 'qwen3' },
  ];
  assert.equal(modelDisambiguator(all[0], all), 'qwen3:8b');
  assert.equal(modelDisambiguator(all[1], all), 'hf.co/unsloth/qwen3:8b');
});

test('modelDisambiguator handles missing publisher (falls back to id on collision)', () => {
  const all = [
    { id: 'x/m', name: 'm' },
    { id: 'y/m', name: 'm' },
  ];
  // no publisher on either → same (empty) publisher → id distinguishes
  assert.equal(modelDisambiguator(all[0], all), 'x/m');
  assert.equal(modelDisambiguator(all[1], all), 'y/m');
});

test('modelIdentity joins present fields and skips blanks', () => {
  assert.equal(
    modelIdentity({ publisher: 'llama', format: 'GGUF', quantization: 'Q4_K_M' }),
    'llama · GGUF · Q4_K_M',
  );
  assert.equal(modelIdentity({ format: 'GGUF', quantization: 'Q8_0' }), 'GGUF · Q8_0');
  assert.equal(modelIdentity({ publisher: 'qwen3' }), 'qwen3');
  assert.equal(modelIdentity({}), '');
});

test('modelIdentity appends the date as the last segment when present', () => {
  assert.equal(
    modelIdentity({ publisher: 'llama', quantization: 'Q4_K_M', date: 'May 12' }),
    'llama · Q4_K_M · May 12',
  );
  assert.equal(modelIdentity({ date: 'May 12' }), 'May 12');
});

// Use local-time fixtures (no trailing Z, midday) so getDate()/getFullYear()
// don't cross a day/year boundary on machines in a non-UTC timezone — the
// formatter renders in local time, which is correct for a local pull time.
test('formatModelDate shows month+day within the current year', () => {
  const now = new Date('2026-06-28T12:00:00');
  assert.equal(formatModelDate('2026-05-12T10:32:14', now), 'May 12');
  assert.equal(formatModelDate('2026-01-03T12:00:00', now), 'Jan 3');
});

test('formatModelDate shows month+year for an older year', () => {
  const now = new Date('2026-06-28T12:00:00');
  assert.equal(formatModelDate('2025-11-20T12:00:00', now), 'Nov 2025');
});

test('formatModelDate returns empty for missing or invalid input', () => {
  const now = new Date('2026-06-28T12:00:00');
  assert.equal(formatModelDate(undefined, now), '');
  assert.equal(formatModelDate('', now), '');
  assert.equal(formatModelDate('not-a-date', now), '');
});

// ---- Load-state logic (the model-load bug fix) --------------------------

test('mergeModelLoadedState preserves prior loaded when an update is unknown', () => {
  const prev = [{ id: 'a', loaded: true }, { id: 'b', loaded: false }];
  // An "unknown" refresh (loaded undefined for both) must keep prior beliefs.
  const merged = mergeModelLoadedState(prev, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(merged.find((m) => m.id === 'a')!.loaded, true);
  assert.equal(merged.find((m) => m.id === 'b')!.loaded, false);
});

test('mergeModelLoadedState lets a definite true/false win over prior', () => {
  const prev = [{ id: 'a', loaded: true }];
  assert.equal(mergeModelLoadedState(prev, [{ id: 'a', loaded: false }])[0].loaded, false);
  assert.equal(mergeModelLoadedState([{ id: 'a', loaded: false }], [{ id: 'a', loaded: true }])[0].loaded, true);
});

test('mergeModelLoadedState leaves unknown as unknown for a brand-new model', () => {
  // No prior entry → nothing to preserve → stays undefined (not coerced to false).
  assert.equal(mergeModelLoadedState([], [{ id: 'new' }])[0].loaded, undefined);
});

test('isModelReady only when selected model is definitely loaded and not loading', () => {
  const models = [{ id: 'a', loaded: true }, { id: 'b', loaded: false }, { id: 'c' }];
  const none = new Set<string>();
  assert.equal(isModelReady('a', models, none), true);
  assert.equal(isModelReady('b', models, none), false, 'not loaded → not ready');
  assert.equal(isModelReady('c', models, none), false, 'unknown loaded → not ready');
  assert.equal(isModelReady('a', models, new Set(['a'])), false, 'mid-load → not ready');
  assert.equal(isModelReady(null, models, none), false, 'no selection → not ready');
  assert.equal(isModelReady('missing', models, none), false, 'unknown id → not ready');
});

test('formatLoadElapsed: empty under 1s, seconds under a minute, M:SS beyond', () => {
  assert.equal(formatLoadElapsed(0), '');
  assert.equal(formatLoadElapsed(0.4), '');
  assert.equal(formatLoadElapsed(18), '18s');
  assert.equal(formatLoadElapsed(59), '59s');
  assert.equal(formatLoadElapsed(60), '1:00');
  assert.equal(formatLoadElapsed(167), '2:47');
  assert.equal(formatLoadElapsed(605), '10:05');
});

