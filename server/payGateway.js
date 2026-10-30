'use strict';
// Pagamento automático pelo Pix na conta do profissional: Asaas, Mercado Pago ou PagBank (ele escolhe um).
// O dinheiro cai direto na conta dele; a Acolia só cria o Pix, confere se foi pago e faz o reembolso.
const { db } = require('./db');

const PROVIDERS = {
  asaas: { label: 'Asaas', mod: () => require('./asaas') },
  mercadopago: { label: 'Mercado Pago', mod: () => require('./mercadopago') },
  pagbank: { label: 'PagBank', mod: () => require('./pagbank') },
};
const valid = (p) => Object.prototype.hasOwnProperty.call(PROVIDERS, p);
const label = (p) => PROVIDERS[p]?.label || 'Asaas';
const mod = (pay) => PROVIDERS[pay.provider || 'asaas'].mod();

function check(provider, key) {
  if (!valid(provider)) throw new (require('./util').HttpError)(400, 'Escolha onde você recebe: Asaas, Mercado Pago ou PagBank.');
  return PROVIDERS[provider].mod().check(key);
}

// Quem paga: o paciente (o e-mail é técnico, a Acolia não guarda e-mail do paciente)
function payerOf(patientId, env) {
  const U = require('./util');
  const p = db.prepare('SELECT id, name, cpf FROM patients WHERE id = ?').get(patientId);
  let cpf = String(p.cpf || '').replace(/\D/g, '');
  if (env !== 'producao' && !U.isValidCpf(cpf)) cpf = '24971563792'; // Paciente Teste no ambiente de teste
  const host = (process.env.SITE_URL || 'https://acolia.onrender.com').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return { id: p.id, name: p.name, cpf, email: `paciente${p.id}@${host}` };
}

// Cria o Pix: { id, payload, image } (image em base64, sem o "data:")
async function charge(pay, { proId, patientId, cents, description, ref }) {
  if ((pay.provider || 'asaas') === 'asaas') {
    const asaas = require('./asaas');
    let cust = db.prepare('SELECT customer_id FROM asaas_customers WHERE professional_id = ? AND patient_id = ?').get(proId, patientId)?.customer_id;
    if (!cust) {
      cust = await asaas.ensureCustomer(pay.env, pay.key, db.prepare('SELECT id, name, cpf FROM patients WHERE id = ?').get(patientId));
      db.prepare('INSERT OR REPLACE INTO asaas_customers (professional_id, patient_id, customer_id) VALUES (?, ?, ?)').run(proId, patientId, cust);
    }
    return asaas.createPix(pay.env, pay.key, { customer: cust, cents, description, ref });
  }
  return mod(pay).createPix(pay.env, pay.key, { cents, description, ref, payer: payerOf(patientId, pay.env) });
}
const status = (pay, id) => mod(pay).status(pay.env, pay.key, id);
const refund = (pay, id, description) => mod(pay).refund(pay.env, pay.key, id, description);
const cancel = (pay, id) => mod(pay).cancel(pay.env, pay.key, id);

module.exports = { PROVIDERS, valid, label, check, charge, status, refund, cancel };
