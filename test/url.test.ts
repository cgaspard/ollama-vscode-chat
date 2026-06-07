import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeOllamaUrl, ollamaRestRoot } from '../src/core/url';

test('normalizeOllamaUrl falls back to the local default on empty input', () => {
  assert.equal(normalizeOllamaUrl(''), 'http://127.0.0.1:11434');
  assert.equal(normalizeOllamaUrl('   '), 'http://127.0.0.1:11434');
  assert.equal(normalizeOllamaUrl('', 'http://custom:11434'), 'http://custom:11434');
});

test('normalizeOllamaUrl adds a scheme and keeps the bare host root', () => {
  assert.equal(normalizeOllamaUrl('192.168.1.50:11434'), 'http://192.168.1.50:11434');
  assert.equal(normalizeOllamaUrl('http://host:11434'), 'http://host:11434');
  assert.equal(normalizeOllamaUrl('https://remote-ollama'), 'https://remote-ollama');
});

test('normalizeOllamaUrl strips trailing slashes and an accidental /vN', () => {
  assert.equal(normalizeOllamaUrl('http://host:11434/'), 'http://host:11434');
  assert.equal(normalizeOllamaUrl('http://host:11434/v1'), 'http://host:11434');
  assert.equal(normalizeOllamaUrl('http://host:11434/v1/'), 'http://host:11434');
});

test('ollamaRestRoot returns the host root (stripping a stray /vN)', () => {
  assert.equal(ollamaRestRoot('http://host:11434'), 'http://host:11434');
  assert.equal(ollamaRestRoot('http://host:11434/v1'), 'http://host:11434');
  assert.equal(ollamaRestRoot(''), '');
});
