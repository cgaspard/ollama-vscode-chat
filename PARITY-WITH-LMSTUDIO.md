# LM Studio Code ⇄ Ollama Code — Definitive Parity Report & Port Plan

**Baselines as of this report (re-verified at write time):**
LM (lead) `fc9afae` = `v0.15.0`, working tree **clean**, OpenCode pin **1.18.4**, 23 unit files / 230 tests green.
OL (port) `d782a45` = `v0.12.0` + **6 dirty files**, OpenCode pin **1.17.18**, 20 unit files / 218 tests green.

Three surveys' claims were independently verified against both trees, the port's own bundled OpenCode binary, and a live Ollama 0.32.4. Where a survey conflicted with verification, verification wins and is used below. Anything still unproven is marked **[UNVERIFIED]**.

---

## 1. Executive summary

The two repos are **two releases and 4 days apart**, and the gap is narrow but sharply concentrated: OL is missing exactly four `src/core/` modules (`effort.ts`, `agents.ts`, `genrate.ts`, `servers.ts`) and the UI/host/protocol plumbing that hangs off them, plus the LM 0.12.0 API-key feature that was never ported at all. Everything else — 13 of 18 shared core modules byte-identical, identical CI/release workflows, identical esbuild/fetch scripts, identical command contributions, byte-identical devDependencies — is already at parity or is a *correct* platform divergence. Critically, **OL is ahead of LM in eleven places** (request timeouts, SSE backoff + CRLF normalization, `crypto` CSP nonce, `pickModel` loaded-beats-stale priority, lazy assistant bubbles, `toolCollapsed` cleanup, load/eject flow, send-button CTA, per-model `num_ctx`, stricter `compile` script, `minContextLength` schema), so a whole-file copy of `main.ts`/`styles.css`/`models.ts` would silently regress six real fixes that no test would catch. Separately, OL carries **one live bug the lead already fixed and whose fix is already sitting unused in OL's own tree**: `src/core/reconnect.ts` (`SelfHealer`) is byte-identical to the lead with passing tests, but zero `src/` files import it, `OpencodeServerManager.isRunning` has **zero call sites in the entire OL source**, and nothing subscribes to `addExitListener` — so if the OpenCode process dies while Ollama stays reachable, the panel reports `connected: true` forever with a dead client.

**The one decision only you can make:** how to derive reasoning-effort *granularity* on Ollama. LM Studio hands you `capabilities.reasoning.allowed_options`; Ollama has no equivalent. Verified substitute: a model is granular **iff its `/api/show` template references `.ThinkLevel`** (`gpt-oss:20b` yes; `qwen3:0.6b`, `deepseek-r1:8b` no — and `qwen3:0.6b` was confirmed byte-identical across low/medium/high/max at temp 0, so binary is the *correct* answer for it, not a limitation). Accepting the template sniff buys a real Low/Med/High/Max slider on gpt-oss-class models; rejecting it means an honest Auto/Off/On tri-state everywhere. Either is shippable. What is **not** optional is inverting `levelsForModel`'s safety rule: LM's "unknown ⇒ offer everything, sending is a harmless no-op" is **false on Ollama** — a non-`none` effort sent to a non-thinking model is a hard 400 that fails the turn.

---

## 2. The in-flight work in the Ollama repo — read before touching anything

`git status --short` on `ollama-vscode-chat`, exactly six entries:

| File | Δ | Content |
|---|---|---|
| `README.md` | M, 1 line | "register, switch, **edit**, and remove Ollama servers" |
| `media/styles.css` | M +28 | `.model-action.server-edit`, `.server-edit-form/-label/-actions` at `:1396-1423` |
| `src/panel/bridge.ts` | M +10/−4 | `updateServer` → reconnect only when the URL changed (`:455-470`) |
| `src/webview/main.ts` | M +72 | `#server-edit-overlay` (`:302-322`), `openServerEdit/closeServerEdit/saveServerEdit` (`:1712-1739`), `.server-edit` pencil (`:1688`), `value` prop in the test hook (`:3127-3132`) |
| `test-integration/suite/loadflow.itest.ts` | M, 8 lines | replaces a `click('#model-btn')` + `waitFor('.model-row')` with pure injection |
| `test-integration/suite/serveredit.itest.ts` | **?? new** | 7 tests |

**What it is:** a back-port of the *Edit-server dialog* half of LM 0.12.0 — deliberately **without** the API-key half (`grep -rn 'apiKey\|SecretStorage' ollama-vscode-chat/src` → **0 hits**).

**How it constrains the plan:**

1. **It converges, it does not conflict.** OL's new `updateServer` is a faithful subset of LM's committed `src/panel/bridge.ts:473-491`, minus the `resolveApiKeyEdit(msg.apiKey).kind !== 'keep'` clause in `connectionChanged`. Land it as-is.
2. **Do not re-port the overlay.** LM's committed version is a *superset* (adds `#server-add-key`, `#server-edit-key`, `#server-edit-remove-key`, `.server-key-badge`). If API keys are ever wanted, layer the key fields onto OL's overlay — do not replace it.
3. **The API-key port (item C-4 below) collides head-on** and must be sequenced *after* this merges: it lands in the same `updateServer` handler and changes the exact `updateServer` message signature (`apiKey?: string | null` tri-state) being edited right now.
4. **Everything else is clear.** The branch touches zero config/packaging/CI/release files, and in `main.ts` it touches only `~302`, `~576`, `~1688-1740`, `~3130` — not the composer (`~257`, `~497`, `~1084-1100`), not the context meter (`~1880`), not the gen-stat (`~2174`, `~2574-2615`). Effort, agents, genrate and `humanizeError` are all non-colliding.
5. **Treat `media/styles.css` and `src/webview/main.ts` as owned by this branch until it lands.**
6. **The `loadflow.itest.ts` hunk is a symptom, not a fix.** Its new comment ("waiting on rows left over from the previous test raced the host's own refresh, which lands whenever the picker has been opened") describes *verbatim* the race LM solved structurally with the `zz-` ordering convention. The workaround is fine to ship; see B-9 for the durable fix.

---

## 3. Divergence inventory

Verdicts: **PORT** (LM→OL) · **PORT-adapted** (needs rework, not a copy) · **BACKPORT** (OL→LM, flag to the lead) · **PLATFORM** (intentional, leave alone) · **PARITY** (already there) · **IN-FLIGHT**.
Effort S/M/L · Risk Low/Med/High.

### 3.1 Core modules (`src/core/`)

Inventory: LM-only `agents.ts` `effort.ts` `genrate.ts` `servers.ts`; OL-only `keepAlive.ts`; **18 shared**.

