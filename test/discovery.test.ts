import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  contextFromTags,
  granularFromShow,
  needsShow,
  showCacheKey,
  tagsCarryCapabilities,
} from '../src/core/discovery';

// ---------------------------------------------------------------------------
// tagsCarryCapabilities — the ≥0.30 feature detection
// ---------------------------------------------------------------------------

test('tagsCarryCapabilities: true only for rows with a capabilities array', () => {
  // Real 0.32.9 row shape (verified live): capabilities is a string array.
  assert.equal(tagsCarryCapabilities({ capabilities: ['completion', 'tools'] }), true);
  assert.equal(tagsCarryCapabilities({ capabilities: [] }), true); // empty array still counts
  // Pre-0.30 rows have no capabilities key at all.
  assert.equal(tagsCarryCapabilities({ name: 'qwen3:0.6b' }), false);
  assert.equal(tagsCarryCapabilities({ capabilities: 'thinking' as unknown as string[] }), false);
  assert.equal(tagsCarryCapabilities(undefined), false);
});

test('contextFromTags: positive numbers only', () => {
  assert.equal(contextFromTags({ details: { context_length: 40960 } }), 40960);
  assert.equal(contextFromTags({ details: { context_length: 0 } }), undefined);
  assert.equal(contextFromTags({ details: { context_length: '40960' } }), undefined);
  assert.equal(contextFromTags({ details: {} }), undefined);
  assert.equal(contextFromTags({}), undefined);
  assert.equal(contextFromTags(undefined), undefined);
});

// ---------------------------------------------------------------------------
// needsShow — when the per-model /api/show call is still required
// ---------------------------------------------------------------------------

test('needsShow: legacy rows always need show (until cached)', () => {
  assert.equal(needsShow({ modern: false, thinking: true, hasContext: false, cached: false }), true);
  assert.equal(needsShow({ modern: false, thinking: false, hasContext: true, cached: false }), true);
  assert.equal(needsShow({ modern: false, thinking: true, hasContext: false, cached: true }), false);
});

test('needsShow: modern non-thinking rows with context skip show entirely', () => {
  assert.equal(needsShow({ modern: true, thinking: false, hasContext: true, cached: false }), false);
});

test('needsShow: modern thinking rows need one show for granularity', () => {
  assert.equal(needsShow({ modern: true, thinking: true, hasContext: true, cached: false }), true);
  // ...but never again once the digest-keyed answer is cached.
  assert.equal(needsShow({ modern: true, thinking: true, hasContext: true, cached: true }), false);
});

test('needsShow: modern rows missing context_length fall back to show', () => {
  assert.equal(needsShow({ modern: true, thinking: false, hasContext: false, cached: false }), true);
});

// ---------------------------------------------------------------------------
// granularFromShow — graded-effort detection across template generations
// ---------------------------------------------------------------------------

test('granularFromShow: .ThinkLevel in the template is the primary oracle', () => {
  assert.equal(granularFromShow({ template: '{{ if .ThinkLevel }}Reasoning: {{ .ThinkLevel }}{{ end }}' }), true);
  // qwen3-style thinking template — thinking-capable but binary.
  assert.equal(granularFromShow({ template: '{{ if .Thinking }}<think>{{ end }}' }), false);
});

test('granularFromShow: renderer/parser identify template-less gpt-oss builds', () => {
  // New-generation models ship built-in renderers instead of Go templates.
  assert.equal(granularFromShow({ template: '', renderer: 'gptoss', parser: 'gptoss' }), true);
  assert.equal(granularFromShow({ renderer: 'gpt-oss' }), true);
  assert.equal(granularFromShow({ parser: 'harmony' }), true);
  assert.equal(granularFromShow({ renderer: 'qwen3' }), false);
  // Renderer names must not match inside unrelated words.
  assert.equal(granularFromShow({ renderer: 'colossus' }), false);
});

test('granularFromShow: null/empty payloads are not granular', () => {
  assert.equal(granularFromShow(null), false);
  assert.equal(granularFromShow(undefined), false);
  assert.equal(granularFromShow({}), false);
  assert.equal(granularFromShow({ template: 42, renderer: 7 }), false);
});

// ---------------------------------------------------------------------------
// showCacheKey — content-addressed cache identity
// ---------------------------------------------------------------------------

test('showCacheKey: keyed by name and digest so re-pulls refresh themselves', () => {
  assert.equal(showCacheKey({ name: 'qwen3:0.6b', digest: 'abc' }), 'qwen3:0.6b@abc');
  assert.notEqual(
    showCacheKey({ name: 'qwen3:0.6b', digest: 'abc' }),
    showCacheKey({ name: 'qwen3:0.6b', digest: 'def' }),
  );
  assert.equal(showCacheKey({}), '@');
});
