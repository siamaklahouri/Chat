'use strict';

const zlib = require('node:zlib');

/** یک PNG کوچک واقعی می‌سازد تا آپلود، تشخیص فرمت را رد کند. */
function pngBuffer(width = 8, height = 6) {
  const crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  // هر سطر با بایت «نوع فیلتر» شروع می‌شود و تنها مقدارهای ۰ تا ۴ مجازند؛
  // اگر این بایت را هم مثل پیکسل‌ها پر کنیم، سرور (که فقط سرآیند را می‌خواند)
  // راضی می‌شود ولی هیچ رمزگشای واقعی‌ای عکس را باز نمی‌کند.
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height, 0x40);
  for (let y = 0; y < height; y += 1) raw[y * stride] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { pngBuffer };
