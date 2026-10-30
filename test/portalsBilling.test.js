'use strict';
// Portais: 7 dias grátis e mensalidade (Pix simulado) funcionando igual no Psi, no Nutri e no Fisio.
// Grátis → venceu (some da vitrine, tela de bloqueio) → paga → liberado de novo por 30 dias.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acolia-portais-pag-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'senha-admin-123';
process.env.FIRST_PASSWORD = 'off';
process.env.SYNCPAY_FAKE = '1';
delete process.env.FREE_TRIAL; // 7 dias grátis ligados
delete process.env.CPF_API_URL;
process.env.TEST_ACCOUNTS = '0';
process.env.SKIP_OWNER_TEST = '1';

const { start } = require('../server');

let server;
let base;
function client(portal) {
  const jar = new Map(portal ? [['acolia_portal', portal]] : []);
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const keep = (res) => {
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  };
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie() }, body: body ? JSON.stringify(body) : undefined });
    keep(res);
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const form = async (url, fields, file) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    if (file) fd.append(file.field, new Blob([file.data], { type: file.type }), file.name);
    const res = await fetch(base + url, { method: 'POST', body: fd, headers: { Cookie: cookie() } });
    keep(res);
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
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const card = { field: 'document', data: PNG, type: 'image/png', name: 'carteirinha.png' };

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

const U = require('../server/util');
const { db } = require('../server/db');
const proForm = (portal, over) => ({
  name: 'Lia Moraes Duarte', email: 'lia@example.com', phone: '(19) 99999-2222', state: 'SP', city: 'Campinas',
  cpf: cpfOf(8100), birth_date: '1991-05-10', terms_accept: '1', terms_version: require('../server/terms').versionOf(portal),
  terms_name: 'Lia Moraes Duarte', plan: 'mensal-30', portal, ...over,
});
const PROS = {
  psi: [{ profession: 'Psicanalista', specialties: JSON.stringify(['Ansiedade']) }],
  nutri: [{ profession: 'Nutricionista', registry: 'CRN-3 45679', specialties: JSON.stringify(['Emagrecimento']) }, card],
  fisio: [{ profession: 'Instrutor(a) de Pilates', specialties: JSON.stringify(['Pilates solo']) }],
};
const inShowcase = async (portal, id) => (await client(portal).get('/api/professionals')).data.items.some((x) => x.id === id);
// Paga a mensalidade pela tela (Pix simulado) e confere a liberação
async function payRenewal(c) {
  const ren = await c.post('/api/plataforma/pagamento/renovar');
  assert.equal(ren.status, 200, JSON.stringify(ren.data));
  assert.equal(ren.data.amount_cents, 3000);
  assert.ok(ren.data.pix_code && ren.data.qr);
  await client().post(`/api/plataforma/pagamento/_simular/${ren.data.id}`);
  const st = await c.get(`/api/plataforma/pagamento/renovar/${ren.data.id}`);
  assert.equal(st.data.status, 'pago');
  return st.data;
}

for (const portal of ['psi', 'nutri', 'fisio']) {
  test(`${portal}: 7 dias grátis → venceu (bloqueia e sai da vitrine) → paga → liberado por 30 dias`, async () => {
    const [over, file] = PROS[portal];
    const r = await client(portal).form('/api/auth/professional/register', proForm(portal, over), file);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.trial.days, 7);
    assert.equal(r.data.trial.until, U.addDaysISO(U.todayISO(), 7));
    const p = db.prepare('SELECT * FROM professionals WHERE code = ?').get(r.data.code);
    assert.equal(p.portal, portal);
    assert.equal(p.status, 'aprovado');
    assert.ok(await inShowcase(portal, p.id), 'nos 7 dias aparece na vitrine do portal');

    const c = client(portal);
    assert.equal((await c.post('/api/auth/professional/login', { login: r.data.code, password: r.data.password })).status, 200);
    let me = (await c.get('/api/auth/me')).data;
    assert.equal(me.account.trial, true);
    assert.ok(!me.account.blocked);
    assert.equal((await c.get('/api/professional/me')).status, 200, 'usa tudo nos 7 dias');

    // Último dia: aviso para pagar; ainda usa
    db.prepare('UPDATE professionals SET subscription_until = ? WHERE id = ?').run(U.todayISO(), p.id);
    me = (await c.get('/api/auth/me')).data;
    assert.equal(me.account.warn, true);
    assert.equal((await c.get('/api/professional/me')).status, 200);

    // Acabou (passou o dia a mais): bloqueia e some da vitrine
    db.prepare('UPDATE professionals SET subscription_until = ? WHERE id = ?').run(U.addDaysISO(U.todayISO(), -2), p.id);
    me = (await c.get('/api/auth/me')).data;
    assert.equal(me.account.blocked, 'vencido');
    assert.equal((await c.get('/api/professional/me')).status, 423);
    assert.ok(!(await inShowcase(portal, p.id)), 'vencido sai da vitrine');

    // Paga pela tela de bloqueio: libera na hora, +30 dias a partir de hoje, sai do período grátis
    const st = await payRenewal(c);
    assert.equal(st.subscription_until, U.addDaysISO(U.todayISO(), 30));
    me = (await c.get('/api/auth/me')).data;
    assert.ok(!me.account.blocked);
    assert.equal(me.account.trial, false);
    assert.equal((await c.get('/api/professional/me')).status, 200);
    assert.ok(await inShowcase(portal, p.id), 'pagou: volta para a vitrine');

    // Pagar de novo antes de vencer soma no fim
    const st2 = await payRenewal(c);
    assert.equal(st2.subscription_until, U.addDaysISO(U.todayISO(), 60));
  });
}

