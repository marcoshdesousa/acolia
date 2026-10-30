'use strict';
// Planos e evolução (portais Nutri e Fisio, versão 2.1). O profissional monta e manda pelo chat:
//   Acolia Nutri → Plano alimentar (refeições, alimentos, quantidade e substituições, água e orientações).
//                  O paciente vê o plano e a lista de compras (marca o que já comprou).
//   Acolia Fisio → Plano de exercícios (séries, repetições, descanso, vídeo e observações, frequência).
//                  O paciente toca em "Fiz hoje" e o profissional vê a adesão dos últimos dias.
//   Evolução    → Nutri: peso e medidas; Fisio: dor de 0 a 10. O profissional registra e o paciente vê o gráfico.
// Quem pode montar: Nutri: nutricionista e nutrólogo (plano alimentar); os outros do Nutri mandam "Cardápio e
// orientações" (não é prescrição). Fisio: todos (Pilates e yoga: "Plano de aulas e exercícios").
// A secretária não monta nem vê planos (são do atendimento; ver server/secretary.js).
const express = require('express');
const { db } = require('../db');
const U = require('../util');
const A = require('../auth');

db.exec(`CREATE TABLE IF NOT EXISTS care_plans (
  id INTEGER PRIMARY KEY,
  professional_id INTEGER NOT NULL,
  patient_id INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- alimentar | exercicios
  title TEXT NOT NULL,
  data TEXT NOT NULL,                 -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_plans_patient ON care_plans(patient_id, id);
CREATE INDEX IF NOT EXISTS idx_plans_pro ON care_plans(professional_id, id);
CREATE TABLE IF NOT EXISTS care_plan_checks (
  plan_id INTEGER NOT NULL,
  item TEXT NOT NULL,                 -- d:AAAA-MM-DD (fez os exercícios no dia) | s:<n> (item da lista de compras)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (plan_id, item)
);
CREATE TABLE IF NOT EXISTS care_evolution (
  id INTEGER PRIMARY KEY,
  professional_id INTEGER NOT NULL,
  patient_id INTEGER NOT NULL,
  date TEXT NOT NULL,                 -- AAAA-MM-DD
  data TEXT NOT NULL,                 -- JSON: nutri {weight, waist, hip, fat, note} | fisio {pain, note}
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_evo_patient ON care_evolution(patient_id, professional_id, date);`);

const PRESCRIBE = ['Nutricionista', 'Nutrólogo(a)'];
// O que cada profissional monta (null: nada, por exemplo no Psi)
function kindFor(pro) {
  const portal = pro.portal || 'psi';
  if (portal === 'nutri') return { kind: 'alimentar', title: PRESCRIBE.includes(pro.profession) ? 'Plano alimentar' : 'Cardápio e orientações', evo: 'nutri' };
  if (portal === 'fisio') return { kind: 'exercicios', title: ['Instrutor(a) de Pilates', 'Instrutor(a) de yoga'].includes(pro.profession) ? 'Plano de aulas e exercícios' : 'Plano de exercícios', evo: 'fisio' };
  return null;
}

