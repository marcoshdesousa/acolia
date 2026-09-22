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
  res.json({ iceServers, professions: PROFESSIONS, ufs: U.UFS });
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
  const me = isPatient ? req.auth.user : null;
  const where = [VISIBLE_SQL];
  const params = [];
  const profession = U.cleanText(req.query.profession, 60);
  if (profession) { where.push('p.profession = ?'); params.push(profession); }
  let rows = db.prepare(`SELECT p.* FROM professionals p WHERE ${where.join(' AND ')}`).all(...params);

  const q = U.norm(req.query.q);
  if (q) rows = rows.filter((p) => U.norm(`${p.name} ${p.specialties} ${p.profession}`).includes(q));

  // Estado: paciente logado começa no próprio estado; "todos" libera o Brasil inteiro
  let state = U.isUf(req.query.state) ? req.query.state.toUpperCase() : '';
  if (!state && me && req.query.state === undefined && !q) state = me.state;
  const city = U.norm(req.query.city);
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
    items: rows.map((p) => (me
      ? { ...publicProfessional(p, { loggedIn: true, favorite: favSet.has(p.id) }), near: near(p) === 0 }
      : publicProfessional(p))),
  });
});

router.get('/professionals/:id', (req, res) => {
  const p = /^\d+$/.test(req.params.id)
    ? db.prepare('SELECT * FROM professionals WHERE id = ?').get(Number(req.params.id))
    : db.prepare('SELECT * FROM professionals WHERE slug = ?').get(String(req.params.id).toLowerCase());
  if (!p || !isVisible(p)) throw new U.HttpError(404, 'Profissional não encontrado.');
  const isPatient = req.auth?.role === 'patient';
  const favorite = isPatient && !!db.prepare('SELECT 1 FROM favorites WHERE patient_id = ? AND professional_id = ?').get(req.auth.user.id, p.id);
  res.json(publicProfessional(p, { loggedIn: isPatient, favorite }));
});

module.exports = { router };
