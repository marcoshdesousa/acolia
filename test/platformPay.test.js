'use strict';
// Mensalidade da Acolia pelo Pix (SyncPay simulada): cadastro pago → conta liberada na hora; renovação → +30 dias
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acolia-pp-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'senha-admin-123';
process.env.SYNCPAY_FAKE = '1';
delete process.env.FIRST_PASSWORD; // aqui a senha de acesso único vale
delete process.env.CPF_API_URL;
process.env.TEST_ACCOUNTS = '0';
process.env.SKIP_OWNER_TEST = '1';

const { start } = require('../server');

let server;
let base;
function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const form = async (url, fields) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const res = await fetch(base + url, { method: 'POST', body: fd });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { form, get: (u) => call('GET', u), post: (u, b = {}) => call('POST', u, b) };
}
function cpfOf(n) {
  const d = String(100000000 + n).slice(-9);
  const dv = (s) => { let t = 0; for (let i = 0; i < s.length; i++) t += +s[i] * (s.length + 1 - i); const r = (t * 10) % 11; return r === 10 ? 0 : r; };
  const x = d + dv(d);
  return x + dv(x);
}

before(async () => {
  const origLog = console.log;
  console.log = () => {};
  server = await start(0);
  console.log = origLog;
  base = `http://localhost:${server.address().port}`;
});
after(() => {
  server.closeAllConnections?.();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const PP = () => require('../server/platformPay');
const { db } = require('../server/db');

test('cadastro com Pix: pago → aprovado na hora, senha única mostrada uma vez, renovação soma 30 dias', async () => {
  const anon = client();
  const cfg = await anon.get('/api/config');
  assert.equal(cfg.data.platform_pix, true);
  const r = await anon.form('/api/auth/professional/register', {
    name: 'Ana Souza Lima', profession: 'Psicanalista', email: 'ana.pp@example.com', phone: '(94) 99999-1111', state: 'PA', city: 'Parauapebas',
    cpf: cpfOf(4242), specialties: JSON.stringify(['Ansiedade']), birth_date: '1985-03-02',
    terms_accept: '1', terms_version: require('../server/terms').VERSION, terms_name: 'Ana Souza Lima', plan: 'mensal-30',
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const pay = r.data.pay;
  assert.ok(pay && pay.pix_code && pay.qr && pay.token);
  assert.equal(pay.amount_cents, 3000);
  const poll = `/api/plataforma/pagamento/cadastro/${pay.id}?token=${pay.token}`;
  // token errado não vê nada
  assert.equal((await anon.get(`/api/plataforma/pagamento/cadastro/${pay.id}?token=errado`)).status, 404);
  let s = await anon.get(poll);
  assert.equal(s.data.status, 'pendente');
  assert.equal(db.prepare('SELECT status FROM professionals WHERE code = ?').get(r.data.code).status, 'pendente');

  // aviso (webhook) com um id desconhecido: ignorado; com o id certo: confere e libera
  const row = db.prepare('SELECT * FROM platform_payments WHERE id = ?').get(pay.id);
  assert.equal((await anon.post('/api/plataforma/pagamento/webhook', { data: { id: '00000000-0000-4000-8000-000000000000' } })).status, 200);
  PP()._fakePay(row.identifier);
  await anon.post('/api/plataforma/pagamento/webhook', { data: { id: row.identifier, status: 'completed' } });
  await new Promise((ok) => setTimeout(ok, 100));
  const p = db.prepare('SELECT * FROM professionals WHERE code = ?').get(r.data.code);
  assert.equal(p.status, 'aprovado');
  assert.equal(p.review_pending, 1);
  assert.equal(p.must_change_password, 1);
  assert.ok(p.subscription_until > require('../server/util').todayISO());

  s = await anon.get(poll);
  assert.equal(s.data.status, 'pago');
  assert.equal(s.data.code, r.data.code);
  assert.ok(s.data.password);
  assert.equal((await anon.get(poll)).data.password, undefined, 'senha só aparece uma vez');

  // entra com a senha única → precisa criar a própria
  const pro = client();
  assert.equal((await pro.post('/api/auth/professional/login', { login: r.data.code, password: s.data.password })).status, 200);
  assert.equal((await pro.get('/api/professional/me')).status, 428);
  assert.equal((await pro.post('/api/professional/first-password', { password: 'minhasenha9', confirm: 'minhasenha9' })).status, 200);

  // renovação: gera o Pix, paga, +30 dias
  const before = db.prepare('SELECT subscription_until FROM professionals WHERE id = ?').get(p.id).subscription_until;
  const ren = await pro.post('/api/plataforma/pagamento/renovar');
  assert.equal(ren.status, 200, JSON.stringify(ren.data));
  assert.equal(ren.data.kind, 'renovacao');
  PP()._fakePay(db.prepare('SELECT identifier FROM platform_payments WHERE id = ?').get(ren.data.id).identifier);
  const st = await pro.get(`/api/plataforma/pagamento/renovar/${ren.data.id}`);
  assert.equal(st.data.status, 'pago');
  assert.equal(st.data.subscription_until, require('../server/util').addDaysISO(before, 30));
  // conferir o pagamento duas vezes não soma de novo
  await PP().check(db.prepare('SELECT * FROM platform_payments WHERE id = ?').get(ren.data.id), { force: true });
  assert.equal(db.prepare('SELECT subscription_until FROM professionals WHERE id = ?').get(p.id).subscription_until, st.data.subscription_until);

  // mensalidade vencida (bloqueado): ainda consegue pagar o Pix e volta na hora
  db.prepare("UPDATE professionals SET subscription_until = date('now', '-10 days') WHERE id = ?").run(p.id);
  assert.equal((await pro.get('/api/professional/me')).status, 423);
  const ren2 = await pro.post('/api/plataforma/pagamento/renovar');
  assert.equal(ren2.status, 200, JSON.stringify(ren2.data));
  PP()._fakePay(db.prepare('SELECT identifier FROM platform_payments WHERE id = ?').get(ren2.data.id).identifier);
  assert.equal((await pro.get(`/api/plataforma/pagamento/renovar/${ren2.data.id}`)).data.status, 'pago');
  assert.equal((await pro.get('/api/professional/me')).status, 200);

  // admin: aparece "conferir"; reprovar tira o acesso
  const admin = client();
  await admin.post('/api/auth/admin/login', { username: 'admin', password: 'senha-admin-123' });
  const det = await admin.get(`/api/admin/professionals/${p.id}`);
  assert.equal(det.data.review_pending, true);
  assert.equal(det.data.payments.length, 3);
  const rv = await admin.post(`/api/admin/professionals/${p.id}/review`, { ok: false });
  assert.equal(rv.data.status, 'recusado');
  assert.equal(rv.data.review_pending, false);
  assert.equal((await pro.get('/api/professional/me')).status, 401);
  // paciente não paga mensalidade
  assert.equal((await anon.post('/api/plataforma/pagamento/renovar')).status, 403);
});