const txt = (v, n) => U.cleanText(v, n);
const num = (v, min, max) => { const x = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(x) && x >= min && x <= max ? Math.round(x * 10) / 10 : null; };
// Vídeo do exercício: só link do YouTube (o paciente assiste no próprio YouTube e volta para a Acolia)
function youtube(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  let url;
  try { url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { url = null; }
  const host = url ? url.hostname.replace(/^www\.|^m\./, '') : '';
  if (!url || !['youtube.com', 'youtu.be', 'youtube-nocookie.com'].includes(host) || s.length > 300) throw new U.HttpError(400, 'O link do vídeo precisa ser do YouTube (youtube.com ou youtu.be).');
  url.protocol = 'https:';
  return url.toString();
}

// Limpa o que veio da tela
function cleanData(kind, d = {}) {
  if (kind === 'alimentar') {
    const meals = (Array.isArray(d.meals) ? d.meals : []).slice(0, 12).map((m) => ({
      name: txt(m.name, 60), time: /^\d{2}:\d{2}$/.test(m.time || '') ? m.time : '',
      items: (Array.isArray(m.items) ? m.items : []).slice(0, 20).map((i) => ({ food: txt(i.food, 120), qty: txt(i.qty, 60), subs: txt(i.subs, 200) })).filter((i) => i.food),
    })).filter((m) => m.name && m.items.length);
    if (!meals.length) throw new U.HttpError(400, 'Coloque pelo menos uma refeição com um alimento.');
    return { meals, water: txt(d.water, 40), notes: txt(d.notes, 1500) };
  }
  const items = (Array.isArray(d.items) ? d.items : []).slice(0, 30).map((i) => ({
    name: txt(i.name, 100), times: txt(i.times, 40), reps: txt(i.reps, 40), sets: txt(i.sets, 20), rest: txt(i.rest, 30), video: youtube(i.video), notes: txt(i.notes, 300),
  })).filter((i) => i.name);
  if (!items.length) throw new U.HttpError(400, 'Coloque pelo menos um exercício.');
  return { items, freq: txt(d.freq, 60), notes: txt(d.notes, 1500) };
}

// Lista de compras: os alimentos do plano, sem repetir
function shoppingList(data) {
  const seen = new Map();
  for (const m of data.meals || []) for (const i of m.items) { const k = U.norm(i.food); if (!seen.has(k)) seen.set(k, i.food); }
  return [...seen.values()];
}

function planOut(p, viewer) {
  const data = JSON.parse(p.data);
  const checks = db.prepare('SELECT item FROM care_plan_checks WHERE plan_id = ?').all(p.id).map((r) => r.item);
  const pro = db.prepare('SELECT name, profession, registry, portal FROM professionals WHERE id = ?').get(p.professional_id) || {};
  const out = { id: p.id, kind: p.kind, title: p.title, data, created_at: p.created_at, professional: pro, viewer };
  if (p.kind === 'alimentar') out.shopping = shoppingList(data).map((food, i) => ({ i, food, done: checks.includes(`s:${i}`) }));
  if (p.kind === 'exercicios') {
    const days = checks.filter((c) => c.startsWith('d:')).map((c) => c.slice(2)).sort();
    const today = U.todayISO();
    const last14 = Array.from({ length: 14 }, (_, i) => U.addDaysISO(today, i - 13));
    out.done_today = days.includes(today);
    out.days = last14.map((d) => ({ date: d, done: days.includes(d) }));
    out.total_days = days.length;
  }
  return out;
}

const router = express.Router();
router.use(A.requireRole('professional', 'patient'));

function canSee(req, p) {
  return p && ((req.auth.role === 'professional' && p.professional_id === req.auth.user.id) || (req.auth.role === 'patient' && p.patient_id === req.auth.user.id));
}
const evoOf = (proId, patientId) => db.prepare('SELECT id, date, data FROM care_evolution WHERE professional_id = ? AND patient_id = ? ORDER BY date, id')
  .all(proId, patientId).map((e) => ({ id: e.id, date: e.date, ...JSON.parse(e.data) }));

// O que o profissional pode montar nesta conversa + os planos e a evolução do paciente com ele
router.get('/conversation/:id', (req, res) => {
  const c = require('./chat').loadConversation(req, req.params.id);
  const pro = db.prepare('SELECT * FROM professionals WHERE id = ?').get(c.professional_id);
  const k = kindFor(pro);
  const plans = db.prepare('SELECT * FROM care_plans WHERE conversation_id = ? ORDER BY id DESC').all(c.id).map((p) => planOut(p, req.auth.role));
  res.json({ can: req.auth.role === 'professional' ? k : null, evo: k?.evo || null, plans, evolution: evoOf(c.professional_id, c.patient_id),
    patient: req.auth.role === 'professional' ? (db.prepare('SELECT name FROM patients WHERE id = ?').get(c.patient_id) || {}).name : undefined });
});

// Paciente: todos os planos e a evolução, de todos os profissionais
router.get('/mine', (req, res) => {
  if (req.auth.role !== 'patient') throw new U.HttpError(403, 'Só para pacientes.');
  const plans = db.prepare('SELECT * FROM care_plans WHERE patient_id = ? ORDER BY id DESC LIMIT 60').all(req.auth.user.id).map((p) => planOut(p, 'patient'));
  const pros = db.prepare('SELECT DISTINCT professional_id FROM care_evolution WHERE patient_id = ?').all(req.auth.user.id);
  const evolution = pros.map(({ professional_id: id }) => {
    const pro = db.prepare('SELECT name, portal FROM professionals WHERE id = ?').get(id) || {};
    return { professional: pro, evo: pro.portal === 'fisio' ? 'fisio' : 'nutri', items: evoOf(id, req.auth.user.id) };
  });
  res.json({ plans, evolution });
});

// Modelos: os planos que o profissional já mandou (para começar de um anterior)
router.get('/templates', (req, res) => {
  if (req.auth.role !== 'professional') throw new U.HttpError(403, 'Só para profissionais.');
  const rows = db.prepare('SELECT id, kind, title, data, created_at, patient_id FROM care_plans WHERE professional_id = ? ORDER BY id DESC LIMIT 20').all(req.auth.user.id);
  res.json({ items: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, data: JSON.parse(r.data), created_at: r.created_at,
    patient: (db.prepare('SELECT name FROM patients WHERE id = ?').get(r.patient_id) || {}).name || '' })) });
});

router.get('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM care_plans WHERE id = ?').get(Number(req.params.id));
  if (!canSee(req, p)) throw new U.HttpError(404, 'Plano não encontrado.');
  res.json(planOut(p, req.auth.role));
});

