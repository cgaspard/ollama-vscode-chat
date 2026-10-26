// OpenCode 2's built-in local plugins take over a provider declared under their
// id (`lmstudio`, `ollama`, `vllm`): once they discover models they drop the
// declared ones and their variants. The panel suffixes those ids at the engine
// boundary (src/core/providerIds.ts). This shows the takeover on the raw id and
// that the mapped id survives it, against a real Ollama.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHost } from '../src/opencode/embedded';
import { OpencodeV2Client } from '../src/opencode/v2client';
import { ENGINE_PROVIDER, MODEL, PROVIDER, ollamaConfig } from './ollama';

// Ollama Code's own provider IS `ollama`: its built-in plugin discovers models
// through /api/tags, so the takeover is reliable to show. A distinctive window
// tells our declaration apart from the plugin's.
const CTX = 20480;
const DISCOVERY_WAIT_MS = 40_000; // the plugins refresh every 30s

/** The panel's real provider block, declared under `engineId`. */
async function modelAfterDiscovery(engineId: string): Promise<{ variants: string[]; context?: number }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-res-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-res-ws-'));
  execFileSync('git', ['init', '-q'], { cwd: ws });
  const base = (await ollamaConfig([MODEL], { ctx: CTX })) as { provider: Record<string, unknown> };
  const config = { enabled_providers: [engineId], provider: { [engineId]: base.provider[ENGINE_PROVIDER] } };
  const host = await createHost(path.resolve(__dirname, '..'), { root }, JSON.stringify(config));
  const client = new OpencodeV2Client(host, ws, 'live');
  try {
    await new Promise((r) => setTimeout(r, DISCOVERY_WAIT_MS));
    const providers = await client.listProviders();
    const m = providers.providers.find((x) => x.id === PROVIDER)?.models[MODEL] as any;
    return { variants: Object.keys(m?.variants ?? {}), context: m?.limit?.context };
  } finally {
    client.dispose();
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

(async () => {
  const raw = await modelAfterDiscovery(PROVIDER);
  const takenOver = raw.variants.length === 0 || raw.context !== CTX;
  console.log(`${takenOver ? 'PASS' : 'NOTE'}  raw "${PROVIDER}" id after discovery: variants [${raw.variants.join(', ')}], context ${raw.context} (the takeover this guards against)`);
  const mapped = await modelAfterDiscovery(ENGINE_PROVIDER);
  const ok = ['off', 'low', 'medium', 'high'].every((v) => mapped.variants.includes(v)) && mapped.context === CTX;
  console.log(`${ok ? 'PASS' : 'FAIL'}  mapped id "${ENGINE_PROVIDER}" keeps the declared model: variants [${mapped.variants.join(', ')}], context ${mapped.context}`);
  process.exitCode = ok ? 0 : 1;
})();
