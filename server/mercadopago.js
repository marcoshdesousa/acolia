'use strict';
// Conector do Mercado Pago (Pix). Usa o token de acesso DO PROFISSIONAL: o Pix é criado na conta dele e o
// dinheiro cai direto para ele — nada passa pela Acolia. Documentação: https://www.mercadopago.com.br/developers
// (Pagamentos → Pix; Reembolsos).
const U = require('./util');

const base = () => (process.env.MERCADOPAGO_BASE_URL || 'https://api.mercadopago.com').replace(/\/+$/, '');
const sandboxAllowed = () => process.env.ALLOW_ASAAS_SANDBOX === '1' || process.env.ALLOW_PAY_SANDBOX === '1';

async function call(key, method, path, body, idem) {
  let res;
  try {
    res = await fetch(base() + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(idem ? { 'X-Idempotency-Key': idem } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new U.HttpError(502, 'Não foi possível falar com o Mercado Pago agora. Tente de novo em instantes.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.cause?.[0]?.description || data?.message;
    const e = new U.HttpError(res.status === 401 ? 400 : 502, msg ? `Mercado Pago: ${msg}` : `O Mercado Pago recusou o pedido (erro ${res.status}).`);
    e.providerStatus = res.status;
    throw e;
  }
  return data;
}

// Confere o token (o de teste começa com TEST-, o da conta real com APP_USR-)
async function check(key) {
  key = String(key || '').trim();
  if (key.length < 20) throw new U.HttpError(400, 'Cole o Access Token completo do Mercado Pago (começa com APP_USR-).');
  const test = /^TEST-/.test(key);
  if (test && !sandboxAllowed()) throw new U.HttpError(400, 'Esse é um token de TESTE do Mercado Pago, que não recebe dinheiro de verdade. Use o Access Token de produção (começa com APP_USR-).');
  try {
    const me = await call(key, 'GET', '/users/me');
    const name = [me.first_name, me.last_name].filter(Boolean).join(' ') || me.nickname || '';
    return { env: test ? 'teste' : 'producao', name, key };
  } catch (e) {
    if (e.providerStatus === 401 || e.providerStatus === 403) throw new U.HttpError(400, 'Token do Mercado Pago inválido. Confira se copiou o Access Token inteiro (de produção).');
    throw e;
  }
}

// Cria o Pix e já traz o "copia e cola" e o QR Code (imagem em base64)
async function createPix(env, key, { cents, description, ref, payer }) {
  const [first, ...rest] = String(payer.name || 'Paciente').split(' ');
  const p = await call(key, 'POST', '/v1/payments', {
    transaction_amount: Math.round(cents) / 100,
    description: String(description).slice(0, 200),
    payment_method_id: 'pix',
    external_reference: ref,
    payer: { email: payer.email, first_name: first, last_name: rest.join(' ') || first, identification: { type: 'CPF', number: payer.cpf } },
  }, ref);
  const t = p.point_of_interaction?.transaction_data || {};
  if (!t.qr_code) throw new U.HttpError(502, 'O Mercado Pago não gerou o Pix. Confira se a sua conta tem uma chave Pix cadastrada.');
  return { id: String(p.id), payload: t.qr_code, image: t.qr_code_base64 || null };
}

async function status(env, key, id) {
  const p = await call(key, 'GET', `/v1/payments/${encodeURIComponent(id)}`);
  return { paid: p.status === 'approved', refunded: ['refunded', 'charged_back'].includes(p.status), raw: p.status };
}
const refund = (env, key, id) => call(key, 'POST', `/v1/payments/${encodeURIComponent(id)}/refunds`, {}, `acolia-refund-${id}`);
const cancel = (env, key, id) => call(key, 'PUT', `/v1/payments/${encodeURIComponent(id)}`, { status: 'cancelled' }).catch(() => null);

module.exports = { check, createPix, status, refund, cancel };
