// Agents you define: a primary agent from .opencode/agents shows up and takes
// over, /agents lists both halves, and the model can delegate to a subagent.
import * as assert from 'node:assert';
import { ask, freshChat, h, until } from './lib';

describe('e2e · agents', function () {
  it('/agents lists the workspace agents', async () => {
    await freshChat();
    await h.setInput('/agents');
    await h.keydown('Enter');
    await until(async () => /pirate/.test((await h.allText('#messages')).join(' ')), 30_000, 'the agents card');
    const text = (await h.allText('#messages')).join(' ');
    assert.match(text, /pirate/, 'the primary agent is selectable');
    assert.match(text, /reviewer/, 'the subagent is listed as delegatable');
  });

  it('a primary agent from .opencode/agents takes over the conversation', async () => {
    await freshChat({ agent: 'pirate' });
    const reply = await ask('Say hello.');
    assert.match(reply, /^\s*ARR\b/m, `the pirate prompt applied (${reply.slice(0, 80)})`);
  });

  it('the model can delegate to a subagent', async () => {
    await freshChat();
    await ask('Use the subagent tool to delegate to the "reviewer" agent: ask it to review src/app.txt. Then tell me what it said.', 600_000);
    // The delegation is a `task` card; expanded, it shows the subagent's work.
    const names = await h.allText('.msg.assistant .part-tool .tool-name');
    const task = names.lastIndexOf('task');
    assert.ok(task >= 0, `a delegation card (cards: ${names.join(', ')})`);
    assert.ok((await h.count('.msg.assistant .part-tool .tool-line.status-completed')) > 0, 'the delegation completed');
    await h.click('.msg.assistant .part-tool .tool-line', task);
    await until(async () => /reviewer|REVIEWER-DONE/i.test((await h.allText('.msg.assistant .part-tool')).join(' ')), 5000, 'the expanded card');
  });
});
