'use strict';
// Conector do PagBank (PagSeguro), API de Pedidos com Pix. Usa o token DO PROFISSIONAL: o Pix é criado na
// conta dele e o dinheiro cai direto para ele — nada passa pela Acolia. Documentação: https://dev.pagbank.uol.com.br
// (Pedidos → Pix; Cancelar/estornar cobrança).
const U = require('./util');

const BASE = { producao: 'https://api.pagseguro.com', teste: 'https://sandbox.api.pagseguro.com' };
const baseFor = (env) => (process.env.PAGBANK_BASE_URL || BASE[env]).replace(/\/+$/, '');
const sandboxAllowed = () => process.env.ALLOW_ASAAS_SANDBOX === '1' || process.env.ALLOW_PAY_SANDBOX === '1';

async function call(env, key, method, path, body) {
  let res;
  try {
    res = await fetch(baseFor(env) + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new U.HttpError(502, 'Não foi possível falar com o PagBank agora. Tente de novo em instantes.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error_messages?.[0]?.description || data?.message;
    const e = new U.HttpError(res.status === 401 ? 400 : 502, msg ? `PagBank: ${msg}` : `O PagBank recusou o pedido (erro ${res.status}).`);
    e.providerStatus = res.status;
    throw e;
  }
  return data;
}

// Confere o token: consulta um pedido que não existe (token inválido → 401; válido → "não encontrado")
async function check(key) {
  key = String(key || '').trim();
  if (key.length < 20) throw new U.HttpError(400, 'Cole o token completo do PagBank.');
  const envs = sandboxAllowed() ? ['producao', 'teste'] : ['producao'];
  for (const env of envs) {
    try {
      await call(env, key, 'GET', '/orders/ORDE_00000000-0000-0000-0000-000000000000');
      return { env, name: 'Conta PagBank', key };
    } catch (e) {
      if (e.providerStatus === 401 || e.providerStatus === 403) continue;
      if (e.providerStatus === 404 || e.providerStatus === 400) return { env, name: 'Conta PagBank', key };
      throw e;
    }
  }
  throw new U.HttpError(400, 'Token do PagBank inválido. Confira se copiou o token inteiro (da conta real).');
}

// Hora de Brasília no formato que o PagBank pede (2030-01-07T12:00:00-03:00)
const brIso = (ms) => `${new Date(ms - 3 * 3600e3).toISOString().slice(0, 19)}-03:00`;

async function createPix(env, key, { cents, description, ref, payer }) {
  const o = await call(env, key, 'POST', '/orders', {
    reference_id: ref,
    customer: { name: String(payer.name || 'Paciente').slice(0, 120), email: payer.email, tax_id: payer.cpf },
    items: [{ reference_id: ref, name: String(description).slice(0, 100), quantity: 1, unit_amount: Math.round(cents) }],
    qr_codes: [{ amount: { value: Math.round(cents) }, expiration_date: brIso(Date.now() + 24 * 3600e3) }],
  });
  const qr = o.qr_codes?.[0];
  if (!qr?.text) throw new U.HttpError(502, 'O PagBank não gerou o Pix. Confira se a sua conta tem uma chave Pix cadastrada.');
  const image = (await require('qrcode').toDataURL(qr.text, { margin: 1, width: 360 })).split(',')[1];
  return { id: String(o.id), payload: qr.text, image };
}

async function status(env, key, id) {
  const o = await call(env, key, 'GET', `/orders/${encodeURIComponent(id)}`);
  const charges = o.charges || [];
  return { paid: charges.some((c) => c.status === 'PAID'), refunded: charges.some((c) => c.status === 'CANCELED'), raw: charges.map((c) => c.status).join(',') };
}
// Estorno: devolve a cobrança paga do pedido
async function refund(env, key, id) {
  const o = await call(env, key, 'GET', `/orders/${encodeURIComponent(id)}`);
  const c = (o.charges || []).find((x) => x.status === 'PAID');
  if (!c) throw new U.HttpError(409, 'O PagBank não encontrou o pagamento para devolver.');
  return call(env, key, 'POST', `/charges/${encodeURIComponent(c.id)}/cancel`, { amount: { value: c.amount?.value } });
}
const cancel = async () => null; // Pix do PagBank não pago simplesmente expira

module.exports = { check, createPix, status, refund, cancel };
