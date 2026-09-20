#!/usr/bin/env node
/**
 * Regenerates the demo room placeholders in `public/demo/`.
 *
 * These are **placeholders, not photographs**, and they say so — but quietly.
 * An earlier version stamped two text layers into every image: a caption
 * across the top and a full-width red banner across the bottom. Both fought
 * the UI. The caption collided with the MOVE-IN / MOVE-OUT badge the room card
 * already draws, and the banner rendered *twice, overlapping*, either side of
 * the compare slider's divider — on the product's hero capability.
 *
 * So the rules here are:
 *  - No caption. The interface labels the phase, the room and the pair index;
 *    an image that repeats them is noise that cannot stay aligned.
 *  - The honesty mark is a small bottom-left watermark. It stays legible, it
 *    never crosses the middle of the frame, and because both images carry it
 *    in the same corner only one is ever visible at a given divider position.
 *  - Each room is drawn differently, so a grid of four rooms reads as four
 *    rooms rather than one illustration repeated.
 *
 * Two properties are load-bearing and must survive any redraw:
 *  - Move-in is 4:3 and move-out is 16:9, so the compare slider's letterbox
 *    reconciliation is exercised by the default demo, not only by a unit test.
 *  - `living_room` pair 0 carries an obvious defect at move-out; `kitchen`
 *    pair 1 is the distractor — the light changes, nothing is damaged. That
 *    pair is the argument for the suggestion layer being flag-off.
 *
 * Usage: node scripts/make-demo-rooms.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/demo');

const DIMS = { MOVEIN: [1200, 900], MOVEOUT: [1280, 720] };

/** Muted, photographic-ish palette. Nothing saturated: this is a room, not a poster. */
const P = {
  wallTop: '#f4f1ea',
  wallBottom: '#e6e0d5',
  floorTop: '#b79572',
  floorBottom: '#94735280',
  skirting: '#d9d2c5',
  glass: '#dce7f0',
  frame: '#b9c4cd',
  wood: '#9b7551',
  woodDark: '#7d5c3e',
  fabric: '#9aa6b1',
  fabricDark: '#8593a0',
  tile: '#e9eef0',
  tileLine: '#d3dade',
  steel: '#c3c9cd',
  ink: '#6b6257',
};

const watermark = (w, h) => `
  <g opacity="0.5">
    <rect x="${Math.round(w * 0.035)}" y="${Math.round(h - h * 0.085)}" width="7" height="${Math.round(h * 0.042)}" fill="#8a5a3c"/>
    <text x="${Math.round(w * 0.035 + 16)}" y="${Math.round(h - h * 0.052)}"
      font-family="system-ui, -apple-system, sans-serif" font-size="${Math.round(h * 0.029)}"
      letter-spacing="${(h * 0.0035).toFixed(1)}" fill="#6f4a31" font-weight="600">PLACEHOLDER</text>
    <text x="${Math.round(w * 0.035 + 16)}" y="${Math.round(h - h * 0.018)}"
      font-family="system-ui, -apple-system, sans-serif" font-size="${Math.round(h * 0.023)}"
      letter-spacing="${(h * 0.002).toFixed(1)}" fill="#6f4a31">not a real photograph</text>
  </g>`;

