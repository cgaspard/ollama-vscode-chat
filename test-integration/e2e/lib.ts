// Shared steps for the e2e suite: connect the panel to a real Ollama, pick and
// load models through the model menu, start fresh chats, type and send, and
// read what came back — plus what Ollama itself reports (GET /api/ps).
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as h from '../suite/helpers';

export const OLLAMA = process.env.E2E_OLLAMA ?? 'http://127.0.0.1:11434';
/**
 * One small model for the run — Ollama is shared hardware, and a single
 * resident model keeps the suite from evicting other work. qwen3-vl:2b has
 * tools and vision, so it covers every feature but one.
 */
export const MODEL = process.env.E2E_MODEL ?? 'qwen3-vl:2b';
export const VISION_MODEL = process.env.E2E_VISION_MODEL ?? MODEL;
/**
 * The thinking on/off tests need a model that honours `think: false`:
 * qwen3-vl:2b keeps streaming thinking with it off (Ollama 0.40.11), so those
 * two tests use the smallest thinking model instead.
 */
export const THINKING_MODEL = process.env.E2E_THINKING_MODEL ?? 'qwen3:0.6b';
/**
 * The window the suite configures (ollamaCode.minContextLength). Deliberately
 * not a picker preset or anyone's default, so seeing it in /api/ps can only
 * mean the extension's setting reached Ollama.
 */
export const CTX = 24576;
export const WORKSPACE = process.env.E2E_WORKSPACE ?? '';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const cfg = () => vscode.workspace.getConfiguration('ollamaCode');
export const ws = (...p: string[]) => path.join(WORKSPACE, ...p);
export const read = (...p: string[]) => fs.readFileSync(ws(...p), 'utf8');

