import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILD_PROMPT, PLAN_PROMPT } from '../src/opencode/prompts';

// Identity override: both agents must claim "Ollama Code", never "opencode" —
// otherwise local models introduce themselves as opencode (the whole reason we
// replace the default agent prompt).
test('both prompts assert the Ollama Code identity and disclaim opencode', () => {
  for (const p of [BUILD_PROMPT, PLAN_PROMPT]) {
    assert.match(p, /Ollama Code/);
    assert.match(p, /never refer to yourself as "opencode"/i);
  }
});

// Regression guard for the question-tool follow-through fix: verified models
// (e.g. qwen3) would call the question tool, get the answer, then re-ask in
// prose instead of acting. The build prompt must keep steering against that.
test('BUILD_PROMPT instructs the model to act on a question answer, not re-ask', () => {
  // Collapse whitespace so the assertions are robust to prompt line-wrapping.
  const flat = BUILD_PROMPT.replace(/\s+/g, ' ');
  assert.match(flat, /question tool/i);
  assert.match(flat, /act on that answer/i);
  assert.match(flat, /do not re-ask/i);
});

// PLAN mode must stay read-only.
test('PLAN_PROMPT keeps the agent read-only', () => {
  assert.match(PLAN_PROMPT, /do NOT modify files/i);
});