| # | Item | LM | Ollama | Verdict | Eff | Risk |
|---|---|---|---|---|---|---|
| C1 | Reasoning effort | `src/core/effort.ts`, **190 lines, 11 exports** | absent; qwen-only `/no_think` text suffix at `src/panel/bridge.ts:1858` (send) and `:1062` (judge); `thinking: boolean` at `src/shared.ts:158` | **PORT-adapted** (§5) | M | **High** |
| C2 | Generation-rate accounting | `src/core/genrate.ts`, 221 lines, pure, 11 tests | absent; ad-hoc `currentGenRate()` at **`src/webview/main.ts:2174-2184`** — `chars/4`, wall-clock from first token ⇒ tool time counted as generation | **PORT** near-verbatim | S | Low |
| C3 | User-defined agents | `src/core/agents.ts`, 140 lines; `PROMPT_TOKENS = {build:5400, plan:1600}` (`:84-87`), `DEFAULT_PROMPT_TOKENS=2000` (`:90`), ~32 tok/delegatable-agent | absent; only a stray `agentsWarned` flag at `src/panel/bridge.ts:103` | **PORT** verbatim + recalibrate constants | M | Low |
| C4 | API-key tri-state | `src/core/servers.ts` 33 lines — `resolveApiKeyEdit` `:18`, `normalizeNewApiKey` `:29` + SecretStorage | absent entirely; `src/connection.ts` is `{id,name,url}` | **PORT** (defer) | S | **Med — collides with in-flight** |
| C5 | Keep-alive | absent | `src/core/keepAlive.ts` — `MIN_KEEP_ALIVE_SECONDS=300` `:9`, `parseKeepAliveSeconds` `:12`, `clampKeepAlive` `:44` | **PLATFORM** | — | — |
| C6 | `models.ts` `pickModel` priority | `src/core/models.ts:17-28` — first-existing-preference → loaded → first | `:24-48` — explicit default → **loaded** → next preference → first; bug documented inline in `test/models.test.ts:21` | **BACKPORT** — LM plausibly opens to a CTA while a loaded model sits ignored | S | Low |
| C7 | `models.ts` load-state block | absent | `mergeModelLoadedState` `:130`, `isModelReady` `:142`, `formatLoadElapsed` `:158` — driven by `/api/ps` unreliability | **PLATFORM** | — | — |
| C8 | `models.ts` `formatModelDate` + `modelIdentity` date slot | absent; `modelIdentity` `:56-62` has no date | `:81-97` + date slot `:99-111` | **PLATFORM** (LM Studio exposes no pull date) | — | — |
| C9 | `url.ts` | `normalizeServerUrl` appends `/v1` `:11`, `lmStudioRestRoot` `:26` | `normalizeOllamaUrl` strips `/vN` `:12`, `ollamaRestRoot` `:25` | **PLATFORM** | — | — |
| C10 | `health.ts` | 14-line diff, **100% brand/doc strings** | same logic | **PARITY** | — | — |
| C11 | `'auth-required'` probe status | emitted by `src/lmstudio/client.ts:128-129` on 401/403 | declared in `core/health.ts:18`, **never emitted** — `src/ollama/client.ts:74` returns only `ok`/`unreachable` | **PORT** (dead branch; real once C4 lands) | S | Low |
| C12 | `binary.ts`, `mcp.ts` | — | diff 2 / 4 lines, brand strings in comments only | **PARITY** | — | — |
| C13 | `backoff` `commands` `compaction` `context` `errors` `goal` `question` `reconnect` `selection` `sessions` `skills` `title` `todos` | — | **13/13 byte-identical** (`diff -q`) | **PARITY** | — | — |

### 3.2 Host, bridge, protocol (`src/panel/`, `src/opencode/`)

| # | Item | LM | Ollama | Verdict | Eff | Risk |
|---|---|---|---|---|---|---|
| H1 | **`SelfHealer` wired into the health tick** | `bridge.ts:149`, `:256` | `src/core/reconnect.ts` byte-identical + `test/reconnect.test.ts` passing, **zero importers**; inline `probeAndHeal` at `bridge.ts:245` branches solely on the Ollama probe | **PORT** | M | **High value / Med risk — top priority** |
| H2 | **OpenCode-death recovery** | `bridge.ts:191` `addExitListener(() => this.onServerExit())`, `:293-303` (`teardownConnection` → `allowImmediate` → `reconnect`) | `serverManager.ts:59` `addExitListener` implemented and fires; **zero subscribers**. `serverManager.ts:50` `isRunning` — **zero call sites in all of `src/`** | **PORT** | S | **High value** — closes a silent-dead-panel bug |
| H3 | `init()` returns `ConnectResult` | `bridge.ts:619` | `bridge.ts:593` returns `void` | **PORT** (prereq for H1) | S | Low |
| H4 | `teardownConnection` / `isLive` / `markOffline` | present | ad-hoc inline | **PORT** (with H1) | S | Low |
| H5 | `PromptBody.variant` | `src/opencode/protocol.ts:278` | absent | **PORT** | S | Low — 1.17.18 accepts it (§5) |
| H6 | `OpencodeAgent` + `AgentsResponse` | `protocol.ts:250`, `:265` | absent | **PORT** | S | Low |
| H7 | `client.listAgents()` / `GET /agent` | `src/opencode/client.ts:112` | absent | **PORT** | S | Low — verified live on 1.17.18 |
| H8 | `runCommand` `variant` field | `client.ts:100` | absent | **PORT** | S | Low |
| H9 | `variants: variantsForModel()` in the generated config | `serverManager.ts:293`, declared **unconditionally** | absent | **PORT-adapted** | M | Med — see §5.6 |
| H10 | `sendAgents()` / `createAgent()` / `loadAgents()` | `bridge.ts:888`, `:913`, `:1454` | absent | **PORT** | M | Low |
| H11 | `modelReasoning()` + `lastModels` cache | `bridge.ts:1480` | no `lastModels` field | **PORT-adapted** | S | Low |
| H12 | `handleSend(effort)` + variant on the prompt body | `bridge.ts:1733`, `:1832` | `handleSend(thinking)` + `/no_think` append at `:1858` | **PORT-adapted** | M | **High** — gating must invert |
| H13 | `judgeGoal` suppresses thinking via `variant:'off'` | `bridge.ts:1191+` | `/no_think` string append at `:1062` | **PORT-adapted** | S | Low — `off`→`none` is a verified 200 on *every* Ollama model |
| H14 | `setGoal` effort | sends `'auto'` | sends `thinking:true` | **PORT** | S | Low |
| H15 | `bakedIdentity` stale-config respawn | `serverManager.ts:42, 77, 129, 454` | absent; `start()` reuses unconditionally, but `switchServer` disposes explicitly at `bridge.ts:1209` | **PORT** (belt-and-braces) | S | Med |
| H16 | Per-request timeout | absent | `src/opencode/client.ts:17` `REQ_TIMEOUT_MS=30000`, `:33` `AbortSignal.timeout` | **BACKPORT** | S | Low |
| H17 | SSE reconnect backoff | fixed 1 s | `client.ts:225` `nextDelay(++attempt, {base:1000, max:30000})` | **BACKPORT** | S | Low |
| H18 | SSE CRLF normalization | absent | `client.ts:198` (one line) | **BACKPORT** | S | Low |
| H19 | `dispose()` clears `this.starting` | absent — LM sets it only in the `.finally` at `:89-90` | `serverManager.ts:~426` | **BACKPORT** — fixes stale-promise-on-restart | S | Low |
| H20 | CSP nonce | `Math.random()` | `node:crypto` `randomBytes` | **BACKPORT** — security | S | Low |
| H21 | Re-resolve disposes the prior bridge | absent | present in `chatViewProvider` | **BACKPORT** — prevents duplicate handlers | S | Low |
| H22 | `mapModels()` split out of `loadModels()` | absent | `bridge.ts:1536` | **BACKPORT** (cosmetic) | S | Low |
| H23 | API-key file (`{file:…}` 0600) + `apiKeyOption()` | present | absent | **PLATFORM/defer** — Ollama has no native auth; matters only behind a reverse proxy | M | — |
| H24 | `OLLAMA_HOST` env injection | n/a | `serverManager.ts:225` | **PLATFORM** | — | — |
| H25 | keep-warm (`keepWarmNow`, `KEEP_WARM_EVERY_MS`) | absent | `bridge.ts:1281` | **PLATFORM** | — | — |
| H26 | `handleReloadModel` / `awaitLoad` / `cancelLoad` / `loadsInFlight` | absent | `bridge.ts:1363-1440` | **PLATFORM** | — | — |
| H27 | `setModelCtx` / `ctxFor` / `rebuildServer` / `prefs` | absent (global `setContextSize`) | `bridge.ts:1293`, `:1440`, `:1463` | **PLATFORM** | — | — |
| H28 | `probeHealth(maxAge, authAware)` 2nd arg | present | 1-arg | **PLATFORM** (until C4) | — | — |
| H29 | `updateServer` reconnect-only-on-URL-change | committed `bridge.ts:473-491` | **IN-FLIGHT**, converging | **IN-FLIGHT** | — | — |
| H30 | `prompts.ts` | identical modulo the identity string | same | **PARITY** | — | — |

### 3.3 Model client (`src/lmstudio/client.ts` ⇄ `src/ollama/client.ts`)

