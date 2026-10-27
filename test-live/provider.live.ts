// Live proof that the bundled Ollama provider works under the embedded
// OpenCode 2 engine, against a real Ollama: prompts stream through it, tools
// run, the configured context window reaches Ollama (`num_ctx`, checked with
// GET /api/ps), reasoning switches on and off (`think`), and images reach a
// vision model. Not part of `npm test`: needs opencode-sdk/ and
// opencode-provider/ built and Ollama up.
//
//   npm run test:live -- provider
//
// Env: LIVE_OLLAMA (default http://127.0.0.1:11434), LIVE_MODEL (default
// qwen3-vl:4b-instruct: tools and vision in one small model), and
// LIVE_TOOL_MODEL / LIVE_VISION_MODEL (default LIVE_MODEL), LIVE_THINKING_MODEL
// (default qwen3:0.6b).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { toEngineProviderID } from '../src/core/providerIds';
import { OllamaClient } from '../src/ollama/client';
import { createHost } from '../src/opencode/embedded';
import { OLLAMA_PROVIDER_ID, ollamaProviderConfig, providerModuleUrl } from '../src/opencode/ollamaProvider';
import type { OpencodeEvent } from '../src/opencode/protocol';
import { OpencodeV2Client } from '../src/opencode/v2client';

const REPO = path.resolve(__dirname, '..');
const OLLAMA = process.env.LIVE_OLLAMA ?? 'http://127.0.0.1:11434';
const MODEL = process.env.LIVE_MODEL ?? 'qwen3-vl:4b-instruct';
const TOOL_MODEL = process.env.LIVE_TOOL_MODEL ?? MODEL;
const VISION = process.env.LIVE_VISION_MODEL ?? MODEL;
// The default model does not think, so thinking on/off is shown on the
// smallest thinking model (it honours `think: false`).
const THINK = process.env.LIVE_THINKING_MODEL ?? 'qwen3:0.6b';
// Deliberately odd windows, so a match cannot be Ollama's default by accident.
const CTX = 24576;
// Both clear the engine's own prompt and tools (~11k tokens), or it compacts
// before the first request.
const VISION_CTX = 28672;
// A 64x64 solid red PNG (the same image as the e2e workspace's red.png).
const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PQQkAMAzAwIqof2UTMxF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFj12qxUDxeFqrFAAAAABJRU5ErkJggg==';

