'use strict';
// Avaliação da consulta: depois de cada consulta concluída, o paciente dá de 1 a 5 estrelas (sem texto).
// A média aparece no perfil e na vitrine, e os mais bem avaliados aparecem primeiro.
// O profissional não vê quem deu cada nota.
const { db } = require('./db');
const U = require('./util');

const LABELS = { 1: 'Péssimo', 2: 'Ruim', 3: 'Regular', 4: 'Muito bom', 5: 'Excelente' };

db.exec(`CREATE TABLE IF NOT EXISTS appointment_ratings (
  appointment_id INTEGER PRIMARY KEY,
  professional_id INTEGER NOT NULL,
  patient_id INTEGER NOT NULL,
  stars INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_ratings_pro ON appointment_ratings(professional_id)');

// Consultas concluídas (nos últimos 14 dias) que o paciente ainda não avaliou
function pending(patientId) {
  const G = require('./agenda');
  const since = G.iso(G.now() - 14 * 864e5);
  return db.prepare(`SELECT a.id, a.start_at, a.modality, p.id AS pro_id, p.name AS pro_name, p.photo AS pro_photo, p.profession
    FROM appointments a JOIN professionals p ON p.id = a.professional_id
    WHERE a.patient_id = ? AND a.status = 'concluida' AND a.start_at >= ?
      AND NOT EXISTS (SELECT 1 FROM appointment_ratings r WHERE r.appointment_id = a.id)
    ORDER BY a.start_at DESC LIMIT 5`).all(patientId, since)
    .map((r) => ({ id: r.id, when: G.fmtWhen(G.ms(r.start_at)), modality: r.modality,
      professional: { id: r.pro_id, name: r.pro_name, photo: r.pro_photo, profession: r.profession } }));
}

function rate(patientId, appointmentId, stars) {
  const n = Number(stars);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new U.HttpError(400, 'Escolha de 1 a 5 estrelas.');
  const a = db.prepare('SELECT * FROM appointments WHERE id = ? AND patient_id = ?').get(Number(appointmentId), patientId);
  if (!a) throw new U.HttpError(404, 'Consulta não encontrada.');
  if (a.status !== 'concluida') throw new U.HttpError(409, 'Só dá para avaliar depois que a consulta acontecer.');
  if (db.prepare('SELECT 1 FROM appointment_ratings WHERE appointment_id = ?').get(a.id)) throw new U.HttpError(409, 'Você já avaliou esta consulta.');
  db.prepare('INSERT INTO appointment_ratings (appointment_id, professional_id, patient_id, stars) VALUES (?, ?, ?, ?)').run(a.id, a.professional_id, patientId, n);
  return { stars: n, label: LABELS[n] };
}

// Média e quantidade de um profissional (ou de todos, para a vitrine)
function summary(proId) {
  const r = db.prepare('SELECT COUNT(*) n, AVG(stars) avg FROM appointment_ratings WHERE professional_id = ?').get(proId);
  return r.n ? { avg: Math.round(r.avg * 10) / 10, count: r.n } : null;
}
function allSummaries() {
  return new Map(db.prepare('SELECT professional_id id, COUNT(*) n, AVG(stars) avg FROM appointment_ratings GROUP BY professional_id').all()
    .map((r) => [r.id, { avg: r.avg, count: r.n }]));
}
// Nota para ordenar a vitrine: média puxada para 3,5 enquanto há poucas avaliações
// (uma única nota 5 não passa na frente de quem tem muitas notas altas; sem avaliação fica no meio)
const score = (s) => (s ? (s.avg * s.count + 3.5 * 3) / (s.count + 3) : 3.5);

module.exports = { LABELS, pending, rate, summary, allSummaries, score };
