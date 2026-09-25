'use strict';
// Redes sociais do perfil: Instagram, TikTok, X e YouTube (só essas).
// Cada campo aceita o @ ou o link do perfil DA PRÓPRIA rede: link do YouTube no campo do X (ou
// qualquer outra troca) é recusado. Guarda só o que identifica o perfil e monta o link na hora.
const U = require('./util');

const NETS = {
  instagram: { name: 'Instagram', col: 'instagram', hosts: ['instagram.com', 'instagr.am'] },
  tiktok: { name: 'TikTok', col: 'tiktok', hosts: ['tiktok.com'] },
  x: { name: 'X', col: 'x_handle', hosts: ['x.com', 'twitter.com'] },
  youtube: { name: 'YouTube', col: 'youtube', hosts: ['youtube.com', 'youtu.be'] },
};
const ORDER = ['instagram', 'tiktok', 'x', 'youtube'];

function hostNet(host) {
  host = host.toLowerCase().replace(/^(www\.|m\.|mobile\.|vm\.|vt\.)/, '');
  return ORDER.find((n) => NETS[n].hosts.includes(host)) || null;
}

// Separa "link" de "@": tem domínio (algo.com/…) → é link
// (um @ como "joao.silva" também tem ponto: só é link com http, com "/" ou com o domínio de uma das redes)
function parseLink(v) {
  const m = /^(https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})(\/[^\s]*)?$/i.exec(v);
  if (!m || !(m[1] || m[3] || hostNet(m[2]))) return null;
  m.splice(1, 1);
  let path = (m[2] || '/').split(/[?#]/)[0];
  try { path = decodeURIComponent(path); } catch { /* fica como veio */ }
  return { host: m[1], path };
}

const bad = (net, extra) => new U.HttpError(400, `${NETS[net].name}: ${extra}`);

function clean(net, value) {
  let v = String(value || '').trim();
  if (!v) return '';
  const link = parseLink(v);
  if (link) {
    const owner = hostNet(link.host);
    if (!owner) throw bad(net, `esse link não é do ${NETS[net].name}. Coloque o seu @ ou o link do seu perfil no ${NETS[net].name}.`);
    if (owner !== net) throw bad(net, `esse link é do ${NETS[owner].name}. Coloque ele no campo do ${NETS[owner].name}.`);
    const parts = link.path.split('/').filter(Boolean);
    if (net === 'youtube') {
      if (/youtu\.be$/i.test(link.host) || ['watch', 'shorts', 'live', 'embed', 'playlist'].includes(parts[0])) {
        throw bad(net, 'esse é o link de um vídeo. Coloque o link do seu canal (ou o @ do canal).');
      }
      if (parts[0]?.startsWith('@')) v = parts[0];
      else if (['channel', 'c', 'user'].includes(parts[0]) && parts[1]) v = `${parts[0]}/${parts[1]}`;
      else throw bad(net, 'coloque o link do seu canal (youtube.com/@seucanal) ou o @ do canal.');
    } else if (net === 'tiktok') {
      if (!parts[0]?.startsWith('@')) throw bad(net, 'coloque o link do seu perfil (tiktok.com/@seu.usuario) ou só o seu @.');
      v = parts[0];
    } else {
      if (!parts[0]) throw bad(net, 'coloque o link do seu perfil ou só o seu @.');
      v = parts[0];
    }
  } else if (/\s|\//.test(v) || /\.(com|net|org)(\.br)?$/i.test(v)) {
    throw bad(net, `coloque o seu @ ou o link do seu perfil no ${NETS[net].name}.`);
  }
  // Agora v é o @ (com ou sem o @), ou "channel/…" do YouTube
  if (net === 'youtube') {
    if (/^(channel|c|user)\//.test(v)) {
      if (!/^(channel|c|user)\/[A-Za-z0-9._-]{2,100}$/.test(v)) throw bad(net, 'link do canal inválido.');
      return v;
    }
    const h = v.replace(/^@+/, '');
    if (!/^[A-Za-z0-9._-]{3,30}$/.test(h)) throw bad(net, '@ do canal inválido (letras, números, ponto, - e _).');
    return '@' + h;
  }
  const h = v.replace(/^@+/, '');
  if (net === 'instagram' && !/^[A-Za-z0-9._]{1,30}$/.test(h)) throw bad(net, '@ inválido (letras, números, ponto e _).');
  if (net === 'tiktok' && !/^[A-Za-z0-9._]{2,24}$/.test(h)) throw bad(net, '@ inválido (letras, números, ponto e _).');
  if (net === 'x') {
    if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) throw bad(net, '@ inválido (até 15 letras, números e _).');
    if (['home', 'i', 'intent', 'search', 'explore', 'settings', 'share'].includes(h.toLowerCase())) throw bad(net, 'coloque o link do seu perfil ou só o seu @.');
  }
  return h;
}

function url(net, stored) {
  if (!stored) return '';
  if (net === 'instagram') return `https://www.instagram.com/${encodeURIComponent(stored)}/`;
  if (net === 'tiktok') return `https://www.tiktok.com/@${encodeURIComponent(stored)}`;
  if (net === 'x') return `https://x.com/${encodeURIComponent(stored)}`;
  return `https://www.youtube.com/${stored.split('/').map((s) => encodeURIComponent(s).replace(/^%40/, '@')).join('/')}`;
}

// Lê do corpo do pedido: só mexe nas redes que vieram (as outras ficam como estão)
function fromBody(body, current) {
  const out = {};
  for (const net of ORDER) {
    const key = net;
    out[NETS[net].col] = body[key] === undefined ? (current?.[NETS[net].col] || '') : clean(net, body[key]);
  }
  return out;
}

// Para mostrar no perfil: só o ícone e a cor da rede (o link vai no botão)
function list(p) {
  return ORDER.filter((n) => p[NETS[n].col]).map((n) => ({ net: n, name: NETS[n].name, url: url(n, p[NETS[n].col]) }));
}

// Para preencher o formulário
function values(p) {
  const o = {};
  for (const n of ORDER) {
    const s = p[NETS[n].col] || '';
    o[n] = !s ? '' : n === 'youtube' ? (s.startsWith('@') ? s : url(n, s)) : '@' + s;
  }
  return o;
}

module.exports = { NETS, ORDER, clean, url, fromBody, list, values };
