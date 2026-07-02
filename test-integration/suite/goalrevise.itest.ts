// Integration tests for the goal-revision confirm flow: while a goal is set,
// the host may post a `goalRevision` offer when a user message looks like it
// changes the goal; the webview must render a confirm card, and the goal only
// changes when "Update goal" is clicked. Host messages are injected directly so
// the tests are deterministic and need no Ollama / OpenCode.
import * as assert from 'node:assert';
import * as helpers from './helpers';

const { openPanel, post, text, count, classes, click, waitFor } = helpers;

const MODELS = [{ id: 'qwen/qwen3-27b', name: 'qwen3-27b', loaded: true, maxContextLength: 262144 }];

function init() {
  return post({
    type: 'init',
    models: MODELS,
    currentModel: 'qwen/qwen3-27b',
    agent: 'build',
    cwd: '/work',
    serverReady: true,
    ollamaConnected: true,
    minContext: 32768,
  });
}

const GOAL = {
  objective: 'create hello.txt containing "hello world"',
  iteration: 1,
  maxIterations: 25,
  startedAt: Date.now(),
  state: 'active' as const,
};

describe('goal revision confirm flow', function () {
  this.timeout(30000);

  before(async () => {
    await openPanel();
    await init();
    await post({ type: 'goal', goal: GOAL });
  });

  it('renders a confirm card with the proposed objective', async () => {
    await post({ type: 'goalRevision', proposed: 'create goodbye.txt instead' });
    await waitFor('.goal-revise-card', (n) => n === 1);
    assert.match((await text('.goal-revise-card .perm-detail')) ?? '', /goodbye\.txt/);
    assert.strictEqual(await count('.goal-revise-card .update'), 1, 'Update goal button');
    assert.strictEqual(await count('.goal-revise-card .keep'), 1, 'Keep current button');
  });

  it('a newer offer replaces the open one (at most one card)', async () => {
    await post({ type: 'goalRevision', proposed: 'create farewell.txt instead' });
    await waitFor('.goal-revise-card', (n) => n === 1);
    assert.match((await text('.goal-revise-card .perm-detail')) ?? '', /farewell\.txt/);
  });

  it('clicking Update resolves the card and reports the update', async () => {
    assert.ok(await click('.goal-revise-card .update'));
    const cls = (await classes('.goal-revise-card'))[0] ?? '';
    assert.ok(cls.includes('resolved'), 'card should be resolved after Update');
    assert.match((await text('.goal-revise-card .perm-resolved')) ?? '', /Goal updated/);
    // The host confirms with a goalEvent(updated) — the webview adds a chip.
    await post({ type: 'goalEvent', kind: 'updated', reason: 'create farewell.txt instead' });
    await waitFor('.sys-chip', (n) => n >= 1);
    const chips = await count('.sys-chip');
    assert.ok(chips >= 1, 'goal-updated chip should render');
  });

  it('clicking Keep leaves the goal alone', async () => {
    await post({ type: 'goalRevision', proposed: 'do something else entirely' });
    await waitFor('.goal-revise-card:not(.resolved)', (n) => n === 1);
    assert.ok(await click('.goal-revise-card:not(.resolved) .keep'));
    assert.strictEqual(await count('.goal-revise-card:not(.resolved)'), 0, 'no unresolved cards left');
  });

  it('clearing the goal retires an open offer', async () => {
    await post({ type: 'goalRevision', proposed: 'one more revision' });
    await waitFor('.goal-revise-card:not(.resolved)', (n) => n === 1);
    await post({ type: 'goal', goal: null });
    await waitFor('.goal-revise-card:not(.resolved)', (n) => n === 0);
    // The last card shows why it was retired.
    const notes = await count('.goal-revise-card .perm-resolved');
    assert.ok(notes >= 1, 'retired card keeps an explanatory note');
  });
});
