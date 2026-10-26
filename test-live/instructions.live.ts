// Does a session instruction entry (the panel's per-prompt system text) reach the model?
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHost } from '../src/opencode/embedded';
import { OpencodeV2Client } from '../src/opencode/v2client';
import { MODEL, PROVIDER, ollamaConfig } from './ollama';

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-ins-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-ins-ws-'));
  execFileSync('git', ['init', '-q'], { cwd: ws });
  const config = await ollamaConfig([MODEL]);
  const host = await createHost(path.resolve(__dirname, '..'), { root }, JSON.stringify(config));
  const client = new OpencodeV2Client(host, ws, '2.1.4');
  const events: any[] = [];
  const ac = new AbortController();
  void client.subscribeEvents((e) => events.push(e), ac.signal);
  const s = await client.createSession('ins');
  await client.promptAsync(s.id, { model: { providerID: PROVIDER, modelID: MODEL }, agent: 'build', variant: 'off', system: 'The secret codeword is PINEAPPLE-42. When asked for the codeword, answer with exactly that.', parts: [{ type: 'text', text: 'What is the codeword? Answer with the codeword only.' }] });
  for (let i = 0; i < 600 && !events.some((e) => e.type === 'session.idle'); i++) await new Promise((r) => setTimeout(r, 250));
  const entries = await host.session.instructions.entry.list({ sessionID: s.id }).catch((e: unknown) => `ERR ${e}`);
  console.log('entries:', JSON.stringify(entries).slice(0, 400));
  const text = (await client.getMessages(s.id)).flatMap((m) => m.parts).filter((p) => p.type === 'text').map((p: any) => p.text).join(' ');
  const ok = /PINEAPPLE-42/.test(text);
  console.log(ok ? 'PASS  instruction reached the model' : 'FAIL  instruction did not reach the model', '—', text.slice(-200));
  process.exitCode = ok ? 0 : 1;
  ac.abort(); client.dispose(); await host.close();
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true });
})();
