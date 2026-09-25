'use strict';
// Asaas SIMULADO — só para as contas de teste (Profissional Teste e Paciente Teste).
// Responde às mesmas rotas do Asaas de verdade, mas sem dinheiro nenhum: o paciente de teste toca em
// "Simular pagamento" e o Pix aparece como pago. Serve para testar o fluxo completo no site.
// Para desligar: tirar 'simulado' de server/asaas.js e de server/agenda.js (ver TEST_PAYMENTS).
const { db } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS sim_payments (
  id TEXT PRIMARY KEY,
  value_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const U = require('./util');

async function handle(method, path, body = {}) {
  const url = new URL(path, 'http://sim');
  const p = url.pathname;
  if (p === '/finance/balance') return { balance: 0 };
  if (p === '/myAccount/commercialInfo') return { name: 'Asaas simulado (conta de teste)' };
  if (p === '/customers' && method === 'GET') return { data: [{ id: `sim_cus_${url.searchParams.get('cpfCnpj')}` }] };
  if (p === '/customers') return { id: `sim_cus_${body.cpfCnpj}` };
  if (p === '/payments' && method === 'POST') {
    const id = `sim_pay_${U.randomMixedCode(12)}`;
    db.prepare('INSERT INTO sim_payments (id, value_cents) VALUES (?, ?)').run(id, Math.round(Number(body.value) * 100));
    return { id, status: 'PENDING' };
  }
  const m = /^\/payments\/([^/]+)(\/.*)?$/.exec(p);
  if (m) {
    const pay = db.prepare('SELECT * FROM sim_payments WHERE id = ?').get(m[1]);
    if (!pay) { const e = new U.HttpError(404, 'Cobrança simulada não encontrada.'); e.asaasStatus = 404; throw e; }
    if (m[2] === '/pixQrCode') {
      const payload = `SIMULADO-ACOLIA-${pay.id}-R$${(pay.value_cents / 100).toFixed(2)}`;
      const dataUrl = await require('qrcode').toDataURL(payload, { width: 300, margin: 1 });
      return { encodedImage: dataUrl.split(',')[1], payload };
    }
    if (m[2] === '/refund') { db.prepare("UPDATE sim_payments SET status = 'REFUNDED' WHERE id = ?").run(pay.id); return { ...pay, status: 'REFUNDED' }; }
    if (method === 'DELETE') { db.prepare("UPDATE sim_payments SET status = 'DELETED' WHERE id = ?").run(pay.id); return { deleted: true }; }
    return { id: pay.id, status: pay.status, value: pay.value_cents / 100 };
  }
  const e = new U.HttpError(404, 'Rota do Asaas simulado não existe.');
  e.asaasStatus = 404;
  throw e;
}

// "Simular pagamento": o Pix de teste passa a constar como pago
function pay(id) {
  db.prepare("UPDATE sim_payments SET status = 'RECEIVED' WHERE id = ? AND status = 'PENDING'").run(id);
}

module.exports = { handle, pay };
