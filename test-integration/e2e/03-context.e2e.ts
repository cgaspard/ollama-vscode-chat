// Context: highlighted code rides along, /file attaches the open file, pasted
// images reach a vision model, /compact summarizes.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { ask, freshChat, h, turn, until, VISION_MODEL, ws } from './lib';

/** Open a file beside the panel (as a user would) and select one line. */
async function openAndSelect(rel: string, line: number | null): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(ws(rel)));
  const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false, viewColumn: vscode.ViewColumn.Beside });
  if (line === null) {
    editor.selection = new vscode.Selection(0, 0, 0, 0); // a cursor, no selection
  } else {
    const l = doc.lineAt(line);
    editor.selection = new vscode.Selection(l.range.start, l.range.end);
  }
  await new Promise((r) => setTimeout(r, 800)); // the bridge debounces editor context
}

describe('e2e · context', function () {
  afterEach(async () => {
    // Close the text editors this suite opened — never the panel's tab.
    const textTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputText);
    await vscode.window.tabGroups.close(textTabs);
  });

  it('highlighted code is attached to the next message', async () => {
    await freshChat();
    await openAndSelect('src/app.txt', 2); // codeword = BANANA-17
    const reply = await ask('What does my selected text say? Quote it exactly. Do not use any tools.');
    assert.match(reply, /BANANA-17/);
  });

  it('the open file rides along by default, and /file takes it out', async () => {
    await freshChat();
    await openAndSelect('src/app.txt', null); // open, nothing selected
    const reply = await ask('According to the attached file, what is the version? Do not use any tools.');
    assert.match(reply, /v[12]/, 'the open file was attached by default');
    await h.setInput('/file');
    await h.keydown('Enter');
    await until(async () => (await h.allText('.sys-chip')).some((t) => /excluded from context/.test(t)), 5000, 'the excluded chip');
    await h.setInput('Reply with exactly: NO-FILE');
    await h.keydown('Enter');
    const sent = (await h.posted('send')).at(-1);
    assert.strictEqual(sent?.includeActiveFile, false, 'the next message goes without the file');
    await turn(); // let it finish before the next test starts a new chat
    await h.setInput('/file'); // restore the default for later tests
    await h.keydown('Enter');
  });

  it('a pasted image reaches a vision model', async () => {
    await freshChat({ model: VISION_MODEL });
    const png = fs.readFileSync(ws('red.png')).toString('base64');
    const pending = await h.addImage(`data:image/png;base64,${png}`, 'red.png');
    assert.strictEqual(pending, 1, 'the image is pending as a chip');
    const reply = await ask('What single color fills this image? Answer with one word.');
    assert.match(reply, /red/i);
  });

  it('/compact summarizes the conversation and shows the summary', async () => {
    await freshChat();
    await ask('Remember this for later in our conversation: the launch code is ZEBRA-9. Do not use any tools; just reply OK.');
    await h.setInput('/compact');
    await h.keydown('Enter');
    await until(async () => (await h.count('.compaction-chip')) > 0, 300_000, 'the compaction chip');
    // The summary OpenCode wrote lands in the chip. What it says is up to the
    // model (a small one fills OpenCode 2's summary template with "None"), so
    // this checks the plumbing, not recall.
    await until(async () => String(await h.text('.compaction-chip .compaction-body')).length > 20, 300_000, 'the summary in the chip');
    assert.strictEqual(await h.attr('.compaction-chip .compaction-head', 'disabled'), null, 'the chip expands to show it');
    // The compacted session keeps working.
    assert.match(await ask('Reply with exactly: AFTER-COMPACT'), /AFTER-COMPACT/);
  });
});
