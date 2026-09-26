// Renders the extension icons (extension/icons/icon-{16,32,48,128}.png) without dependencies.
// Shapes are drawn as signed distance fields and supersampled for anti-aliasing.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

const SIZES = [16, 32, 48, 128];
const SAMPLES = 4; // per axis

const BLUE_TOP = [0x3b, 0x82, 0xf6];
const BLUE_BOTTOM = [0x1a, 0x56, 0xc4];
const WHITE = [0xff, 0xff, 0xff];
const LINE = [0x9d, 0xb8, 0xe8];
const GREEN = [0x16, 0xa3, 0x4a];

// Signed distance to a rounded rectangle (negative = inside).
function roundRect(x, y, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const qx = Math.abs(x - cx) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(y - cy) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;

// Returns [r, g, b, a] (0..255, a 0..1) for a point in unit space.
function shade(x, y) {
  let color = null;
  const paint = (rgb) => { color = rgb; };

  if (roundRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22) <= 0) {
    const t = y;
    paint(BLUE_TOP.map((c, i) => c + (BLUE_BOTTOM[i] - c) * t));
  }
  // Document
  if (roundRect(x, y, 0.24, 0.16, 0.68, 0.74, 0.07) <= 0) paint(WHITE);
  for (const ly of [0.30, 0.41, 0.52]) {
    if (roundRect(x, y, 0.33, ly - 0.03, 0.59, ly + 0.03, 0.03) <= 0) paint(LINE);
  }
  // Download badge
  if (circle(x, y, 0.70, 0.70, 0.22) <= 0) paint(WHITE);
  if (circle(x, y, 0.70, 0.70, 0.18) <= 0) {
    paint(GREEN);
    const shaft = roundRect(x, y, 0.675, 0.58, 0.725, 0.74, 0.02) <= 0;
    // Arrow head: triangle pointing down, tip at (0.70, 0.81)
    const head = y >= 0.69 && y <= 0.81 && Math.abs(x - 0.70) <= (0.81 - y) * 0.9;
    if (shaft || head) paint(WHITE);
  }
  return color;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = shade((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; hits++;
        }
      }
      const i = (py * size + px) * 4;
      if (hits) {
        pixels[i] = Math.round(r / hits);
        pixels[i + 1] = Math.round(g / hits);
        pixels[i + 2] = Math.round(b / hits);
        pixels[i + 3] = Math.round((hits / SAMPLES ** 2) * 255);
      }
    }
  }
  return encodePng(size, pixels);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = new URL('../extension/icons/', import.meta.url);
mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  writeFileSync(new URL(`icon-${size}.png`, outDir), render(size));
  console.log(`icons/icon-${size}.png`);
}
