// Erzeugt die PNG-Icons ohne Abhängigkeiten:  node scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const out = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
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
const png = (size, rgba) => {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

// Glyph in Einheitskoordinaten (liegt komplett in der Maskable-Safe-Zone).
const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const inTri = (x, y, [ax, ay], [bx, by], [cx, cy]) => {
  const d = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = d(x, y, ax, ay, bx, by), d2 = d(x, y, bx, by, cx, cy), d3 = d(x, y, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
const glyph = (x, y) =>
  inRect(x, y, 0.465, 0.27, 0.535, 0.5) ||
  inTri(x, y, [0.37, 0.44], [0.63, 0.44], [0.5, 0.6]) ||
  inRect(x, y, 0.3, 0.52, 0.355, 0.72) ||
  inRect(x, y, 0.645, 0.52, 0.7, 0.72) ||
  inRect(x, y, 0.3, 0.665, 0.7, 0.72);

const A = [139, 108, 255], B = [34, 211, 238];

function render(size, maskable) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 3;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size, y = (py + (sy + 0.5) / SS) / size;
          // Rundung der Ecken nur bei "any"-Icons; maskable füllt die ganze Fläche.
          let inside = true;
          if (!maskable) {
            const rad = 0.22;
            const cx = Math.min(Math.max(x, rad), 1 - rad), cy = Math.min(Math.max(y, rad), 1 - rad);
            inside = (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
          }
          if (!inside) continue;
          let c;
          if (glyph(x, y)) c = [255, 255, 255];
          else {
            const t = Math.min(1, Math.max(0, (x + y) / 2 * 1.25 - 0.1));
            c = A.map((v, i) => v + (B[i] - v) * t);
          }
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      }
      const n = SS * SS, i = (py * size + px) * 4;
      const cov = a / 255;
      buf[i] = cov ? r / cov : 0;
      buf[i + 1] = cov ? g / cov : 0;
      buf[i + 2] = cov ? b / cov : 0;
      buf[i + 3] = Math.round(a / n);
    }
  }
  return buf;
}

for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['maskable-192.png', 192, true],
  ['maskable-512.png', 512, true],
]) {
  fs.writeFileSync(path.join(out, name), png(size, render(size, maskable)));
  console.log('geschrieben', name);
}

fs.writeFileSync(
  path.join(out, 'icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b6cff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><rect width="512" height="512" rx="113" fill="url(#g)"/><g fill="#fff"><rect x="238" y="138" width="36" height="118"/><path d="M189 225h134l-67 80z"/><rect x="154" y="266" width="28" height="103"/><rect x="330" y="266" width="28" height="103"/><rect x="154" y="341" width="204" height="28"/></g></svg>\n`
);
console.log('geschrieben icon.svg');
