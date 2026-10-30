'use strict';
// Portais (versão 2.0): Acolia Psi, Nutri e Fisio num app só, com uma conta de paciente para os três
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acolia-portais-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'senha-admin-123';
process.env.FIRST_PASSWORD = 'off';
delete process.env.FREE_TRIAL; // 7 dias grátis ligados
delete process.env.SYNCPAY_FAKE;
delete process.env.CPF_API_URL;
process.env.TEST_ACCOUNTS = '0';
process.env.SKIP_OWNER_TEST = '1';

const { start } = require('../server');

let server;
let base;
// Cliente com cookies (sessão e o portal escolhido)
function client(portal) {
  const jar = new Map(portal ? [['acolia_portal', portal]] : []);
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const keep = (res) => {
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  };
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie() }, body: body ? JSON.stringify(body) : undefined });
    keep(res);
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  const form = async (url, fields, file) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    if (file) fd.append(file.field, new Blob([file.data], { type: file.type }), file.name);
    const res = await fetch(base + url, { method: 'POST', body: fd, headers: { Cookie: cookie() } });
    keep(res);
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { jar, form, get: (u) => call('GET', u), post: (u, b = {}) => call('POST', u, b), put: (u, b = {}) => call('PUT', u, b) };
}
function cpfOf(n) {
  const d = String(100000000 + n).slice(-9);
  const dv = (s) => { let t = 0; for (let i = 0; i < s.length; i++) t += +s[i] * (s.length + 1 - i); const r = (t * 10) % 11; return r === 10 ? 0 : r; };
  const x = d + dv(d);
  return x + dv(x);
}
// PNG 1x1 (carteirinha de mentira)
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

const proForm = (over) => ({
  name: 'Camila Ferreira Lopes', email: 'camila@example.com', phone: '(19) 99999-1111', state: 'SP', city: 'Campinas',
  cpf: cpfOf(7001), specialties: JSON.stringify(['Emagrecimento']), birth_date: '1990-03-22',
  terms_accept: '1', terms_version: require('../server/terms').versionOf(over.portal), terms_name: 'Camila Ferreira Lopes', plan: 'mensal-30', ...over,
});

test('portais: página principal, páginas de cada portal, ícones e configuração', async () => {
  const anon = client();
  const cfg = (await anon.get('/api/config')).data;
  assert.equal(cfg.portals_enabled, true);
  assert.deepEqual(cfg.portals.map((p) => p.key), ['psi', 'nutri', 'fisio']);
  assert.ok(cfg.portals[1].professions.includes('Nutricionista'));
  assert.equal(cfg.councils.Fisioterapeuta, 'CREFITO');
  assert.ok(cfg.specialties_by_portal.fisio.some((g) => g.items.includes('Pilates solo')));
  const home = await anon.get('/');
  assert.match(home.data, /Cuidado para você por inteiro/);
  const nutri = await anon.get('/nutri');
  assert.match(nutri.data, /data-portal="nutri"/);
  assert.equal(anon.jar.get('acolia_portal'), 'nutri');
  // Ícone do app: a logo oficial nova (pasta v2) com os portais ligados
  const icon = await fetch(base + '/img/favicon.png').then((r) => r.arrayBuffer());
  assert.deepEqual(Buffer.from(icon), fs.readFileSync(path.join(__dirname, '..', 'public', 'img', 'v2', 'favicon.png')));
});

test('portais: profissional de cada portal, CPF e e-mail por portal, 7 dias grátis em cada um, vitrine separada', async () => {
  const anon = client();
  // Profissão de outro portal é recusada
  let r = await anon.form('/api/auth/professional/register', proForm({ portal: 'nutri', profession: 'Psicólogo(a)', registry: 'CRP 06/12345' }), card);
  assert.equal(r.status, 400);
  // Nutricionista (CRN) no Nutri: 7 dias grátis, entra direto
  r = await anon.form('/api/auth/professional/register', proForm({ portal: 'nutri', profession: 'Nutricionista', registry: 'crn 3 45678' }), card);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(r.data.trial && r.data.password);
  const nutriCode = r.data.code;
  const { db } = require('../server/db');
  const nutri = db.prepare('SELECT * FROM professionals WHERE code = ?').get(nutriCode);
  assert.equal(nutri.portal, 'nutri');
  assert.equal(nutri.registry, 'CRN-3 45678');
  // Mesmo CPF de novo no Nutri: já tem conta
  r = await anon.form('/api/auth/professional/register', proForm({ portal: 'nutri', profession: 'Nutricionista', registry: 'CRN-3 45678', email: 'outro@example.com' }), card);
  assert.equal(r.status, 409);
  // Mesmo CPF e mesmo e-mail no Fisio (Pilates não tem conselho): outra conta, com os seus 7 dias grátis
  r = await anon.form('/api/auth/professional/register', proForm({ portal: 'fisio', profession: 'Instrutor(a) de Pilates', specialties: JSON.stringify(['Pilates solo']) }));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(r.data.trial);
  const fisioCode = r.data.code;
  // Fisioterapeuta com CREFITO
  r = await anon.form('/api/auth/professional/register', proForm({ portal: 'fisio', profession: 'Fisioterapeuta', registry: 'CREFITO-3/123456', cpf: cpfOf(7002), email: 'bruno@example.com', name: 'Bruno Nogueira Silva', terms_name: 'Bruno Nogueira Silva', specialties: JSON.stringify(['Dor lombar']) }), card);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(db.prepare('SELECT registry FROM professionals WHERE code = ?').get(r.data.code).registry, 'CREFITO-3/123456-F');

  // Vitrine: cada portal mostra só os seus
  const names = async (portal) => (await client(portal).get('/api/professionals')).data.items.map((p) => p.profession);
  assert.deepEqual(await names('nutri'), ['Nutricionista']);
  assert.deepEqual((await names('fisio')).sort(), ['Fisioterapeuta', 'Instrutor(a) de Pilates']);
  assert.deepEqual(await names('psi'), []);
  assert.deepEqual(await names(null), []); // sem portal escolhido: Psi

  // Login pelo e-mail: entra na conta do portal em que a pessoa está; o e-mail aparece sem o "#portal"
  const pn = client('nutri');
  const pass = (code) => { const pw = 'senha-nova-1'; db.prepare('UPDATE professionals SET password_hash = ?, must_change_password = 0 WHERE code = ?').run(require('../server/util').hashPassword(pw), code); return pw; };
  const pw1 = pass(nutriCode); pass(fisioCode);
  assert.equal((await pn.post('/api/auth/professional/login', { login: 'camila@example.com', password: pw1 })).status, 200);
  let me = (await pn.get('/api/auth/me')).data;
  assert.equal(me.user.portal, 'nutri');
  assert.equal(me.user.email, 'camila@example.com');
  const pf = client('fisio');
  await pf.post('/api/auth/professional/login', { login: 'camila@example.com', password: pw1 });
  me = (await pf.get('/api/auth/me')).data;
  assert.equal(me.user.portal, 'fisio');
  assert.equal(me.user.profession, 'Instrutor(a) de Pilates');
  // Profissional vê a vitrine do próprio portal (mesmo com outro portal no cookie)
  pf.jar.set('acolia_portal', 'psi');
  assert.ok((await pf.get('/api/professionals')).data.items.every((p) => p.portal === 'fisio'));

  // Documentos por profissão
  const { allowedKinds } = require('../server/routes/docs');
  assert.ok(allowedKinds('Fisioterapeuta').includes('atestado'));
  assert.ok(!allowedKinds('Instrutor(a) de Pilates').includes('atestado'));
  assert.ok(allowedKinds('Nutrólogo(a)').includes('receita'));
  assert.ok(!allowedKinds('Nutricionista').includes('receita'));
});

