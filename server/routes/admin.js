'use strict';
// Área administrativa. Por segurança/sigilo, NÃO existe aqui nenhuma rota que
// leia mensagens ou dados de atendimentos (chamadas).
const express = require('express');
const { db } = require('../db');
const U = require('../util');
const A = require('../auth');
const { isVisible, parsePackages } = require('../serialize');
const { validateProfessionalInput, insertProfessional, requirePassword } = require('./auth');
const { endCall } = require('./calls');

const router = express.Router();
router.use(A.requireRole('admin'));

const PRO_STATUSES = ['pendente', 'aprovado', 'recusado', 'restrito', 'bloqueado'];

function adminPro(p) {
  return {
    id: p.id, code: p.code, name: p.name, profession: p.profession, registry: p.registry, email: p.email, phone: p.phone,
    status: p.status, state: p.state, city: p.city, photo: p.photo, bio: p.bio, specialties: p.specialties,
    price_cents: p.price_cents, packages: parsePackages(p.packages), has_clinic: !!p.has_clinic,
    clinic_name: p.clinic_name, clinic_address: p.clinic_address, subscription_until: p.subscription_until,
    visible: isVisible(p), admin_note: p.admin_note, created_at: p.created_at,
  };
}

function adminPatient(p) {
  return {
    id: p.id, name: p.name, display_name: p.display_name, cpf: U.formatCpf(p.cpf), cpf_name_verified: !!p.cpf_name_verified,
    state: p.state, city: p.city, photo: p.photo, status: p.status, created_at: p.created_at,
  };
}

function filterRows(rows, q) {
  const state = U.isUf(q.state) ? q.state.toUpperCase() : '';
  const city = U.norm(q.city);
  const text = U.norm(q.q);
  const digits = U.onlyDigits(q.q);
  const matchesText = (r) => !text
    || U.norm(`${r.name} ${r.email || ''} ${r.code || ''} ${r.registry || ''}`).includes(text)
    || (digits.length >= 3 && (r.cpf || '').includes(digits));
  return rows.filter((r) => (!state || r.state === state) && (!city || r.city_norm === city) && matchesText(r));
}

router.get('/stats', (_req, res) => {
  const g = (sql) => db.prepare(sql).get().n;
  res.json({
    patients: g('SELECT COUNT(*) n FROM patients'),
    patients_blocked: g("SELECT COUNT(*) n FROM patients WHERE status = 'bloqueado'"),
    professionals: g('SELECT COUNT(*) n FROM professionals'),
    pending: g("SELECT COUNT(*) n FROM professionals WHERE status = 'pendente'"),
    approved: g("SELECT COUNT(*) n FROM professionals WHERE status = 'aprovado'"),
    visible: g("SELECT COUNT(*) n FROM professionals WHERE status = 'aprovado' AND subscription_until >= date('now')"),
    overdue: g("SELECT COUNT(*) n FROM professionals WHERE status = 'aprovado' AND (subscription_until IS NULL OR subscription_until < date('now'))"),
    conversations: g('SELECT COUNT(*) n FROM conversations'),
  });
});

// Estados e municípios existentes, para os filtros
router.get('/locations', (_req, res) => {
  const rows = db.prepare(`SELECT state, city FROM patients UNION SELECT state, city FROM professionals WHERE state <> ''`).all();
  const map = {};
  for (const r of rows) {
    map[r.state] ||= new Set();
    map[r.state].add(r.city);
  }
  const out = {};
  for (const [uf, set] of Object.entries(map)) out[uf] = [...set].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  res.json(out);
});

// ---------- Profissionais ----------
router.get('/professionals', (req, res) => {
  let rows = db.prepare('SELECT * FROM professionals ORDER BY created_at DESC').all();
  if (PRO_STATUSES.includes(req.query.status)) rows = rows.filter((r) => r.status === req.query.status);
  if (req.query.status === 'vencido') rows = rows.filter((r) => r.status === 'aprovado' && !isVisible(r));
  rows = filterRows(rows, req.query);
  res.json({ items: rows.map(adminPro) });
});

router.get('/professionals/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM professionals WHERE id = ?').get(Number(req.params.id));
  if (!p) throw new U.HttpError(404, 'Profissional não encontrado.');
  res.json(adminPro(p));
});

// Administrador cadastra um profissional diretamente (já aprovado)
router.post('/professionals', (req, res) => {
  const d = validateProfessionalInput(req.body);
  const password = req.body.password ? String(req.body.password) : U.randomPassword(10);
  requirePassword(password);
  const until = U.addDaysISO(U.todayISO(), Number(req.body.days) > 0 ? Math.min(Number(req.body.days), 3650) : 30);
  const { id, code } = insertProfessional(d, U.hashPassword(password), 'aprovado', until);
  res.status(201).json({ id, code, password });
});

router.post('/professionals/:id/status', (req, res) => {
  const p = db.prepare('SELECT * FROM professionals WHERE id = ?').get(Number(req.params.id));
  if (!p) throw new U.HttpError(404, 'Profissional não encontrado.');
  const status = req.body.status;
  if (!PRO_STATUSES.includes(status) || status === 'pendente') throw new U.HttpError(400, 'Status inválido.');
  let until = p.subscription_until;
  // Na primeira aprovação, libera o primeiro período de mensalidade
  if (status === 'aprovado' && !until) until = U.addDaysISO(U.todayISO(), 30);
  db.prepare('UPDATE professionals SET status = ?, subscription_until = ? WHERE id = ?').run(status, until, p.id);
  if (['bloqueado', 'recusado'].includes(status)) {
    A.destroyUserSessions('professional', p.id);
    const active = db.prepare("SELECT * FROM calls WHERE professional_id = ? AND status = 'ativo'").get(p.id);
    if (active) endCall(active);
  }
  res.json(adminPro(db.prepare('SELECT * FROM professionals WHERE id = ?').get(p.id)));
});

