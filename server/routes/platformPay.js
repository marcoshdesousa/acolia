'use strict';
// Mensalidade da plataforma pelo Pix (SyncPay, conta da Acolia). Ver server/platformPay.js.
const express = require('express');
const { db } = require('../db');
const U = require('../util');
const PP = require('../platformPay');

const router = express.Router();

// Aviso da SyncPay: responde 200 sempre e só usa o aviso para conferir na hora (consulta a SyncPay)
router.post('/pagamento/webhook', (req, res) => {
  res.json({ ok: true });
  PP.onWebhook(req.body).catch((e) => console.warn('[syncpay] aviso:', e.message));
});

// Cadastro novo (ainda sem login): acompanha o Pix com o token que veio no cadastro.
// Pago → mostra o código e a senha de acesso único UMA vez.
router.get('/pagamento/cadastro/:id', async (req, res) => {
  let p = db.prepare("SELECT * FROM platform_payments WHERE id = ? AND kind = 'cadastro'").get(Number(req.params.id));
  if (!p || !p.token_hash || !U.verifyPassword(String(req.query.token || ''), p.token_hash)) throw new U.HttpError(404, 'Pagamento não encontrado.');
  p = await PP.check(p);
  const r = { status: p.status };
  if (p.status === 'pago') {
    const table = p.role === 'clinic' ? 'clinics' : 'professionals';
    const u = db.prepare(`SELECT code, email FROM ${table} WHERE id = ?`).get(p.user_id) || {};
    r.code = u.code; r.email = u.email;
    if (p.reveal) {
      try { r.password = require('../secretBox').open(p.reveal); } catch { /* nada */ }
      db.prepare('UPDATE platform_payments SET reveal = NULL WHERE id = ?').run(p.id); // só uma vez
    }
  }
  res.json(r);
});

// Renovação (profissional ou clínica logados; a secretária não paga): gera o Pix de +30 dias
function owner(req) {
  const role = req.auth?.role;
  if (role !== 'professional' && role !== 'clinic') throw new U.HttpError(403, 'Só o profissional ou a clínica pagam a mensalidade.');
  if (req.auth.blocked === 'admin') throw new U.HttpError(423, 'Perfil bloqueado. Fale com a administração.');
  return { role, user: req.auth.user };
}
router.post('/pagamento/renovar', async (req, res) => {
  const { role, user } = owner(req);
  if (!['aprovado', 'restrito'].includes(user.status)) throw new U.HttpError(400, 'A conta ainda não foi liberada.');
  const plan = role === 'clinic' ? 'clinica-4990' : (PP.PRICES[user.plan] ? user.plan : 'mensal-30');
  let payer;
  if (role === 'clinic') {
    // Clínica com CNPJ e sem o CPF do responsável: pede uma vez (fica guardado para as próximas)
    if (!PP.clinicPayer(user) && req.body?.responsible_cpf !== undefined) {
      const cpf = U.onlyDigits(req.body.responsible_cpf);
      if (!U.isValidCpf(cpf)) throw new U.HttpError(400, 'CPF inválido.');
      const name = U.cleanText(req.body.responsible || '', 120);
      if (!user.responsible && !U.isFullName(name)) throw new U.HttpError(400, 'Informe o nome completo do responsável.');
      db.prepare('UPDATE clinics SET responsible_cpf = ?, responsible = CASE WHEN responsible = \'\' THEN ? ELSE responsible END WHERE id = ?').run(cpf, name, user.id);
      Object.assign(user, db.prepare('SELECT * FROM clinics WHERE id = ?').get(user.id));
    }
    payer = PP.clinicPayer(user);
    if (!payer) throw Object.assign(new U.HttpError(400, 'Para gerar o Pix, informe o CPF do responsável pela clínica.'), { extra: { need_cpf: true, has_responsible: !!user.responsible } });
  } else payer = { name: user.legal_name || user.name, cpf: user.cpf, email: user.email, phone: user.phone };
  res.json(await PP.create({ role, userId: user.id, kind: 'renovacao', plan, payer }));
});
router.get('/pagamento/renovar/:id', async (req, res) => {
  const { role, user } = owner(req);
  let p = db.prepare("SELECT * FROM platform_payments WHERE id = ? AND role = ? AND user_id = ?").get(Number(req.params.id), role, user.id);
  if (!p) throw new U.HttpError(404, 'Pagamento não encontrado.');
  p = await PP.check(p);
  const table = role === 'clinic' ? 'clinics' : 'professionals';
  res.json({ status: p.status, subscription_until: db.prepare(`SELECT subscription_until FROM ${table} WHERE id = ?`).get(user.id)?.subscription_until || null });
});

// Só no modo simulado (SYNCPAY_FAKE=1, testes): marca a cobrança como paga
if (process.env.SYNCPAY_FAKE === '1') {
  router.post('/pagamento/_simular/:id', (req, res) => {
    const p = db.prepare('SELECT identifier FROM platform_payments WHERE id = ?').get(Number(req.params.id));
    if (p) PP._fakePay(p.identifier);
    res.json({ ok: !!p });
  });
}

module.exports = { router };
