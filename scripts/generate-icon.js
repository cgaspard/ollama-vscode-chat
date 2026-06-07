#!/usr/bin/env node
// Generate media/icon.png — a dark slate rounded square with a soft glow and
// the white Ollama llama mascot. Requires `rsvg-convert` (librsvg) and
// ImageMagick (`magick`) locally. The PNG is committed, so this only runs on a
// maintainer machine, not in CI.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const logo = path.join(root, 'media', 'ollama-logo.svg');
const out = path.join(root, 'media', 'icon.png');
const tmp = os.tmpdir();

const d = fs.readFileSync(logo, 'utf8').match(/d="([^"]+)"/)[1];
const whiteSvg = path.join(tmp, 'ollama-white.svg');
fs.writeFileSync(
  whiteSvg,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="256" height="256"><path fill="#ffffff" fill-rule="evenodd" d="${d}"/></svg>`,
);

const sh = (c) => execSync(c, { stdio: 'inherit' });
sh(`rsvg-convert -w 150 -h 150 "${whiteSvg}" -o "${tmp}/llama.png"`);
sh(`magick -size 256x256 xc:none -fill '#191e29' -draw "roundrectangle 8,8,247,247,46,46" "${tmp}/base.png"`);
sh(`magick -size 256x256 radial-gradient:'#343a5c'-'#00000000' "${tmp}/glow.png"`);
sh(`magick "${tmp}/glow.png" "${tmp}/base.png" -compose DstIn -composite "${tmp}/glowc.png"`);
sh(
  `magick "${tmp}/base.png" "${tmp}/glowc.png" -compose over -composite "${tmp}/llama.png" -gravity center -compose over -composite "${out}"`,
);
console.log('wrote', out);