// Mensalidade: define a data até quando está pago, ou soma dias
router.post('/professionals/:id/subscription', (req, res) => {
  const p = db.prepare('SELECT * FROM professionals WHERE id = ?').get(Number(req.params.id));
  if (!p) throw new U.HttpError(404, 'Profissional não encontrado.');
  let until;
  if (req.body.until === null) until = null;
  else if (req.body.until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.until)) throw new U.HttpError(400, 'Data inválida.');
    until = req.body.until;
  } else {
    const days = Number(req.body.add_days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new U.HttpError(400, 'Quantidade de dias inválida.');
    const base = p.subscription_until && p.subscription_until > U.todayISO() ? p.subscription_until : U.todayISO();
    until = U.addDaysISO(base, days);
  }
  db.prepare('UPDATE professionals SET subscription_until = ? WHERE id = ?').run(until, p.id);
  res.json(adminPro(db.prepare('SELECT * FROM professionals WHERE id = ?').get(p.id)));
});

router.post('/professionals/:id/note', (req, res) => {
  db.prepare('UPDATE professionals SET admin_note = ? WHERE id = ?').run(U.cleanText(req.body.note, 1000), Number(req.params.id));
  res.json({ ok: true });
});

router.post('/professionals/:id/reset-password', (req, res) => {
  const p = db.prepare('SELECT id FROM professionals WHERE id = ?').get(Number(req.params.id));
  if (!p) throw new U.HttpError(404, 'Profissional não encontrado.');
  const password = U.randomPassword(10);
  db.prepare('UPDATE professionals SET password_hash = ? WHERE id = ?').run(U.hashPassword(password), p.id);
  A.destroyUserSessions('professional', p.id);
  res.json({ password });
});

// ---------- Pacientes ----------
router.get('/patients', (req, res) => {
  let rows = db.prepare('SELECT * FROM patients ORDER BY created_at DESC').all();
  if (['ativo', 'bloqueado'].includes(req.query.status)) rows = rows.filter((r) => r.status === req.query.status);
  rows = filterRows(rows, req.query);
  res.json({ items: rows.map(adminPatient) });
});

router.post('/patients/:id/status', (req, res) => {
  const status = req.body.status;
  if (!['ativo', 'bloqueado'].includes(status)) throw new U.HttpError(400, 'Status inválido.');
  const r = db.prepare('UPDATE patients SET status = ? WHERE id = ?').run(status, Number(req.params.id));
  if (!r.changes) throw new U.HttpError(404, 'Paciente não encontrado.');
  if (status === 'bloqueado') A.destroyUserSessions('patient', Number(req.params.id));
  res.json({ ok: true, status });
});

router.post('/patients/:id/reset-password', (req, res) => {
  const p = db.prepare('SELECT id FROM patients WHERE id = ?').get(Number(req.params.id));
  if (!p) throw new U.HttpError(404, 'Paciente não encontrado.');
  const password = U.randomPassword(10);
  db.prepare('UPDATE patients SET password_hash = ? WHERE id = ?').run(U.hashPassword(password), p.id);
  A.destroyUserSessions('patient', p.id);
  res.json({ password });
});

// ---------- Exportação (CSV, abre no Excel) ----------
function csv(rows, cols) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return '﻿' + [cols.map((c) => esc(c[0])).join(';'), ...rows.map((r) => cols.map((c) => esc(r[c[1]])).join(';'))].join('\r\n');
}

router.get('/export/patients.csv', (req, res) => {
  const rows = filterRows(db.prepare('SELECT * FROM patients ORDER BY name').all(), req.query).map(adminPatient);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pacientes.csv"');
  res.send(csv(rows, [['Nome', 'name'], ['CPF', 'cpf'], ['UF', 'state'], ['Município', 'city'], ['Status', 'status'], ['Cadastro', 'created_at']]));
});

router.get('/export/professionals.csv', (req, res) => {
  const rows = filterRows(db.prepare('SELECT * FROM professionals ORDER BY name').all(), req.query).map(adminPro);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="profissionais.csv"');
  res.send(csv(rows, [['Nome', 'name'], ['Profissão', 'profession'], ['Registro', 'registry'], ['Código', 'code'], ['E-mail', 'email'],
    ['WhatsApp', 'phone'], ['UF', 'state'], ['Município', 'city'], ['Status', 'status'], ['Mensalidade até', 'subscription_until'], ['Cadastro', 'created_at']]));
});

router.post('/password', (req, res) => {
  const a = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.auth.user.id);
  if (!U.verifyPassword(req.body.current || '', a.password_hash)) throw new U.HttpError(400, 'Senha atual incorreta.');
  if (typeof req.body.password !== 'string' || req.body.password.length < 8) throw new U.HttpError(400, 'A nova senha precisa ter pelo menos 8 caracteres.');
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(U.hashPassword(req.body.password), a.id);
  res.json({ ok: true });
});

module.exports = { router };