test('mesmo CPF: os 7 dias valem uma vez em cada portal; pagar um portal não libera o outro', async () => {
  const cpf = cpfOf(8200);
  const reg = (portal, email) => client(portal).form('/api/auth/professional/register',
    proForm(portal, { ...PROS[portal][0], registry: PROS[portal][0].registry ? 'CRN-3 45680' : undefined, cpf, email }), PROS[portal][1]);
  const a = await reg('nutri', 'rui@example.com');
  const b = await reg('fisio', 'rui@example.com');
  assert.ok(a.data.trial && b.data.trial, 'grátis nos dois portais');
  const pa = db.prepare('SELECT * FROM professionals WHERE code = ?').get(a.data.code);
  const pb = db.prepare('SELECT * FROM professionals WHERE code = ?').get(b.data.code);
  db.prepare('UPDATE professionals SET subscription_until = ? WHERE id IN (?, ?)').run(U.addDaysISO(U.todayISO(), -2), pa.id, pb.id);
  const cn = client('nutri');
  await cn.post('/api/auth/professional/login', { login: a.data.code, password: a.data.password });
  await payRenewal(cn);
  assert.ok(await inShowcase('nutri', pa.id));
  assert.ok(!(await inShowcase('fisio', pb.id)), 'o Fisio continua vencido até pagar o dele');
  const cf = client('fisio');
  await cf.post('/api/auth/professional/login', { login: b.data.code, password: b.data.password });
  assert.equal((await cf.get('/api/auth/me')).data.account.blocked, 'vencido');
  await payRenewal(cf);
  assert.ok(await inShowcase('fisio', pb.id));
});

test('CPF que já usou os 7 dias no portal: paga o Pix no cadastro e a conta libera na hora', async () => {
  for (const portal of ['psi', 'nutri', 'fisio']) {
    const cpf = cpfOf(8300 + portal.length);
    require('../server/trial').markUsed(cpf, portal);
    const [over, file] = PROS[portal];
    const r = await client(portal).form('/api/auth/professional/register',
      proForm(portal, { ...over, registry: over.registry ? 'CRN-3 45681' : undefined, cpf, email: `ja.${portal}@example.com` }), file);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.trial, undefined);
    assert.ok(r.data.pay && r.data.pay.token, `${portal}: gerou o Pix do cadastro`);
    assert.equal(r.data.pay.amount_cents, 3000);
    await client().post(`/api/plataforma/pagamento/_simular/${r.data.pay.id}`);
    const st = await client().get(`/api/plataforma/pagamento/cadastro/${r.data.pay.id}?token=${r.data.pay.token}`);
    assert.equal(st.data.status, 'pago');
    assert.ok(st.data.password);
    const p = db.prepare('SELECT * FROM professionals WHERE code = ?').get(r.data.code);
    assert.equal(p.status, 'aprovado');
    assert.equal(p.portal, portal);
    assert.ok(await inShowcase(portal, p.id));
  }
});

test('clínica de cada portal: paga R$ 49,90 no cadastro e libera; venceu → paga e volta', async () => {
  for (const [i, portal] of ['psi', 'nutri', 'fisio'].entries()) {
    const r = await client(portal).form('/api/auth/clinic/register', {
      name: `Clínica ${portal}`, doc: cpfOf(8400 + i), email: `clinica.${portal}@example.com`, phone: '(19) 3333-4444', state: 'SP', city: 'Campinas',
      address: 'Rua das Flores, 100, Centro', plan: 'clinica-4990', has_doctors: '0', portal, responsible: 'Ana Paula Reis',
    }, { field: 'photo', data: PNG, type: 'image/png', name: 'logo.png' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.pay.amount_cents, 4990);
    await client().post(`/api/plataforma/pagamento/_simular/${r.data.pay.id}`);
    const st = await client().get(`/api/plataforma/pagamento/cadastro/${r.data.pay.id}?token=${r.data.pay.token}`);
    assert.equal(st.data.status, 'pago');
    const cl = db.prepare('SELECT * FROM clinics WHERE code = ?').get(r.data.code);
    assert.equal(cl.status, 'aprovado');
    assert.equal(cl.portal, portal);
    db.prepare('UPDATE clinics SET subscription_until = ? WHERE id = ?').run(U.addDaysISO(U.todayISO(), -2), cl.id);
    const c = client(portal);
    assert.equal((await c.post('/api/auth/clinic/login', { login: r.data.code, password: st.data.password })).status, 200);
    assert.equal((await c.get('/api/auth/me')).data.account.blocked, 'vencido');
    const ren = await c.post('/api/plataforma/pagamento/renovar');
    assert.equal(ren.data.amount_cents, 4990);
    await client().post(`/api/plataforma/pagamento/_simular/${ren.data.id}`);
    assert.equal((await c.get(`/api/plataforma/pagamento/renovar/${ren.data.id}`)).data.status, 'pago');
    assert.ok(!(await c.get('/api/auth/me')).data.account.blocked);
  }
});
