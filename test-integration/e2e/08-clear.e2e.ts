// Runs last: /clear deletes every conversation in this workspace.
import * as assert from 'node:assert';
import { ask, freshChat, h, setEffort, MODEL, until } from './lib';

describe('e2e · clear all', function () {
  it('/clear deletes every conversation and starts fresh', async () => {
    await freshChat({ model: MODEL });
    await setEffort('off');
    await ask('Reply with exactly: BEFORE-CLEAR');
    await h.click('#ta-history');
    await until(async () => (await h.count('.history-row')) > 1, 15_000, 'a populated history');
    await h.click('#history-close');
    await h.setInput('/clear');
    await h.keydown('Enter');
    await until(async () => (await h.count('.msg')) === 0, 30_000, 'the conversation to clear');
    await h.click('#ta-history');
    await until(async () => (await h.count('.history-row')) <= 1, 30_000, 'the history to empty');
    const titles = await h.allText('.history-row .history-title');
    assert.ok(!titles.some((t) => /BEFORE-CLEAR|Reply with exactly/i.test(t)), `nothing old is left (${titles.join(' | ')})`);
    await h.click('#history-close');
  });
});
