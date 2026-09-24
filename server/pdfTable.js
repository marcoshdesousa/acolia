'use strict';
// PDF simples (sem biblioteca): uma tabela em A4 deitado, com a logo da Acolia no topo,
// título, subtítulo, numeração de páginas e o total no fim. Fonte Helvetica (acentos via WinAnsi).
// Sem limite de páginas. O PDF é montado na memória e enviado direto: nada é gravado no servidor.
const fs = require('node:fs');
const path = require('node:path');

const LOGO = fs.readFileSync(path.join(__dirname, 'assets', 'logo-pdf.jpg'));
const LOGO_W = 409, LOGO_H = 120; // tamanho da imagem em pixels

const PAGE_W = 842, PAGE_H = 595, M = 40;
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
// Texto -> bytes WinAnsi (Latin-1); o que não existe vira "?"
const latin1 = (s) => Buffer.from(String(s ?? '').replace(/[^\x20-\x7e\xa0-\xff]/g, (c) => ({ '–': '-', '—': '-', '“': '"', '”': '"', '’': "'", '…': '...' }[c] || '?')), 'latin1').toString('latin1');
// Corta o texto para caber na coluna (largura média da Helvetica ~0,52 do tamanho)
function fit(s, width, size) {
  const max = Math.max(1, Math.floor(width / (size * 0.52)));
  const t = latin1(s);
  return t.length > max ? `${t.slice(0, max - 1)}...` : t;
}

function makeTablePdf({ title, subtitle = '', columns, rows, footer = '', summary = '' }) {
  const size = 9, rowH = 18, headH = 22;
  const top = PAGE_H - M - 50; // abaixo da logo
  const perPage = Math.max(1, Math.floor((top - 40 - M - headH) / rowH));
  const pages = [];
  for (let i = 0; i < Math.max(1, rows.length); i += perPage) pages.push(rows.slice(i, i + perPage));
  // o total vai logo depois da última linha; se a última página estiver cheia, ganha uma página só para ele
  if (summary && pages[pages.length - 1].length > perPage - 2) pages.push([]);
  const tableW = PAGE_W - 2 * M;
  const total = columns.reduce((a, c) => a + c.width, 0);
  const cols = columns.map((c) => ({ ...c, w: (c.width / total) * tableW }));

  const streams = pages.map((chunk, pi) => {
    const out = [];
    const text = (x, y, s, sz = size, font = 'F1', rgb = '0.15 0.2 0.18') => out.push(`BT ${rgb} rg /${font} ${sz} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (${esc(s)}) Tj ET`);
    // logo + título
    const lh = 34, lw = (LOGO_W / LOGO_H) * lh;
    out.push(`q ${lw.toFixed(1)} 0 0 ${lh} ${M} ${PAGE_H - M - lh} cm /Logo Do Q`);
    text(M + lw + 18, PAGE_H - M - 14, latin1(title), 15, 'F2');
    if (subtitle) text(M + lw + 18, PAGE_H - M - 30, latin1(subtitle), 9, 'F1', '0.38 0.43 0.41');
    let y = top - 10;
    // cabeçalho da tabela
    out.push(`0.247 0.333 0.314 rg ${M} ${y - headH + 6} ${tableW} ${headH} re f`);
    let x = M;
    for (const c of cols) { text(x + 6, y - 9, fit(c.label, c.w - 10, size), size, 'F2', '1 1 1'); x += c.w; }
    y -= headH;
    chunk.forEach((r, ri) => {
      if (ri % 2 === 1) out.push(`0.945 0.941 0.922 rg ${M} ${y - rowH + 6} ${tableW} ${rowH} re f`);
      let cx = M;
      for (const c of cols) { text(cx + 6, y - 7, fit(r[c.key], c.w - 10, size)); cx += c.w; }
      y -= rowH;
    });
    if (!rows.length) { text(M + 6, y - 10, latin1('Nenhum paciente encontrado.'), 10, 'F1', '0.38 0.43 0.41'); y -= rowH; }
    if (summary && pi === pages.length - 1) {
      out.push(`0.898 0.922 0.91 rg ${M} ${y - 26} ${tableW} 26 re f`);
      text(M + 8, y - 17, latin1(summary), 11, 'F2', '0.18 0.25 0.235');
    }
    // rodapé
    out.push(`0.89 0.886 0.863 RG 0.5 w ${M} ${M + 10} m ${PAGE_W - M} ${M + 10} l S`);
    if (footer) text(M, M - 2, latin1(footer), 8, 'F1', '0.38 0.43 0.41');
    text(PAGE_W - M - 70, M - 2, latin1(`Página ${pi + 1} de ${pages.length}`), 8, 'F1', '0.38 0.43 0.41');
    return Buffer.from(out.join('\n'), 'latin1');
  });

  // Montagem dos objetos do PDF
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const f1 = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  const f2 = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));
  const logo = add(Buffer.concat([
    Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${LOGO_W} /Height ${LOGO_H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${LOGO.length} >>\nstream\n`),
    LOGO, Buffer.from('\nendstream'),
  ]));
  const kids = [];
  for (const st of streams) {
    const content = add(Buffer.concat([Buffer.from(`<< /Length ${st.length} >>\nstream\n`), st, Buffer.from('\nendstream')]));
    kids.push(add(Buffer.from(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${content} 0 R /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> /XObject << /Logo ${logo} 0 R >> >> >>`)));
  }
  objs[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  objs[pagesObj - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);

  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = parts[0].length;
  const xref = [];
  objs.forEach((body, i) => {
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    xref.push(offset);
    offset += chunk.length;
    parts.push(chunk);
  });
  const xrefStr = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${xref.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  parts.push(Buffer.from(`${xrefStr}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(parts);
}

module.exports = { makeTablePdf };
