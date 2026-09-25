'use strict';
// Contas de teste do dono da plataforma. São criadas uma vez só (na primeira
// vez que o site sobe com esta versão) e depois só pelo botão do painel do admin.
// O admin pode apagar essas contas quando quiser; contas reais não são afetadas.
const { db } = require('./db');
const U = require('./util');

const PRO = { code: '123456789', password: '123456789' };
// Clínica fictícia fora do Brasil (Lisboa), só para testar o mapa sem apontar para um lugar real daqui
const TEST_CLINIC = {
  name: 'Clínica Teste Acolia (fictícia)',
  address: 'Avenida da Liberdade, 110 — Lisboa, Portugal',
  maps_url: 'https://www.google.com/maps/place/Avenida+da+Liberdade,+Lisboa,+Portugal/@38.7194,-9.1449,17z',
  maps_query: '38.7194,-9.1449',
};
const PATIENT = { cpf: '00000000000', password: '1234' };

db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

function ensureTestAccounts() {
  const created = { professional: false, patient: false };
  if (!db.prepare('SELECT 1 FROM professionals WHERE code = ?').get(PRO.code)) {
    const name = 'Profissional Teste';
    db.prepare(`INSERT INTO professionals
      (code, name, legal_name, profession, registry, email, phone, password_hash, status, bio, price_cents,
       state, city, city_norm, subscription_until, slug, is_test, has_clinic, clinic_name, clinic_address, maps_url, maps_query, specialties)
      VALUES (?, ?, ?, 'Psicólogo(a)', 'TESTE', ?, '11939023938', ?, 'aprovado', ?, 10000, 'SP', 'São Paulo', ?, ?, ?, 1, 1, ?, ?, ?, ?, 'Ansiedade, Depressão, Adultos')`)
      .run(PRO.code, name, name, 'profissional@teste.acolia', U.hashPassword(PRO.password),
        'Conta de teste da plataforma.', U.norm('São Paulo'), U.addDaysISO(U.todayISO(), 3650),
        require('./slug').uniqueSlug(db, name), TEST_CLINIC.name, TEST_CLINIC.address, TEST_CLINIC.maps_url, TEST_CLINIC.maps_query);
    created.professional = true;
  }
  if (!db.prepare('SELECT 1 FROM patients WHERE cpf = ?').get(PATIENT.cpf)) {
    db.prepare(`INSERT INTO patients (name, cpf, birth_date, state, city, city_norm, password_hash, is_test)
      VALUES ('Paciente Teste', ?, '1995-01-01', 'SP', 'São Paulo', ?, ?, 1)`)
      .run(PATIENT.cpf, U.norm('São Paulo'), U.hashPassword(PATIENT.password));
    created.patient = true;
  }
  require('./handles').backfill(); // Paciente Teste = @pacienteteste
  return created;
}

// Uma vez só: coloca a clínica fictícia no profissional de teste que já existia
// (só se ele ainda não tiver clínica cadastrada — não mexe no que foi editado à mão)
function addTestClinicOnce() {
  if (db.prepare("SELECT 1 FROM settings WHERE key = 'test_pro_clinic_v1'").get()) return;
  db.prepare(`UPDATE professionals SET has_clinic = 1, clinic_name = ?, clinic_address = ?, maps_url = ?, maps_query = ?
    WHERE code = ? AND is_test = 1 AND has_clinic = 0`).run(TEST_CLINIC.name, TEST_CLINIC.address, TEST_CLINIC.maps_url, TEST_CLINIC.maps_query, PRO.code);
  db.prepare("INSERT INTO settings (key, value) VALUES ('test_pro_clinic_v1', ?)").run(new Date().toISOString());
}

// Na subida do servidor: cria só na primeira vez (se o admin apagar, não volta sozinha)
function seedOnce() {
  addTestClinicOnce();
  if (db.prepare("SELECT 1 FROM settings WHERE key = 'test_accounts_seeded'").get()) return;
  ensureTestAccounts();
  db.prepare("INSERT INTO settings (key, value) VALUES ('test_accounts_seeded', ?)").run(new Date().toISOString());
}

// Pedido do dono (depois dos testes da versão 1.1.3): apaga UMA vez as contas de teste (Profissional
// Teste, Paciente Teste) e a secretária de teste, com tudo delas (conversas, consultas, Asaas simulado).
// Não voltam sozinhas: só se o admin tocar em "Preparar o teste de novo".
function removeTestAccountsOnce() {
  const KEY = 'test_accounts_removed_v1';
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(KEY)) return null;
  const out = { professionals: 0, patients: 0 };
  for (const p of db.prepare("SELECT * FROM professionals WHERE is_test = 1 AND status <> 'excluido'").all()) {
    require('./routes/professional').wipeProfessional(p); // também apaga a secretária e o Asaas simulado
    db.prepare('UPDATE professionals SET code = ?, slug = NULL WHERE id = ?').run(`excluido-${p.id}`, p.id);
    out.professionals++;
  }
  for (const p of db.prepare("SELECT * FROM patients WHERE is_test = 1 AND status <> 'excluido'").all()) {
    require('./routes/patient').wipePatient(p);
    out.patients++;
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(KEY, new Date().toISOString());
  if (out.professionals || out.patients) console.log(`[teste] contas de teste apagadas: ${out.professionals} profissional(is), ${out.patients} paciente(s)`);
  return out;
}

module.exports = { ensureTestAccounts, seedOnce, removeTestAccountsOnce, PRO, PATIENT };
