'use strict';
// Pagamento automático na conta do profissional pelo Mercado Pago e pelo PagBank (além do Asaas):
// conectar, Pix da consulta, confirmação sozinha, reembolso automático e pacote mensal.
// Os dois são simulados por servidores falsos; o relógio é controlado pelo teste.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acolia-pay-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'senha-admin-123';
process.env.FIRST_PASSWORD = 'off';
process.env.FREE_TRIAL = 'off';
process.env.TEST_ACCOUNTS = '0';
process.env.SKIP_OWNER_TEST = '1';
process.env.ALLOW_ASAAS_SANDBOX = '1';

// ---------- Mercado Pago falso ----------
const mp = { tokens: new Set(['APP_USR-token-de-producao-do-mercado-pago-123']), pays: new Map(), seq: 1000, calls: [] };
const mpServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    mp.calls.push(`${req.method} ${req.url}`);
    const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (!mp.tokens.has(tok)) return send(401, { message: 'invalid access token' });
    const json = body ? JSON.parse(body) : {};
    if (req.url === '/users/me') return send(200, { id: 1, first_name: 'Consultório', last_name: 'MP' });
    if (req.url === '/v1/payments' && req.method === 'POST') {
      if (!req.headers['x-idempotency-key']) return send(400, { message: 'X-Idempotency-Key obrigatório' });
      if (json.payment_method_id !== 'pix' || !json.payer?.email || !/^\d{11}$/.test(json.payer?.identification?.number || '')) return send(400, { message: 'dados do pagador' });
      const p = { id: ++mp.seq, status: 'pending', ...json, point_of_interaction: { transaction_data: { qr_code: `00020126MP-${mp.seq}`, qr_code_base64: 'iVBORw0KGgoAAAANSUhEUg==' } } };
      mp.pays.set(String(p.id), p);
      return send(201, p);
    }
    const m = /^\/v1\/payments\/(\d+)(\/refunds)?$/.exec(req.url);
    if (m) {
      const p = mp.pays.get(m[1]);
      if (!p) return send(404, { message: 'not found' });
      if (m[2]) { p.status = 'refunded'; return send(201, { id: 1, status: 'approved' }); }
      if (req.method === 'PUT') { p.status = json.status; return send(200, p); }
      return send(200, p);
    }
    send(404, { message: 'rota' });
  });
});

// ---------- PagBank falso ----------
const pb = { tokens: new Set(['token-pagbank-de-producao-0000-1111-2222-3333']), orders: new Map(), seq: 0 };
const pbServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (!pb.tokens.has(tok)) return send(401, { error_messages: [{ description: 'invalid token' }] });
    const json = body ? JSON.parse(body) : {};
    if (req.url === '/orders' && req.method === 'POST') {
      if (!json.customer?.email || !/^\d{11}$/.test(json.customer?.tax_id || '') || !json.qr_codes?.[0]?.amount?.value) return send(400, { error_messages: [{ description: 'dados' }] });
      const o = { id: `ORDE_${++pb.seq}`, reference_id: json.reference_id, qr_codes: [{ id: `QRCO_${pb.seq}`, text: `00020126PB-${pb.seq}`, amount: json.qr_codes[0].amount }], charges: [] };
      pb.orders.set(o.id, o);
      return send(201, o);
    }
    let m = /^\/orders\/(ORDE_[\w-]+)$/.exec(req.url);
    if (m) { const o = pb.orders.get(m[1]); return o ? send(200, o) : send(404, { error_messages: [{ description: 'not found' }] }); }
    m = /^\/charges\/(CHAR_\d+)\/cancel$/.exec(req.url);
    if (m) {
      for (const o of pb.orders.values()) for (const c of o.charges) if (c.id === m[1]) { c.status = 'CANCELED'; return send(201, c); }
      return send(404, {});
    }
    send(404, { error_messages: [{ description: 'rota' }] });
  });
});
const pbPay = (orderId) => { const o = pb.orders.get(orderId); o.charges.push({ id: `CHAR_${pb.seq}${o.charges.length}`, status: 'PAID', amount: { value: o.qr_codes[0].amount.value } }); };

