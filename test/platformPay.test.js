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
process.env.FREE_TRIAL = 'off'; // ligado só no teste dos 7 dias grátis
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
  const form = async (url, fields, file) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    if (file) fd.append(file.field, new Blob([file.data], { type: file.type }), file.name);
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

test('clínica com Pix: usa os dados do cadastro (CNPJ), R$ 49,90, liberada na hora; admin confere', async () => {
  const LOGO = { field: 'photo', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), type: 'image/png', name: 'logo.png' };
  const base0 = { name: 'Clínica Pix Teste', email: 'pix@clinica.example.com', phone: '(11) 98888-7777', state: 'SP', city: 'Campinas', address: 'Rua das Flores, 10', plan: 'clinica-4990' };
  const anon = client();
  const r = await anon.form('/api/auth/clinic/register', { ...base0, doc: '11.222.333/0001-81', owner_cpf: cpfOf(5151) }, LOGO);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.pay.amount_cents, 4990);
  const row = db.prepare('SELECT * FROM platform_payments WHERE id = ?').get(r.data.pay.id);
  PP()._fakePay(row.identifier);
  const s = await anon.get(`/api/plataforma/pagamento/cadastro/${r.data.pay.id}?token=${r.data.pay.token}`);
  assert.equal(s.data.status, 'pago');
  assert.ok(s.data.password);
  const c = db.prepare('SELECT * FROM clinics WHERE code = ?').get(r.data.code);
  assert.equal(c.status, 'aprovado');
  assert.equal(c.review_pending, 1);
  assert.equal(c.must_change_password, 1);
  assert.equal(PP().clinicPayer(c).cpf, cpfOf(5151), 'o Pix sai com o CPF do proprietário');

  const cl = client();
  assert.equal((await cl.post('/api/auth/clinic/login', { login: r.data.code, password: s.data.password })).status, 200);
  assert.equal((await cl.post('/api/clinic/first-password', { password: 'clinica123', confirm: 'clinica123' })).status, 200);
  // renovação: um clique, com os dados que a clínica já tem
  const ren = await cl.post('/api/plataforma/pagamento/renovar');
  assert.equal(ren.status, 200, JSON.stringify(ren.data));
  assert.equal(ren.data.amount_cents, 4990);

  const admin = client();
  await admin.post('/api/auth/admin/login', { username: 'admin', password: 'senha-admin-123' });
  const det = await admin.get(`/api/admin/clinics/${c.id}`);
  assert.equal(det.data.review_pending, true);
  assert.equal(det.data.payments.length, 2);
  assert.equal((await admin.post(`/api/admin/clinics/${c.id}/review`, { ok: true })).data.review_pending, false);
});

