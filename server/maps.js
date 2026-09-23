'use strict';
// Link do Google Maps da clínica: o profissional cola o link e o perfil mostra um
// mini mapa (sem chave de API) e o botão "Abrir no Google Maps".
const { HttpError } = require('./util');

function isGoogleMaps(u) {
  const host = u.hostname.toLowerCase();
  if (host === 'maps.app.goo.gl') return true;
  if (host === 'goo.gl') return u.pathname.startsWith('/maps');
  if (/^maps\.google\.[a-z.]+$/.test(host)) return true;
  if (/^(www\.)?google\.[a-z.]+$/.test(host)) return u.pathname.startsWith('/maps');
  return false;
}

// Aceita só links do Google Maps; devolve '' quando vazio
function cleanMapsUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { u = null; }
  if (!u || !isGoogleMaps(u) || raw.length > 1000) {
    throw new HttpError(400, 'Cole um link do Google Maps (no Google Maps: Compartilhar → Copiar link).');
  }
  u.protocol = 'https:';
  return u.toString();
}

// Links curtos (maps.app.goo.gl) não trazem o local: segue o redirecionamento uma vez
async function resolveShort(url) {
  const host = new URL(url).hostname;
  if (host !== 'maps.app.goo.gl' && host !== 'goo.gl') return url;
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
    const loc = res.headers.get('location');
    return loc && isGoogleMaps(new URL(loc)) ? loc : url;
  } catch { return url; }
}

// O que o mini mapa deve mostrar: coordenadas do link, nome do lugar, busca do link ou o endereço
function mapQuery(url, fallback = '') {
  if (url) {
    const at = url.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
    if (at) return `${at[1]},${at[2]}`;
    const place = url.match(/\/maps\/place\/([^/@?]+)/);
    if (place) return decodeURIComponent(place[1].replace(/\+/g, ' '));
    try {
      const p = new URL(url).searchParams;
      const q = p.get('q') || p.get('query') || p.get('destination');
      if (q) return q;
    } catch { /* ignora */ }
  }
  return fallback;
}

const embedUrl = (query) => (query ? `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed` : '');
const searchUrl = (query) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

module.exports = { cleanMapsUrl, resolveShort, mapQuery, embedUrl, searchUrl };
