#!/usr/bin/env node
// Build the Ollama provider the embedded OpenCode engine loads:
//
//   opencode-provider/ollama.mjs      one ES module: scripts/provider/ollama-panel.mjs
//                                     + the patched provider in vendor/ + its deps
//   opencode-provider/LICENSE.provider the provider's Apache-2.0 license
//
// Why bundle at all: OpenCode would otherwise fetch a provider from npm on
// first use. For a tool whose whole point is running local models, requiring a
// registry round-trip before the first prompt is the wrong trade, and our
// provider is a patched fork that is not on npm anyway (see
// vendor/<pkg>/package.json `_forkedFrom`). OpenCode 2 imports a provider
// given as a file:// URL directly, so a single file is all it needs.
//
// The provider's dependencies are installed from the registry at PACKAGE time
// into a scratch folder, bundled in, and the folder is removed.
//
// Run via `npm run bundle:provider`; `package:vsix:bundled` does it for you.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const PKG = 'ollama-ai-provider-cgaspard';
const VENDOR = path.join(ROOT, 'vendor', PKG);
const OUT = path.join(ROOT, 'opencode-provider');
const STAGE = path.join(OUT, '.stage');

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(VENDOR, 'package.json'), 'utf8'));
  const version = manifest.version;

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  try {
    // The dependency closure (zod is a peer of @ai-sdk/provider-utils).
    const deps = manifest.dependencies ?? {};
    const specs = Object.entries(deps).map(([n, v]) => `${n}@${v}`);
    fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify({ name: 'provider-stage', private: true }, null, 2));
    console.log(`installing provider deps: ${specs.join(' ')}`);
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--omit=dev', '--no-package-lock', ...specs], {
      cwd: STAGE,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    fs.cpSync(VENDOR, path.join(STAGE, 'node_modules', PKG), { recursive: true });

    await esbuild.build({
      entryPoints: [path.join(ROOT, 'scripts', 'provider', 'ollama-panel.mjs')],
      nodePaths: [path.join(STAGE, 'node_modules')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: path.join(OUT, 'ollama.mjs'),
      legalComments: 'eof',
      logLevel: 'warning',
      mainFields: ['module', 'main'],
      // CommonJS deps inside the ESM bundle still call require().
      banner: { js: "import { createRequire as __pvCreateRequire } from 'node:module'; const require = __pvCreateRequire(import.meta.url);" },
    });
  } finally {
    fs.rmSync(STAGE, { recursive: true, force: true });
  }
  fs.copyFileSync(path.join(VENDOR, 'LICENSE.md'), path.join(OUT, 'LICENSE.provider'));
  fs.writeFileSync(path.join(OUT, 'version'), `${PKG}@${version}\n`);

  const kb = (fs.statSync(path.join(OUT, 'ollama.mjs')).size / 1024).toFixed(0);
  console.log(`bundled ${PKG}@${version} -> opencode-provider/ollama.mjs (${kb} KB)`);
}

main().catch((err) => {
  console.error(`[bundle-provider] ${err.message}`);
  process.exit(1);
});
