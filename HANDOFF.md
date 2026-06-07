# Ollama Code — Handoff

Context for resuming work on this project in a fresh session.

## What this is

`ollama-vscode-chat` ("**Ollama Code**", extension id `ollama-code`, publisher
`cgaspard`) is a VS Code extension: a Claude Code / Codex–style **agentic chat
panel for local Ollama models**. It wraps the open-source **OpenCode** agent
(`opencode serve`, a headless HTTP server) and drives it from a webview UI.

It is a **feature-parity port of `../lmstudio-vscode-chat`** (`lmstudio-code`),
adapted from LM Studio's API to Ollama's. The two projects are structurally
identical; only the provider client + a few config/branding bits differ. When
porting a future feature, do it in one and mirror to the other.

Status (2026-06-07): builds clean, end-to-end verified against a local Ollama,
packaged (`ollama-code-0.1.0.vsix`) and installed locally. **Local git repo with
one commit; no GitHub remote yet; not published to the Marketplace.**

## Architecture

```
VS Code webview (media/styles.css + dist/webview/main.js)   ← the chat UI
        │  postMessage  (protocol in src/shared.ts)
        ▼
Extension host  (src/extension.ts → src/panel/bridge.ts)
        │  HTTP + SSE (raw fetch, src/opencode/client.ts)
        ▼
opencode serve   (spawned by src/opencode/serverManager.ts)
        │  native `ollama` provider, OLLAMA_HOST + OPENCODE_CONFIG_CONTENT
        ▼
Ollama server  (/api/chat, /api/tags, /api/show, /api/ps, /api/generate)
```

- The extension spawns a headless `opencode serve` (auto-detected binary at
  `~/.opencode/bin/opencode` or PATH), parses its `listening on <url>` line, and
  talks to it over raw `fetch` + SSE.
- OpenCode has a **built-in `ollama` provider** that it auto-detects from a
  running Ollama. We **augment** it (we do NOT set `npm`/`baseURL`) via the
  `OPENCODE_CONFIG_CONTENT` env var with the user's *installed* models (the
  native provider otherwise lists a static models.dev catalog, not what's
  installed). The active Ollama host is passed via the `OLLAMA_HOST` env var.
- Sessions, streaming, tools, permissions, compaction all come from OpenCode's
  event stream (`GET /event`, SSE). Prompts via `POST /session/:id/prompt_async`.

## Key files

| File | Role |
| --- | --- |
| `src/ollama/client.ts` | **Ollama-specific.** Model discovery + load/unload (see API notes below). |
| `src/opencode/serverManager.ts` | Spawns/owns `opencode serve`; `buildConfigContent()` augments the `ollama` provider with installed models; sets `OLLAMA_HOST`. |
| `src/opencode/client.ts` | Raw HTTP/SSE client for the OpenCode server (sessions, prompt, events, permissions). |
| `src/opencode/protocol.ts` | TS types for the OpenCode API subset we use. |
| `src/panel/bridge.ts` | The heart: connects one webview to OpenCode; handles all webview↔host messages, titles, active-file context, AGENTS.md warning. |
| `src/panel/chatViewProvider.ts` | Registers the webview view(s) + editor-tab panel; CSP/HTML. |
| `src/webview/main.ts` | The entire webview UI (timeline, model menu, server menu, composer, meter, history). Bundled to `dist/webview/main.js`. |
| `src/config.ts` | Settings (`ollamaCode.*`) + URL normalization (`normalizeOllamaUrl`). |
| `src/connection.ts` | `ServerRegistry` — persisted multi-server list in globalState. |
| `src/shared.ts` | Host↔webview message protocol types. |
| `media/styles.css` | Webview styling. |
| `scripts/generate-icon.js` | Builds `media/icon.png` from `media/ollama-logo.svg` via `rsvg-convert` + ImageMagick. |
| `.github/workflows/{ci,release}.yml` | CI (build) + tag-driven Marketplace publish. |
| `releasenotes/<version>.yaml` | Per-version notes, rendered by `scripts/render-release-notes.js`. |

## Ollama API specifics (the porting work)

`src/ollama/client.ts`, host root `http://127.0.0.1:11434` (NO `/v1`):

