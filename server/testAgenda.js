'use strict';
// Teste da agenda com pagamento automático, pedido pelo dono da plataforma: deixa o Profissional
// Teste pronto (ativo, agenda aberta todos os dias e o Asaas SIMULADO já conectado) e o Paciente
// Teste ativo, para testar marcar → pagar → consulta confirmada, sem dinheiro de verdade.
// Roda UMA vez (na subida do servidor). Ninguém consegue conectar o simulado pela tela; se a conta
// de teste for apagada, o simulado some junto. Para montar de novo, troque a chave KEY abaixo.
const { db } = require('./db');
const U = require('./util');

const KEY = 'agenda_teste_simulado_v2';
// Agenda do teste (pedido do dono): todos os dias a partir das 02:35, consulta de 1 hora e 15 minutos
// de descanso entre uma e outra (02:35, 03:50, 05:05, 06:20…)
const START_MIN = 2 * 60 + 35;
const SESSION = 60;
const BREAK = 15;

// withHours: também monta a agenda (02:35, 1 h + 15 min). O botão do admin só monta se não tiver nenhum horário.
function provision({ withHours = true } = {}) {
  const T = require('./testAccounts');
  T.ensureTestAccounts();
  const pro = db.prepare('SELECT * FROM professionals WHERE code = ? AND is_test = 1').get(T.PRO.code);
  if (!pro) return false;
  db.prepare(`UPDATE professionals SET status = 'aprovado', subscription_until = ?, price_cents = COALESCE(price_cents, 10000),
    session_minutes = ?, break_minutes = ?, agenda_on = 1, specialties = CASE WHEN specialties = '' THEN 'Ansiedade, Adultos' ELSE specialties END WHERE id = ?`)
    .run(U.addDaysISO(U.todayISO(), 3650), SESSION, BREAK, pro.id);
  // Agenda aberta todos os dias, das 02:35 até o fim do dia
  const hasHours = db.prepare('SELECT 1 FROM agenda_hours WHERE professional_id = ?').get(pro.id);
  if (withHours || !hasHours) {
    db.prepare('DELETE FROM agenda_hours WHERE professional_id = ?').run(pro.id);
    const ins = db.prepare('INSERT INTO agenda_hours (professional_id, dow, start_min, end_min) VALUES (?, ?, ?, 1439)');
    for (let d = 0; d <= 6; d++) ins.run(pro.id, d, START_MIN);
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

// Painel do admin: como está o teste da agenda (o que falta para funcionar)
function status() {
  const T = require('./testAccounts');
  const G = require('./agenda');
  const pro = db.prepare('SELECT * FROM professionals WHERE code = ? AND is_test = 1').get(T.PRO.code);
  const pat = db.prepare('SELECT status FROM patients WHERE cpf = ? AND is_test = 1').get(T.PATIENT.cpf);
  const out = { patient: { exists: !!pat, active: pat?.status === 'ativo' } };
  if (!pro) return { ...out, pro: { exists: false } };
  const pay = db.prepare('SELECT env, enabled FROM pro_payment WHERE professional_id = ?').get(pro.id);
  const ready = G.readiness(pro);
  out.pro = {
    exists: true, status: pro.status, visible: require('./serialize').isVisible(pro), online: !!pro.agenda_on,
    starts: Object.values(G.weekStarts(pro)).reduce((n, l) => n + l.length, 0), price_cents: pro.price_cents,
    payment: pay ? { env: pay.env, enabled: !!pay.enabled } : null, mode: ready.mode, missing: ready.missing, next: G.nextAvailable(pro),
  };
  return out;
}

module.exports = { runOnce, provision, status };
