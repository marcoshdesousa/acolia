'use strict';
// Teste da agenda com pagamento automático, pedido pelo dono da plataforma: deixa o Profissional
// Teste pronto (ativo, agenda aberta todos os dias e o Asaas SIMULADO já conectado) e o Paciente
// Teste ativo, para testar marcar → pagar → consulta confirmada, sem dinheiro de verdade.
// Roda UMA vez (na subida do servidor). Ninguém consegue conectar o simulado pela tela; se a conta
// de teste for apagada, o simulado some junto. Para montar de novo, troque a chave KEY abaixo.
const { db } = require('./db');
const U = require('./util');

const KEY = 'agenda_teste_simulado_v1';

function provision() {
  const T = require('./testAccounts');
  T.ensureTestAccounts();
  const pro = db.prepare('SELECT * FROM professionals WHERE code = ? AND is_test = 1').get(T.PRO.code);
  if (!pro) return false;
  db.prepare(`UPDATE professionals SET status = 'aprovado', subscription_until = ?, price_cents = COALESCE(price_cents, 10000),
    session_minutes = COALESCE(session_minutes, 50), specialties = CASE WHEN specialties = '' THEN 'Ansiedade, Adultos' ELSE specialties END WHERE id = ?`)
    .run(U.addDaysISO(U.todayISO(), 3650), pro.id);
  // Agenda aberta todos os dias, o dia inteiro (para dar para testar a qualquer hora)
  if (!db.prepare('SELECT 1 FROM agenda_hours WHERE professional_id = ?').get(pro.id)) {
    const ins = db.prepare('INSERT INTO agenda_hours (professional_id, dow, start_min, end_min) VALUES (?, ?, 0, 1439)');
    for (let d = 0; d <= 6; d++) ins.run(pro.id, d);
  }
  db.prepare(`INSERT INTO pro_payment (professional_id, provider, key_enc, env, account_name, enabled) VALUES (?, 'asaas', ?, 'simulado', 'Asaas simulado (teste)', 1)
    ON CONFLICT(professional_id) DO UPDATE SET key_enc = excluded.key_enc, env = 'simulado', account_name = excluded.account_name, enabled = 1`)
    .run(pro.id, require('./secretBox').seal('SIMULADO'));
  db.prepare("UPDATE patients SET status = 'ativo' WHERE cpf = ? AND is_test = 1").run(T.PATIENT.cpf);
  require('./agenda').touch();
  return true;
}

function runOnce() {
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(KEY)) return;
  const ok = provision();
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(KEY, new Date().toISOString());
  if (ok) console.log('[agenda] Profissional Teste pronto: agenda aberta e Asaas simulado conectado');
}

module.exports = { runOnce, provision };
