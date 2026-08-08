#!/usr/bin/env node
// Stage the bundled Ollama provider into `opencode-provider/`, laid out exactly
// the way OpenCode's package cache expects, so the extension can pre-seed it at
// runtime instead of having OpenCode npm-install a provider on first use.
//
// Why bundle at all: OpenCode fetches non-built-in providers from npm into
// $XDG_CACHE_HOME/opencode/packages/<name>/. For a tool whose whole point is
// running local models, requiring a registry round-trip before the first
// prompt is the wrong trade — and our provider is a patched fork that isn't on
// npm anyway (see vendor/<pkg>/package.json `_forkedFrom`).
//
// The layout below is what OpenCode was observed to accept, verified with an
// unpublished package name and no registry access at all:
//
//   packages/<pkg>/package.json           {"dependencies":{"<pkg>":"<version>"}}
//   packages/<pkg>/package-lock.json      matching lockfileVersion 3 stub
//   packages/<pkg>/node_modules/<pkg>/    the provider itself (from vendor/)
//   packages/<pkg>/node_modules/…         its dependency closure (npm-installed)
//
// Run via `npm run bundle:provider`; `package:vsix:bundled` does it for you.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PKG = 'ollama-ai-provider-cgaspard';
const VENDOR = path.join(ROOT, 'vendor', PKG);
const OUT = path.join(ROOT, 'opencode-provider', 'packages', PKG);

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(VENDOR, 'package.json'), 'utf8'));
  const version = manifest.version;

  fs.rmSync(path.join(ROOT, 'opencode-provider'), { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // The dependency closure. Installed from the registry at PACKAGE time (never
  // at the user's first prompt), then shipped inside the VSIX.
  const deps = manifest.dependencies ?? {};
  const specs = Object.entries(deps).map(([n, v]) => `${n}@${v}`);
  fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify({ name: PKG, private: true }, null, 2));
  console.log(`installing provider deps: ${specs.join(' ')}`);
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--omit=dev', ...specs], {
    cwd: OUT,
    stdio: 'inherit',
  });

  // The provider itself, alongside its deps.
  const dest = path.join(OUT, 'node_modules', PKG);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(VENDOR, dest, { recursive: true });

  // Finally the two manifests OpenCode reads, naming OUR package rather than
  // the private stub npm just wrote.
  fs.writeFileSync(
    path.join(OUT, 'package.json'),
    JSON.stringify({ dependencies: { [PKG]: version } }, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT, 'package-lock.json'),
    JSON.stringify(
      {
        name: PKG,
        lockfileVersion: 3,
        requires: true,
        packages: { '': { dependencies: { [PKG]: version } } },
      },
      null,
      2,
    ),
  );

  const size = execFileSync('du', ['-sh', OUT]).toString().trim().split('\t')[0];
  console.log(`staged ${PKG}@${version} -> opencode-provider/ (${size})`);
}

main();