test('portais: paciente com uma conta para os três e clínica por portal', async () => {
  const pat = client();
  let r = await pat.post('/api/auth/patient/register', {
    name: 'Tainá Souza Prado', cpf: cpfOf(7100), birth_date: '1995-06-10', state: 'SP', city: 'Campinas', phone: '(19) 98888-7777',
    password: 'senha12345', handle: 'taina.prado', portal: 'fisio',
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  let me = (await pat.get('/api/auth/me')).data;
  assert.equal(me.user.last_portal, 'fisio');
  r = await pat.post('/api/patient/portal', { portal: 'nutri' });
  assert.equal(r.status, 200);
  assert.equal(pat.jar.get('acolia_portal'), 'nutri');
  me = (await pat.get('/api/auth/me')).data;
  assert.equal(me.user.last_portal, 'nutri');
  assert.equal((await pat.post('/api/patient/portal', { portal: 'xyz' })).status, 400);
  // Clínica no Nutri: o mesmo CPF pode ter outra clínica no Fisio
  const C = require('../server/clinics');
  const doc = cpfOf(7200);
  const logo = { field: 'photo', data: PNG, type: 'image/png', name: 'logo.png' };
  const clinic = (portal) => client().form('/api/auth/clinic/register', { name: `Clínica ${portal}`, doc, owner_cpf: doc, email: 'clinica@example.com', phone: '(19) 3333-4444', state: 'SP', city: 'Campinas', address: 'Rua A, 100', plan: 'clinica-4990', portal }, logo);
  assert.equal((await clinic('nutri')).status, 201);
  assert.equal((await clinic('nutri')).status, 409);
  assert.equal((await clinic('fisio')).status, 201);
  assert.ok(C.docTaken(doc, 0, 'nutri') && C.docTaken(doc, 0, 'fisio') && !C.docTaken(doc, 0, 'psi'));
});

test('portais: desligar e "Desistir dos portais" (o site volta ao de antes; Psi e pacientes ficam)', async () => {
  const adm = client();
  await adm.post('/api/auth/admin/login', { username: 'admin', password: 'senha-admin-123' });
  let s = (await adm.get('/api/admin/portals')).data;
  assert.equal(s.enabled, true);
  assert.equal(s.portals.find((p) => p.key === 'fisio').pros, 2);
  // Desligar sem apagar
  s = (await adm.post('/api/admin/portals', { enabled: false })).data;
  assert.equal(s.enabled, false);
  let home = await client().get('/');
  assert.match(home.data, /Saúde mental ao seu alcance/);
  assert.equal((await client().get('/nutri')).status, 404);
  assert.deepEqual((await client('nutri').get('/api/professionals')).data.items, []); // desligado: tudo é Psi
  s = (await adm.post('/api/admin/portals', { enabled: true })).data;
  assert.equal(s.enabled, true);
  // Desistir: precisa digitar DESISTIR
  assert.equal((await adm.post('/api/admin/portals/desistir', { confirm: 'sim' })).status, 400);
  const r = await adm.post('/api/admin/portals/desistir', { confirm: 'desistir' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.removed_professionals, 3);
  assert.equal(r.data.removed_clinics, 2);
  const { db } = require('../server/db');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM professionals WHERE portal IN ('nutri', 'fisio') AND status <> 'excluido'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM patients WHERE status = 'ativo'").get().n, 1); // paciente continua
  home = await client().get('/');
  assert.match(home.data, /Saúde mental ao seu alcance/);
  assert.equal((await adm.get('/api/admin/portals')).data.enabled, false);
});
