'use strict';
// Lista de bloqueados: quem o admin bloqueia continua bloqueado mesmo se apagar a própria conta.
// Se criar uma conta nova com o mesmo CPF (paciente) ou o mesmo e-mail, registro ou WhatsApp
// (profissional), a conta nova já nasce bloqueada — para liberar, só falando com a administração.
// - Admin bloqueia → entra na lista.  Admin desbloqueia → sai da lista.
// - Admin APAGA a conta → sai da lista (a pessoa pode criar de novo; profissional passa pela aprovação).
// - A própria pessoa apaga estando bloqueada → continua na lista.
const { db } = require('./db');
const U = require('./util');

db.exec(`CREATE TABLE IF NOT EXISTS blocked_identities (
  kind TEXT NOT NULL,            -- cpf | email | registry | phone
  value TEXT NOT NULL,
  role TEXT NOT NULL,            -- patient | professional
  account_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kind, value)
)`);

const normRegistry = (r) => U.norm(String(r || '')).replace(/[^a-z0-9]/g, '');
const normPhone = (p) => U.onlyDigits(p).slice(-11); // DDD + número (sem o 55)

function identitiesOf(role, a) {
  if (!a) return [];
  if (role === 'patient') return /^\d{11}$/.test(a.cpf || '') ? [['cpf', a.cpf]] : [];
  const out = [];
  if (a.email && !/\.invalid$/.test(a.email) && a.email.includes('@')) out.push(['email', String(a.email).toLowerCase()]);
  const reg = normRegistry(a.registry);
  if (reg.length >= 4 && !reg.startsWith('excluido')) out.push(['registry', reg]);
  const ph = normPhone(a.phone);
  if (ph.length >= 10) out.push(['phone', ph]);
  return out;
}

function block(role, account) {
  const ins = db.prepare('INSERT OR REPLACE INTO blocked_identities (kind, value, role, account_id) VALUES (?, ?, ?, ?)');
  for (const [k, v] of identitiesOf(role, account)) ins.run(k, v, role, account.id);
}

function unblock(role, account) {
  const del = db.prepare('DELETE FROM blocked_identities WHERE kind = ? AND value = ? AND role = ?');
  for (const [k, v] of identitiesOf(role, account)) del.run(k, v, role);
  if (account?.id) db.prepare('DELETE FROM blocked_identities WHERE role = ? AND account_id = ?').run(role, account.id);
}

function isBlocked(role, data) {
  const q = db.prepare('SELECT 1 FROM blocked_identities WHERE kind = ? AND value = ? AND role = ?');
  return identitiesOf(role, data).some(([k, v]) => q.get(k, v, role));
}

// Contas que já estavam bloqueadas antes desta lista existir
for (const p of db.prepare("SELECT * FROM patients WHERE status = 'bloqueado'").all()) block('patient', p);
for (const p of db.prepare("SELECT * FROM professionals WHERE status = 'bloqueado'").all()) block('professional', p);

module.exports = { block, unblock, isBlocked };