export async function until(pred: () => Promise<boolean> | boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

/** What Ollama reports for a loaded model (GET /api/ps), or undefined when it is not loaded. */
export async function ps(model: string): Promise<{ context_length?: number; expires_at?: string } | undefined> {
  const res = (await (await fetch(`${OLLAMA}/api/ps`)).json()) as { models?: any[] };
  return res.models?.find((m) => m.name === model || m.model === model);
}

/** Point the extension at Ollama and open a ready panel. Once per run. */
let connected = false;
export async function connect(): Promise<void> {
  if (connected) {
    return;
  }
  assert(WORKSPACE, 'E2E_WORKSPACE is not set — run via npm run test:e2e');
  // autoEnsureContext stays on (the default): the panel loads a model at the
  // configured window before prompting, which is part of what is under test.
  await cfg().update('defaultModel', MODEL, vscode.ConfigurationTarget.Global);
  await cfg().update('minContextLength', CTX, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('ollamaCode._test.useServer', OLLAMA);
  await h.openPanel();
  await until(async () => (await h.text('#model-btn .model-btn-label')) !== 'Model', 120_000, 'the model chip');
  connected = true;
}

/** Open the model menu (idempotent) and wait for its model list (or, with `servers`, its server list). */
export async function openModelMenu(opts: { servers?: boolean } = {}): Promise<void> {
  if ((await h.count('#model-menu:not(.hidden)')) === 0) {
    await h.click('#model-btn');
  }
  const rows = opts.servers ? '#server-menu-list .model-row' : '#model-menu-list .model-row';
  await until(async () => (await h.count(rows)) > 0, 30_000, opts.servers ? 'the server list' : 'the model list');
}

export async function closeMenus(): Promise<void> {
  if ((await h.count('#model-menu:not(.hidden)')) > 0) {
    await h.click('#model-btn');
  }
}

/** Index of `model`'s row in the model menu. */
async function modelRow(model: string): Promise<number> {
  await openModelMenu();
  const names = await h.allText('#model-menu-list .model-row .model-name');
  const i = names.findIndex((n) => n === model);
  assert(i >= 0, `${model} is in the model menu (${names.join(', ')})`);
  return i;
}

/**
 * Make `model` the panel's model the way a user does — click its row in the
 * model menu — and, when Ollama does not have it loaded, press its Load
 * button and wait until the composer is ready to send.
 */
export async function useModel(model: string): Promise<void> {
  const i = await modelRow(model);
  await h.click('#model-menu-list .model-row', i); // selects and closes the menu
  await sleep(300);
  if ((await h.count('.send-btn.cta')) > 0) {
    const j = await modelRow(model);
    const row = `#model-menu-list .model-row:nth-child(${j + 1})`;
    if ((await h.count(`${row} [data-act="load"]`)) > 0) {
      await h.click(`${row} [data-act="load"]`);
    }
    await until(async () => (await h.count('.send-btn.cta')) === 0, 600_000, `${model} to load`);
  }
  await closeMenus();
}

/** Pick a Thinking level in the behavior menu (auto | off | low | medium | high). */
export async function setEffort(level: string): Promise<void> {
  await h.click('#behavior-btn');
  await until(async () => (await h.count('#behavior-menu:not(.hidden)')) > 0, 5000, 'the behavior menu');
  assert(await h.click(`#effort-presets .effort-dot[data-level="${level}"]`), `the ${level} thinking level is offered`);
  await h.click('#behavior-btn');
}

/** A clean conversation on `model` (default MODEL) with `agent` (default build). */
export async function freshChat(opts: { model?: string; agent?: string } = {}): Promise<void> {
  await connect();
  // The panel's own New chat button (the command targets the sidebar view,
  // not this editor-tab panel; /clear deletes every session).
  // A failed test must not strand the rest of the run: drop a goal it left
  // running and stop a turn that will not end on its own.
  if (!/hidden/.test(String(await h.attr('#goal-bar', 'class')))) {
    await h.setInput('/goal clear');
    await h.keydown('Enter');
    await sleep(500);
  }
  const settled = await until(async () => !(await busy()), 60_000, 'the previous turn to settle').then(
    () => true,
    () => false,
  );
  if (!settled) {
    await h.click('#send'); // the send button is the stop button while busy
    await until(async () => !(await busy()), 30_000, 'the stuck turn to stop');
  }
  await h.click('#ta-new');
  await until(async () => (await h.count('.msg')) === 0, 15_000, 'the conversation to clear');
  await useModel(opts.model ?? MODEL);
  await h.postToHost({ type: 'selectAgent', agent: opts.agent ?? 'build' });
  await sleep(300);
}

export async function busy(): Promise<boolean> {
  return /\bbusy\b/.test(String(await h.attr('#send', 'class')));
}

/** Type `text` into the composer and press Enter (Alt+Enter with `queue`). */
export async function send(text: string, opts: { queue?: boolean } = {}): Promise<void> {
  await h.setInput(text);
  await h.keydown('Enter', { altKey: !!opts.queue });
}

/** Wait for the panel to start and then finish a turn. */
export async function turn(ms = 240_000): Promise<void> {
  await until(busy, 30_000, 'the turn to start').catch(() => undefined); // a fast turn may already be over
  await until(async () => !(await busy()), ms, 'the turn to end');
}

/** Send and wait for the reply. */
export async function ask(text: string, ms = 240_000): Promise<string> {
  const before = await assistantText();
  await send(text);
  await turn(ms);
  const reply = (await assistantText()).slice(before.length);
  if (!reply.trim()) {
    console.log(`      [diag] empty reply to: ${text.slice(0, 60)}\n${await panelState()}`);
  }
  return reply;
}

/** What the panel shows right now, for failure diagnostics. */
export async function panelState(): Promise<string> {
  const lines = [
    `activity: ${await h.text('#activity .activity-label')}`,
    `model chip: ${await h.text('#model-btn .model-btn-label')}`,
    `send: ${await h.attr('#send', 'class')}`,
    `input: ${await h.attr('#input', 'value')} (disabled=${await h.attr('#input', 'disabled')})`,
    `messages: ${(await h.allText('.msg')).map((t) => t.slice(0, 120)).join(' || ')}`,
    `chips: ${(await h.allText('.sys-chip, .error-bubble')).join(' || ')}`,
    `waiting on: ${(await h.allText('.perm-card:not(.resolved) .perm-head, .question-card:not(.resolved)')).map((t) => t.slice(0, 120)).join(' || ')}`,
    `banner: ${await h.text('#conn-banner')}`,
  ];
  return lines.map((l) => `        ${l}`).join('\n');
}

export async function assistantText(): Promise<string> {
  return (await h.allText('.msg.assistant .part-text')).join('\n');
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    throw new Error(message);
  }
}

export { h };
