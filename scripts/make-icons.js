'use strict';

/** می‌سازد: آیکون‌های PNG برنامه بدون نیاز به کتابخانه‌ی گرافیکی. */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ICON_DIR = path.join(__dirname, '..', 'public', 'icons');

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
      offset += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a.map((value, i) => Math.round(value + (b[i] - value) * t));

/** حباب گفتگو با دُم، روی پس‌زمینه‌ی گرادیانی آبی-بنفش. */
function iconPixel(size, { maskable }) {
  const pad = maskable ? size * 0.19 : size * 0.12;
  const radius = maskable ? size / 2 : size * 0.23;
  const from = [59, 130, 246];
  const to = [139, 92, 246];

  return (x, y) => {
    const t = (x / size + y / size) / 2;
    const bg = mix(from, to, t);

    // گوشه‌های گرد پس‌زمینه (در حالت maskable کل مربع پر می‌شود)
    if (!maskable) {
      const cx = Math.min(Math.max(x, radius), size - radius);
      const cy = Math.min(Math.max(y, radius), size - radius);
      if (Math.hypot(x - cx, y - cy) > radius) return [0, 0, 0, 0];
    }

    // بدنه‌ی حباب
    const left = pad;
    const right = size - pad;
    const top = pad + size * 0.04;
    const bottom = size - pad - size * 0.14;
    const bubbleRadius = (bottom - top) * 0.32;
    const bx = Math.min(Math.max(x, left + bubbleRadius), right - bubbleRadius);
    const by = Math.min(Math.max(y, top + bubbleRadius), bottom - bubbleRadius);
    const inBubble =
      x >= left && x <= right && y >= top && y <= bottom &&
      Math.hypot(x - bx, y - by) <= bubbleRadius;

    // دُم حباب در گوشه‌ی پایین-راست
    const tailTop = bottom - 1;
    const tailHeight = size * 0.14;
    const tailRight = right - (right - left) * 0.18;
    const inTail =
      y >= tailTop && y <= tailTop + tailHeight &&
      x <= tailRight && x >= tailRight - (tailHeight - (y - tailTop)) * 1.1;

    if (inBubble || inTail) {
      // سه نقطه‌ی داخل حباب
      const dotY = (top + bottom) / 2;
      const dotR = (bottom - top) * 0.075;
      const spacing = (right - left) * 0.18;
      const centerX = (left + right) / 2;
      for (const dx of [-spacing, 0, spacing]) {
        if (Math.hypot(x - (centerX + dx), y - dotY) <= dotR) return [...bg, 255];
      }
      return [255, 255, 255, 255];
    }

    return [...bg, 255];
  };
}

fs.mkdirSync(ICON_DIR, { recursive: true });
const targets = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
];

for (const { file, size, maskable } of targets) {
  fs.writeFileSync(path.join(ICON_DIR, file), encodePng(size, iconPixel(size, { maskable })));
  console.log(`ساخته شد: ${file} (${size}×${size})`);
}
