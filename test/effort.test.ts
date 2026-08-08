import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fallbackPromptText,
  isBinary,
  levelLabel,
  levelsForModel,
  resolveLevel,
  variantForLevel,
  variantsForModel,
  type ReasoningCapability,
} from '../src/core/effort';

// qwen3 / deepseek-r1: thinking-capable, but their templates don't reference
// .ThinkLevel — verified byte-identical output across low/medium/high/max.
const BINARY: ReasoningCapability = { supported: true, granular: false };
// gpt-oss: template references .ThinkLevel, so graded effort is real.
const GRANULAR: ReasoningCapability = { supported: true, granular: true };
// llama3.2 and friends: no `thinking` capability at all.
const NONE: ReasoningCapability = { supported: false, granular: false };

test('variants send the provider\'s boolean `think` — reasoningEffort is stripped', () => {
  // ollama-ai-provider-v2 parses providerOptions.ollama as { think?, options? }
  // and drops anything else. Wire-verified: {think:true} produced 38,745
  // reasoning chars from qwen3:0.6b, {think:false} and {reasoningEffort:'high'}
  // both produced 0.
  const v = variantsForModel();
  assert.deepEqual(Object.keys(v).sort(), ['high', 'off']);
  assert.equal(v.off.think, false);
  assert.equal(v.high.think, true);
  for (const key of Object.keys(v)) {
    assert.ok(!('reasoningEffort' in (v[key] as object)), `${key} must not use reasoningEffort`);
  }
});

test('a non-thinking model offers NOTHING — sending would be a hard 400', () => {
  // This is the inverse of the LM Studio rule and the crux of the port: on
  // Ollama, reasoning_effort on a model without `thinking` fails the turn.
  assert.deepEqual(levelsForModel(NONE), []);
  assert.deepEqual(levelsForModel(undefined), [], 'unknown must be treated as unsupported');
  assert.deepEqual(levelsForModel(null), []);
  // ...and nothing but `auto` can ever escape resolveLevel for such a model.
  for (const req of ['off', 'low', 'medium', 'high'] as const) {
    assert.equal(resolveLevel(req, NONE), 'auto');
    assert.equal(variantForLevel(resolveLevel(req, NONE)), undefined);
  }
});

test('a thinking model without .ThinkLevel collapses to auto/off/on', () => {
  assert.deepEqual(levelsForModel(BINARY), ['auto', 'off', 'high']);
  assert.ok(isBinary(BINARY));
  assert.equal(levelLabel('high', BINARY), 'On');
});

test('even a .ThinkLevel model is binary here — the provider carries a boolean', () => {
  // Ollama itself grades via .ThinkLevel, but the provider flattens every
  // non-none effort to think:true (it warns as much). Offering low/medium/high
  // would send byte-identical requests and lie about the difference.
  assert.deepEqual(levelsForModel(GRANULAR), ['auto', 'off', 'high']);
  assert.ok(isBinary(GRANULAR));
  assert.equal(levelLabel('high', GRANULAR), 'On');
});

test('resolveLevel clamps a level carried over from another model', () => {
  assert.equal(resolveLevel('medium', BINARY), 'off'); // meaningless on a binary model
  assert.equal(resolveLevel('high', BINARY), 'high');
  // A stored 'medium' (or a settings.json default) now degrades the same way on
  // every thinking model, since none of them expose the middle of the scale.
  assert.equal(resolveLevel('medium', GRANULAR), 'off');
  assert.equal(resolveLevel('high', GRANULAR), 'high');
  assert.equal(resolveLevel(undefined, GRANULAR), 'auto');
});

test('auto omits the field entirely', () => {
  assert.ok(!('auto' in variantsForModel()));
  assert.equal(variantForLevel('auto'), undefined);
  assert.equal(variantForLevel('off'), 'off');
});

test('the text fallback is the primary path for non-thinking models', () => {
  // Most Ollama models have no `thinking` capability, so text is the only lever.
  assert.match(fallbackPromptText('off', NONE), /concise|not produce/i);
  assert.match(fallbackPromptText('high', NONE), /step by step|thoroughly/i);
  assert.match(fallbackPromptText('off', undefined), /concise/i);
  // With the parameter available we must NOT also nudge with text.
  assert.equal(fallbackPromptText('off', BINARY), '');
  assert.equal(fallbackPromptText('high', GRANULAR), '');
  assert.equal(fallbackPromptText('auto', NONE), '');
});