- **List models** — `GET /api/tags`, then per model `POST /api/show` for
  `capabilities` (array containing `vision` / `tools` / `thinking` /
  `embedding`) and max context (`model_info["<arch>.context_length"]`), plus
  `GET /api/ps` for which models are loaded and their loaded `context_length`.
  Embedding models are filtered out.
- **Load / warm with a context window** — `POST /api/generate`
  `{model, keep_alive, options:{num_ctx}}`. **Unload** — same with
  `keep_alive: 0`. An Ollama "instance id" is just the model name.
- **Context** — Ollama's default window is small (~4k); OpenCode's build-agent
  prompt is ~11k tokens, so we declare `limit.context` + `options.num_ctx`
  (= `minContextLength`, default 32768) per model. In testing OpenCode loaded
  the model at ~64k ctx, no overflow. `keepAlive` setting (default `30m`)
  controls how long models stay resident.
- **Capabilities → OpenCode model flags**: `tools`→`tool_call`,
  `vision`→`attachment` + `modalities.input:['text','image']`,
  `thinking`→`reasoning`.

Reference: https://github.com/ollama/ollama/blob/main/docs/api.md

## Build / run / test

```bash
npm install
npm run compile          # typecheck + esbuild bundle (extension + webview)
npx vsce package --allow-missing-repository --skip-license   # -> ollama-code-0.1.0.vsix
code --install-extension ollama-code-0.1.0.vsix --force      # install locally
# or press F5 in VS Code for the Extension Development Host
```

To exercise it you need: Ollama running (`ollama serve` / the app) with a
**tool-capable** model pulled (`ollama pull qwen3` or `llama3.2:3b` /
`mistral-small` / `devstral`), and the `opencode` binary installed.

Headless verification recipes that were used (adapt as needed):
- Probe Ollama directly: `curl localhost:11434/api/tags`, `POST /api/show`,
  `GET /api/ps`, `POST /api/generate` (load/unload).
- Activation harness: require `dist/extension.js` with a mocked `vscode` and call
  `activate()` to confirm views/commands register.
- Integration: replicate `serverManager` — enumerate models, build the config,
  spawn `opencode serve` with `OLLAMA_HOST` + `OPENCODE_CONFIG_CONTENT`, create a
  session, `prompt_async`, read the `/event` SSE stream, assert text streams with
  no `session.error`.

## Known gotchas / caveats

- **Test model too weak:** `llama3.2:1b` (only one currently pulled) echoes tool
  JSON instead of answering — integration is fine, output isn't. Use a real
  tool-capable model.
- **Demo GIF is stale:** `media/sample.gif` is the *LM Studio* recording. Re-record
  against this extension. README's `## Demo` references it.
- **`media/screenshots/`** has a guide but no images yet.
- OpenCode's native ollama provider can pick its own `num_ctx` (loaded 64k when we
  asked 32k) — fine, but don't assume the loaded ctx equals `minContextLength`.
  The context meter reads the real loaded ctx from `/api/ps` when available, else
  estimates (OpenCode may not report exact tokens; the meter shows `~`).
- ImageMagick's built-in SVG parser can't render the Ollama logo path — the icon
  generator needs **librsvg** (`rsvg-convert`).

## Next steps / TODO

1. **GitHub repo** (user said they'll create it): `cgaspard/ollama-vscode-chat`,
   public, push `main`. The `package.json` `repository`/`bugs`/`homepage` already
   point there. CI runs on push; Release runs on a `vX.Y.Z` tag.
2. **Marketplace publish:** add the `VSCE_PAT` repo secret
   (`gh secret set VSCE_PAT --repo cgaspard/ollama-vscode-chat`), then
   `git tag v0.1.0 && git push origin v0.1.0`. (Same flow as `lmstudio-code`;
   publisher `cgaspard` already verified for that PAT.)
3. **Re-record `media/sample.gif`** and optionally add `media/screenshots/*.png`.
4. Consider exposing `keepAlive` / a per-model `num_ctx` override in the UI, and
   confirm multi-server `OLLAMA_HOST` switching against a real remote host.
5. Keep parity with `../lmstudio-vscode-chat` when either gains features.

## Publishing the LM Studio sibling (already done, for reference)

`lmstudio-code` is live: repo `cgaspard/lmstudio-vscode-chat`, published to the
Marketplace as `cgaspard.lmstudio-code` v0.1.0 via the tag-driven workflow.
