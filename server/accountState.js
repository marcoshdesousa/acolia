'use strict';
// Situação da conta: bloqueada (pelo admin ou por assinatura vencida) e aviso de vencimento.
//
// Profissional: a assinatura "vence" no dia subscription_until (ex.: 25). Ele ainda funciona
// no dia seguinte (26, sem aviso de que existe esse dia a mais) e é bloqueado no outro (27).
// O aviso de renovação aparece 2 dias antes (23) até o último dia.
// Bloqueado: entra, mas só vê a tela de bloqueio (falar com o admin / excluir a conta).
// Os dados ficam guardados e o perfil não aparece para ninguém.
const U = require('./util');

const GRACE_DAYS = 1; // dia a mais depois do vencimento
const WARN_DAYS = 2;  // aviso começa 2 dias antes do vencimento
const SUPPORT_WHATSAPP = process.env.SUPPORT_WHATSAPP || '5511939023938'; // canal de atendimento da Acolia

// Profissional sem CPF (conta antiga): precisa informar para liberar a plataforma. Conta de teste não precisa.
const needsCpf = (p) => !!p && !p.cpf && !p.is_test && !['oficial', 'clinica', 'excluido'].includes(p.status);
// Entrou com a senha de acesso único (gerada pelo admin): precisa criar a própria senha antes de usar.
// FIRST_PASSWORD=off desliga a regra (usado nos testes automáticos).
const needsPassword = (u) => !!u && !!u.must_change_password && process.env.FIRST_PASSWORD !== 'off';

function proState(p) {
  if (!p) return {};
  if (p.status === 'bloqueado') return { blocked: 'admin' };
  if (needsPassword(p)) return { needs_password: true };
  if (needsCpf(p)) return { needs_cpf: true };
  const until = p.subscription_until;
  if (p.status !== 'aprovado' && p.status !== 'restrito') return {};
  if (!until) return {};
  const today = U.todayISO();
  if (today > U.addDaysISO(until, GRACE_DAYS)) return { blocked: 'vencido', until };
  if (today >= U.addDaysISO(until, -WARN_DAYS)) return { warn: true, until, ended: today > until };
  return { until };
}

function patientState(p) {
  if (p && p.status === 'bloqueado') return { blocked: 'admin' };
  return {};
}

// Clínica: bloqueada pelo admin ou com a mensalidade vencida (mesma regra do profissional)
function clinicState(c) {
  if (!c) return {};
  if (c.status === 'bloqueado') return { blocked: 'admin' };
  if (needsPassword(c)) return { needs_password: true };
  if (c.status !== 'aprovado' || !c.subscription_until) return {};
  const today = U.todayISO();
  if (today > U.addDaysISO(c.subscription_until, GRACE_DAYS)) return { blocked: 'vencido', until: c.subscription_until };
  if (today >= U.addDaysISO(c.subscription_until, -WARN_DAYS)) return { warn: true, until: c.subscription_until, ended: today > c.subscription_until };
  return { until: c.subscription_until };
}

const stateOf = (role, user) => (role === 'professional' ? proState(user) : role === 'patient' ? patientState(user) : role === 'clinic' ? clinicState(user) : {});

// Pedido do dono (uma vez só): todos os profissionais que já tinham conta entraram com a senha de acesso único
// enviada pela equipe; no próximo acesso cada um cria a própria senha. Só marca isso: perfil, publicações,
// conversas, agenda e tudo o mais continuam iguais. Contas de teste ficam de fora.
function requireNewPasswordOnce(key = 'first_password_all_v1') {
  const { db } = require('./db');
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key)) return 0;
  const n = db.prepare("UPDATE professionals SET must_change_password = 1 WHERE status IN ('aprovado', 'restrito', 'bloqueado') AND is_test = 0").run().changes;
  db.prepare("INSERT INTO settings (key, value) VALUES (?, datetime('now'))").run(key);
  console.log(`[senha] ${n} profissional(is) vão criar a própria senha no próximo acesso`);
  return n;
}

module.exports = { requireNewPasswordOnce, needsCpf, needsPassword, proState, patientState, stateOf, GRACE_DAYS, WARN_DAYS, SUPPORT_WHATSAPP };