const results: boolean[] = [];
function check(name: string, ok: boolean, detail: unknown = ''): void {
  results.push(ok);
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d ? `  — ${d.slice(0, 240)}` : ''}`);
}

/** A pass-through proxy in front of Ollama that records every /api/chat body. */
function startRecorder(target: string): Promise<{ url: string; chats: any[]; close(): void }> {
  const chats: any[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      if (req.url?.startsWith('/api/chat')) {
        try {
          chats.push(JSON.parse(body.toString('utf8')));
        } catch {
          chats.push({ unparsable: true });
        }
      }
      try {
        const up = await fetch(target + req.url, {
          method: req.method,
          headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
        });
        res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
        if (up.body) {
          for await (const chunk of up.body as any) {
            res.write(chunk);
          }
        }
        res.end();
      } catch (err) {
        res.writeHead(502);
        res.end(String(err));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, chats, close: () => server.close() });
    });
  });
}

async function loadedContext(model: string): Promise<number | undefined> {
  const ps = (await (await fetch(`${OLLAMA}/api/ps`)).json()) as { models?: any[] };
  return ps.models?.find((m) => m.name === model || m.model === model)?.context_length;
}

async function main(): Promise<void> {
  const npm = providerModuleUrl(REPO);
  if (!npm) {
    throw new Error('opencode-provider/ollama.mjs is missing: run npm run bundle:provider');
  }
  const recorder = await startRecorder(OLLAMA);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-ollama-live-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-ollama-ws-'));
  execFileSync('git', ['init', '-q'], { cwd: ws });
  fs.writeFileSync(path.join(ws, 'secret.txt'), 'The vault code is MANGO-7781.\n');

  // The model facts the extension itself would use (capabilities from /api/show).
  const discovered = await new OllamaClient(OLLAMA).listModels();
  const wanted = [...new Set([MODEL, TOOL_MODEL, VISION, THINK])];
  const models = discovered.filter((m) => wanted.includes(m.id));
  check('the test models are installed', models.length === wanted.length, discovered.map((m) => m.id));
  const engineID = toEngineProviderID(OLLAMA_PROVIDER_ID);
  const config = {
    permission: { question: 'allow', external_directory: 'allow', read: 'allow' },
    enabled_providers: [engineID],
    provider: ollamaProviderConfig({
      baseUrl: recorder.url,
      npm,
      models,
      defaultCtx: CTX,
      // A per-model window, when the vision model is a model of its own.
      ctxOverride: (id) => (id === VISION && VISION !== MODEL ? VISION_CTX : undefined),
    }),
  };

  const host = await createHost(REPO, { root }, JSON.stringify(config));
  const client = new OpencodeV2Client(host, ws, '2.1.4');
  const events: OpencodeEvent[] = [];
  const ac = new AbortController();
  void client.subscribeEvents((e) => events.push(e), ac.signal);
  const waitFor = async (pred: (e: OpencodeEvent) => boolean, ms: number, from = 0) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = events.slice(from).find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 200));
    }
    return undefined;
  };
  const sid = (e: OpencodeEvent) => (e.properties as any).sessionID;
  const turn = async (sessionID: string, body: Parameters<OpencodeV2Client['promptAsync']>[1], ms = 300000) => {
    const mark = events.length;
    const chatMark = recorder.chats.length;
    await client.promptAsync(sessionID, body);
    const done = await waitFor((e) => (e.type === 'session.idle' || e.type === 'session.error') && sid(e) === sessionID, ms, mark);
    const msgs = await client.getMessages(sessionID);
    const last = msgs.filter((m) => m.info.role === 'assistant').slice(-1)[0];
    const parts = (last?.parts ?? []) as any[];
    return {
      done,
      error: events.slice(mark).find((e) => e.type === 'session.error' && sid(e) === sessionID),
      text: parts.filter((p) => p.type === 'text').map((p) => p.text).join(''),
      reasoning: parts.filter((p) => p.type === 'reasoning').map((p) => p.text).join(''),
      parts,
      msgs,
      chats: recorder.chats.slice(chatMark),
      deltas: events.slice(mark).filter((e) => e.type === 'message.part.delta' && sid(e) === sessionID).length,
    };
  };
  const provider = { providerID: OLLAMA_PROVIDER_ID };

  try {
    const providers = await client.listProviders();
    const mine = providers.providers.find((p) => p.id === OLLAMA_PROVIDER_ID);
    check('engine lists the panel provider under the panel id', !!mine && wanted.every((id) => !!mine.models[id]), providers.providers.map((p) => `${p.id}:${Object.keys(p.models).length}`));
    check('the built-in ollama plugin is not in play', providers.providers.every((p) => p.id === OLLAMA_PROVIDER_ID || p.id === 'opencode'), providers.providers.map((p) => p.id));

    // (1) streaming + (3) num_ctx + (4) think off
    const s = await client.createSession('ollama live');
    const off = await turn(s.id, {
      model: { ...provider, modelID: MODEL },
      agent: 'build',
      variant: 'off',
      parts: [{ type: 'text', text: 'Reply with exactly the word PONG and nothing else.' }],
    });
    check('prompt answered through the bundled provider', !!off.done && !off.error && /PONG/i.test(off.text), off.error?.properties ?? off.text);
    check('the answer streamed (part deltas)', off.deltas > 0, off.deltas);
    const offChat = off.chats.slice(-1)[0] ?? {};
    check('requests go to the native /api/chat endpoint', off.chats.length > 0, off.chats.length);
    check(`num_ctx ${CTX} is on the wire`, offChat.options?.num_ctx === CTX, offChat.options);
    check(`Ollama loaded ${MODEL} at ${CTX} (GET /api/ps)`, (await loadedContext(MODEL)) === CTX, await loadedContext(MODEL));
    check(`${MODEL}: variant off sends think:false`, offChat.think === false, offChat.think);

    // (4) think off / on, on a model that honours think:false
    const th = await client.createSession('ollama thinking');
    const thOff = await turn(th.id, {
      model: { ...provider, modelID: THINK },
      agent: 'build',
      variant: 'off',
      parts: [{ type: 'text', text: 'What is 6 + 7? Answer with just the number.' }],
    });
    check(`${THINK}: variant off sends think:false`, (thOff.chats.slice(-1)[0] ?? {}).think === false);
    check('variant off: no reasoning generated', !thOff.reasoning && /13/.test(thOff.text), { reasoning: thOff.reasoning.slice(0, 60), text: thOff.text.slice(0, 60) });
    const on = await turn(th.id, {
      model: { ...provider, modelID: THINK },
      agent: 'build',
      variant: 'high',
      parts: [{ type: 'text', text: 'What is 17 + 25? Answer with just the number.' }],
    });
    const onChat = on.chats.slice(-1)[0] ?? {};
    check('variant high sends think', onChat.think === 'high' || onChat.think === true, onChat.think);
    check('variant high keeps num_ctx (model + variant options merge)', onChat.options?.num_ctx === CTX, onChat.options);
    check('variant high: reasoning streamed back as a reasoning part', on.reasoning.length > 20, on.reasoning.slice(0, 80));
    check('variant high: answer still arrives', /42/.test(on.text), on.text.slice(0, 120));

    // (2) tool calls
    const t = await client.createSession('ollama tools');
    const tool = await turn(t.id, {
      model: { ...provider, modelID: TOOL_MODEL },
      agent: 'build',
      variant: 'off',
      parts: [{ type: 'text', text: `Use the read tool to read the file ${path.join(ws, 'secret.txt')} and tell me the vault code.` }],
    });
    const toolParts = tool.msgs.flatMap((m) => m.parts as any[]).filter((p) => p.type === 'tool');
    const read = toolParts.find((p) => p.tool === 'read');
    check('the model called the read tool', !!read, toolParts.map((p) => `${p.tool}:${p.state?.status}`));
    check('the tool completed', read?.state?.status === 'completed', read?.state);
    check('the tool result fed the answer', /MANGO-7781/.test(tool.text), tool.text.slice(0, 160));
    check('tool definitions went out on /api/chat', tool.chats.some((c) => Array.isArray(c.tools) && c.tools.length > 0), tool.chats.map((c) => c.tools?.length));

    // (5) images reach a vision model, at its own window
    const v = await client.createSession('ollama vision');
    const vision = await turn(v.id, {
      model: { ...provider, modelID: VISION },
      agent: 'build',
      variant: 'off',
      parts: [
        { type: 'text', text: 'What single colour fills this image? Answer with one word.' },
        { type: 'file', mime: 'image/png', url: `data:image/png;base64,${RED_PNG}`, filename: 'red.png' } as any,
      ],
    });
    check('one request, no compaction', vision.chats.length === 1, vision.chats.length);
    const vChat = vision.chats.slice(-1)[0] ?? {};
    const images = (vChat.messages ?? []).flatMap((m: any) => m.images ?? []);
    if (process.env.LIVE_DEBUG) console.log(JSON.stringify(vChat.messages?.slice(-1), (k, v) => (typeof v === 'string' && v.length > 300 ? v.slice(0, 300) : v)), vision.text, JSON.stringify(vision.msgs.find((m) => m.info.role === 'user')?.parts).slice(0, 600));
    check('the image went out on /api/chat', images.length === 1, images.map((i: string) => i.slice(0, 16)));
    check('the vision model saw red', /red/i.test(vision.text), vision.text.slice(0, 120));
    const want = VISION !== MODEL ? VISION_CTX : CTX;
    check(`${VISION} runs at ${want}`, vChat.options?.num_ctx === want && (await loadedContext(VISION)) === want, { wire: vChat.options, ps: await loadedContext(VISION) });
  } catch (err) {
    check('unexpected exception', false, String((err as Error)?.stack ?? err));
  } finally {
    ac.abort();
    client.dispose();
    await host.close();
    recorder.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}

void main();