const shell = (w, h, daylight, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">
  <defs>
    <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${P.wallTop}"/><stop offset="1" stop-color="${P.wallBottom}"/>
    </linearGradient>
    <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${P.floorTop}"/><stop offset="1" stop-color="#8f6d4c"/>
    </linearGradient>
    <radialGradient id="day" cx="0.24" cy="0.22" r="0.85">
      <stop offset="0" stop-color="#ffffff" stop-opacity="${daylight}"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="mark" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#5d4326" stop-opacity="0.85"/>
      <stop offset="0.6" stop-color="#6b4d2d" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#6b4d2d" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#wall)"/>
${body}
  <rect width="${w}" height="${h}" fill="url(#day)"/>
${watermark(w, h)}
</svg>
`;

/** Floor plane plus skirting — shared by every room. */
const floor = (w, h, y = 0.72) => `
  <rect y="${h * y}" width="${w}" height="${h * (1 - y)}" fill="url(#floor)"/>
  <rect y="${h * y - h * 0.018}" width="${w}" height="${h * 0.018}" fill="${P.skirting}"/>`;

const window_ = (x, y, w, h) => `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${P.glass}" stroke="${P.frame}" stroke-width="6"/>
  <line x1="${x + w / 2}" y1="${y}" x2="${x + w / 2}" y2="${y + h}" stroke="${P.frame}" stroke-width="5"/>
  <line x1="${x}" y1="${y + h / 2}" x2="${x + w}" y2="${y + h / 2}" stroke="${P.frame}" stroke-width="5"/>`;

function livingRoom(w, h, { defect, shifted }) {
  const sofaX = shifted ? w * 0.44 : w * 0.40;
  return `${floor(w, h)}
  ${window_(w * 0.07, h * 0.16, w * 0.22, h * 0.36)}
  <rect x="${sofaX}" y="${h * 0.50}" width="${w * 0.30}" height="${h * 0.20}" rx="10" fill="${P.fabric}"/>
  <rect x="${sofaX}" y="${h * 0.50}" width="${w * 0.30}" height="${h * 0.06}" rx="10" fill="${P.fabricDark}"/>
  <rect x="${w * 0.80}" y="${h * 0.22}" width="${w * 0.13}" height="${h * 0.50}" fill="${P.wood}"/>
  <rect x="${w * 0.80}" y="${h * 0.22}" width="${w * 0.013}" height="${h * 0.50}" fill="${P.woodDark}"/>
  ${defect ? `<ellipse cx="${w * 0.335}" cy="${h * 0.60}" rx="${w * 0.055}" ry="${h * 0.055}" fill="url(#mark)"/>` : ''}`;
}

function kitchen(w, h, { brighter }) {
  return `${floor(w, h, 0.76)}
  <rect y="${h * 0.30}" width="${w}" height="${h * 0.16}" fill="${P.tile}"/>
  <line x1="0" y1="${h * 0.38}" x2="${w}" y2="${h * 0.38}" stroke="${P.tileLine}" stroke-width="3"/>
  <rect x="${w * 0.06}" y="${h * 0.10}" width="${w * 0.34}" height="${h * 0.18}" fill="${P.wallBottom}" stroke="${P.tileLine}" stroke-width="4"/>
  <rect x="0" y="${h * 0.46}" width="${w}" height="${h * 0.06}" fill="${P.steel}"/>
  <rect x="0" y="${h * 0.52}" width="${w}" height="${h * 0.24}" fill="${P.wallBottom}"/>
  <line x1="${w * 0.33}" y1="${h * 0.52}" x2="${w * 0.33}" y2="${h * 0.76}" stroke="${P.tileLine}" stroke-width="3"/>
  <line x1="${w * 0.66}" y1="${h * 0.52}" x2="${w * 0.66}" y2="${h * 0.76}" stroke="${P.tileLine}" stroke-width="3"/>
  ${brighter ? `<rect width="${w}" height="${h}" fill="#fff3d6" opacity="0.22"/>` : ''}`;
}

function bedroom(w, h) {
  return `${floor(w, h)}
  ${window_(w * 0.70, h * 0.16, w * 0.22, h * 0.34)}
  <rect x="${w * 0.10}" y="${h * 0.46}" width="${w * 0.42}" height="${h * 0.26}" rx="8" fill="${P.fabric}"/>
  <rect x="${w * 0.10}" y="${h * 0.38}" width="${w * 0.42}" height="${h * 0.10}" rx="8" fill="${P.wallBottom}"/>
  <rect x="${w * 0.10}" y="${h * 0.44}" width="${w * 0.42}" height="${h * 0.05}" rx="6" fill="#ffffff" opacity="0.7"/>
  <rect x="${w * 0.57}" y="${h * 0.56}" width="${w * 0.09}" height="${h * 0.16}" fill="${P.wood}"/>`;
}

function bathroom(w, h) {
  const tiles = [];
  for (let x = 0; x < w; x += w * 0.075) {
    tiles.push(`<line x1="${x}" y1="0" x2="${x}" y2="${h * 0.74}" stroke="${P.tileLine}" stroke-width="2"/>`);
  }
  for (let y = 0; y < h * 0.74; y += h * 0.10) {
    tiles.push(`<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="${P.tileLine}" stroke-width="2"/>`);
  }
  return `<rect width="${w}" height="${h * 0.74}" fill="${P.tile}"/>
  ${tiles.join('\n  ')}
  ${floor(w, h, 0.74)}
  <rect x="${w * 0.12}" y="${h * 0.14}" width="${w * 0.20}" height="${h * 0.22}" rx="6" fill="${P.glass}" stroke="${P.frame}" stroke-width="5"/>
  <rect x="${w * 0.10}" y="${h * 0.46}" width="${w * 0.24}" height="${h * 0.07}" rx="8" fill="#ffffff"/>
  <rect x="${w * 0.20}" y="${h * 0.53}" width="${w * 0.04}" height="${h * 0.20}" fill="#ffffff"/>
  <rect x="${w * 0.66}" y="${h * 0.40}" width="${w * 0.18}" height="${h * 0.34}" rx="10" fill="#ffffff"/>`;
}

const ROOMS = {
  living_room: (w, h, phase, pair) =>
    livingRoom(w, h, { defect: phase === 'MOVEOUT' && pair === 0, shifted: false }),
  kitchen: (w, h, phase, pair) => kitchen(w, h, { brighter: phase === 'MOVEOUT' && pair === 1 }),
  bedroom_1: (w, h) => bedroom(w, h),
  bathroom_1: (w, h) => bathroom(w, h),
};

let n = 0;
for (const [key, draw] of Object.entries(ROOMS)) {
  for (const phase of ['MOVEIN', 'MOVEOUT']) {
    for (const pair of [0, 1]) {
      const [w, h] = DIMS[phase];
      // Move-out is a little dimmer: a flat photographed at handover, curtains
      // half drawn. It also keeps the two sides of the slider distinguishable
      // at a glance when nothing has actually changed.
      const daylight = phase === 'MOVEIN' ? 0.5 : 0.36;
      writeFileSync(
        `${OUT}/${key}-${phase.toLowerCase()}-${pair}.svg`,
        shell(w, h, daylight, draw(w, h, phase, pair)),
      );
      n += 1;
    }
  }
}
console.log(`wrote ${n} demo room placeholders to public/demo/`);