const { start } = require('../server');
const G = require('../server/agenda');
let server;
let base;
let AUTO_CPF = 0;
function nextCpf() {
  const d = String(300000000 + (++AUTO_CPF));
  const dv = (x) => { let t = 0; for (let i = 0; i < x.length; i++) t += +x[i] * (x.length + 1 - i); const r = (t * 10) % 11; return r === 10 ? 0 : r; };
  const a = d + dv(d);
  return a + dv(a);
}
function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    if (method === 'POST' && url === '/api/auth/patient/register' && body && !('phone' in body)) body = { ...body, phone: '11988887777' };
    if (method === 'POST' && url === '/api/admin/professionals' && body && !('cpf' in body)) body = { ...body, cpf: nextCpf() };
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { get: (u) => call('GET', u), post: (u, b = {}) => call('POST', u, b), put: (u, b = {}) => call('PUT', u, b), del: (u) => call('DELETE', u) };
}
let clock = Date.parse('2030-01-07T12:00:00.000Z'); // segunda, 09:00 em Brasília
const at = (date, hm) => new Date(Date.parse(`${date}T${hm}:00.000Z`) + 3 * 3600e3).toISOString();

before(async () => {
  await new Promise((ok) => mpServer.listen(0, ok));
  await new Promise((ok) => pbServer.listen(0, ok));
  process.env.MERCADOPAGO_BASE_URL = `http://localhost:${mpServer.address().port}`;
  process.env.PAGBANK_BASE_URL = `http://localhost:${pbServer.address().port}`;
  const origLog = console.log;
  console.log = () => {};
  server = await start(0);
  console.log = origLog;
  base = `http://localhost:${server.address().port}`;
  G._setNow(() => clock);
});
after(() => {
  server.closeAllConnections?.();
  server.close();
  mpServer.close();
  pbServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const admin = client();
async function mkPro(name, email, phone) {
  await admin.post('/api/auth/admin/login', { username: 'admin', password: 'senha-admin-123' });
  const r = await admin.post('/api/admin/professionals', { name, profession: 'Psicólogo(a)', registry: `CRP 06/${60000 + AUTO_CPF}`, email, phone, state: 'SP', city: 'Campinas', specialties: ['Ansiedade'] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const cl = client();
  await cl.post('/api/auth/professional/login', { login: r.data.code, password: r.data.password });
  await cl.put('/api/professional/profile', { name, phone, state: 'SP', city: 'Campinas', bio: '', price: '150', specialties: ['Ansiedade'] });
  await cl.put('/api/agenda/settings', { starts: { 1: ['08:00', '10:00'], 2: ['08:00'], 3: ['08:00'], 4: ['08:00'], 5: ['08:00'] }, session_minutes: 50, online: true });
  return { cl, id: r.data.id };
}
async function mkPatient(name) {
  const cl = client();
  const r = await cl.post('/api/auth/patient/register', { name, cpf: nextCpf(), state: 'SP', city: 'Campinas', birth_date: '1990-01-01', password: 'senha123' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return cl;
}

test('Mercado Pago: conecta com o Access Token, Pix da consulta confirma sozinho e o reembolso sai sozinho', async () => {
  const P = await mkPro('Marta Mercado Pago', 'marta.mp@example.com', '11966660001');
  // Sem forma de receber: não abre a agenda
  assert.equal((await P.cl.get('/api/agenda/settings')).data.ready, false);
  assert.equal((await P.cl.post('/api/agenda/payment', { provider: 'mercadopago', key: 'APP_USR-errado-0000000000000000000' })).status, 400, 'token inválido');
  assert.equal((await P.cl.post('/api/agenda/payment', { provider: 'inventada', key: 'x'.repeat(30) })).status, 400);
  const c = await P.cl.post('/api/agenda/payment', { provider: 'mercadopago', key: 'APP_USR-token-de-producao-do-mercado-pago-123' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.payment.provider, 'mercadopago');
  assert.equal(c.data.payment.provider_label, 'Mercado Pago');
  assert.equal(c.data.payment.account_name, 'Consultório MP');
  assert.equal(c.data.mode, 'auto');
  assert.equal(c.data.ready, true);
  const pat = await mkPatient('Paula Pagadora Mendes');
  let r = await pat.post('/api/agenda/book', { professional_id: P.id, start: at('2030-01-08', '08:00'), accept: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.mode, 'auto');
  assert.match(r.data.pix_payload, /^00020126MP-/);
  assert.ok(r.data.pix_image);
  const a = r.data;
  const payId = [...mp.pays.keys()].pop();
  assert.equal(mp.pays.get(payId).transaction_amount, 150);
  assert.equal(mp.pays.get(payId).external_reference, `acolia-consulta-${a.id}`);
  // Pagou no banco: a varredura confere e confirma
  mp.pays.get(payId).status = 'approved';
  await G.sweep();
  r = await pat.get(`/api/agenda/appointments/${a.id}`);
  assert.equal(r.data.status, 'confirmada');
  // Cancela no prazo: reembolso automático pelo Mercado Pago
  r = await pat.post(`/api/agenda/appointments/${a.id}/cancel`, { reason: 'horario' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await new Promise((ok) => setTimeout(ok, 100));
  r = await pat.get(`/api/agenda/appointments/${a.id}`);
  assert.equal(r.data.status, 'reembolsada');
  assert.equal(mp.pays.get(payId).status, 'refunded');
  // Pacote mensal também pelo Mercado Pago
  await P.cl.post('/api/agenda/packages', { per_week: 1, price: '500' });
  const offer = (await pat.get(`/api/agenda/pro/${P.id}/packages`)).data.items[0];
  const buy = await pat.post(`/api/agenda/packages/${offer.id}/buy`, { accept: true });
  assert.equal(buy.status, 201, JSON.stringify(buy.data));
  assert.equal(buy.data.mode, 'auto');
  assert.ok(buy.data.pix_image);
  mp.pays.get([...mp.pays.keys()].pop()).status = 'approved';
  assert.equal((await pat.get(`/api/agenda/my-packages/${buy.data.id}`)).data.status, 'ativo');
});

test('PagBank: conecta com o token, Pix da consulta (QR Code gerado aqui) confirma sozinho e o estorno sai sozinho', async () => {
  const P = await mkPro('Paulo PagBank Souza', 'paulo.pb@example.com', '11966660002');
  assert.equal((await P.cl.post('/api/agenda/payment', { provider: 'pagbank', key: 'token-errado-0000-0000-0000-000000000' })).status, 400);
  const c = await P.cl.post('/api/agenda/payment', { provider: 'pagbank', key: 'token-pagbank-de-producao-0000-1111-2222-3333' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.payment.provider_label, 'PagBank');
  assert.equal(c.data.payment.env, 'producao');
  const pat = await mkPatient('Pedro Pix Andrade');
  let r = await pat.post('/api/agenda/book', { professional_id: P.id, start: at('2030-01-09', '08:00'), accept: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.pix_payload, /^00020126PB-/);
  assert.ok(r.data.pix_image && r.data.pix_image.length > 100, 'QR Code gerado pela Acolia');
  const order = [...pb.orders.keys()].pop();
  assert.equal(pb.orders.get(order).qr_codes[0].amount.value, 15000);
  pbPay(order);
  await G.sweep();
  r = await pat.get(`/api/agenda/appointments/${r.data.id}`);
  assert.equal(r.data.status, 'confirmada');
  r = await pat.post(`/api/agenda/appointments/${r.data.id}/cancel`, { reason: 'saude' });
  await new Promise((ok) => setTimeout(ok, 100));
  r = await pat.get(`/api/agenda/appointments/${r.data.id}`);
  assert.equal(r.data.status, 'reembolsada');
  assert.equal(pb.orders.get(order).charges[0].status, 'CANCELED');
  // Trocar de empresa com consulta paga em andamento: não deixa
  const pat2 = await mkPatient('Pietra Segunda Lima');
  r = await pat2.post('/api/agenda/book', { professional_id: P.id, start: at('2030-01-10', '08:00'), accept: true });
  pbPay([...pb.orders.keys()].pop());
  await G.sweep();
  assert.equal((await P.cl.post('/api/agenda/payment', { provider: 'mercadopago', key: 'APP_USR-token-de-producao-do-mercado-pago-123' })).status, 409);
});
