'use strict';
// Menos internet: páginas, CSS e JS vão compactados (Brotli ou gzip), já prontos na memória,
// e respostas grandes da API (JSON) também vão compactadas. Tudo com ETag: se o aparelho já
// tem a versão certa, a resposta é só "304 — não mudou" (quase nada de internet).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function walk(dir, base = dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) walk(full, base, out);
    else if (TYPES[path.extname(f.name)]) out.push(full);
  }
  return out;
}

// Pré-compacta os arquivos de texto de public/ (uma vez, na subida do servidor)
function staticCompressed(pubDir) {
  const files = new Map();
  for (const full of walk(pubDir)) {
    const raw = fs.readFileSync(full);
    const url = `/${path.relative(pubDir, full).split(path.sep).join('/')}`;
    const entry = {
      type: TYPES[path.extname(full)],
      raw,
      br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }),
      gz: zlib.gzipSync(raw, { level: 9 }),
      etag: `"${crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 20)}"`,
    };
    files.set(url, entry);
    if (url.endsWith('.html')) files.set(url.slice(0, -5), entry); // /entrar → entrar.html
    if (url === '/index.html') files.set('/', entry);
  }
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const e = files.get(req.path);
    if (!e) return next();
    res.setHeader('Content-Type', e.type);
    res.setHeader('ETag', e.etag);
    res.setHeader('Vary', 'Accept-Encoding');
    // Páginas, CSS e JS sempre conferem se mudou (com o ETag, se não mudou volta só um "304", quase
    // nada de internet): assim, depois de uma atualização, ninguém fica com código velho misturado com
    // a página nova. Ícones e imagens podem ficar 1 dia.
    const always = /^(text\/html|text\/css|text\/javascript)/.test(e.type) || req.path === '/sw.js' || req.path.endsWith('.webmanifest');
    res.setHeader('Cache-Control', always ? 'no-cache' : 'public, max-age=86400');
    if (req.headers['if-none-match'] === e.etag) return res.status(304).end();
    const accept = String(req.headers['accept-encoding'] || '');
    let body = e.raw;
    if (/\bbr\b/.test(accept)) { body = e.br; res.setHeader('Content-Encoding', 'br'); } else if (/\bgzip\b/.test(accept)) { body = e.gz; res.setHeader('Content-Encoding', 'gzip'); }
    res.setHeader('Content-Length', body.length);
    if (req.method === 'HEAD') return res.end();
    res.end(body);
  };
}

// JSON da API: acima de 1 KB vai compactado
function compressJson(req, res, next) {
  const accept = String(req.headers['accept-encoding'] || '');
  const enc = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
  if (!enc) return next();
  const json = res.json.bind(res);
  res.json = (obj) => {
    const text = JSON.stringify(obj);
    if (Buffer.byteLength(text) < 1024 || res.headersSent) return json(obj);
    const body = enc === 'br'
      ? zlib.brotliCompressSync(text, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
      : zlib.gzipSync(text, { level: 6 });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Encoding', enc);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Content-Length', body.length);
    return res.end(body);
  };
  next();
}

module.exports = { staticCompressed, compressJson };
