'use strict';

// Renders the app icons (a ring and a dot on near-black) to PNG with no
// image libraries: analytic coverage, 4x4 supersampling, zlib for the PNG.
// Run with `npm run icons` after changing the design.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');
const BG = [7, 7, 8];
const FG = [244, 244, 245];

/**
 * Coverage of the mark at (x, y) in a unit square. `scale` shrinks the mark
 * for maskable icons, whose outer 10% may be cropped.
 * @param {number} x
 * @param {number} y
 * @param {number} scale
 */
function coverage(x, y, scale) {
  const d = Math.hypot(x - 0.5, y - 0.5) / scale;
  const ring = Math.abs(d - 0.2) <= 0.032;
  const dot = d <= 0.068;
  return ring || dot ? 1 : 0;
}

/**
 * @param {number} size
 * @param {{ scale?: number, rounded?: boolean }} options
 */
function render(size, { scale = 1, rounded = false } = {}) {
  const samples = 4;
  const rows = [];
  for (let py = 0; py < size; py += 1) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // filter: none
    for (let px = 0; px < size; px += 1) {
      let mark = 0;
      let inside = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          mark += coverage(x, y, scale);
          inside += rounded ? roundedSquare(x, y) : 1;
        }
      }
      const total = samples * samples;
      const m = mark / total;
      const a = inside / total;
      const i = 1 + px * 4;
      for (let c = 0; c < 3; c += 1) row[i + c] = Math.round(BG[c] + (FG[c] - BG[c]) * m);
      row[i + 3] = Math.round(255 * a);
    }
    rows.push(row);
  }
  return png(size, Buffer.concat(rows));
}

/** iOS-like squircle for the favicon, so it does not look like a black tile. @param {number} x @param {number} y */
function roundedSquare(x, y) {
  const r = 0.22;
  const dx = Math.max(0, Math.abs(x - 0.5) - (0.5 - r));
  const dy = Math.max(0, Math.abs(y - 0.5) - (0.5 - r));
  return dx * dx + dy * dy <= r * r ? 1 : 0;
}

/** @param {number} size @param {Buffer} raw */
function png(size, raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** @param {Buffer} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#070708"/>
  <circle cx="32" cy="32" r="12.8" fill="none" stroke="#f4f4f5" stroke-width="4.1"/>
  <circle cx="32" cy="32" r="4.35" fill="#f4f4f5"/>
</svg>
`;

fs.mkdirSync(OUT, { recursive: true });
const files = {
  'icon-32.png': render(32, { rounded: true }),
  'icon-192.png': render(192),
  'icon-512.png': render(512),
  'icon-maskable-512.png': render(512, { scale: 0.8 }),
  'apple-touch-icon.png': render(180),
};
for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), data);
fs.writeFileSync(path.join(OUT, 'icon.svg'), SVG);
console.log(`wrote ${Object.keys(files).length + 1} icons to ${path.relative(process.cwd(), OUT) || OUT}`);
