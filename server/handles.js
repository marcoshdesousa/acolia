'use strict';
// @ dos pacientes (só pacientes; profissionais não têm). Cada @ é único na plataforma (guardado em
// minúsculas). Aparece nos comentários e curtidas no lugar do nome; o profissional vê o nome completo
// e o @ pequeno embaixo na conversa. Dá para trocar quando quiser (se estiver livre) ou gerar um.
const crypto = require('node:crypto');
const { db } = require('./db');
const U = require('./util');

const RE = /^[a-z0-9](?:[a-z0-9._]{1,28}[a-z0-9])$/; // 3 a 30: letras, números, ponto e _

function normalize(v) {
  return String(v || '').trim().replace(/^@+/, '').toLowerCase();
}

function validate(v) {
  const h = normalize(v);
  if (!RE.test(h) || /[._]{2}/.test(h)) {
    throw new U.HttpError(400, 'O @ precisa ter de 3 a 30 caracteres: letras sem acento, números, ponto ou _ (sem começar ou terminar com ponto).');
  }
  return h;
}

const taken = (h, exceptId = 0) => !!db.prepare('SELECT 1 FROM patients WHERE handle = ? AND id <> ?').get(h, exceptId);

// Base a partir do nome (ex.: "Maria Souza Lima" → "maria.souza")
function base(name) {
  const w = U.norm(name).replace(/[^a-z0-9 ]/g, '').split(' ').filter(Boolean);
  return (w.slice(0, 2).join('.') || 'paciente').slice(0, 22);
}

// Gera um @ livre: pelo nome e, se já existir, com números no fim
function generate(name, exceptId = 0) {
  const b = base(name);
  if (RE.test(b) && !taken(b, exceptId)) return b;
  for (let i = 0; i < 50; i++) {
    const h = `${b}${crypto.randomInt(10, 9999)}`;
    if (!taken(h, exceptId)) return h;
  }
  return `paciente${crypto.randomInt(100000, 999999)}`;
}

function assertFree(h, exceptId = 0) {
  if (taken(h, exceptId)) throw new U.HttpError(409, `O @${h} já está em uso. Escolha outro ou toque em "Gerar @".`);
  return h;
}

// Uma vez: dá um @ para quem ainda não tem (Paciente Teste = @pacienteteste)
function backfill() {
  const t = db.prepare("SELECT id FROM patients WHERE cpf = '00000000000' AND is_test = 1 AND handle IS NULL").get();
  if (t && !taken('pacienteteste')) db.prepare("UPDATE patients SET handle = 'pacienteteste' WHERE id = ?").run(t.id);
  for (const p of db.prepare("SELECT id, name FROM patients WHERE handle IS NULL AND status <> 'excluido'").all()) {
    db.prepare('UPDATE patients SET handle = ? WHERE id = ?').run(generate(p.name, p.id), p.id);
  }
}

module.exports = { normalize, validate, generate, assertFree, taken, backfill };
