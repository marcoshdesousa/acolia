'use strict';
// Financeiro do profissional: quanto entrou pelas consultas (pela Acolia e as que ele lança à mão).
// - Recebido: consulta paga que aconteceu (online: concluída; presencial: ele confirmou "Sim, aconteceu")
//   e os lançamentos manuais.
// - A confirmar: paga, mas ainda não aconteceu (pode ser remarcada ou reembolsada) — não entra no total.
// - Reembolsado: devolvido ao paciente — não entra no total.
// - Não reembolsado: paga, a consulta não aconteceu e o paciente perdeu o prazo de reembolso
//   (ex.: não entrou na chamada) — entra no total.
// Convênio não entra (o pagamento não passa pela Acolia). O profissional pode tirar um valor da lista.
// A secretária não vê o financeiro.
const express = require('express');
const { db } = require('../db');
const U = require('../util');
const A = require('../auth');
const G = require('../agenda');

const router = express.Router();
router.use(A.requireRole('professional'));
router.use((req, _res, next) => { if (req.auth.secretary) throw new U.HttpError(403, 'O financeiro é só do profissional.'); next(); });

db.exec(`
CREATE TABLE IF NOT EXISTS pro_finance_manual (
  id INTEGER PRIMARY KEY,
  professional_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  cpf TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,             -- AAAA-MM-DD
  amount_cents INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fin_manual_pro ON pro_finance_manual(professional_id, date);
CREATE TABLE IF NOT EXISTS pro_finance_hidden (
  professional_id INTEGER NOT NULL,
  appointment_id INTEGER NOT NULL,
  PRIMARY KEY (professional_id, appointment_id)
);`);

const STATE = {
  concluida: 'recebido',
  confirmada: 'a_confirmar', aguardando_paciente: 'a_confirmar', reembolso_pendente: 'a_confirmar',
  reembolsada: 'reembolsado',
  paciente_ausente: 'nao_reembolsado', nao_realizada: 'nao_reembolsado',
};
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };

// Todas as entradas (consultas pagas pela Acolia + lançamentos manuais)
function entries(proId) {
  const auto = db.prepare(`SELECT a.id, a.start_at, a.price_cents, a.status, a.refund_status, a.modality, p.name, p.cpf
      FROM appointments a JOIN patients p ON p.id = a.patient_id
      WHERE a.professional_id = ? AND a.billing = 'pix' AND a.paid_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pro_finance_hidden h WHERE h.professional_id = a.professional_id AND h.appointment_id = a.id)`).all(proId)
    .map((a) => {
      let state = STATE[a.status];
      if (['feito', 'confirmado'].includes(a.refund_status)) state = 'reembolsado';
      if (!state) return null;
      return { key: `a${a.id}`, kind: 'acolia', date: G.localDate(G.ms(a.start_at)), name: a.name, cpf: U.formatCpf(a.cpf), amount_cents: a.price_cents || 0, state, modality: a.modality };
    }).filter(Boolean);
  const manual = db.prepare('SELECT * FROM pro_finance_manual WHERE professional_id = ?').all(proId)
    .map((m) => ({ key: `m${m.id}`, kind: 'manual', date: m.date, name: m.name, cpf: m.cpf ? U.formatCpf(m.cpf) : '', amount_cents: m.amount_cents, state: 'recebido', note: m.note }));
  return auto.concat(manual).sort((x, y) => y.date.localeCompare(x.date));
}

function summarize(list) {
  const sum = (st) => list.filter((e) => e.state === st).reduce((n, e) => n + e.amount_cents, 0);
  const count = (st) => list.filter((e) => e.state === st).length;
  const s = {
    recebido_cents: sum('recebido'), a_confirmar_cents: sum('a_confirmar'), reembolsado_cents: sum('reembolsado'), nao_reembolsado_cents: sum('nao_reembolsado'),
    realizadas: count('recebido'), a_confirmar: count('a_confirmar'), reembolsos: count('reembolsado'), nao_reembolsados: count('nao_reembolsado'),
    clientes: new Set(list.filter((e) => e.state !== 'a_confirmar').map((e) => e.cpf || e.name)).size,
  };
  s.total_cents = s.recebido_cents + s.nao_reembolsado_cents; // reembolsado e a confirmar não entram
  return s;
}

// ?ym=AAAA-MM (padrão: mês atual) ou ?from=&to= (período); ?q= nome ou CPF
router.get('/', (req, res) => {
  const all = entries(req.auth.user.id);
  const today = G.localDate(G.now());
  const ym = /^\d{4}-\d{2}$/.test(req.query.ym || '') ? req.query.ym : today.slice(0, 7);
  const from = isDate(req.query.from) ? req.query.from : (req.query.to ? '' : `${ym}-01`);
  const to = isDate(req.query.to) ? req.query.to : (req.query.from ? '' : lastDay(ym));
  let list = all.filter((e) => (!from || e.date >= from) && (!to || e.date <= to));
  const q = U.norm(req.query.q || '').trim();
  const digits = U.onlyDigits(req.query.q || '');
  if (q) list = list.filter((e) => U.norm(e.name).includes(q) || (digits.length >= 3 && U.onlyDigits(e.cpf).includes(digits)));
  res.json({ ym, from, to, items: list, period: summarize(list), all_time: summarize(all) });
});

// Lançamento manual (consulta atendida fora da Acolia ou paga por fora)
router.post('/manual', (req, res) => {
  const name = U.cleanText(req.body.name, 120);
  if (name.length < 2) throw new U.HttpError(400, 'Informe o nome do paciente.');
  const cpf = U.onlyDigits(req.body.cpf);
  if (cpf && !U.isValidCpf(cpf)) throw new U.HttpError(400, 'CPF inválido. Confira os números (ou deixe em branco).');
  if (!isDate(req.body.date)) throw new U.HttpError(400, 'Informe a data da consulta.');
  const cents = Math.round(Number(String(req.body.amount || '').replace(/\./g, '').replace(',', '.')) * 100);
  if (!(cents > 0) || cents > 100000000) throw new U.HttpError(400, 'Informe o valor da consulta.');
  const info = db.prepare('INSERT INTO pro_finance_manual (professional_id, name, cpf, date, amount_cents, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.auth.user.id, name, cpf, req.body.date, cents, U.cleanText(req.body.note, 200));
  res.status(201).json({ ok: true, id: Number(info.lastInsertRowid) });
});

// Tirar um valor da lista: manual é apagado; o da Acolia some só do financeiro
router.post('/remove', (req, res) => {
  const key = String(req.body.key || '');
  const id = Number(key.slice(1));
  if (key[0] === 'm') {
    if (!db.prepare('DELETE FROM pro_finance_manual WHERE id = ? AND professional_id = ?').run(id, req.auth.user.id).changes) throw new U.HttpError(404, 'Lançamento não encontrado.');
  } else if (key[0] === 'a') {
    if (!db.prepare('SELECT 1 FROM appointments WHERE id = ? AND professional_id = ?').get(id, req.auth.user.id)) throw new U.HttpError(404, 'Consulta não encontrada.');
    db.prepare('INSERT OR IGNORE INTO pro_finance_hidden (professional_id, appointment_id) VALUES (?, ?)').run(req.auth.user.id, id);
  } else throw new U.HttpError(400, 'Item inválido.');
  res.json({ ok: true });
});

module.exports = { router };
