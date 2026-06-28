import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatModelDate, modelDisambiguator, modelIdentity, pickModel } from '../src/core/models';

const M = (id: string, loaded = false) => ({ id, loaded });

test('pickModel honors preference order, skipping ones that no longer exist', () => {
  assert.equal(pickModel(['a', 'b'], [M('b'), M('c')]), 'b'); // a is gone, b wins
  assert.equal(pickModel(['c', 'b'], [M('b'), M('c')]), 'c'); // first match wins
});

test('pickModel falls back to a loaded model, then the first available', () => {
  assert.equal(pickModel(['gone'], [M('a'), M('b', true)]), 'b'); // prefer the loaded one
  assert.equal(pickModel(['gone'], [M('a'), M('b')]), 'a'); // else first
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
