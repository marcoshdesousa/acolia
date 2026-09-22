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
// Visitante: vê todos, mas sem valores/localização (e sem filtrar por local).
// Paciente logado: vê tudo, com os da sua cidade primeiro, depois do seu estado.
router.get('/professionals', (req, res) => {
  const isPatient = req.auth?.role === 'patient';
  const where = [VISIBLE_SQL];
  const params = [];
  const q = U.norm(req.query.q);
  const profession = U.cleanText(req.query.profession, 60);
  if (profession) { where.push('p.profession = ?'); params.push(profession); }

  let rows = db.prepare(`SELECT p.* FROM professionals p WHERE ${where.join(' AND ')}`).all(...params);
  if (q) rows = rows.filter((p) => U.norm(`${p.name} ${p.specialties}`).includes(q));

  let favSet = new Set();
  if (isPatient) {
    const me = req.auth.user;
    const state = U.isUf(req.query.state) ? req.query.state.toUpperCase() : '';
    const city = U.norm(req.query.city);
    const place = U.norm(req.query.place); // busca livre de localidade
    if (state) rows = rows.filter((p) => p.state === state);
    if (city) rows = rows.filter((p) => p.city_norm === city);
    if (place) rows = rows.filter((p) => U.norm(`${p.city} ${p.state} ${p.clinic_address}`).includes(place));
    if (req.query.favorites === '1') {
      const ids = new Set(db.prepare('SELECT professional_id FROM favorites WHERE patient_id = ?').all(me.id).map((r) => r.professional_id));
      rows = rows.filter((p) => ids.has(p.id));
    }
    favSet = new Set(db.prepare('SELECT professional_id FROM favorites WHERE patient_id = ?').all(me.id).map((r) => r.professional_id));
    const score = (p) => (p.city_norm === me.city_norm && p.state === me.state ? 0 : p.state === me.state ? 1 : 2);
    rows.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name, 'pt-BR'));
    return res.json({
      loggedIn: true,
      items: rows.map((p) => ({ ...publicProfessional(p, { loggedIn: true, favorite: favSet.has(p.id) }), near: score(p) === 0 })),
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  res.json({ loggedIn: false, items: rows.map((p) => publicProfessional(p)) });
});

router.get('/professionals/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM professionals WHERE id = ?').get(Number(req.params.id));
  if (!p || !isVisible(p)) throw new U.HttpError(404, 'Profissional não encontrado.');
  const isPatient = req.auth?.role === 'patient';
  const favorite = isPatient && !!db.prepare('SELECT 1 FROM favorites WHERE patient_id = ? AND professional_id = ?').get(req.auth.user.id, p.id);
  res.json(publicProfessional(p, { loggedIn: isPatient, favorite }));
});

module.exports = { router };
