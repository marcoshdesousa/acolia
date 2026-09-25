'use strict';
// Conector do Asaas (pagamento automático por Pix). Usa a chave de API DO PROFISSIONAL: a cobrança
// é criada na conta dele e o dinheiro cai direto para ele — nada passa pela Acolia.
// Documentação: https://docs.asaas.com (cobranças, Pix QR Code, estorno).
const U = require('./util');

const BASE = {
  producao: 'https://api.asaas.com/v3',
  teste: 'https://api-sandbox.asaas.com/v3',
};
// Testes automáticos apontam para um Asaas falso
const baseFor = (env) => process.env.ASAAS_BASE_URL || BASE[env];

const PAID = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];
const REFUNDED = ['REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS'];

async function call(env, key, method, path, body) {
  let res;
  try {
    res = await fetch(baseFor(env) + path, {
      method,
      headers: { access_token: key, 'Content-Type': 'application/json', 'User-Agent': 'Acolia' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new U.HttpError(502, 'Não foi possível falar com o Asaas agora. Tente de novo em instantes.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.errors?.[0]?.description;
    const e = new U.HttpError(res.status === 401 ? 400 : 502, msg ? `Asaas: ${msg}` : `O Asaas recusou o pedido (erro ${res.status}).`);
    e.asaasStatus = res.status;
    throw e;
  }
  return data;
}

// Confere a chave. A chave de teste (sandbox) e a de produção vão para endereços diferentes:
// pelo começo da chave dá para saber; se não der, tenta produção e depois teste.
async function check(key) {
  key = String(key || '').trim();
  if (key.length < 20) throw new U.HttpError(400, 'Cole a chave de API completa do Asaas (começa com $aact_).');
  const envs = /_hmlg_/.test(key) ? ['teste'] : /_prod_/.test(key) ? ['producao'] : ['producao', 'teste'];
  let last;
  for (const env of envs) {
    try {
      await call(env, key, 'GET', '/finance/balance');
      let name = '';
      try { const info = await call(env, key, 'GET', '/myAccount/commercialInfo'); name = info.name || info.companyName || ''; } catch { /* opcional */ }
      return { env, name, key };
    } catch (e) { last = e; }
  }
  if (last?.asaasStatus === 401) throw new U.HttpError(400, 'Chave do Asaas inválida. Confira se copiou a chave inteira.');
  throw last;
}

async function ensureCustomer(env, key, patient) {
  const cpf = String(patient.cpf || '').replace(/\D/g, '');
  const found = await call(env, key, 'GET', `/customers?cpfCnpj=${cpf}`);
  if (found?.data?.length) return found.data[0].id;
  const c = await call(env, key, 'POST', '/customers', { name: patient.name, cpfCnpj: cpf, notificationDisabled: true });
  return c.id;
}

// Cria a cobrança Pix e já traz o QR Code e o "copia e cola"
async function createPix(env, key, { customer, cents, description, ref }) {
  const today = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10); // data de Brasília
  const pay = await call(env, key, 'POST', '/payments', {
    customer, billingType: 'PIX', value: Math.round(cents) / 100, dueDate: today, description, externalReference: ref,
  });
  const qr = await call(env, key, 'GET', `/payments/${pay.id}/pixQrCode`);
  return { id: pay.id, payload: qr.payload, image: qr.encodedImage };
}

async function status(env, key, id) {
  const p = await call(env, key, 'GET', `/payments/${id}`);
  return { paid: PAID.includes(p.status), refunded: REFUNDED.includes(p.status), raw: p.status };
}

const refund = (env, key, id, description) => call(env, key, 'POST', `/payments/${id}/refund`, { description });
const cancel = (env, key, id) => call(env, key, 'DELETE', `/payments/${id}`).catch(() => null);

module.exports = { check, ensureCustomer, createPix, status, refund, cancel, PAID, REFUNDED };