| # | Item | LM | Ollama | Verdict |
|---|---|---|---|---|
| M1 | Model endpoint | `/api/v1/models` → `/api/v0` → `/v1/models` fallback chain | `/api/tags` + `/api/ps` + per-model `/api/show` | **PLATFORM** |
| M2 | Reasoning metadata | `capabilities.reasoning = {allowed_options, default}` → `ReasoningCapability` (`client.ts:41-48`, `:259-269`) | `capabilities: string[]` → **`reasoning: caps.includes('thinking')`**, a plain boolean, `src/ollama/client.ts:200`, typed `reasoning?: boolean` at `:32` | **PORT-adapted** — shape must differ (§5) |
| M3 | Granularity signal | `allowed_options` distinguishes binary vs granular | **no API equivalent**; recoverable from the `/api/show` **template** (`.ThinkLevel` ⇒ granular) | **decision, §5.4** |
| M4 | 401/403 → `'auth-required'` | `client.ts:128-129` | not emitted (`:74`) | **PORT with C4** |
| M5 | Capability badges (👁 vision / 🔧 tools), `numCtx`, `created` | absent | present | **PLATFORM** |
| M6 | `loadModel` / `unloadModel` explicit control | `src/shared.ts:192-193` | replaced by keep-alive + load/eject flow | **PLATFORM** |

### 3.4 Shared message contract (`src/shared.ts`)

| # | Item | LM | Ollama | Verdict | Eff | Risk |
|---|---|---|---|---|---|---|
| S1 | `UiModel.reasoning: ReasoningCapability \| null` | present | **not surfaced to the UI at all** — `src/shared.ts:4-17` has no `reasoning` field despite the client computing it | **PORT-adapted** (boolean/union) | M | Med |
| S2 | `EffortLevel` / `ReasoningCapability` re-exports | present | absent | **PORT** | S | Low |
| S3 | `send.effort` replaces `send.thinking` | present | `thinking: boolean` `:158` | **PORT-adapted** | M | Med — webview co-change |
| S4 | `init.defaultEffort` | present | absent | **PORT** | S | Low |
| S5 | `UiAgent` + `agents` on `init` + `{type:'agents'}` | present | absent | **PORT** | M | Low |
| S6 | `requestAgents` / `createAgent` | present | absent | **PORT** | M | Low |
| S7 | `selectAgent: string` (was the enum) | widened | still `'build'\|'plan'` | **PORT** | S | Low |
| S8 | `UiServer.hasApiKey`, `addServer/updateServer` apiKey | present | absent (`:25-29`) | **PORT/defer** | M | Med (collides) |
| S9 | `lmStudioAuthRequired` on `init` | present | absent | **PLATFORM/defer** | — | — |
| S10 | `setContextSize` (global) | present | `setModelCtx`/`setModelCtxPref` (`:168-169`) | **PLATFORM** | — | — |
| S11 | `loadProgress` `:104` / `loadSettled` `:108` / `cancelLoad` `reloadModel` `:164-167` / `setKeepAlive` `:170` / `numCtx` `:10` / `created` `:16` | absent | present | **PLATFORM** | — | — |

### 3.5 Webview UI (`src/webview/main.ts` 3242 ⇄ 3162; `media/styles.css` 2112 ⇄ 2114)

| # | Item | LM | Ollama | Verdict | Eff | Risk |
|---|---|---|---|---|---|---|
| W1 | Effort control — `#effort-foot`, `#effort-presets`, `#effort-note`, `applyEffort`, `renderEffortPresets`, `currentEffort`, `setEffort`, per-model `effortByModel` | `main.ts:323-327`, `:1226-1310`, re-applied `:3062`/`:3088` | `state.thinking` (`:51,68,78`), `applyThinking()` (`:1092-1096`), `post({type:'send',thinking})` (`:1084`) | **PORT-adapted** | L | **High** |
| W2 | Effort pill cycler (click cycles, alt-click toggles reasoning *display*, self-hides + `layoutComposer()`) | `:538-554`, `:1246-1277`; markup `:294` | on/off only `:497-501` | **PORT** (with W1) | S | Low — pill is already in `overflowItems` (`ol:384`) |
| W3 | `/effort` slash command | `:711` + `effortCommand()` `:742-775` | `LOCAL_COMMANDS` = `/clear /compact /file /mcp /skills /goal /help` (`:648-654`) | **PORT** (with W1) | S | Low |
| W4 | Dynamic agent picker (`<select id="agent-select">` from the roster, `state.agents: UiAgent[]`, `renderAgents()`) | `:306`, `:1539-1566`, called from `renderModels()` `:1568` | hardcoded `<option value="build">/<option value="plan">` `:269-272`; `state.agent: 'build'\|'plan'` `:51` | **PORT** | M | Med |
| W5 | `/agents` command + panel (pickable/delegatable, `/agents new <name>`) | `:708`, `:798-813`, `showAgents()` `:815-848`, `case 'agents'` `:3144-3150` | absent | **PORT** (with W4) | M | Low — reuses `.mcp-panel/.mcp-row/.mcp-dot`, **no new CSS** |
| W6 | Subagent name in `task` tool cards (`→ <subagent>`) | `:2280-2288` | `title = st.title \|\| filePath` `:2191` | **PORT** (with W4) | S | Low |
| W7 | Agent-aware context overhead | `agentOverheadTokens(agent, agents)` `:1962-1965` | hardcoded `state.agent === 'plan' ? 6000 : 9000` `:1880` | **PORT** — **keep OL's 9000**, it was measured against Ollama | S | Low |
| W8 | Reasoning auto-collapse + "Thought for Xs" (`collapseReasoning()`, `.reasoning-label`, `data-startedAt/endedAt/chars/userToggled`, fired on `session.idle`) | `:2084-2098`, `:2704-2740`, `:3019`; label from `genrate.ts:214-221` `formatThinkingLabel` | static `<summary>…Thinking</summary>` `:2000`, never collapses | **PORT** | M | Low — `.part-reasoning` hook already exists (`:2096`) |
| W9 | `<summary>` as a real control (hit area, hover, focus ring, tabular-nums) | `media/styles.css:352-365` | absent | **PORT** (with W8) | S | None |
| W10 | `.gen-stat` rewrite → `agent · 8.2k in · ~340 out (120 thinking) · 8.5k total · 7.5s · ~45 tok/s` | `:2260` `recordDelta`, `:2748` `formatRate`, `:2985-2990` `recordTokens`/`recordAgent` | `turnOutputChars`/`turnFirstTokenAt` `:2255-2270`, math at **`:2174`**, display `:2612-2614` | **PORT** — idle-gap fix is the real win; exact-usage path **[UNVERIFIED]** (§8) | M | Med |
| W11 | Live tok/s drops the `~` when usage is exact | `:2676` | always `~` `:2580` | **PORT** (with W10) | S | None |
| W12 | `humanizeError` in the webview + `lastErrorText` dedup | `:38`, `:146`, `showError()` `:2760-2770`, call sites `:2934,:2981,:3033` | raw `err?.data?.message ?? err?.message ?? 'Error'` at `:2832,:2877,:2930`; no dedup — **yet `src/core/errors.ts:122` already exports `humanizeError`** and `bridge.ts:588` uses it | **PORT** — best ratio in the whole report | S | **Very low** (change `subject:'LM Studio'`→`'Ollama'`) |
| W13 | Server API-key UI (`#server-add-key`, `#server-edit-key`, `#server-edit-remove-key`, `.server-key-badge`, 401 banner) | `:353-357`, `:637-643`, `:1780-1815`, badge `:1748`, `renderConnection()` auth branch `:1905-1921`; CSS `:2084-2110` | absent | **PORT/defer** | M | Low, sequence after in-flight |
| W14 | Model-menu footer semantics | global `state.minContext`, presets clamped to model max, `setContextSize` `:1657-1690` | **per-model `numCtx`** + `#ctx-foot-model` + `setModelCtxPref` + Reload-to-apply `:1548-1598` | **PLATFORM — OL ahead** | — | — |
| W15 | Keep-alive presets (`#ka-presets`, `KEEP_ALIVE_PRESETS`, `renderKeepAlive()`) | absent | `:288-289`, `:1584-1625`; called from `renderModelMenu()` `:1545` | **PLATFORM — must survive.** LM calls `renderEffortPresets()` at `:1655`; **OL needs both** | — | — |
| W16 | Model Load/Eject/Reload/Cancel + elapsed timer + hint (`beginModelLoad`, `loadModeById`, `ensureModelLoadTimer`, `loadElapsedLabel`, `reconcileLoadingState`, `mergeModels`) | single button, blanket `loadingModels.clear()` `:1624-1645`, `:3079-3094` | `:1352-1430`, `:1444-1544`, `:3007-3060`; CSS `:1260-1305` | **PLATFORM — OL ahead. Do not regress.** | — | — |
| W17 | "Load a model" send-button CTA (`syncSendEnabled()`, `.send-btn.cta`, `selectedModelReady()`), slash-commands-**before**-model-gate, send-btn carve-out from outside-click | absent; LM runs slash commands *after* the gate `:1190-1196` | `:625`, `:2786-2822`, gate `:1042-1063`, carve-out `:585-593`; CSS `:1707-1719` | **PLATFORM — OL ahead. Keep OL's ordering.** | — | — |
| W18 | Titlebar actions at rest | `opacity: 0` (`styles.css:35-52`) | `opacity: 0.55` (`:36-53`) | **BACKPORT** | S | Low |
| W19 | Lazy assistant-bubble creation (compaction-marker-only messages leave no stray bubble) | eager `ensureMessageEl(info.id, info.role)` `:2962` | lazy, rationale at `:1951`/`:2820` | **BACKPORT** | S | Low |
| W20 | `toolCollapsed` cleared on chat reset and `part.removed` | absent (map leaks) | `:1929`, `:2898` | **BACKPORT** | S | Low |
| W21 | Model identity line includes pull date | `modelIdentity(m)` `:1605`, no date | `modelIdentity({...m, date: formatModelDate(m.created)})` `:1417` | **PLATFORM** | — | — |
| W22 | Server-edit overlay | committed superset | **IN-FLIGHT** | **IN-FLIGHT — do not re-port** | — | — |
| W23 | Goal bar, todo cards, question picker, MCP panel, skills panel, session history, image attachments/lightbox, context meter, `layoutComposer`/`overflowItems`, slash menu | present | **byte-identical apart from brand strings** — zero diff hunks across `:1116-1530`, `:1749-1830`, `:2255-2600` | **PARITY** | — | — |
| W24 | Cosmetic drift | `\u{1F3AF}` escape `:1394` | literal 🎯 `:1394` | **PARITY** (source-encoding only) | — | — |

