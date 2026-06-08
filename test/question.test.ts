import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAnswers, isEmptyAnswer, parseQuestionBlob } from '../src/core/question';

const valid = {
  questions: [
    {
      question: 'Which to fix first?',
      header: 'Where to start?',
      options: [
        { label: 'Race conditions', description: 'Fix the bridge races' },
        { label: 'Resource leaks', description: 'Clean up listeners' },
      ],
    },
  ],
};

test('parseQuestionBlob accepts a clean question payload', () => {
  const qs = parseQuestionBlob(JSON.stringify(valid));
  assert.ok(qs);
  assert.equal(qs!.length, 1);
  assert.equal(qs![0].question, 'Which to fix first?');
  assert.equal(qs![0].options.length, 2);
  assert.equal(qs![0].options[0].label, 'Race conditions');
});

test('parseQuestionBlob tolerates a ```json fence and surrounding prose', () => {
  const fenced = 'Sure, here you go:\n```json\n' + JSON.stringify(valid, null, 2) + '\n```';
  const qs = parseQuestionBlob(fenced);
  assert.ok(qs);
  assert.equal(qs![0].header, 'Where to start?');
});

test('parseQuestionBlob returns null for a partial (mid-stream) blob', () => {
  const partial = '{ "questions": [ { "question": "Which to f';
  assert.equal(parseQuestionBlob(partial), null);
});

test('parseQuestionBlob returns null for ordinary text and other JSON', () => {
  assert.equal(parseQuestionBlob('Here is my answer in prose.'), null);
  assert.equal(parseQuestionBlob('{"foo": 1, "bar": [2,3]}'), null);
  assert.equal(parseQuestionBlob(''), null);
});

test('parseQuestionBlob rejects a questions array with the wrong shape', () => {
  // Mentions "questions" and parses, but options/question fields are wrong.
  assert.equal(parseQuestionBlob('{"questions": []}'), null);
  assert.equal(parseQuestionBlob('{"questions": [{"question": 5, "options": []}]}'), null);
  assert.equal(
    parseQuestionBlob('{"questions": [{"question": "ok", "options": [{"x": 1}]}]}'),
    null,
  );
});

test('parseQuestionBlob rejects empty options when custom answers are disabled', () => {
  // No options AND custom:false → an unanswerable picker (only "Skip"). Reject.
  assert.equal(
    parseQuestionBlob('{"questions": [{"question": "ok", "options": [], "custom": false}]}'),
    null,
  );
});

test('parseQuestionBlob accepts empty options when a custom answer is allowed', () => {
  // No options but custom is allowed (default) → answerable via free text.
  const qs = parseQuestionBlob('{"questions": [{"question": "Name it?", "options": []}]}');
  assert.ok(qs);
  assert.equal(qs!.length, 1);
});

// --- buildAnswers: the reply wire shape (one array per question) ------------

test('buildAnswers produces one labels-array per question, in order', () => {
  const answers = buildAnswers([{ chosen: new Set(['Word counter']) }, { chosen: new Set(['Yes']) }]);
  assert.deepEqual(answers, [['Word counter'], ['Yes']]);
});

test('buildAnswers appends a trimmed custom answer and ignores blank custom', () => {
  assert.deepEqual(buildAnswers([{ chosen: new Set(['A']), custom: '  extra ' }]), [['A', 'extra']]);
  assert.deepEqual(buildAnswers([{ chosen: new Set(['A']), custom: '   ' }]), [['A']]);
  assert.deepEqual(buildAnswers([{ chosen: new Set<string>(), custom: 'only custom' }]), [['only custom']]);
});

test('buildAnswers preserves multi-select order and yields empty arrays for unanswered', () => {
  assert.deepEqual(buildAnswers([{ chosen: ['X', 'Y'] }]), [['X', 'Y']]);
  assert.deepEqual(buildAnswers([{ chosen: new Set<string>() }]), [[]]);
});

test('isEmptyAnswer is true only when nothing was chosen or typed anywhere', () => {
  assert.equal(isEmptyAnswer([[], []]), true);
  assert.equal(isEmptyAnswer([[], ['picked']]), false);
  assert.equal(isEmptyAnswer([['x']]), false);
});
