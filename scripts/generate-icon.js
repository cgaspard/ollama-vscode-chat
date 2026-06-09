#!/usr/bin/env node
// Generate media/icon.png — a dark slate rounded square with a purple glow and
// a SOLID purple-gradient llama mascot (filled body, dark face/contour detail),
// to match the colorful sibling extensions (LM Studio Code / BYOM).
//
// The Ollama logo path is line-art, not a closed silhouette, so we can't just
// fill it. Instead we render a hand-authored body silhouette (BODY_PATH, traced
// to sit just inside the original outline) with the gradient, then overlay the
// original line-art in a dark indigo for the eyes/snout/contour definition.
//
// Requires `rsvg-convert` (librsvg) and ImageMagick (`magick`) locally. The PNG
// is committed, so this only runs on a maintainer machine, not in CI.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const logo = path.join(root, 'media', 'ollama-logo.svg');
const out = path.join(root, 'media', 'icon.png');
const tmp = os.tmpdir();

// Original line-art path (drawn dark on top for facial/contour definition).
const d = fs.readFileSync(logo, 'utf8').match(/d="([^"]+)"/)[1];

// Solid body silhouette, hand-traced to the llama's outer contour (viewBox
// coords match the logo's 0..24). Head + two ears + body lobe + two legs.
const BODY_PATH =
  'M7.7 2.2 C7.0 2.6 6.7 4.4 6.9 6.2 C5.6 7.0 4.8 8.4 4.7 10.2 ' +
  'C4.6 11.6 4.9 12.6 5.5 13.4 C4.9 14.6 4.6 16.0 4.8 17.4 ' +
  'C5.0 18.8 4.6 20.4 4.4 21.6 C4.3 22.2 4.7 22.6 5.3 22.5 ' +
  'C6.0 22.4 6.4 21.6 6.4 20.6 C6.4 19.4 6.2 18.4 6.7 17.6 L6.7 17.6 ' +
  'C7.6 18.7 9.6 19.4 12.0 19.4 C14.4 19.4 16.4 18.7 17.3 17.6 ' +
  'C17.8 18.4 17.6 19.4 17.6 20.6 C17.6 21.6 18.0 22.4 18.7 22.5 ' +
  'C19.3 22.6 19.7 22.2 19.6 21.6 C19.4 20.4 19.0 18.8 19.2 17.4 ' +
  'C19.4 16.0 19.1 14.6 18.5 13.4 C19.1 12.6 19.4 11.6 19.3 10.2 ' +
  'C19.2 8.4 18.4 7.0 17.1 6.2 C17.3 4.4 17.0 2.6 16.3 2.2 ' +
  'C15.6 1.9 14.9 3.4 14.7 5.2 C13.9 4.8 13.0 4.6 12.0 4.6 ' +
  'C11.0 4.6 10.1 4.8 9.3 5.2 C9.1 3.4 8.4 1.9 7.7 2.2 Z';

const silSvg = path.join(tmp, 'ollama-sil.svg');
fs.writeFileSync(
  silSvg,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="600" height="600">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#c4b1ff"/>
      <stop offset="50%" stop-color="#8b6cff"/>
      <stop offset="100%" stop-color="#6a45e6"/>
    </linearGradient>
  </defs>
  <path fill="url(#g)" d="${BODY_PATH}"/>
</svg>`,
);

const darkSvg = path.join(tmp, 'ollama-dark.svg');
fs.writeFileSync(
  darkSvg,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="600" height="600"><path fill="#2b1d63" fill-rule="evenodd" d="${d}"/></svg>`,
);

const sh = (c) => execSync(c, { stdio: 'inherit' });
sh(`rsvg-convert -w 600 -h 600 "${silSvg}" -o "${tmp}/sil.png"`);
sh(`rsvg-convert -w 600 -h 600 "${darkSvg}" -o "${tmp}/dark.png"`);

// Dark rounded-square base with a purple radial glow behind the mascot.
sh(`magick -size 256x256 xc:none -fill '#191e29' -draw "roundrectangle 8,8,247,247,46,46" "${tmp}/base.png"`);
sh(`magick -size 256x256 radial-gradient:'#4733a6'-'#00000000' "${tmp}/glow.png"`);
sh(`magick "${tmp}/glow.png" "${tmp}/base.png" -compose DstIn -composite "${tmp}/glowc.png"`);

// Compose: base → purple glow → filled gradient body → dark line-art detail.
sh(
  `magick "${tmp}/base.png" ` +
    `"${tmp}/glowc.png" -compose over -composite ` +
    `\\( "${tmp}/sil.png" -resize 150x150 \\) -gravity center -compose over -composite ` +
    `\\( "${tmp}/dark.png" -resize 150x150 \\) -gravity center -compose over -composite ` +
    `"${out}"`,
);
console.log('wrote', out);
