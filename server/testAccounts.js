'use strict';
// Contas de teste do dono da plataforma. São criadas uma vez só (na primeira
// vez que o site sobe com esta versão) e depois só pelo botão do painel do admin.
// O admin pode apagar essas contas quando quiser; contas reais não são afetadas.
const { db } = require('./db');
const U = require('./util');

const PRO = { code: '123456789', password: '123456789' };
const PATIENT = { cpf: '00000000000', password: '1234' };

db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

function ensureTestAccounts() {
  const created = { professional: false, patient: false };
  if (!db.prepare('SELECT 1 FROM professionals WHERE code = ?').get(PRO.code)) {
    const name = 'Profissional Teste';
    db.prepare(`INSERT INTO professionals
      (code, name, legal_name, profession, registry, email, phone, password_hash, status, bio, price_cents,
       state, city, city_norm, subscription_until, slug, is_test)
      VALUES (?, ?, ?, 'Psicólogo(a)', 'TESTE', ?, '11939023938', ?, 'aprovado', ?, 10000, 'SP', 'São Paulo', ?, ?, ?, 1)`)
      .run(PRO.code, name, name, 'profissional@teste.acolia', U.hashPassword(PRO.password),
        'Conta de teste da plataforma.', U.norm('São Paulo'), U.addDaysISO(U.todayISO(), 3650),
        require('./slug').uniqueSlug(db, name));
    created.professional = true;
  }
  if (!db.prepare('SELECT 1 FROM patients WHERE cpf = ?').get(PATIENT.cpf)) {
    db.prepare(`INSERT INTO patients (name, cpf, state, city, city_norm, password_hash, is_test)
      VALUES ('Paciente Teste', ?, 'SP', 'São Paulo', ?, ?, 1)`)
      .run(PATIENT.cpf, U.norm('São Paulo'), U.hashPassword(PATIENT.password));
    created.patient = true;
  }
  return created;
}

// Na subida do servidor: cria só na primeira vez (se o admin apagar, não volta sozinha)
function seedOnce() {
  if (db.prepare("SELECT 1 FROM settings WHERE key = 'test_accounts_seeded'").get()) return;
  ensureTestAccounts();
  db.prepare("INSERT INTO settings (key, value) VALUES ('test_accounts_seeded', ?)").run(new Date().toISOString());
}

module.exports = { ensureTestAccounts, seedOnce, PRO, PATIENT };