**CSS delta ≈ 35 lines net.** LM-only: `.model-menu-foot.hidden` `:1192`, `.effort-note`/`:empty` `:1197-1204`, `.reasoning-label` `:363`, `.reasoning summary` block `:352-361`, `.server-edit-check[.hidden]` `:2084-2095`, `.server-key-badge` `:2103-2110`. OL-only: `.ctx-foot-model`/`.ctx-foot-hint` `:1150-1158`, `.model-actions` `:1260-1266`, `.model-action.reload` `:1288`, `.model-action.busy .cancel-x` `:1288-1296`, `.model-load-hint` `:1298-1304`, `.send-btn.cta` `:1707-1719`, plus in-flight `:1396-1423`. **Append; never block-merge** — LM parked its server-edit CSS at the file tail (`:2069+`), OL put its copy mid-file (`:1396`), so a merge duplicates rules.

### 3.6 Config & packaging

| # | Item | LM | Ollama | Verdict | Eff | Risk |
|---|---|---|---|---|---|---|
| P1 | `defaultThinkingEffort` setting (enum `auto/off/low/medium/high`, 5 `enumDescriptions`) | `package.json:143-161` + `normalizeEffort()` in `src/config.ts:6,9-13,28,48` | **absent** | **PORT-adapted** | M | Med |
| P2 | `agent` setting | `package.json:128-132` — **no enum**, desc documents `.opencode/agent/*.md`; `src/config.ts:21,43` free-form coerce | `package.json:127-135` — **`enum:["build","plan"]`**; `src/config.ts:13,32` unchecked cast | **PORT** — **must land with `src/core/agents.ts`**; enum-only removal yields a setting the picker can't honor | S | **Med** |
| P3 | `opencodeVersion` | `package.json:9` = `1.18.4` | `:9` = `1.17.18` | **PORT** — one field; `scripts/fetch-opencode.js:42-45` reads it | S | Med (needs OL-side verification) |
| P4 | `esbuild.test.js` | async IIFE with explicit `process.exit(0)` + the comment from LM `836951f` "fix(ci): wait for esbuild test bundler before exiting" | old `esbuild.build({…}).catch(…)` promise form, **no explicit exit** | **PORT** — `npm test` = `esbuild.test.js && node --test out-test/**`; OL can start the runner before bundling finishes. **Highest value-per-line item in the repo.** | S | Low |
| P5 | `sample-workspace/.opencode/agent/qa.md` | present (new in 0.15.0, 2029 B) | absent | **PORT** with P2 | S | Low |
| P6 | `minContextLength` | `"type":"number"`, no `minimum` | `"type":"integer"`, `"minimum":2048` | **BACKPORT** | S | Low |
| P7 | `scripts.compile` / `scripts.package` | `check-types && esbuild` | `check-types && check-types:test && esbuild` | **BACKPORT** | S | Low |
| P8 | `.claude/**` in the publish-skill `.vscodeignore` checklist | dropped | present | **BACKPORT** | S | Low |
| P9 | Base URL setting | `lmStudioBaseUrl` `http://127.0.0.1:1234/v1`, "must end in /v1"; inline suffix repair `config.ts:33-37` | `ollamaBaseUrl` `http://127.0.0.1:11434`; delegated to `normalizeOllamaUrl()` | **PLATFORM** — OL's factoring is cleaner | — | — |
| P10 | `healthCheckSeconds` | min 5 / **max 600**; `clampSeconds(…,30,5,600)` | min 5 / **max 120**, desc explains the cap ("so the keep-warm ping always lands within the 5-minute minimum keep_alive"); `config.ts:36` | **PLATFORM** | — | — |
| P11 | `keepAlive` setting | absent | `package.json:147-151`, `config.ts:16,35` | **PLATFORM** | — | — |
| P12 | `gpuOffload` (`lms load`) | `package.json:162-166`, `config.ts:24,46` | absent | **PLATFORM** | — | — |
| P13 | `autoEnsureContext` | "context length / lms CLI" | "context window (num_ctx)" | **PLATFORM** (wording is correct on both) | — | — |
| P14 | `opencodePath`, `serverPort`, `defaultModel`, `mcpServers` (full sub-schema), `engines`, `categories`, `activationEvents`, `viewsContainers`/`views`, `dependencies`, **all 9 devDependencies**, all other scripts | — | identical/byte-identical | **PARITY** | — | — |
| P15 | `contributes.commands` | 6: `newChat`, `openInTab`, `history`, `restartServer`, `showLogs`, `focus` | **same 6, same icons, same order** — zero drift 0.13→0.15 | **PARITY** | — | — |
| P16 | `.github/workflows/ci.yml`, `release.yml` | — | **functionally identical**; only VSIX filename strings and the example versions inside the odd/even policy comments (`release.yml:35-37`). `MINOR % 2` logic byte-identical `:38-47` | **PARITY** | — | — |
| P17 | `scripts/fetch-opencode.js` (4281 B), `esbuild.js` (1562 B), `tsconfig.test.json`, `tsconfig.integration.json`, `LICENSE`, `releasenotes/README.md` | — | **byte-identical** | **PARITY** | — | — |
| P18 | `scripts/generate-icon.js` | pure-Node PNG rasterizer, no deps, 200 lines | llama-mascot compositor, shells to `rsvg-convert` + ImageMagick, 79 lines | **PLATFORM** (maintainer-only; PNG is committed) | — | — |
| P19 | `.vscodeignore`, `.gitignore`, `.vscode/launch.json`, `scripts/render-release-notes.js:52` | — | brand/asset strings only; each ships the gif its README references | **PLATFORM** | — | — |
| P20 | **LM packaging hazard** (not OL's problem) | `THINKING-EFFORT-BRIEF.md` / `THINKING-EFFORT-PLAN.md` were untracked in the LM root and match no `.vscodeignore` rule (only `*HANDOFF.md` at `:20`). CI packages from a clean checkout so v0.15.0 is unaffected; a laptop `npm run package:vsix` would ship them | — | **flag to LM** | S | Low |

### 3.7 Tests

| # | Item | LM | Ollama | Verdict | Eff | Risk |
|---|---|---|---|---|---|---|
| T1 | `test/effort.test.ts` (8), `test/agents.test.ts` (8), `test/genrate.test.ts` (11), `test/servers.test.ts` (4) | present | absent | **PORT** with their features | L | Med |
| T2 | `test/keepAlive.test.ts` (5) | absent | present | **PLATFORM** | — | — |
| T3 | `test/models.test.ts` | 9 tests | **19 tests — OL ahead**, 134 changed lines; covers `formatModelDate`, `mergeModelLoadedState`, `isModelReady`, `formatLoadElapsed`, and the loaded-beats-stale `pickModel` fix | **BACKPORT** with C6 | M | Low |
| T4 | `test/url.test.ts` | `/v1`-suffix semantics | bare-root semantics | **PLATFORM** | — | — |
| T5 | `test/compaction.test.ts`, `health.test.ts`, `prompts.test.ts` | — | diff is the vendor noun in comments/titles only; assertions identical | **PARITY** | — | — |
| T6 | 14 of 23 unit files | — | byte-identical | **PARITY** | — | — |
| T7 | Integration: LM-only `apikey.itest.ts` (7), `genrate.itest.ts` (7), `zz-agents.itest.ts` (5), `zz-effort.itest.ts` (8) | present | absent | **PORT** with features (apikey partly superseded by in-flight `serveredit.itest.ts`) | M–L | Med |
| T8 | Integration: OL-only `fakeOllama.itest.ts` (3), `loadflow.itest.ts` (9), `serveredit.itest.ts` (7, in-flight) | absent | present | **PLATFORM** | — | — |
| T9 | `v080.itest.ts` (11) ⇄ `v060.itest.ts` (13) | — | same suite renamed per version; OL adds an `editor selection` describe | **PARITY** | — | — |
| T10 | `v052.itest.ts` | 6 tests | 3 — superseded by OL's `loadflow`/`fakeOllama` | **PARITY** | — | — |
| T11 | **`zz-` last-run convention** | 3 of 8 suites; rationale in headers: `zz-polling:6` (live health loop must not disturb injection suites), `zz-effort:4` (opening the picker fast-polls the real backend; async responses race earlier suites), `zz-agents:6` (re-inits the shared webview) | **1 of 7** (`zz-polling`, inherited). **`fakeOllama.itest.ts` meets the first criterion exactly** — real in-process HTTP server driving `bridge → OllamaClient → fetch` via `useServer` (`:7-9`) — yet sorts **first** | **PORT the convention** → rename `zz-fakeOllama.itest.ts`; that would let `loadflow`'s deleted picker-click assertion come back | S | Low |
| T12 | Harness | `index.ts` byte-identical; `helpers.ts` differs only by command namespace + OL's `useServer(url)` `:14-18` | — | **PARITY** | — | — |
| T13 | **Windows `where` CRLF coverage hole (both repos)** | `serverManager.ts:435` | `serverManager.ts:405` — same line: `resolve(code === 0 && out.trim() ? out.trim().split('\n')[0] : null)`. On Windows `where` emits `…opencode\r\n…opencode.cmd\r\n`; `.trim()` strips only the *trailing* CRLF, so `[0]` is `C:\…\opencode\r` — still ENOENT. `test/binary.test.ts` is byte-identical in both and only exercises the pure resolver with a pre-cleaned string; **no test in either repo feeds raw `where`/`which` stdout through the parser** | **PORT to BOTH** | S | Low |

### 3.8 Docs

Most of the README gap is documentation-only — features OL **already ships** but never mentions.

| # | Item | LM | Ollama | Verdict | Eff | Risk |
|---|---|---|---|---|---|---|
| D1 | README structure | rewritten as a Marketplace listing in `5422246` (v0.14.1), 240 lines, benefit-framed sections | pre-rewrite, 188 lines, Why / Features bullets / Requirements | **PORT** | M | Low |
| D2 | `/goal` loop, judge, goal bar, 25-round cap, mid-goal revision | `README.md:33-38` | **shipped** (`src/core/goal.ts`, 31 unit tests, `goalrevise.itest.ts`) — **0 occurrences of `/goal` or "judge" in the README** | **PORT (doc only)** | S | **None — pure win** |
| D3 | `/skills`, `/compact`, `/file`, `/help`, slash menu | `README.md:58,72-73` | shipped (`src/core/skills.ts`, `commands.ts`, `v060.itest.ts`); README documents only `/mcp` | **PORT (doc only)** | S | None |
| D4 | Steering mid-flight | `README.md:40` | shipped (2 src files), undocumented | **PORT (doc only)** | S | None |
| D5 | Session auto-restore on launch | `README.md:63` | shipped — `src/panel/bridge.ts:55` `LAST_SESSION_KEY='ollamaCode.lastSessionID'`; 0 hits for "restore" | **PORT (doc only)** | S | None |
| D6 | Quiet 30 s polling / no offline flash mid-generation | `README.md:51` | shipped (OL 0.11.0, `zz-polling.itest.ts`); surfaces only in a settings-table cell | **PORT (doc only)** | S | None |
| D7 | **"How it works" diagram is factually wrong** | correct (`README.md:213`, OpenAI `/v1`) | `README.md:158` claims `native ollama provider ──▶ Ollama (/api/chat)`. Contradicted by `src/opencode/serverManager.ts:326-331` which pins `@ai-sdk/openai-compatible` with `baseURL: ${host}/v1`, and by the comment at `:294` ("we deliberately do NOT use the native `ollama-ai-provider-v2`") | **PORT/fix — user-reported, issue #1** | S | Low, but it also invalidates the documented `keepAlive` guarantee |
| D8 | Custom agents, reasoning effort, per-server API keys, scaled output budget | `README.md:22,25-30,48,50` | genuinely absent | **PORT** (doc follows code) | L | Med |
| D9 | Capability badges, `num_ctx` auto-context, `keepAlive` | absent | `README.md:23,27` + settings table | **PLATFORM** | — | — |
| D10 | `.claude/skills/publish/SKILL.md` | 5730 B | 5744 B — 3 cosmetic hunks (sibling ordering, odd/even example versions, `.vscodeignore` checklist) | **PARITY** (+ P8 backport) | — | — |
| D11 | GitHub issues | **zero open** (closed #1–#5, #7) | **one open: #1** — Windows out-of-box failure + README routing contradiction (0.9.0). Nothing open in one repo is already fixed in the other; the fixes are D7 + T13 | — | — | — |

---

## 4. Intentional differences — do NOT "fix" these

A future parity pass will be tempted to erase these. Each is correct for its platform.

1. **Keep-alive is Ollama's whole model-residency story.** `src/core/keepAlive.ts` (`MIN_KEEP_ALIVE_SECONDS=300`), the `ollamaCode.keepAlive` setting, `setKeepAlive`, `#ka-presets`/`KEEP_ALIVE_PRESETS`/`renderKeepAlive()`, and the `keepWarmNow`/`KEEP_WARM_EVERY_MS` loop at `src/panel/bridge.ts:1281`. LM Studio instead has explicit `loadModel`/`unloadModel` (`src/shared.ts:192-193`). Neither side should acquire the other's mechanism. **When you add `renderEffortPresets()` to the model menu, OL must call *both* it and `renderKeepAlive()`** — LM's `renderModelMenu` calls only the former (`:1655`), OL's only the latter (`:1545`).
2. **`healthCheckSeconds` max is 120 on Ollama, 600 on LM Studio.** The lower ceiling is load-bearing: it guarantees the keep-warm ping lands inside the 5-minute minimum `keep_alive`. Do not "unify" it.
3. **Model API and metadata.** `/api/tags` + `/api/ps` + `/api/show` vs `/api/v1/models`. Consequences that must stay: `formatModelDate` and the `date` slot in `modelIdentity` (Ollama reports `created`, LM Studio does not); capability badges 👁/🔧; `mergeModelLoadedState`/`isModelReady`/`formatLoadElapsed`, which exist specifically because `/api/ps` is unreliable.
4. **Load/eject semantics.** OL's Load/Eject/Reload/Cancel + elapsed timer + `loadProgress`/`loadSettled`/`cancelLoad`/`loadsInFlight` (`bridge.ts:1363-1440`, `main.ts:1352-1430/1444-1544/3007-3060`) exists because Ollama loads take minutes. LM's single blocking button is not an upgrade.
5. **Per-model `num_ctx` (OL) vs global `minContextLength` (LM).** Ollama loads a model *at* a chosen context; LM Studio does not. `setModelCtx`/`setModelCtxPref`/`prefs.ts`/`#ctx-foot-model`/Reload-to-apply must stay. Do not port LM's global `setContextSize`.
6. **`gpuOffload` is LM-Studio-only** (it is an `lms load` argument). Ollama schedules GPU split itself.
7. **URL semantics.** `normalizeOllamaUrl` strips a version segment and keeps the host root; `normalizeServerUrl` appends `/v1`. `ollamaRestRoot` ≠ `lmStudioRestRoot`.
8. **Naming and branding everywhere**: `ollamaCode.*` vs `lmstudioCode.*`, `OLLAMA_HOST` injection, `humanizeError`'s `subject`, VSIX/artifact filenames, launch-config labels, icon-generation pipeline, `.vscodeignore` asset lists, `keywords`. The ~30 "identical modulo brand string" diffs are a feature; leave them.
9. **`'auth-required'` is currently dead on Ollama**, and that is correct — Ollama has no native auth. It becomes live only if C4/W13/H23 (API keys behind a reverse proxy) is deliberately shipped.
10. **The version lines are deliberately offset by −2 minors.** `releasenotes/0.11.0.yaml:4` says so explicitly ("0.10.0 was skipped to start the even/odd channel convention"). Do not "align" them; see §7.
11. **OL's slash-commands-run-before-the-model-gate ordering** (`main.ts:1042-1045`) is deliberate — it lets `/help` work before a model is loaded, which matters because Ollama models must be explicitly loaded. LM's post-gate ordering (`:1190-1196`) is the one that should change.

---

## 5. Can reasoning effort be ported? **Yes — same transport, rebuilt derivation, one inverted safety rule.**

Verified against Ollama **0.32.4**, the port's own bundled OpenCode **1.17.18**, and a logging proxy in front of Ollama. `qwen3:0.6b` (522 MB) was pulled for the thinking-model tests — remove with `ollama rm qwen3:0.6b` if not wanted.

### 5.1 The transport is byte-for-byte the same

`PromptBody.variant` → `provider.<id>.models.<m>.variants` → `@ai-sdk/openai-compatible` renames camelCase `reasoningEffort` → wire `reasoning_effort`. OL already uses **the identical provider**: `src/opencode/serverManager.ts:326-331` sets `npm: '@ai-sdk/openai-compatible'`, `baseURL: ${host}/v1`, `includeUsage: true`. The variant hop is provider-side and platform-agnostic. Verified end-to-end through the proxy:

| declared variant | prompt `variant` | wire |
|---|---|---|
| `{reasoningEffort:'high'}` | `high` | `reasoning_effort:"high"` |
| `{reasoningEffort:'none'}` | `off` | `reasoning_effort:"none"` |
| `{reasoningEffort:'max'}` | `maxx` | `reasoning_effort:"max"` |
| `{reasoning_effort:'high'}` (snake) | `snake` | **field absent** |
| — | none | field absent |

**The camelCase-only trap reproduces exactly** — snake_case is silently dropped. That finding is an AI-SDK property, not an LM Studio one, and transfers verbatim.

Ollama's OpenAI shim consumes it: `openai/openai.go:113` `ReasoningEffort *string \`json:"reasoning_effort,omitempty"\``, mapped at `~:630-650` — `none` → `api.ThinkValue{false}`, else `ThinkValue{"<level>"}`.

### 5.2 **No OpenCode upgrade is required.** I started the port's own `bin/opencode` (version file `1.17.18`) and read `/doc`:

```
POST /session/{sessionID}/message -> [agent,format,messageID,model,noReply,parts,system,tools,variant]
POST /session/{sessionID}/command -> [agent,arguments,command,messageID,model,parts,variant]
Model.variants                    -> {"type":"object","additionalProperties":{"type":"object"}}
GET  /agent                       -> 7 agents; keys = name,description,mode,native,hidden,permission,options,prompt,temperature
```
Binary strings: `variants` ×53, `reasoningEffort` ×20, `describeTask` ×1, `is a subagent, not a primary agent` ×1 — same as LM's 1.18.4. **Ship effort + agents on the existing pin; bump separately**, or a regression is unattributable.

### 5.3 The one hard behavioral break — invert the optimistic-send rule

`src/core/effort.ts:85-87`:
```ts
if (!reasoning) {
  return [...ALL_LEVELS]; // unknown != unsupported — offer everything, sending is a safe no-op
}
```
justified by the doc comment at `:26-28`. **False on Ollama.** Live probes:

```
reasoning_effort:"high"     llama3.2:1b -> 400 "llama3.2:1b" does not support thinking
reasoning_effort:"bogus"    llama3.2:1b -> 400 invalid reasoning value: 'bogus' (must be "high","medium","low","max","none")
reasoning_effort:"none"     llama3.2:1b -> 200
reasoning_effort:"max"      qwen3:0.6b  -> 200      <- Ollama-only value
reasoning_effort:"minimal"  qwen3:0.6b  -> 400      <- LM's ApiEffort has it
reasoning_effort:"xhigh"    qwen3:0.6b  -> 400      <- LM's ApiEffort has it
(omitted)                   qwen3:0.6b  -> 200, response carries "reasoning"   <- default is thinking-ON
```

Consequences:
- `levelsForModel(undefined)` **must return `[]`**, never `ALL_LEVELS`. Never send speculatively.
- `resolveLevel()` must guarantee that anything other than `auto`/`off` is emitted only when `supported === true`.
- Only `none` is universally safe (200 even on a non-thinking model) — which is why `off` becomes the **load-bearing** control: Ollama's default with `Think == nil` on a thinking-capable model is **thinking ON** (`server/routes.go:2607-2611`). That is exactly the intent of today's `/no_think` hack, and why replacing it is a functional improvement, not just cosmetics.
- `ApiEffort` = `'none'|'low'|'medium'|'high'|'max'` — drop `minimal`/`xhigh`, add `max`. Note `variantsForModel()` (`effort.ts:64-71`) already emits only `off→none/low/medium/high`, all four valid on Ollama, so **that function ports unchanged**.

### 5.4 Capability derivation — no `allowed_options`, but a real substitute exists

| | LM Studio | Ollama |
|---|---|---|
| source | `capabilities.reasoning = {allowed_options, default}` (`src/lmstudio/client.ts:41-48, :259-269`) | `/api/show` `capabilities: string[]` → `reasoning: caps.includes('thinking')`, already computed at `src/ollama/client.ts:200`, typed `:32` |
| granularity | directly declared | **not exposed by any API** |
| unknown | safe no-op | hard 400 |

**The granularity oracle:** Ollama passes `.Think` (bool), `.ThinkLevel` (string), `.IsThinkSet` into model templates (`template/template.go:200-205`, `server/prompt.go:152`), and `/api/show` returns the template. **A model is granular iff its template references `.ThinkLevel`.** Verified from registry template blobs (no weights pulled):

- `gpt-oss:20b` → `{{- if and .IsThinkSet .Think (ne .ThinkLevel "") }}` / `Reasoning: {{ .ThinkLevel }}` ⇒ **granular**
- `qwen3:0.6b`, `deepseek-r1:8b` → only `.Think`/`.IsThinkSet` ⇒ **binary**

Empirically corroborated on `qwen3:0.6b` (temp 0, seed 42): `low`/`medium`/`high`/`max` produced **byte-identical output** (sha `7f85f642`, 3658 reasoning chars, 1472 completion tokens each); `none` gave 0 reasoning chars / 100 tokens. That is LM Studio's binary finding reproduced on Ollama — binary is the *correct* UI for these models, not a degradation.

`src/ollama/client.ts` already calls `/api/show` per model, so `granular` is a **free extra field — no new HTTP**.

### 5.5 How the Ollama `src/core/effort.ts` differs — a sibling, not a copy

```ts
export type ApiEffort = 'none' | 'low' | 'medium' | 'high' | 'max';   // was: +minimal +xhigh, -max
export type ReasoningCapability = { supported: boolean; granular: boolean };  // was {allowedOptions, default}

levelsForModel(cap):
  !cap || !cap.supported        -> []                                  // INVERTED from LM
  cap.granular                  -> ['auto','off','low','medium','high'(,'max')]
  else                          -> ['auto','off','high']               // labeled "On" — same as LM's binary path

isBinary(cap)                   -> cap.supported && !cap.granular      // source flips, logic identical
variantsForModel()              -> ports verbatim (off→none, low/medium/high pass through)
resolveLevel()                  -> downward-clamp logic ports verbatim
fallbackPromptText()            -> ports; trigger becomes "model lacks `thinking`" rather than
                                   "capabilities unavailable" — and it becomes the PRIMARY path,
                                   since most Ollama models are non-thinking
```

**Honest fallback UI if you decline the template sniff:** every thinking-capable model gets **Auto / Off / On** and the pill hides entirely on non-thinking models. That is fully truthful — it is the *right* answer for qwen3/deepseek-r1 regardless — and costs only the gpt-oss-class Low/Med/High/Max slider. It is also strictly safer, since no granularity inference can be wrong.

### 5.6 One deliberate divergence from the other survey's advice

Declare `variants` **unconditionally** in the generated config (as LM does at `serverManager.ts:293`), *not* only for `m.reasoning === true`. Declaring a variant a model cannot use is harmless — **only sending it errors** — and unconditional declaration preserves the "no server restart when effort changes" property. The gate belongs in `levelsForModel`/`resolveLevel` (which decide what can be *sent*), not in config generation. **[This contradicts the host survey's §item-4 bullet; the conditional gate is unnecessary and costs a respawn.]**

### 5.7 Port checklist for C1/W1

`src/core/effort.ts` (new, adapted) · `variantsForModel()` into `src/opencode/serverManager.ts:266-277` · `variant` on `PromptBody` (`src/opencode/protocol.ts`) and `runCommand` · `granular` alongside `reasoning` in `src/ollama/client.ts:200` · `EffortLevel` replacing `thinking: boolean` at `src/shared.ts:158` + `UiModel.reasoning` + `init.defaultEffort` · `ollamaCode.defaultThinkingEffort` + `normalizeEffort` in `src/config.ts` · delete `/no_think` at `src/panel/bridge.ts:1062` and `:1858` · composer pill + `#effort-foot`/`#effort-presets`/`#effort-note` in `src/webview/main.ts` replacing `btn-think` (`:257, 497, 1084, 1092-1096`) · `/effort` in `LOCAL_COMMANDS` (`:648-654`) · CSS `.model-menu-foot.hidden` + `.effort-note` · `test/effort.test.ts` + `zz-effort.itest.ts`.

---

## 6. Port plan, in dependency order

### (a) Mechanical / no-risk — do these first, in any order, all independently shippable

1. **`esbuild.test.js` explicit-exit fix.** Copy LM's async-IIFE form with `process.exit(0)` and the `836951f` comment. ~10 lines. Fixes a live CI race where `node --test out-test/**` can start before bundling finishes. Zero collision. *Highest value-per-line item in the repo.*
2. **`humanizeError` in the webview + `lastErrorText` dedup.** `src/webview/main.ts:38, 146, 2832, 2877, 2930` → import from `src/core/errors.ts` (already identical and already used by `src/panel/bridge.ts:588`); add `showError()` with dedup; `subject: 'Ollama'`.
3. **README truth-fixes (doc-only, no code).** Fix the "How it works" diagram at `README.md:158` to say `@ai-sdk/openai-compatible → ${host}/v1` (closes the second half of issue #1). Then document the shipped-but-invisible features: `/goal` + judge + goal bar + 25-round cap + mid-goal revision, `/skills` `/compact` `/file` `/help` + slash menu, mid-flight steering, session auto-restore, quiet 30 s polling.
4. **Windows `where`/`which` CRLF fix + test — in BOTH repos.** `src/opencode/serverManager.ts:405` (OL) / `:435` (LM): split on `/\r?\n/` and trim each candidate before taking `[0]`. Add `whichOpencode` stdout-parsing tests (CRLF, multi-line, trailing blank) to `test/binary.test.ts` in both. Closes the remaining half of issue #1.
5. **Integration-suite ordering.** Rename `test-integration/suite/fakeOllama.itest.ts` → `zz-fakeOllama.itest.ts` with a header comment matching LM's convention. Then restore the picker-click assertion the in-flight `loadflow.itest.ts` had to delete. Optionally make the sort explicit in `test-integration/suite/index.ts` (glob@13 does not formally guarantee sorted results) — in both repos.
6. **Reasoning `<summary>` styling + auto-collapse (W8/W9).** `collapseReasoning()`, `.reasoning-label`, `data-startedAt/endedAt/chars/userToggled`, fire on `session.idle`; take `formatThinkingLabel` from `genrate.ts:214-221` standalone. `.part-reasoning` hook already exists at `main.ts:2096`. No protocol change; biggest visible UX win per line. *(Touches `main.ts` — sequence after the in-flight branch lands.)*
7. **Titlebar-actions opacity backport is the reverse direction** — flag to LM, don't touch OL.

### (b) Feature ports

8. **Reliability: wire `SelfHealer` + OpenCode-death recovery.** *Do this before any feature work — it is a live bug.*
   - `src/panel/bridge.ts`: `init(): Promise<void>` → `Promise<ConnectResult>` (`:593`); replace inline `probeAndHeal` (`:245-286`) with the `SelfHealer` from `src/core/reconnect.ts` (already byte-identical, already tested); add `teardownConnection`/`isLive`/`markOffline`; subscribe `this.deps.server.addExitListener(() => this.onServerExit())` and add `onServerExit()` mirroring LM `bridge.ts:293-303`.
   - Mirror LM `bridge.ts:149, 191, 293-303, 619`. `deps.server.isRunning` (`serverManager.ts:50`) gets its first call site.
   - Add `src/opencode/serverManager.ts` `bakedIdentity` (LM `:42, 77, 129, 454`) — belt-and-braces given `switchServer` already disposes at `bridge.ts:1209`.
9. **Agents (H6/H7/H10/C3/W4-W7/P2/P5/T1/T7).** One coherent unit:
   - `src/opencode/protocol.ts`: `OpencodeAgent`, `AgentsResponse`; `src/opencode/client.ts`: `listAgents()` → `GET /agent` (verified on 1.17.18).
   - `src/core/agents.ts` verbatim, then **recalibrate `PROMPT_TOKENS` (`:84-87`, currently `{build:5400, plan:1600}`) against OL's own `BUILD_PROMPT`/`PLAN_PROMPT` in `src/opencode/prompts.ts`.** Note: the 11000/6000 figures in circulation are the *old LM webview overhead constant* (`git show 5422246:src/webview/main.ts:1685`), a different quantity from `PROMPT_TOKENS` — don't conflate them.
   - `src/shared.ts`: `UiAgent`, `agents` on `init`, `{type:'agents'}`, `requestAgents`, `createAgent`, widen `selectAgent` to `string`.
   - `src/panel/bridge.ts`: `sendAgents()`, `createAgent()`, `loadAgents()`.
   - `src/config.ts:13,32` → `agent: string` with the free-form coerce; **`package.json:127-135` drop the `enum`** and adopt LM's description. *(P2 and the runtime must land together.)*
   - `src/webview/main.ts`: populate `#agent-select` from the roster (`:269-272`), `renderAgents()` called from `renderModels()`, `/agents` command + `showAgents()` panel (reuses `.mcp-panel` CSS, no new styles), subagent name in `task` cards (`:2191`), replace the hardcoded overhead at `:1880` with `agentOverheadTokens()` — **keep 9000 as OL's build calibration**.
   - `sample-workspace/.opencode/agent/qa.md`; `test/agents.test.ts`; `zz-agents.itest.ts`.
10. **Generation rate (C2/W10/W11/T1/T7).** Drop in `src/core/genrate.ts` unchanged; rewrite the ad-hoc math at **`src/webview/main.ts:2174-2184`** (not `:2578` — that is the display site); wire `recordDelta` (`:2255-2270` region), `recordTokens`/`recordAgent` on `message.updated`/`session.idle`, `formatRate` at the `.gen-stat` write (`:2612-2614`). Add `total?` to the `tokens` shape at `src/opencode/protocol.ts:154` to match `:174`. Delete the stale comment at `main.ts:1871` ("the native ollama provider doesn't report token usage") — OL moved to `/v1` + `includeUsage: true` and never revisited it. **Gate the exact-usage branch behind an observed-usage check until Open Question 1 is settled**; the idle-gap exclusion is an unconditional win either way.
11. **Reasoning effort (C1/H5/H8/H9/H11/H12/H13/H14/S1-S4/P1/W1-W3/T1/T7)** — §5.7 checklist. Land **after** agents (smaller blast radius first) and **after** the granularity decision in §8.

### (c) Needs a decision before code is written

12. **Granular vs binary effort UI** — accept the `.ThinkLevel` template sniff (real Low/Med/High/Max on gpt-oss-class models, one inference that could be wrong on an exotic template) or ship Auto/Off/On everywhere (strictly truthful, loses one slider). §8 Q2.
13. **OpenCode pin 1.17.18 → 1.18.4** — one field, `package.json:9`; `scripts/fetch-opencode.js` is byte-identical, `bin/opencode.version` is regenerated by `npm run bundle:opencode`. Nothing in OL's host code reads or branches on the version. LM recorded zero behavioral diff, but that was verified against LM Studio. **Ship it as its own commit/release after the feature work verifies**, so any regression is attributable.
14. **Per-server API keys (C4/H23/S8/W13/T7)** — genuinely optional. Ollama has no native auth; the use case is reverse-proxied Ollama. `src/core/servers.ts` (33 lines) + SecretStorage + `apiKey` on `src/connection.ts` + `hasApiKey` on `UiServer` + the key fields on the overlay + the `resolveApiKeyEdit(...).kind !== 'keep'` clause in `updateServer` + `'auth-required'` emission at `src/ollama/client.ts:74` + the 401 banner. **Must be sequenced after the in-flight branch merges** — it changes the exact `updateServer` signature being edited right now. This is the LM 0.12.0 hole in the version ledger (`grep -rn 'apiKey|SecretStorage' src` → 0 hits vs 8 files in LM).
15. **Backports to LM** (separate PRs against the lead, do not action from the OL side): `pickModel` loaded-beats-stale priority + the 10 extra `models.test.ts` cases; `REQ_TIMEOUT_MS`/`AbortSignal.timeout`; SSE `nextDelay` backoff; SSE CRLF normalization; `crypto.randomBytes` CSP nonce; `dispose()` clearing `this.starting`; re-resolve disposing the prior bridge; lazy assistant-bubble creation; `toolCollapsed` cleanup; titlebar `opacity: 0.55`; `minContextLength` as `integer` + `minimum: 2048`; `check-types:test` in `compile`/`package`; `.claude/**` in the publish-skill `.vscodeignore` checklist; `mapModels()` split; and the `THINKING-EFFORT-*.md` `.vscodeignore` gap.

---

## 7. Recommended release shape for the Ollama repo

**Convention (identical in both, enforced in `release.yml:38-47`):** `-suffix` tag ⇒ GitHub draft only · **odd minor ⇒ Marketplace pre-release** · **even minor ⇒ Marketplace stable**.

The −2 offset is deliberate and should be preserved. Cadence was same-day lockstep through 2026-07-21, then OL stopped; it is now 2 releases and 4 days behind.

**Recommended: two releases, not one.**

**`0.12.1` — patch, stable channel (even minor), ship immediately.**
Contents: in-flight server-edit overlay + `serveredit.itest.ts` · `esbuild.test.js` exit fix · `humanizeError` + dedup · Windows `where` CRLF fix + parser tests · README truth-fix (`:158` routing diagram) + the four undocumented-feature sections · `zz-fakeOllama` rename + restored `loadflow` assertion.
Rationale: closes issue #1 in full, fixes a real CI race, makes four shipped headline features visible to users, and carries **zero** new surface. Nothing here needs a beta soak.

**`0.13.0` — pre-release / beta channel (odd minor).**
Contents: SelfHealer + OpenCode-death recovery + `bakedIdentity` · agents (core + protocol + config + UI + `qa.md`) · genrate + reasoning auto-collapse · reasoning effort with the inverted gating.
Rationale: this is LM 0.14.1 + 0.15.0 content plus a reliability fix, and the effort feature carries a genuine wire-behavior risk (400s on non-thinking models) that deserves a beta soak. Matching LM's own 0.13.0-was-a-beta precedent.

**`0.14.0` — stable graduation**, after the beta soak, restoring the −2 offset against LM 0.16.x. Fold the **OpenCode 1.18.4 bump** in here (or as `0.13.1` during the soak) as its own commit.

**Do not** fold API keys into either. If it ships, it is `0.15.0`-beta material and the ledger note is that LM 0.12.0 was skipped on the Ollama side.

Each release needs `releasenotes/<version>.yaml` (schema `version/date/highlights/added/changed/fixed/removed`) or `release.yml` fails the gate.

---

## 8. Open questions, and the cheapest experiment for each

1. **Does OpenCode actually receive token usage from Ollama's `/v1` shim?** The two surveys conflict: one says the "no usage" comment at `src/webview/main.ts:1871` is stale (OL moved to `/v1` + `includeUsage: true`), the other says usage is genuinely absent. Verification confirmed only the *config* (`serverManager.ts:326-331`), not observed usage. This decides whether `genrate`'s `in`/`total`/`exact` fields are real or always empty on Ollama. **[UNVERIFIED]**
 *Cheapest test:* run one turn through the logging proxy already in the scratchpad and grep the SSE for `"usage"` / `prompt_tokens`. ~5 minutes. If absent, ship only the idle-gap fix and stub the exact-usage branch.

2. **Granular vs binary — is `.ThinkLevel` in the `/api/show` template a sound oracle beyond gpt-oss?** Confirmed on three model families (gpt-oss granular; qwen3, deepseek-r1 binary) plus a byte-identical-output check across low/medium/high/max on `qwen3:0.6b`. Unconfirmed on the long tail.
 *Cheapest test:* pull template blobs only (no weights) for the next 5–10 thinking-capable models in the registry and grep for `.ThinkLevel`. ~10 minutes, no disk cost. If the split stays clean, take the sniff; if any model references `.ThinkLevel` but collapses levels in practice, ship binary-only.

3. **How does the 400 actually surface in the UI when a non-thinking model gets an effort?** The raw-HTTP 400 is solid; the claim that it *fails the turn in-app* is inferred, not observed — `qwen3:0.6b` was too weak for tool calls to get a clean capture. **[UNVERIFIED]** This matters because it determines whether the inverted gating is a correctness fix or merely a defense in depth.
 *Cheapest test:* temporarily force `variant:'high'` on `llama3.2:1b` in a dev host, send one message, watch the panel. ~10 minutes.

4. **Does OpenCode render Ollama's `message.reasoning` delta as a thinking block in the webview?** Ollama's `/v1` shim puts thinking in `reasoning` (not `reasoning_content`). If OpenCode's openai-compatible provider only maps `reasoning_content`, the effort control would work on the wire while producing no visible thinking pane. **[UNVERIFIED — this would invalidate most of W8's user-visible value.]**
 *Cheapest test:* one `qwen3:0.6b` turn with `variant:'high'` in the dev host; look for a `.part-reasoning` element. ~10 minutes. **Run this before item (b)-11, ideally before (a)-6.**

5. **Does `max` belong in the UI at all?** It is Ollama-only, valid on the wire, and has no LM Studio equivalent — so it permanently diverges the two `EffortLevel` unions and the two `defaultThinkingEffort` enums. *Decide by preference, not experiment.* Recommendation: include it only if Q2 resolves to granular, and only for granular models.

6. **Does `glob@13` guarantee sorted results?** Both repos' `zz-` ordering convention silently depends on it. *Cheapest test:* read the `glob` changelog, or just pass an explicit `.sort()` in `test-integration/suite/index.ts` in both repos and stop depending on it. ~2 minutes.

7. **`PROMPT_TOKENS` recalibration for Ollama.** LM's `{build:5400, plan:1600}` was measured against LM Studio's tokenizer and LM's prompt text. *Cheapest test:* run OL's `BUILD_PROMPT`/`PLAN_PROMPT` from `src/opencode/prompts.ts` through `/api/embed`-adjacent token counting or a `/api/generate` with `num_predict:0` and read `prompt_eval_count`. ~10 minutes; low stakes (it only shifts a context-meter estimate).