// Monta e manda o plano na conversa
router.post('/', (req, res) => {
  if (req.auth.role !== 'professional') throw new U.HttpError(403, 'Só o profissional monta planos.');
  const chat = require('./chat');
  const c = chat.loadConversation(req, req.body.conversation_id);
  const k = kindFor(req.auth.user);
  if (!k) throw new U.HttpError(403, 'Planos são dos portais Nutri e Fisio.');
  const data = cleanData(k.kind, req.body.data);
  const title = txt(req.body.title, 80) || k.title;
  const info = db.prepare('INSERT INTO care_plans (professional_id, patient_id, conversation_id, kind, title, data) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.auth.user.id, c.patient_id, c.id, k.kind, title, JSON.stringify(data));
  const id = Number(info.lastInsertRowid);
  const msg = chat.postMessage(req, c, 'plan', `${id}|${title}`);
  res.status(201).json({ plan: planOut(db.prepare('SELECT * FROM care_plans WHERE id = ?').get(id), 'professional'), message: msg });
});

// Paciente marca: "Fiz hoje" (exercícios) ou um item da lista de compras
router.post('/:id/check', (req, res) => {
  const p = db.prepare('SELECT * FROM care_plans WHERE id = ?').get(Number(req.params.id));
  if (!canSee(req, p) || req.auth.role !== 'patient') throw new U.HttpError(404, 'Plano não encontrado.');
  let item;
  if (p.kind === 'exercicios') item = `d:${U.todayISO()}`;
  else {
    const i = Number(req.body.item);
    if (!Number.isInteger(i) || i < 0 || i >= shoppingList(JSON.parse(p.data)).length) throw new U.HttpError(400, 'Item inválido.');
    item = `s:${i}`;
  }
  if (req.body.on === false) db.prepare('DELETE FROM care_plan_checks WHERE plan_id = ? AND item = ?').run(p.id, item);
  else db.prepare('INSERT OR IGNORE INTO care_plan_checks (plan_id, item) VALUES (?, ?)').run(p.id, item);
  res.json(planOut(p, 'patient'));
});

// Evolução: o profissional registra (Nutri: peso e medidas; Fisio: dor de 0 a 10)
router.post('/evolution', (req, res) => {
  if (req.auth.role !== 'professional') throw new U.HttpError(403, 'Só o profissional registra a evolução.');
  const c = require('./chat').loadConversation(req, req.body.conversation_id);
  const k = kindFor(req.auth.user);
  if (!k) throw new U.HttpError(403, 'A evolução é dos portais Nutri e Fisio.');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') && req.body.date <= U.todayISO() ? req.body.date : U.todayISO();
  const b = req.body;
  let data;
  if (k.evo === 'nutri') {
    data = { weight: num(b.weight, 2, 400), waist: num(b.waist, 20, 300), hip: num(b.hip, 20, 300), fat: num(b.fat, 1, 80), note: txt(b.note, 300) };
    if (data.weight == null && data.waist == null && data.hip == null && data.fat == null) throw new U.HttpError(400, 'Coloque pelo menos o peso ou uma medida.');
  } else {
    data = { pain: num(b.pain, 0, 10), note: txt(b.note, 300) };
    if (data.pain == null) throw new U.HttpError(400, 'Escolha a dor de 0 a 10.');
  }
  db.prepare('INSERT INTO care_evolution (professional_id, patient_id, date, data) VALUES (?, ?, ?, ?)').run(req.auth.user.id, c.patient_id, date, JSON.stringify(data));
  res.status(201).json({ evolution: evoOf(req.auth.user.id, c.patient_id) });
});

router.delete('/evolution/:id', (req, res) => {
  if (req.auth.role !== 'professional') throw new U.HttpError(403, 'Só o profissional.');
  const e = db.prepare('SELECT * FROM care_evolution WHERE id = ? AND professional_id = ?').get(Number(req.params.id), req.auth.user.id);
  if (!e) throw new U.HttpError(404, 'Registro não encontrado.');
  db.prepare('DELETE FROM care_evolution WHERE id = ?').run(e.id);
  res.json({ evolution: evoOf(e.professional_id, e.patient_id) });
});

// Conta apagada: some tudo da pessoa
function purge(role, id) {
  const col = role === 'patient' ? 'patient_id' : 'professional_id';
  db.prepare(`DELETE FROM care_plan_checks WHERE plan_id IN (SELECT id FROM care_plans WHERE ${col} = ?)`).run(id);
  db.prepare(`DELETE FROM care_plans WHERE ${col} = ?`).run(id);
  db.prepare(`DELETE FROM care_evolution WHERE ${col} = ?`).run(id);
}

module.exports = { router, kindFor, purge, shoppingList };