test('7 dias grátis: CPF novo entra direto (vitrine, tudo liberado), só uma vez por CPF; paga quando quiser; selo e avaliações', async () => {
  process.env.FREE_TRIAL = 'on';
  try {
    const U = require('../server/util');
    const anon = client();
    const cpf = cpfOf(7777);
    const reg = (email) => anon.form('/api/auth/professional/register', {
      name: 'Bruno Teixeira Gomes', profession: 'Psicanalista', email, phone: '(94) 99999-3333', state: 'PA', city: 'Parauapebas',
      cpf, specialties: JSON.stringify(['Ansiedade']), birth_date: '1987-07-07',
      terms_accept: '1', terms_version: require('../server/terms').VERSION, terms_name: 'Bruno Teixeira Gomes', plan: 'mensal-30',
    });
    const r = await reg('bruno.trial@example.com');
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.pay, undefined, 'sem pagamento no cadastro');
    assert.equal(r.data.trial.days, 7);
    assert.equal(r.data.trial.until, U.addDaysISO(U.todayISO(), 7));
    assert.ok(r.data.password);
    const p = db.prepare('SELECT * FROM professionals WHERE code = ?').get(r.data.code);
    assert.equal(p.status, 'aprovado');
    assert.equal(p.trial, 1);
    assert.equal(p.review_pending, 1);
    assert.equal(p.verified, 0);
    // Já aparece na vitrine, sem selo
    const vit = (await client().get('/api/professionals')).data.items.find((x) => x.id === p.id);
    assert.ok(vit, 'aparece na vitrine');
    assert.equal(vit.verified, false);
    // Entra com a senha de acesso único e cria a própria
    const pro = client();
    assert.equal((await pro.post('/api/auth/professional/login', { login: r.data.code, password: r.data.password })).status, 200);
    assert.equal((await pro.post('/api/professional/first-password', { password: 'minhasenha7', confirm: 'minhasenha7' })).status, 200);
    let me = (await pro.get('/api/auth/me')).data;
    assert.equal(me.account.trial, true);
    assert.equal(me.user.trial, true);
    // Paga antes de acabar: soma 30 dias depois do fim dos 7 dias e sai do período grátis
    const ren = await pro.post('/api/plataforma/pagamento/renovar');
    assert.equal(ren.status, 200, JSON.stringify(ren.data));
    PP()._fakePay(db.prepare('SELECT identifier FROM platform_payments WHERE id = ?').get(ren.data.id).identifier);
    const st = await pro.get(`/api/plataforma/pagamento/renovar/${ren.data.id}`);
    assert.equal(st.data.subscription_until, U.addDaysISO(U.todayISO(), 37));
    me = (await pro.get('/api/auth/me')).data;
    assert.equal(me.account.trial, false);
    // O mesmo CPF não ganha os 7 dias de novo (ex.: apagou a conta e voltou): paga no cadastro
    db.prepare('UPDATE professionals SET cpf = ?, email = ? WHERE id = ?').run(cpfOf(7799), 'outro.cpf@example.com', p.id); // (libera o CPF, como se tivesse apagado)
    const again = await reg('bruno.denovo@example.com');
    assert.equal(again.status, 201, JSON.stringify(again.data));
    assert.equal(again.data.trial, undefined);
    assert.ok(again.data.pay, 'vai para o Pix');
    assert.equal(db.prepare('SELECT status FROM professionals WHERE code = ?').get(again.data.code).status, 'pendente');

    // Período grátis acabou: sai da vitrine e só usa depois de pagar
    const r2 = await anon.form('/api/auth/professional/register', {
      name: 'Carla Nunes Prado', profession: 'Psicanalista', email: 'carla.trial@example.com', phone: '(94) 99999-4444', state: 'PA', city: 'Parauapebas',
      cpf: cpfOf(7778), specialties: JSON.stringify(['Ansiedade']), birth_date: '1990-01-01',
      terms_accept: '1', terms_version: require('../server/terms').VERSION, terms_name: 'Carla Nunes Prado', plan: 'mensal-30',
    });
    const carla = db.prepare('SELECT * FROM professionals WHERE code = ?').get(r2.data.code);
    db.prepare("UPDATE professionals SET subscription_until = date('now', '-3 days'), must_change_password = 0 WHERE id = ?").run(carla.id);
    assert.ok(!(await client().get('/api/professionals')).data.items.some((x) => x.id === carla.id), 'saiu da vitrine');
    const cl = client();
    await cl.post('/api/auth/professional/login', { login: r2.data.code, password: r2.data.password });
    const meC = (await cl.get('/api/auth/me')).data;
    assert.equal(meC.account.blocked, 'vencido');
    assert.equal(meC.account.trial, true);
    assert.equal((await cl.get('/api/professional/me')).status, 423);
    assert.equal((await cl.post('/api/plataforma/pagamento/renovar')).status, 200, 'consegue pagar pela tela de bloqueio');

    // Selo de verificado: a equipe confere e dá o selo; ele vê o aviso uma vez
    const admin = client();
    await admin.post('/api/auth/admin/login', { username: 'admin', password: 'senha-admin-123' });
    const rv = await admin.post(`/api/admin/professionals/${p.id}/review`, { ok: true });
    assert.equal(rv.data.verified, true);
    assert.equal(rv.data.review_pending, false);
    const pub = (await client().get(`/api/professionals/${p.id}`)).data;
    assert.equal(pub.verified, true);
    me = (await pro.get('/api/professional/me')).data;
    assert.equal(me.verified, true);
    assert.equal(me.verified_seen, false);
    await pro.post('/api/professional/verified-seen');
    assert.equal((await pro.get('/api/professional/me')).data.verified_seen, true);
    assert.equal((await admin.post(`/api/admin/professionals/${p.id}/verified`, { verified: false })).data.verified, false, 'admin tira o selo');
    await admin.post(`/api/admin/professionals/${p.id}/verified`, { verified: true });

    // Avaliação: depois da consulta concluída, o paciente dá de 1 a 5 estrelas (uma vez)
    const pt = client();
    assert.equal((await pt.post('/api/auth/patient/register', { name: 'Paula Avalia Silva', cpf: cpfOf(8888), birth_date: '1991-01-01', state: 'PA', city: 'Parauapebas', phone: '94999995555', password: 'senha123' })).status, 201);
    const ptId = db.prepare("SELECT id FROM patients WHERE name = 'Paula Avalia Silva'").get().id;
    const t0 = new Date(Date.now() - 2 * 3600e3).toISOString();
    const t1 = new Date(Date.now() - 3600e3).toISOString();
    const mk = (status) => Number(db.prepare("INSERT INTO appointments (professional_id, patient_id, start_at, end_at, price_cents, mode, origin, status) VALUES (?, ?, ?, ?, 15000, 'manual', 'paciente', ?)").run(p.id, ptId, t0, t1, status).lastInsertRowid);
    const done = mk('concluida');
    const open = mk('confirmada');
    const tr = (await pt.get('/api/agenda/to-rate')).data;
    assert.deepEqual(tr.items.map((x) => x.id), [done]);
    assert.equal(tr.labels[5], 'Excelente');
    assert.equal((await pt.post(`/api/agenda/appointments/${done}/rate`, { stars: 6 })).status, 400);
    assert.equal((await pt.post(`/api/agenda/appointments/${open}/rate`, { stars: 5 })).status, 409, 'só depois da consulta');
    assert.equal((await client().post(`/api/agenda/appointments/${done}/rate`, { stars: 1 })).status, 401);
    assert.equal((await pro.post(`/api/agenda/appointments/${done}/rate`, { stars: 5 })).status, 403, 'profissional não se avalia');
    const ok = await pt.post(`/api/agenda/appointments/${done}/rate`, { stars: 5 });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.label, 'Excelente');
    assert.equal((await pt.post(`/api/agenda/appointments/${done}/rate`, { stars: 1 })).status, 409, 'uma vez só');
    assert.equal((await pt.get('/api/agenda/to-rate')).data.items.length, 0);
    assert.deepEqual((await client().get(`/api/professionals/${p.id}`)).data.rating, { avg: 5, count: 1 });
    // Na vitrine, os mais bem avaliados vêm primeiro
    const ids = (await client().get('/api/professionals')).data.items.map((x) => x.id);
    assert.equal(ids[0], p.id);
  } finally { process.env.FREE_TRIAL = 'off'; }
});
