'use strict';
// Descobre largura × altura de uma foto (JPG, PNG ou WEBP) lendo só o começo do arquivo.
// Nas fotos de celular (JPG) respeita a orientação (EXIF): foto "de pé" tem largura < altura.
const fs = require('node:fs');

function jpegSize(b) {
  let i = 2;
  let orientation = 1;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    // APP1 com Exif: procura a etiqueta 0x0112 (orientação)
    if (marker === 0xe1 && b.toString('latin1', i + 4, i + 8) === 'Exif') {
      const t = i + 10;
      const le = b.toString('latin1', t, t + 2) === 'II';
      const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
      const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
      try {
        const ifd = t + u32(t + 4);
        const n = u16(ifd);
        for (let k = 0; k < n; k++) {
          const e = ifd + 2 + k * 12;
          if (u16(e) === 0x0112) { orientation = u16(e + 8); break; }
        }
      } catch { /* EXIF estranho: ignora */ }
    }
    // SOF0..SOF15 (menos DHT/JPG/DAC) trazem altura e largura
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const h = b.readUInt16BE(i + 5);
      const w = b.readUInt16BE(i + 7);
      return orientation >= 5 && orientation <= 8 ? { w: h, h: w } : { w, h };
    }
    i += 2 + len;
  }
  return null;
}

function sizeOf(buf) {
  if (buf.length < 30) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpegSize(buf);
  if (buf.toString('latin1', 1, 4) === 'PNG') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const kind = buf.toString('latin1', 12, 16);
    if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  }
  return null;
}

// Lê até 256 KB do arquivo (o tamanho fica sempre no começo)
function fileSize(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const s = sizeOf(buf.subarray(0, n));
    return s && s.w > 0 && s.h > 0 ? s : null;
  } catch { return null; }
}

// Formato do feed mais próximo: Paisagem 1,91:1 · Quadrado 1:1 · Retrato 4:5
function bestAspect(w, h) {
  const r = w / h;
  if (r >= 1.4) return '1.91:1';
  if (r >= 0.9) return '1:1';
  return '4:5';
}

module.exports = { sizeOf, fileSize, bestAspect };
