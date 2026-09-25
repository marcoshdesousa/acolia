'use strict';
const express = require('express');
const { db } = require('../db');
const U = require('../util');
const { VISIBLE_SQL, publicProfessional, isVisible } = require('../serialize');
const { PROFESSIONS } = require('./auth');

const router = express.Router();

router.get('/config', (_req, res) => {
  let iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.ICE_SERVERS) {
    try { iceServers = JSON.parse(process.env.ICE_SERVERS); } catch { console.error('ICE_SERVERS inválido (JSON)'); }
  }
  res.json({ iceServers, professions: PROFESSIONS, specialties: require('../specialties').GROUPS, ufs: U.UFS, support: require('../accountState').SUPPORT_WHATSAPP });
});

// Vitrine de profissionais.
// - Todos podem buscar e filtrar (tipo, estado, município, localidade, preço).
// - Visitante sem conta: vê os profissionais em destaque, mas sem valores/localização
//   e sem favoritar ou mandar mensagem.
// - Paciente logado: por padrão vê os do seu estado, com os do seu município primeiro;
//   para ver outros estados, usa o filtro ("state=todos" mostra o Brasil todo).
function popularity() {
  // Destaque = atendimentos realizados + conversas iniciadas (o número não é exibido)
  const rows = db.prepare(`SELECT p.id,
      (SELECT COUNT(*) FROM calls c WHERE c.professional_id = p.id AND c.started_at IS NOT NULL) AS atend,
      (SELECT COUNT(*) FROM conversations v WHERE v.professional_id = p.id) AS conv
    FROM professionals p`).all();
  return new Map(rows.map((r) => [r.id, r.atend * 3 + r.conv]));
}

router.get('/professionals', (req, res) => {
  const isPatient = req.auth?.role === 'patient';
  const viewerIsPro = req.auth?.role === 'professional'; // profissional vê a vitrine completa (sem filtro automático)
  const me = isPatient ? req.auth.user : null;
  const where = [VISIBLE_SQL];
  const params = [];
  const profession = U.cleanText(req.query.profession, 60);
  if (profession) { where.push('p.profession = ?'); params.push(profession); }
  let rows = db.prepare(`SELECT p.* FROM professionals p WHERE ${where.join(' AND ')}`).all(...params);

  const q = U.norm(req.query.q);
  if (q) rows = rows.filter((p) => U.norm(`${p.name} ${p.specialties} ${p.profession}`).includes(q));
  // Filtro de especialidades: mostra quem tem todas as escolhidas (vêm separadas por "|")
  const wanted = String(req.query.specialties || '').split('|').map(U.norm).filter(Boolean).slice(0, 30);
  if (wanted.length) {
    const { toList } = require('../specialties');
    rows = rows.filter((p) => { const mine = new Set(toList(p.specialties).map(U.norm)); return wanted.every((w) => mine.has(w)); });
  }

  // Estado: paciente logado começa no próprio estado; "todos" libera o Brasil inteiro
  let state = U.isUf(req.query.state) ? req.query.state.toUpperCase() : '';
  let widened = null;
  if (!state && me && req.query.state === undefined && !q) {
    state = me.state;
    // Plataforma nova: se ainda não há ninguém no estado do paciente, mostra o Brasil todo
    // (todos atendem online), para ele não dar de cara com a vitrine vazia
    if (!rows.some((p) => p.state === state)) { state = ''; widened = 'brasil'; }
  }
  let city = U.norm(req.query.city);
  let cityLabel = U.cleanText(req.query.city, 80);
  // Filtro automático do paciente: o estado dele e, se houver profissionais no município dele, só eles
  if (me && req.query.auto === '1' && !q && req.query.state === undefined && !city) {
    if (rows.some((p) => p.state === me.state && p.city_norm === me.city_norm)) { city = me.city_norm; cityLabel = me.city; }
  }
  const place = U.norm(req.query.place);
  if (state) rows = rows.filter((p) => p.state === state);
  if (city) rows = rows.filter((p) => p.city_norm === city);
  if (place) rows = rows.filter((p) => U.norm(`${p.city} ${p.state} ${p.clinic_address}`).includes(place));

  const maxPrice = Number(req.query.max_price);
  if (maxPrice > 0) rows = rows.filter((p) => p.price_cents != null && p.price_cents <= maxPrice * 100);

  let favSet = new Set();
  if (me) {
    favSet = new Set(db.prepare('SELECT professional_id FROM favorites WHERE patient_id = ?').all(me.id).map((r) => r.professional_id));
    if (req.query.favorites === '1') rows = rows.filter((p) => favSet.has(p.id));
  }

  const pop = popularity();
  const near = (p) => (me ? (p.city_norm === me.city_norm && p.state === me.state ? 0 : p.state === me.state ? 1 : 2) : 0);
  const byPop = (a, b) => (pop.get(b.id) || 0) - (pop.get(a.id) || 0);
  const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR');
  const price = (p, dir) => (p.price_cents == null ? Infinity : dir * p.price_cents); // sem valor vai para o fim
  if (req.query.sort === 'preco_menor') rows.sort((a, b) => price(a, 1) - price(b, 1) || byPop(a, b) || byName(a, b));
  else if (req.query.sort === 'preco_maior') rows.sort((a, b) => price(a, -1) - price(b, -1) || byPop(a, b) || byName(a, b));
  else rows.sort((a, b) => near(a) - near(b) || byPop(a, b) || byName(a, b));

  res.json({
    loggedIn: !!me,
    state: state || null,
    city: city ? cityLabel : null,
    widened,
    my_state: me ? me.state : null,
    my_city: me ? me.city : null,
    items: rows.map((p) => (me
      ? { ...publicProfessional(p, { loggedIn: true, favorite: favSet.has(p.id) }), near: near(p) === 0 }
      : publicProfessional(p, { loggedIn: viewerIsPro }))),
  });
});

router.get('/professionals/:id', (req, res) => {
  const p = /^\d+$/.test(req.params.id)
    ? db.prepare('SELECT * FROM professionals WHERE id = ?').get(Number(req.params.id))
    : db.prepare('SELECT * FROM professionals WHERE slug = ?').get(String(req.params.id).toLowerCase());
  const role = req.auth?.role;
  // Perfil oficial da Acolia Brasil: só nome, Instagram, seguidores e as publicações
  if (p && p.status === 'oficial') {
    const logged = role === 'patient' || role === 'professional';
    return res.json({ ...require('../official').publicOfficial({ loggedIn: logged }), viewer_role: logged ? role : undefined });
  }
  if (!p || !isVisible(p)) throw new U.HttpError(404, 'Profissional não encontrado.');
  const isPatient = role === 'patient';
  const logged = isPatient || role === 'professional'; // profissionais também veem o perfil completo
  const favorite = isPatient && !!db.prepare('SELECT 1 FROM favorites WHERE patient_id = ? AND professional_id = ?').get(req.auth.user.id, p.id);
  const out = publicProfessional(p, { loggedIn: logged, favorite });
  if (logged) {
    out.following = !!db.prepare('SELECT 1 FROM follows WHERE follower_role = ? AND follower_id = ? AND professional_id = ?').get(role, req.auth.user.id, p.id);
    out.is_self = role === 'professional' && req.auth.user.id === p.id;
    out.viewer_role = role;
  }
  res.json(out);
});

module.exports = { router };
