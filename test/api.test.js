'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acolia-test-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'senha-admin-123';
delete process.env.CPF_API_URL;
process.env.TEST_ACCOUNTS = '0';

const { start } = require('../server');
const { isValidCpf } = require('../server/util');
const { io: ioClient } = require('socket.io-client');

let server;
let base;

// Cliente HTTP com "cookie jar" simples
function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
  const form = async (url, fields, file) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    if (file) fd.append('document', new Blob([file.data], { type: file.type }), file.name);
    const res = await fetch(base + url, { method: 'POST', body: fd, headers: cookie ? { Cookie: cookie } : {} });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return {
    form,
    get: (u) => call('GET', u),
    post: (u, b = {}) => call('POST', u, b),
    put: (u, b = {}) => call('PUT', u, b),
    del: (u) => call('DELETE', u),
    get cookie() { return cookie; },
  };
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

// CPFs válidos (gerados para teste)
const CPF_A = '529.982.247-25';
const CPF_B = '111.444.777-35';

const admin = client();
const pro = client();
const pat = client();
const anon = client();
let proId;
let proCode;
let PROFILE;

test('validação de CPF', () => {
  assert.equal(isValidCpf(CPF_A), true);
  assert.equal(isValidCpf('529.982.247-24'), false);
  assert.equal(isValidCpf('111.111.111-11'), false);
  assert.equal(isValidCpf('123'), false);
});

test('paciente: cadastro exige CPF válido e nome completo', async () => {
  let r = await pat.post('/api/auth/patient/register', { name: 'Maria Souza', cpf: '123.456.789-00', state: 'PA', city: 'Parauapebas', password: '123456' });
  assert.equal(r.status, 400);
  r = await pat.post('/api/auth/patient/register', { name: 'Maria', cpf: CPF_A, state: 'PA', city: 'Parauapebas', password: '123456' });
  assert.equal(r.status, 400);
  r = await pat.post('/api/auth/patient/register', { name: 'Maria Souza', cpf: CPF_A, state: 'PA', city: 'Parauapebas', password: '123456' });
  assert.equal(r.status, 201);
  r = await anon.post('/api/auth/patient/register', { name: 'Outra Pessoa', cpf: CPF_A, state: 'PA', city: 'Parauapebas', password: '123456' });
  assert.equal(r.status, 409, 'CPF duplicado');
  r = await pat.get('/api/auth/me');
  assert.equal(r.data.role, 'patient');
  assert.equal(r.data.user.city, 'Parauapebas');
});

const DOC = { data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), type: 'image/png', name: 'carteirinha.png' };
const PRO = {
  name: 'João Pereira', profession: 'Psicólogo(a)', registry: 'CRP 10/12345', email: 'joao@example.com',
  phone: '(94) 99999-0000', state: 'PA', city: 'Parauapebas', password: 'segredo1',
};

test('profissional: registro precisa ser válido, do mesmo estado, e com carteirinha', async () => {
  let r = await anon.form('/api/auth/professional/register', PRO);
  assert.equal(r.status, 400, 'sem carteirinha');
  assert.match(r.data.error, /carteirinha/);
  r = await anon.form('/api/auth/professional/register', { ...PRO, registry: '12345' }, DOC);
  assert.equal(r.status, 400, 'formato inválido');
  r = await anon.form('/api/auth/professional/register', { ...PRO, registry: 'CRP 99/12345' }, DOC);
  assert.equal(r.status, 400, 'região inexistente');
  r = await anon.form('/api/auth/professional/register', { ...PRO, registry: 'CRP 06/12345' }, DOC);
  assert.equal(r.status, 400, 'CRP de SP com estado PA');
  assert.match(r.data.error, /SP/);
  r = await anon.form('/api/auth/professional/register', { ...PRO, profession: 'Psiquiatra', registry: 'CRM-SP 123456' }, DOC);
  assert.equal(r.status, 400, 'CRM de outro estado');
});

test('profissional: cadastro fica pendente e não entra até aprovação', async () => {
  let r = await pro.form('/api/auth/professional/register', { ...PRO, registry: 'crp 10 / 12345' }, DOC);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  proCode = r.data.code;
  assert.match(proCode, /^[A-Z0-9]{8}$/);
  assert.match(proCode, /[A-Z]/);
  assert.match(proCode, /[0-9]/);
  r = await anon.form('/api/auth/professional/register', { ...PRO, email: 'outro@example.com' }, DOC);
  assert.equal(r.status, 409, 'mesmo CRP duas vezes');
  r = await pro.post('/api/auth/professional/login', { login: proCode, password: 'segredo1' });
  assert.equal(r.status, 403);
  // Não aparece na vitrine
  r = await anon.get('/api/professionals');
  assert.equal(r.data.items.length, 0);
});

test('admin: login, lista pendentes e aprova', async () => {
  let r = await admin.post('/api/auth/admin/login', { username: 'admin', password: 'errada' });
  assert.equal(r.status, 401);
  r = await admin.post('/api/auth/admin/login', { username: 'admin', password: 'senha-admin-123' });
  assert.equal(r.status, 200);
  r = await admin.get('/api/admin/professionals?status=pendente');
  assert.equal(r.data.items.length, 1);
  proId = r.data.items[0].id;
  assert.equal(r.data.items[0].code, proCode);
  assert.equal(r.data.items[0].registry, 'CRP 10/12345', 'registro normalizado');
  assert.equal(r.data.items[0].has_document, true);
  const doc = await fetch(`${base}/api/admin/professionals/${proId}/document`, { headers: { Cookie: admin.cookie } });
  assert.equal(doc.status, 200);
  assert.equal((await fetch(`${base}/api/admin/professionals/${proId}/document`)).status, 401, 'carteirinha não é pública');
  r = await admin.post(`/api/admin/professionals/${proId}/status`, { status: 'aprovado' });
  assert.equal(r.data.status, 'aprovado');
  assert.equal(r.data.visible, true);
  // Paciente/profissional não acessam a área do admin
  assert.equal((await pat.get('/api/admin/stats')).status, 401);
});

test('profissional entra (código ou e-mail) e edita o perfil', async () => {
  let r = await pro.post('/api/auth/professional/login', { login: proCode.toLowerCase(), password: 'segredo1' });
  assert.equal(r.status, 200);
  r = await client().post('/api/auth/professional/login', { login: 'joao@example.com', password: 'segredo1' });
  assert.equal(r.status, 200);
  r = await pro.put('/api/professional/profile', PROFILE = {
    name: 'João Pereira', profession: 'Psicólogo(a)', registry: 'CRP 10/12345', phone: '94999990000',
    bio: 'Atendo adultos.', specialties: 'Ansiedade, TCC', price: '150,00',
    packages: [{ sessions: 4, price: '520', description: 'Mensal' }], state: 'PA', city: 'Parauapebas',
    has_clinic: true, clinic_name: 'Clínica Bem', clinic_address: 'Rua A, 100, Centro', pix_key: 'joao@example.com',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.price_cents, 15000);
  // Não consegue trocar o registro nem usar outro nome
  const full = JSON.parse(JSON.stringify(PROFILE));
  r = await pro.put('/api/professional/profile', { ...full, registry: 'CRP 10/99999', profession: 'Psiquiatra' });
  assert.equal(r.data.registry, 'CRP 10/12345');
  assert.equal(r.data.profession, 'Psicólogo(a)');
  r = await pro.put('/api/professional/profile', { ...full, name: 'Carlos Silva' });
  assert.equal(r.status, 400);
  r = await pro.get('/api/professional/me');
  assert.equal(r.data.packages[0].price_cents, 52000);
  assert.equal(r.data.name, 'João Pereira');
});

test('vitrine: visitante vê o básico (local), mas não valores, "Sobre" nem endereço; paciente vê tudo', async () => {
  let r = await anon.get('/api/professionals');
  assert.equal(r.data.items.length, 1);
  const p = r.data.items[0];
  assert.equal(p.locked, true);
  assert.equal(p.price_cents, undefined);
  assert.equal(p.city, 'Parauapebas', 'localização aparece para todos');
  assert.equal(p.clinic_address, undefined);
  assert.equal(p.bio, undefined, '"Sobre" só com conta');
  assert.equal(p.has_bio, true);
  r = await anon.get(`/api/professionals/${proId}`);
  assert.equal(r.data.price_cents, undefined);
  assert.equal(r.data.has_price, true);
  assert.deepEqual(r.data.package_sessions, [4], 'mostra que tem pacote, sem o valor');
  assert.equal(JSON.stringify(r.data).includes('520'), false, 'valor do pacote não vaza');

  r = await pat.get('/api/professionals');
  assert.equal(r.data.items[0].price_cents, 15000);
  assert.equal(r.data.items[0].city, 'Parauapebas');
  assert.equal(r.data.items[0].near, true);
  r = await pat.get('/api/professionals?q=joao');
  assert.equal(r.data.items.length, 1);
  r = await pat.get('/api/professionals?state=SP');
  assert.equal(r.data.items.length, 0);
  r = await pat.get('/api/professionals?place=parauapebas');
  assert.equal(r.data.items.length, 1);
  r = await pat.get('/api/professionals?max_price=100');
  assert.equal(r.data.items.length, 0, 'consulta de R$150 fica fora do limite de R$100');
  r = await pat.get('/api/professionals?max_price=150&sort=preco_menor');
  assert.equal(r.data.items.length, 1);
});

test('favoritos', async () => {
  await pat.post(`/api/patient/favorites/${proId}`);
  let r = await pat.get('/api/professionals?favorites=1');
  assert.equal(r.data.items.length, 1);
  assert.equal(r.data.items[0].favorite, true);
  await pat.del(`/api/patient/favorites/${proId}`);
  r = await pat.get('/api/professionals?favorites=1');
  assert.equal(r.data.items.length, 0);
});

let convId;
test('chat: paciente inicia, profissional responde, Pix, arquivar', async () => {
  let r = await pat.post('/api/chat/conversations', { professional_id: proId });
  assert.equal(r.status, 200);
  convId = r.data.id;
  r = await pat.post(`/api/chat/conversations/${convId}/messages`, { body: 'Olá, doutor!' });
  assert.equal(r.status, 201);
  r = await pro.get('/api/chat/unread');
  assert.equal(r.data.unread, 1);
  r = await pro.get('/api/chat/conversations');
  assert.equal(r.data.items[0].peer.name, 'Maria Souza');
  r = await pro.post(`/api/chat/conversations/${convId}/read`);
  r = await pro.post(`/api/chat/conversations/${convId}/messages`, { body: 'Olá, Maria!' });
  assert.equal(r.status, 201);
  r = await pro.post(`/api/chat/conversations/${convId}/messages`, { kind: 'pix' });
  assert.equal(r.data.kind, 'pix');
  assert.equal(r.data.body, 'joao@example.com');
  r = await pat.post(`/api/chat/conversations/${convId}/messages`, { kind: 'pix' });
  assert.equal(r.status, 403);

  r = await pro.post(`/api/chat/conversations/${convId}/archive`, { archived: true });
  r = await pro.get('/api/chat/conversations');
  assert.equal(r.data.items.length, 0);
  assert.equal(r.data.archived_count, 1);
  r = await pro.get('/api/chat/conversations?archived=1');
  assert.equal(r.data.items.length, 1);
  // Arquivar de um lado não afeta o outro
  r = await pat.get('/api/chat/conversations');
  assert.equal(r.data.items.length, 1);
  r = await pat.get(`/api/chat/conversations/${convId}/messages`);
  assert.equal(r.data.items.length, 3);
});

test('mensagens não podem ser editadas (só apagadas)', async () => {
  const r = await pat.del(`/api/chat/conversations/${convId}/messages`);
  assert.equal(r.status, 404);
  const { db } = require('../server/db');
  assert.throws(() => db.prepare("UPDATE messages SET body = 'x'").run(), /não podem ser alteradas/);
  assert.throws(() => db.prepare("UPDATE messages SET kind = 'deleted', body = 'ainda aqui'").run(), /não podem ser alteradas/);
});

test('outro paciente não acessa a conversa', async () => {
  const other = client();
  await other.post('/api/auth/patient/register', { name: 'Carlos Lima', cpf: CPF_B, state: 'SP', city: 'São Paulo', password: '123456' });
  const r = await other.get(`/api/chat/conversations/${convId}/messages`);
  assert.equal(r.status, 404);
  // e o paciente de SP vê o profissional do PA depois dos locais (sem "near")
  let list = await other.get('/api/professionals');
  assert.equal(list.data.state, null, 'ninguém em SP ainda: mostra o Brasil todo');
  assert.equal(list.data.widened, 'brasil');
  assert.ok(list.data.items.length > 0);
  list = await other.get('/api/professionals?state=todos');
  assert.equal(list.data.items[0].near, false, 'pelo filtro vê outros estados');
});

test('admin não tem acesso a mensagens', async () => {
  assert.equal((await admin.get(`/api/chat/conversations/${convId}/messages`)).status, 401);
  assert.equal((await admin.get('/api/chat/conversations')).status, 401);
  const r = await admin.get('/api/admin/patients?state=PA');
  assert.equal(r.data.items.length, 1);
  assert.equal(r.data.items[0].cpf, CPF_A);
  assert.equal((await admin.get('/api/admin/patients?city=sao paulo')).data.items.length, 1);
});

let call;
test('atendimento: código do paciente, até dois ao mesmo tempo, finalizar invalida', async () => {
  let r = await pro.post('/api/calls', { patient_label: 'Paciente X' });
  assert.equal(r.status, 201);
  call = r.data;
  assert.equal(call.patient_code.slice(0, 2), proCode.slice(0, 2));
  assert.equal(call.patient_code.length, 8);
  r = await pro.post('/api/calls', { patient_label: 'Outro' });
  assert.equal(r.status, 201, 'dois atendimentos ao mesmo tempo');
  const second = r.data;
  r = await pro.post('/api/calls', { patient_label: 'Terceiro' });
  assert.equal(r.status, 409, 'no máximo dois');
  assert.equal((await pro.get('/api/calls')).data.actives.length, 2);
  r = await pro.post('/api/calls/resolve', { code: proCode });
  assert.equal(r.status, 409, 'com dois abertos, o código único não sabe qual abrir');
  r = await pro.post('/api/calls/resolve', { code: second.patient_code });
  assert.equal(r.data.role, 'host', 'profissional entra pelo código do paciente como anfitrião');
  assert.equal(r.data.call.id, second.id);
  await pro.post(`/api/calls/${second.id}/end`);

  r = await anon.post('/api/calls/resolve', { code: call.patient_code });
  assert.equal(r.data.role, 'guest');
  r = await anon.post('/api/calls/resolve', { code: proCode });
  assert.equal(r.status, 403, 'código do profissional exige login do profissional');
  r = await pro.post('/api/calls/resolve', { code: proCode });
  assert.equal(r.data.role, 'host');
});

test('atendimento: sinalização WebRTC via socket e encerramento', async () => {
  const hostSock = ioClient(base, { extraHeaders: { Cookie: pro.cookie }, transports: ['websocket'] });
  const guestSock = ioClient(base, { transports: ['websocket'] });
  const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
  const once = (s, ev) => new Promise((res) => s.once(ev, res));
  try {
    let r = await emit(hostSock, 'call:join', { code: proCode });
    assert.equal(r.role, 'host');
    assert.equal(r.peerPresent, false);
    const joined = once(hostSock, 'call:peer-joined');
    r = await emit(guestSock, 'call:join', { code: call.patient_code });
    assert.equal(r.role, 'guest');
    assert.equal(r.peerPresent, true);
    await joined;
    const got = once(guestSock, 'call:signal');
    hostSock.emit('call:signal', { description: { type: 'offer', sdp: 'x' } });
    assert.equal((await got).description.type, 'offer');

    const ended = once(guestSock, 'call:ended');
    hostSock.emit('call:end');
    await ended;
    r = await anon.post('/api/calls/resolve', { code: call.patient_code });
    assert.equal(r.status, 404, 'código não vale mais');
    r = await emit(guestSock, 'call:join', { code: call.patient_code });
    assert.ok(r.error);
    // Agora pode criar outro
    r = await pro.post('/api/calls', { patient_label: 'Paciente Y' });
    assert.equal(r.status, 201);
    await pro.post(`/api/calls/${r.data.id}/end`);
  } finally {
    hostSock.close();
    guestSock.close();
  }
});

test('mensalidade: vence no dia, funciona mais 1 dia e depois bloqueia; aviso 2 dias antes; restrito/bloqueado', async () => {
  const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  // Venceu há muito tempo: some da vitrine e a conta fica bloqueada (só vê a tela de bloqueio)
  await admin.post(`/api/admin/professionals/${proId}/subscription`, { until: '2020-01-01' });
  assert.equal((await anon.get('/api/professionals')).data.items.length, 0);
  let r = await pro.get('/api/professional/me');
  assert.equal(r.status, 423, 'bloqueado');
  assert.equal(r.data.blocked, true);
  r = await pro.get('/api/auth/me');
  assert.equal(r.data.account.blocked, 'vencido');
  assert.equal(r.data.account.until, '2020-01-01');
  assert.ok(r.data.account.support, 'WhatsApp do atendimento');
  // Venceu ontem: ainda funciona hoje (dia a mais), com aviso
  await admin.post(`/api/admin/professionals/${proId}/subscription`, { until: day(-1) });
  assert.equal((await anon.get('/api/professionals')).data.items.length, 1, 'ainda aparece no dia a mais');
  r = await pro.get('/api/auth/me');
  assert.equal(r.data.account.blocked, undefined);
  assert.equal(r.data.account.warn, true);
  // Vence daqui a 2 dias: aviso de renovação; daqui a 10: sem aviso
  await admin.post(`/api/admin/professionals/${proId}/subscription`, { until: day(2) });
  assert.equal((await pro.get('/api/auth/me')).data.account.warn, true);
  await admin.post(`/api/admin/professionals/${proId}/subscription`, { until: day(10) });
  assert.equal((await pro.get('/api/auth/me')).data.account.warn, undefined);
  assert.equal((await pro.get('/api/professional/me')).status, 200);

  await admin.post(`/api/admin/professionals/${proId}/status`, { status: 'restrito' });
  assert.equal((await anon.get('/api/professionals')).data.items.length, 0);
  assert.equal((await pro.get('/api/professional/me')).status, 200);

  // Bloqueado pelo admin: entra, mas só vê a tela de bloqueio
  await admin.post(`/api/admin/professionals/${proId}/status`, { status: 'bloqueado' });
  assert.equal((await pro.get('/api/professional/me')).status, 423);
  const again = client();
  r = await again.post('/api/auth/professional/login', { login: proCode, password: 'segredo1' });
  assert.equal(r.status, 200, 'consegue entrar');
  assert.equal((await again.get('/api/auth/me')).data.account.blocked, 'admin');
  assert.equal((await again.get('/api/social/feed')).status, 423, 'não vê o feed');
  await admin.post(`/api/admin/professionals/${proId}/status`, { status: 'aprovado' });
  assert.equal((await pro.get('/api/professional/me')).status, 200, 'desbloqueado volta ao normal');
});

test('paciente: recuperar senha com CPF + nome gera senha aleatória', async () => {
  let r = await anon.post('/api/auth/patient/recover', { cpf: CPF_A, name: 'Maria Errada' });
  assert.equal(r.status, 400);
  r = await anon.post('/api/auth/patient/recover', { cpf: CPF_A, name: 'maria souza' });
  assert.equal(r.status, 200);
  const newPw = r.data.password;
  assert.equal(newPw.length, 10);
  r = await client().post('/api/auth/patient/login', { cpf: CPF_A, password: '123456' });
  assert.equal(r.status, 401);
  r = await client().post('/api/auth/patient/login', { cpf: CPF_A.replace(/\D/g, ''), password: newPw });
  assert.equal(r.status, 200);
});

test('admin bloqueia paciente', async () => {
  const list = await admin.get('/api/admin/patients?q=maria');
  const id = list.data.items[0].id;
  await admin.post(`/api/admin/patients/${id}/status`, { status: 'bloqueado' });
  const r = await admin.post(`/api/admin/patients/${id}/reset-password`);
  const blocked = client();
  const login = await blocked.post('/api/auth/patient/login', { cpf: CPF_A, password: r.data.password });
  assert.equal(login.status, 200, 'entra, mas só vê a tela de bloqueio');
  assert.equal((await blocked.get('/api/auth/me')).data.account.blocked, 'admin');
  assert.equal((await blocked.get('/api/chat/conversations')).status, 423, 'sem acesso a nada');
  assert.equal((await blocked.get('/api/professionals')).status, 423);
});

test('admin cadastra profissional já aprovado', async () => {
  const r = await admin.post('/api/admin/professionals', {
    name: 'Ana Costa', profession: 'Psicanalista', registry: 'Registro 123', email: 'ana@example.com', phone: '11988887777', state: 'SP', city: 'Campinas',
  });
  assert.equal(r.status, 201, 'admin escolhe o registro que quiser');
  // Ordenação por preço: Ana (sem valor) vai sempre para o fim
  const ana = client();
  await ana.post('/api/auth/professional/login', { login: r.data.code, password: r.data.password });
  const cheap = await admin.post('/api/admin/professionals', {
    name: 'Rui Alves', profession: 'Psicanalista', registry: 'R-9', email: 'rui@example.com', phone: '11977776666', state: 'SP', city: 'Campinas',
  });
  const rui = client();
  await rui.post('/api/auth/professional/login', { login: cheap.data.code, password: cheap.data.password });
  await rui.put('/api/professional/profile', { name: 'Rui Alves', phone: '11977776666', state: 'SP', city: 'Campinas', price: '90' });
  const patient = client(); // Carlos, cadastrado antes
  await patient.post('/api/auth/patient/login', { cpf: CPF_B, password: '123456' });
  const names = async (sort) => (await patient.get(`/api/professionals?state=todos&sort=${sort}`)).data.items.map((x) => x.name);
  assert.deepEqual(await names('preco_menor'), ['Rui Alves', 'João Pereira', 'Ana Costa']);
  assert.deepEqual(await names('preco_maior'), ['João Pereira', 'Rui Alves', 'Ana Costa']);
  // Visitante sem conta também filtra e ordena; vê o local, mas não o valor
  const v = client();
  let r2 = await v.get('/api/professionals?state=SP&sort=preco_menor');
  assert.deepEqual(r2.data.items.map((x) => x.name), ['Rui Alves', 'Ana Costa']);
  assert.equal(r2.data.items[0].price_cents, undefined);
  assert.equal(r2.data.items[0].city, 'Campinas');
  r2 = await v.get('/api/professionals?max_price=100');
  assert.deepEqual(r2.data.items.map((x) => x.name), ['Rui Alves']);
  // Destaques: quem tem mais conversas/atendimentos aparece primeiro para o visitante
  r2 = await v.get('/api/professionals');
  assert.equal(r2.data.items[0].name, 'João Pereira', 'João tem conversa e atendimentos');
  const login = await client().post('/api/auth/professional/login', { login: r.data.code, password: r.data.password });
  assert.equal(login.status, 200);
});

test('proteção CSRF: POST de outra origem é recusado', async () => {
  const res = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Origin: 'https://site-malicioso.com' } });
  assert.equal(res.status, 403);
});

test('páginas estáticas', async () => {
  for (const p of ['/', '/entrar', '/cadastro-paciente', '/cadastro-profissional', '/app', '/painel', '/admin', '/atendimento', '/manifest.webmanifest', '/sw.js']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
  }
  assert.equal((await fetch(`${base}/nao-existe`)).status, 404);
});

test('a própria pessoa exclui a conta (paciente e profissional)', async () => {
  const CPF_C = '714.285.039-60';
  const p = client();
  await p.post('/api/auth/patient/register', { name: 'Paula Lima', cpf: CPF_C, state: 'SP', city: 'Campinas', password: '123456' });
  let r = await p.post('/api/patient/delete', { password: 'errada' });
  assert.equal(r.status, 400);
  r = await p.post('/api/patient/delete', { password: '123456' });
  assert.equal(r.status, 200);
  assert.equal((await p.get('/api/auth/me')).data.role, null, 'saiu da conta');
  r = await client().post('/api/auth/patient/login', { cpf: CPF_C, password: '123456' });
  assert.equal(r.status, 401);
  r = await client().post('/api/auth/patient/register', { name: 'Paula Lima', cpf: CPF_C, state: 'SP', city: 'Campinas', password: '123456' });
  assert.equal(r.status, 201, 'o CPF pode criar conta de novo');

  const created = await admin.post('/api/admin/professionals', {
    name: 'Bia Rocha', profession: 'Psicanalista', registry: 'X-1', email: 'bia@example.com', phone: '11988887777', state: 'SP', city: 'Campinas',
  });
  const b = client();
  await b.post('/api/auth/professional/login', { login: created.data.code, password: created.data.password });
  r = await b.post('/api/professional/delete', { password: created.data.password });
  assert.equal(r.status, 200);
  r = await client().post('/api/auth/professional/login', { login: created.data.code, password: created.data.password });
  assert.equal(r.status, 401);
  const list = await admin.get('/api/admin/professionals?status=excluido');
  assert.equal(list.data.items.length, 1);
  assert.equal(list.data.items[0].name, 'Profissional removido');
  r = await admin.post(`/api/admin/professionals/${created.data.id}/status`, { status: 'aprovado' });
  assert.equal(r.status, 400, 'admin não reativa conta excluída');
});

test('link próprio do profissional', async () => {
  await pro.post('/api/auth/professional/login', { login: proCode, password: 'segredo1' });
  let me = await pro.get('/api/professional/me');
  assert.equal(me.data.slug, 'joao-pereira', 'link criado a partir do nome');
  let r = await pro.post('/api/professional/slug', { slug: 'admin' });
  assert.equal(r.status, 400, 'endereço reservado');
  r = await pro.post('/api/professional/slug', { slug: 'x' });
  assert.equal(r.status, 400, 'curto demais');
  r = await pro.post('/api/professional/slug', { slug: 'Dr João Psicólogo' });
  assert.equal(r.status, 200);
  assert.equal(r.data.slug, 'dr-joao-psicologo');
  // A página abre pelo link, com o nome no título (bom para compartilhar)
  let page = await fetch(`${base}/dr-joao-psicologo`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>João Pereira — Psicólogo\(a\) \| Acolia<\/title>/);
  assert.match(html, /data-slug="dr-joao-psicologo"/);
  assert.equal((await fetch(`${base}/nao-existe-ninguem`)).status, 404);
  // Visitante vê o perfil sem valores; paciente vê com valores
  r = await anon.get('/api/professionals/dr-joao-psicologo');
  assert.equal(r.data.name, 'João Pereira');
  assert.equal(r.data.price_cents, undefined);
  const carlos = client();
  await carlos.post('/api/auth/patient/login', { cpf: CPF_B, password: '123456' });
  r = await carlos.get('/api/professionals/dr-joao-psicologo');
  assert.equal(typeof r.data.price_cents, 'number');
  // Outro profissional não pode pegar o mesmo link
  const other = await admin.post('/api/admin/professionals', {
    name: 'Joao Pereira', profession: 'Psicanalista', registry: 'Z-7', email: 'jp2@example.com', phone: '11966665555', state: 'SP', city: 'Campinas',
  });
  const c = client();
  await c.post('/api/auth/professional/login', { login: other.data.code, password: other.data.password });
  me = await c.get('/api/professional/me');
  assert.equal(me.data.slug, 'joao-pereira', 'nome livre de novo depois da troca');
  r = await c.post('/api/professional/slug', { slug: 'dr-joao-psicologo' });
  assert.equal(r.status, 409);
});

test('notificação chega no aparelho de quem recebe a mensagem', async () => {
  const crypto = require('node:crypto');
  const webpush = require('web-push');
  const original = webpush.sendNotification;
  const hits = [];
  let fail = null;
  // Troca o envio real (que iria para o Google/Apple) por um registro local
  webpush.sendNotification = async (sub, payload) => {
    hits.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    if (fail) throw Object.assign(new Error('gone'), { statusCode: fail });
    return { statusCode: 201 };
  };
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const subscription = {
    endpoint: 'https://push.exemplo.com/aparelho-do-joao',
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
  };
  try {
    await pro.post('/api/auth/professional/login', { login: proCode, password: 'segredo1' });
    assert.equal((await pro.post('/api/push/subscribe', { subscription })).status, 200);
    assert.equal((await anon.post('/api/push/subscribe', { subscription })).status, 401, 'precisa estar logado');
    assert.equal((await pro.post('/api/push/subscribe', { subscription: { ...subscription, endpoint: 'http://x' } })).status, 400);
    const carlos = client();
    await carlos.post('/api/auth/patient/login', { cpf: CPF_B, password: '123456' });
    const conv = await carlos.post('/api/chat/conversations', { professional_id: proId });
    await carlos.post(`/api/chat/conversations/${conv.data.id}/messages`, { body: 'Oi, doutor, tudo bem?' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(hits.length, 1, 'o profissional recebeu a notificação');
    assert.equal(hits[0].payload.body, 'Oi, doutor, tudo bem?');
    assert.equal(hits[0].payload.url, `/painel#conversas/${conv.data.id}`);
    // Quem envia não é notificado
    await pro.post(`/api/chat/conversations/${conv.data.id}/messages`, { body: 'Tudo, e você?' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(hits.length, 1, 'o paciente não tem aparelho inscrito; o profissional não recebe o próprio aviso');
    // Aparelho que desinstalou (410) sai da lista
    fail = 410;
    await carlos.post(`/api/chat/conversations/${conv.data.id}/messages`, { body: 'Mais uma' });
    await new Promise((r) => setTimeout(r, 30));
    const { db } = require('../server/db');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n, 0);
  } finally {
    webpush.sendNotification = original;
  }
});

test('aviso de armazenamento: pasta comum no Render não conta como permanente', () => {
  const { execFileSync } = require('node:child_process');
  const run = (env) => JSON.parse(execFileSync(process.execPath, ['--no-warnings', '-e',
    "process.stdout.write(JSON.stringify(require('./server/paths').storageStatus()))"], { cwd: path.join(__dirname, '..'), env: { ...process.env, ...env } }).toString());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acolia-paths-'));
  assert.equal(run({ DATA_DIR: dir, RENDER: 'true', SUPABASE_URL: '' }).permanent, false, 'no Render sem disco: temporário');
  assert.equal(run({ DATA_DIR: dir, RENDER: '', SUPABASE_URL: '' }).permanent, true, 'no computador: permanente');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('contas de teste: o admin cria, entram com os dados combinados e só elas podem ser apagadas pelo admin', async () => {
  let r = await client().post('/api/admin/test-accounts');
  assert.equal(r.status, 401, 'só o admin');
  r = await admin.post('/api/admin/test-accounts');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.created, { professional: true, patient: true });

  const tp = client();
  r = await tp.post('/api/auth/professional/login', { login: '123456789', password: '123456789' });
  assert.equal(r.status, 200, 'profissional de teste entra');
  const tpat = client();
  r = await tpat.post('/api/auth/patient/login', { cpf: '000.000.000-00', password: '1234' });
  assert.equal(r.status, 200, 'paciente de teste entra');
  r = await anon.get('/api/professionals?state=todos');
  assert.ok(r.data.items.some((x) => x.name === 'Profissional Teste'), 'aparece na vitrine');

  r = await admin.post('/api/admin/test-accounts');
  assert.deepEqual(r.data.created, { professional: false, patient: false }, 'não duplica');

  const pros = (await admin.get('/api/admin/professionals?q=Profissional Teste')).data.items;
  const tpro = pros.find((x) => x.is_test);
  const pats = (await admin.get('/api/admin/patients')).data.items;
  const tpatient = pats.find((x) => x.is_test);
  const real = pats.find((x) => !x.is_test && x.status === 'ativo');
  r = await admin.post(`/api/admin/patients/${real.id}/delete-test`);
  assert.equal(r.status, 403, 'conta real não é apagada pelo admin');
  r = await admin.post(`/api/admin/professionals/${proId}/delete-test`);
  assert.equal(r.status, 403);

  r = await admin.post(`/api/admin/professionals/${tpro.id}/delete-test`);
  assert.equal(r.status, 200);
  r = await admin.post(`/api/admin/patients/${tpatient.id}/delete-test`);
  assert.equal(r.status, 200);
  assert.equal((await tp.get('/api/auth/me')).data.role, null, 'sessão encerrada');
  r = await client().post('/api/auth/professional/login', { login: '123456789', password: '123456789' });
  assert.equal(r.status, 401);
  r = await client().post('/api/auth/patient/login', { cpf: '000.000.000-00', password: '1234' });
  assert.equal(r.status, 401);

  r = await admin.post('/api/admin/test-accounts');
  assert.deepEqual(r.data.created, { professional: true, patient: true }, 'pode criar de novo');
});

test('profissional só vê a conversa depois que o paciente manda mensagem', async () => {
  const created = await admin.post('/api/admin/professionals', {
    name: 'Caio Mendes', profession: 'Psicanalista', registry: 'X-9', email: 'caio@example.com', phone: '11977776666', state: 'SP', city: 'Campinas',
  });
  const cp = client();
  await cp.post('/api/auth/professional/login', { login: created.data.code, password: created.data.password });
  const pt = client();
  await pt.post('/api/auth/patient/register', { name: 'Rita Souza', cpf: '453.178.287-91', state: 'SP', city: 'Campinas', password: '123456' });
  const conv = (await pt.post('/api/chat/conversations', { professional_id: created.data.id })).data;
  assert.equal((await cp.get('/api/chat/conversations')).data.items.length, 0, 'só abrir o chat não aparece para o profissional');
  let r = await cp.post(`/api/chat/conversations/${conv.id}/messages`, { body: 'Oi' });
  assert.equal(r.status, 404, 'profissional não escreve antes do paciente');
  r = await cp.post('/api/calls', { patient_label: 'Rita', conversation_id: conv.id });
  assert.equal(r.status, 404);
  await pt.post(`/api/chat/conversations/${conv.id}/messages`, { body: 'Olá, gostaria de agendar' });
  assert.equal((await cp.get('/api/chat/conversations')).data.items.length, 1, 'aparece depois da mensagem do paciente');
  r = await cp.post(`/api/chat/conversations/${conv.id}/messages`, { body: 'Olá, Rita!' });
  assert.equal(r.status, 201);
});

test('perfil: duração da sessão, Instagram e galeria de até 6 fotos (visitante vê no máximo 2, sem ampliar)', async () => {
  const created = await admin.post('/api/admin/professionals', {
    name: 'Lia Campos', profession: 'Psicólogo(a)', registry: 'X-10', email: 'lia@example.com', phone: '11966665555', state: 'SP', city: 'Campinas',
  });
  const lp = client();
  await lp.post('/api/auth/professional/login', { login: created.data.code, password: created.data.password });
  const pf = { name: 'Lia Campos', phone: '11966665555', state: 'SP', city: 'Campinas', bio: '', specialties: '', price: '120' };
  let r = await lp.put('/api/professional/profile', { ...pf, session_minutes: 50, instagram: 'https://www.instagram.com/lia.psi/' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.instagram, 'lia.psi', 'guarda só o @');
  assert.equal(r.data.session_minutes, 50);
  r = await lp.put('/api/professional/profile', { ...pf, session_minutes: 50, instagram: '@lia psi!' });
  assert.equal(r.status, 400, 'Instagram inválido');
  r = await lp.put('/api/professional/profile', { ...pf, session_minutes: 51, instagram: '@lia.psi' });
  assert.equal(r.status, 400, 'duração fora da lista');
  await lp.put('/api/professional/profile', { ...pf, session_minutes: 50, instagram: '@lia.psi' });

  // A galeria do perfil agora são as publicações (versão 1.2)
  const upload = async (caption = '') => {
    const fd = new FormData();
    fd.append('caption', caption);
    fd.append('photo', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'f.png');
    const res = await fetch(`${base}/api/social/posts`, { method: 'POST', body: fd, headers: { Cookie: lp.cookie } });
    return { status: res.status, data: await res.json() };
  };
  r = await upload('Primeira foto');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const first = r.data;
  r = await upload();
  assert.equal((await lp.del(`/api/social/posts/${r.data.id}`)).status, 200, 'apaga a própria publicação');

  const anonView = (await anon.get(`/api/professionals/${created.data.id}`)).data;
  assert.equal(anonView.session_minutes, undefined, 'duração só com conta');
  assert.equal(anonView.has_session_minutes, true);
  assert.equal(anonView.instagram, 'lia.psi', 'Instagram aparece para todos');
  assert.equal(anonView.gallery.length, 0, 'com 1 foto, ela fica bloqueada');
  assert.equal(anonView.gallery_hidden, 1);
  for (let i = 0; i < 3; i++) await upload();
  const anon2 = (await anon.get(`/api/professionals/${created.data.id}`)).data;
  assert.equal(anon2.gallery.length, 2, 'com 4 fotos, 2 abertas');
  assert.equal(anon2.gallery_hidden, 2, 'e sabe quantas faltam');
  const pt = client();
  await pt.post('/api/auth/patient/login', { cpf: '453.178.287-91', password: '123456' });
  const { freeGalleryCount } = require('../server/serialize');
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(freeGalleryCount), [0, 1, 1, 2, 2, 2], 'regra das fotos abertas para visitante');
  const patView = (await pt.get(`/api/professionals/${created.data.id}`)).data;
  assert.equal(patView.session_minutes, 50);
  assert.equal(patView.gallery.length, 4, 'paciente vê todas as fotos colocadas');
  assert.equal(patView.posts_count, 4);
  assert.equal(patView.gallery_posts.at(-1).id, first.id, 'a mais antiga fica por último');
  assert.equal(patView.gallery_hidden, 0);
  assert.equal(patView.instagram, 'lia.psi');
});

test('clínica: link do Google Maps vira mini mapa, só para quem tem conta', async () => {
  const created = await admin.post('/api/admin/professionals', {
    name: 'Davi Nunes', profession: 'Psicólogo(a)', registry: 'X-11', email: 'davi@example.com', phone: '11955554444', state: 'SP', city: 'Campinas',
  });
  const dp = client();
  await dp.post('/api/auth/professional/login', { login: created.data.code, password: created.data.password });
  const pf = { name: 'Davi Nunes', phone: '11955554444', state: 'SP', city: 'Campinas', has_clinic: true, clinic_name: 'Espaço Davi', clinic_address: 'Rua B, 200, Centro' };
  let r = await dp.put('/api/professional/profile', { ...pf, maps_url: 'https://site-estranho.com/maps' });
  assert.equal(r.status, 400, 'só aceita link do Google Maps');
  r = await dp.put('/api/professional/profile', { ...pf, maps_url: 'https://www.google.com/maps/place/Espa%C3%A7o/@-22.9056,-47.0608,17z' });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const anonView = (await anon.get(`/api/professionals/${created.data.id}`)).data;
  assert.equal(anonView.has_clinic, true);
  assert.equal(anonView.maps_url, undefined, 'visitante não vê o link');
  assert.equal(anonView.map_embed, undefined, 'nem o mapa');
  assert.equal(anonView.clinic_address, undefined);
  const pt = client();
  await pt.post('/api/auth/patient/login', { cpf: '453.178.287-91', password: '123456' });
  const v = (await pt.get(`/api/professionals/${created.data.id}`)).data;
  assert.ok(v.maps_url.startsWith('https://www.google.com/maps/place/'));
  assert.ok(v.map_embed.includes('-22.9056%2C-47.0608') && v.map_embed.includes('output=embed'), v.map_embed);

  // Sem link, o mapa usa o endereço; sem clínica, não tem mapa
  await dp.put('/api/professional/profile', { ...pf, maps_url: '' });
  assert.ok((await pt.get(`/api/professionals/${created.data.id}`)).data.map_embed.includes('Rua%20B'));
  await dp.put('/api/professional/profile', { ...pf, has_clinic: false, maps_url: 'https://www.google.com/maps/@1,1,1z' });
  const none = (await pt.get(`/api/professionals/${created.data.id}`)).data;
  assert.equal(none.map_embed, '');
  assert.equal((await dp.get('/api/professional/me')).data.maps_url, '', 'sem clínica o link é descartado');
});

test('mensagem de voz: paciente e profissional mandam áudio; só quem participa ouve', async () => {
  const created = await admin.post('/api/admin/professionals', {
    name: 'Eva Prado', profession: 'Psicólogo(a)', registry: 'X-12', email: 'eva@example.com', phone: '11944443333', state: 'SP', city: 'Campinas',
  });
  const ep = client();
  await ep.post('/api/auth/professional/login', { login: created.data.code, password: created.data.password });
  const pt = client();
  await pt.post('/api/auth/patient/login', { cpf: '453.178.287-91', password: '123456' });
  const conv = (await pt.post('/api/chat/conversations', { professional_id: created.data.id })).data;
  const sendAudio = async (who, type = 'audio/webm;codecs=opus') => {
    const fd = new FormData();
    fd.append('duration', '7');
    fd.append('audio', new Blob([Buffer.from('OggS-fake-audio')], { type }), 'a.webm');
    const res = await fetch(`${base}/api/chat/conversations/${conv.id}/audio`, { method: 'POST', body: fd, headers: { Cookie: who.cookie } });
    return { status: res.status, data: await res.json() };
  };
  let r = await sendAudio(ep);
  assert.equal(r.status, 404, 'profissional não manda áudio antes do paciente escrever');
  r = await sendAudio(pt);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.kind, 'audio');
  const [file, secs] = r.data.body.split('|');
  assert.equal(secs, '7');
  r = await sendAudio(ep, 'audio/mp4');
  assert.equal(r.status, 201, 'profissional responde com áudio (formato do iPhone)');
  assert.equal((await sendAudio(pt, 'video/mp4')).status, 400, 'vídeo não é aceito');

  const listen = (who) => fetch(`${base}/api/chat/audio/${file}`, { headers: who.cookie ? { Cookie: who.cookie } : {} });
  assert.equal((await listen(pt)).status, 200);
  assert.equal((await listen(ep)).status, 200);
  assert.equal((await listen(anon)).status, 401, 'sem login não ouve');
  const other = client();
  const reg = await other.post('/api/auth/patient/register', { name: 'Tomas Reis', cpf: '987.654.320-29', state: 'SP', city: 'Campinas', password: '123456' });
  assert.equal(reg.status, 201);
  assert.equal((await listen(other)).status, 404, 'outro paciente logado não ouve');
});

test('apagar mensagem: só quem enviou, para todos; o conteúdo sai do banco', async () => {
  const created = await admin.post('/api/admin/professionals', {
    name: 'Gil Souto', profession: 'Psicólogo(a)', registry: 'X-13', email: 'gil@example.com', phone: '11933332222', state: 'SP', city: 'Campinas',
  });
  const gp = client();
  await gp.post('/api/auth/professional/login', { login: created.data.code, password: created.data.password });
  const pt = client();
  await pt.post('/api/auth/patient/login', { cpf: '453.178.287-91', password: '123456' });
  const conv = (await pt.post('/api/chat/conversations', { professional_id: created.data.id })).data;
  const m1 = (await pt.post(`/api/chat/conversations/${conv.id}/messages`, { body: 'texto secreto 123' })).data;
  const fd = new FormData();
  fd.append('duration', '3');
  fd.append('peaks', '0123456789');
  fd.append('audio', new Blob([Buffer.from('RIFF....WAVEfmt ')], { type: 'audio/wav' }), 'a.wav');
  const res = await fetch(`${base}/api/chat/conversations/${conv.id}/audio`, { method: 'POST', body: fd, headers: { Cookie: pt.cookie } });
  const m2 = await res.json();
  assert.equal(res.status, 201, JSON.stringify(m2));
  assert.ok(m2.body.endsWith('|3|0123456789'), 'guarda as ondas do áudio');
  const file = m2.body.split('|')[0];
  assert.ok(file.endsWith('.wav'));

  let r = await gp.post(`/api/chat/messages/${m1.id}/delete`, { for: 'everyone' });
  assert.equal(r.status, 403, 'o profissional não apaga para todos a mensagem do paciente');
  r = await pt.post(`/api/chat/messages/${m1.id}/delete`);
  assert.equal(r.status, 200);
  r = await pt.post(`/api/chat/messages/${m2.id}/delete`);
  assert.equal(r.status, 200);

  const { db } = require('../server/db');
  const row = db.prepare('SELECT kind, body FROM messages WHERE id = ?').get(m1.id);
  assert.deepEqual({ kind: row.kind, body: row.body }, { kind: 'deleted', body: '' }, 'texto apagado do banco');
  assert.equal((await pt.get(`/api/chat/conversations/${conv.id}/messages`)).data.items.length, 0, 'para quem apagou, some');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE body LIKE '%texto secreto%'").get().n, 0);
  const seen = (await gp.get(`/api/chat/conversations/${conv.id}/messages`)).data.items;
  assert.ok(seen.every((m) => m.kind === 'deleted' && m.body === ''), 'o outro lado vê "Mensagem apagada"');
  const listen = await fetch(`${base}/api/chat/audio/${file}`, { headers: { Cookie: pt.cookie } });
  assert.equal(listen.status, 404, 'o áudio apagado não toca mais');
  await new Promise((ok) => setTimeout(ok, 50));
  const { AUDIO_DIR } = require('../server/upload');
  assert.equal(fs.existsSync(path.join(AUDIO_DIR, file)), false, 'arquivo do áudio removido');
});

test('vitrine do paciente: filtro automático pelo estado e, se houver, pelo município', async () => {
  // Rita mora em Campinas-SP; há profissionais em Campinas criados nos testes anteriores
  const pt = client();
  await pt.post('/api/auth/patient/login', { cpf: '453.178.287-91', password: '123456' });
  let r = await pt.get('/api/professionals?auto=1');
  assert.equal(r.data.state, 'SP');
  assert.equal(r.data.city, 'Campinas', 'município do paciente aplicado');
  assert.ok(r.data.items.length > 0 && r.data.items.every((p) => p.city === 'Campinas'));
  r = await pt.get('/api/professionals?state=todos');
  assert.equal(r.data.city, null, 'sem filtro: todos');
  // Paciente de uma cidade sem profissionais: fica só o estado
  const other = client();
  const reg = await other.post('/api/auth/patient/register', { name: 'Ivo Lima', cpf: '123.456.700-88', state: 'SP', city: 'Sorocaba', password: '123456' });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  r = await other.get('/api/professionals?auto=1');
  assert.equal(r.data.state, 'SP');
  assert.equal(r.data.city, null, 'sem profissionais no município, filtra só o estado');
  // Paciente de um estado sem nenhum profissional: mostra o Brasil todo
  const far = client();
  assert.equal((await far.post('/api/auth/patient/register', { name: 'Ana Acre', cpf: '987.654.321-00', state: 'AC', city: 'Rio Branco', password: '123456' })).status, 201);
  r = await far.get('/api/professionals?auto=1');
  assert.equal(r.data.state, null);
  assert.equal(r.data.widened, 'brasil');
  assert.ok(r.data.items.length > 0 && r.data.items.some((p) => p.state === 'SP'), 'vê profissionais de outros estados');
});

test('v1.2 — seguir, feed (não vistas primeiro), curtir, comentar, stories e notificações', async () => {
  const mk = async (name, email) => {
    const c = await admin.post('/api/admin/professionals', { name, profession: 'Psicólogo(a)', registry: `R-${email}`, email, phone: '11922221111', state: 'SP', city: 'Campinas' });
    const cl = client();
    await cl.post('/api/auth/professional/login', { login: c.data.code, password: c.data.password });
    return { id: c.data.id, cl };
  };
  const A = await mk('Ana Feed', 'anafeed@example.com');
  const B = await mk('Bruno Feed', 'brunofeed@example.com');
  const post = async (who, caption) => {
    const fd = new FormData();
    fd.append('caption', caption);
    fd.append('photo', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'f.png');
    const res = await fetch(`${base}/api/social/posts`, { method: 'POST', body: fd, headers: { Cookie: who.cl.cookie } });
    return res.json();
  };
  const p1 = await post(A, 'Post 1');
  const p2 = await post(A, 'Post 2');
  const pt = client();
  await pt.post('/api/auth/patient/login', { cpf: '453.178.287-91', password: '123456' });

  // Sem seguir, o feed mostra publicações de outros profissionais como sugestão (com Seguir); paciente não publica
  let sugFeed = (await pt.get('/api/social/feed')).data.items;
  assert.ok([p1.id, p2.id].every((id) => sugFeed.some((p) => p.id === id)));
  assert.ok(sugFeed.every((p) => p.suggested && p.follow === false), 'sugestão com o botão Seguir');
  // Sugestão já mostrada não repete
  const again = (await pt.get(`/api/social/feed?sug=${sugFeed.map((p) => p.id).join(',')}`)).data.items;
  assert.ok(!again.some((p) => sugFeed.some((q) => q.id === p.id)));
  // Sem seguir, curte e comenta do mesmo jeito
  assert.equal((await pt.post(`/api/social/posts/${p2.id}/like`)).data.liked, true);
  await pt.del(`/api/social/posts/${p2.id}/like`);
  let r = await pt.post('/api/social/posts');
  assert.equal(r.status, 403);

  // Seguir (paciente e profissional); contadores no perfil, sem lista de quem segue
  r = await pt.post(`/api/social/follow/${A.id}`);
  assert.deepEqual(r.data, { followers: 2, following: true }, 'quem segue + a Acolia Brasil');
  await B.cl.post(`/api/social/follow/${A.id}`);
  assert.equal((await A.cl.post(`/api/social/follow/${A.id}`)).status, 400, 'não segue a si mesmo');
  const prof = (await pt.get(`/api/professionals/${A.id}`)).data;
  assert.equal(prof.followers_count, 3);
  assert.equal(prof.following, true);
  assert.equal((await pt.get(`/api/professionals/${B.id}`)).data.following_count, 2, 'Bruno segue Ana e a Acolia Brasil');

  // Feed: não vistas primeiro
  const followed = async () => (await pt.get('/api/social/feed')).data.items.filter((p) => !p.suggested && !p.author.official);
  let feed = await followed();
  assert.deepEqual(feed.map((p) => p.id), [p2.id, p1.id]);
  assert.ok(feed.every((p) => p.follow === true));
  await pt.post('/api/social/seen', { ids: [p2.id] });
  feed = await followed();
  assert.deepEqual(feed.map((p) => p.id), [p1.id, p2.id], 'a já vista desce');

  // Curtir (sem mostrar quem) e comentar
  r = await pt.post(`/api/social/posts/${p1.id}/like`);
  assert.equal(r.data.likes, 1);
  assert.equal(r.data.liked, true);
  const cPat = (await pt.post(`/api/social/posts/${p1.id}/comments`, { body: 'Muito bom!' })).data;
  assert.equal(cPat.author.name, 'Rita Souza', 'paciente aparece com 1º e 2º nome');
  assert.equal(cPat.author.subtitle, 'Campinas - SP');
  const cPro = (await B.cl.post(`/api/social/posts/${p1.id}/comments`, { body: 'Parabéns' })).data;
  assert.equal((await pt.del(`/api/social/comments/${cPro.id}`)).status, 403, 'não apaga comentário dos outros');
  assert.equal((await A.cl.del(`/api/social/comments/${cPro.id}`)).status, 200, 'o dono da publicação apaga qualquer comentário');
  assert.equal((await pt.del(`/api/social/comments/${cPat.id}`)).status, 200, 'cada um apaga o seu');
  assert.equal((await pt.get(`/api/social/posts/${p1.id}`)).data.comments, 0);

  // Stories: só profissional posta; vídeo com mais de 20 s é recusado; quem segue vê e curte
  const story = async (who, type, duration) => {
    const fd = new FormData();
    fd.append('duration', String(duration));
    fd.append('media', new Blob([Buffer.from('fake')], { type }), type.startsWith('video') ? 'v.mp4' : 'f.png');
    const res = await fetch(`${base}/api/social/stories`, { method: 'POST', body: fd, headers: { Cookie: who.cookie } });
    return { status: res.status, data: await res.json() };
  };
  assert.equal((await story(pt, 'image/png', 0)).status, 403);
  assert.equal((await story(A.cl, 'video/mp4', 25)).status, 400, 'no máximo 20 s');
  const s1 = await story(A.cl, 'video/mp4', 15);
  assert.equal(s1.status, 201);
  assert.equal(s1.data.kind, 'video');
  const groups = (await pt.get('/api/social/stories')).data.groups;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].professional.id, A.id);
  await B.cl.post(`/api/social/stories/${s1.data.id}/like`);
  const mine = (await A.cl.get('/api/social/stories')).data.groups[0];
  assert.equal(mine.mine, true, 'o próprio profissional aparece primeiro');
  assert.equal(mine.items[0].likes, 1);

  // Notificações do profissional A
  const n = (await A.cl.get('/api/social/notifications')).data;
  const texts = n.items.map((x) => x.text);
  assert.ok(texts.includes('Um paciente começou a seguir você.'), 'seguidor sem nome');
  assert.ok(texts.includes('Um profissional começou a seguir você.'));
  assert.ok(texts.includes('Sua publicação recebeu uma curtida.'), 'curtida sem nome');
  assert.ok(texts.includes('Bruno Feed curtiu seu story.'));
  assert.ok(n.unread >= 4);
  await A.cl.post('/api/social/notifications/read');
  assert.equal((await A.cl.get('/api/social/notifications/unread')).data.unread, 0);

  // Visitante: grade limitada; sem conta não vê a publicação
  const vis = (await anon.get(`/api/social/professionals/${A.id}/posts`)).data;
  assert.equal(vis.locked, true);
  assert.equal(vis.items.length, 1, 'com 2 fotos, 1 aberta');
  assert.equal(vis.items[0].id, undefined, 'visitante não abre a publicação');
  // Link compartilhado: sem conta vê a publicação, mas não curte nem vê comentários
  r = await anon.get(`/api/social/posts/${p1.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.locked, true);
  assert.equal(r.data.caption, 'Post 1');
  assert.equal((await anon.get(`/api/social/posts/${p1.id}/comments`)).status, 401);
  assert.equal((await anon.post(`/api/social/posts/${p1.id}/like`)).status, 401);
  const shared = await fetch(`${base}/p/${p1.id}`);
  assert.equal(shared.status, 200);
  const html = await shared.text();
  assert.ok(html.includes(`<meta property="og:image" content="http://localhost:`) && html.includes(p1.image), 'prévia com a foto');
  assert.ok(html.includes('<meta property="og:title" content="Ana Feed na Acolia">'), 'prévia com o nome');
  assert.ok(html.includes('<meta property="og:description" content="Post 1">'), 'prévia com a descrição');

  // Profissional não inicia conversa com profissional
  assert.equal((await B.cl.post('/api/chat/conversations', { professional_id: A.id })).status, 403);

  // Deixar de seguir
  r = await pt.del(`/api/social/follow/${A.id}`);
  assert.deepEqual(r.data, { followers: 2, following: false });
  assert.ok((await pt.get('/api/social/feed')).data.items.every((p) => p.suggested), 'volta a ver só como sugestão');
});

test('carrossel: uma publicação com até 10 fotos e uma descrição só', async () => {
  const c = await admin.post('/api/admin/professionals', { name: 'Caro Sel', profession: 'Psicólogo(a)', registry: 'R-car', email: 'carosel@example.com', phone: '11922220000', state: 'SP', city: 'Campinas' });
  const cl = client();
  await cl.post('/api/auth/professional/login', { login: c.data.code, password: c.data.password });
  const send = async (n) => {
    const fd = new FormData();
    fd.append('caption', 'Várias fotos');
    fd.append('aspect', '4:5');
    for (let i = 0; i < n; i++) fd.append('photos', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, i])], { type: 'image/png' }), `f${i}.png`);
    const res = await fetch(`${base}/api/social/posts`, { method: 'POST', body: fd, headers: { Cookie: cl.cookie } });
    return { status: res.status, data: await res.json() };
  };
  const r = await send(3);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.images.length, 3);
  assert.equal(r.data.image, r.data.images[0], 'a 1ª foto é a capa');
  assert.equal(r.data.caption, 'Várias fotos');
  assert.equal(r.data.aspect, '4:5', 'formato escolhido (retrato 1080 × 1350)');
  assert.equal((await send(11)).status, 400, 'no máximo 10');
  const grid = (await cl.get(`/api/social/professionals/${c.data.id}/posts`)).data.items;
  assert.equal(grid.length, 1, 'no perfil conta como 1 publicação');
  assert.equal(grid[0].count, 3, 'com o ícone de várias fotos');
  const prof = (await cl.get(`/api/professionals/${c.data.id}`)).data;
  assert.equal(prof.posts_count, 1);
  assert.equal(prof.gallery_posts[0].count, 3);
  assert.equal((await cl.del(`/api/social/posts/${r.data.id}`)).status, 200);
  const { db } = require('../server/db');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM post_images WHERE post_id = ?').get(r.data.id).n, 0, 'fotos do carrossel apagadas junto');
});

test('publicação no story: só o dono coloca; quem segue vê e abre a publicação', async () => {
  const mk = async (name, email) => {
    const c = await admin.post('/api/admin/professionals', { name, profession: 'Psicólogo(a)', registry: `R-${email}`, email, phone: '11911110000', state: 'SP', city: 'Campinas' });
    const cl = client();
    await cl.post('/api/auth/professional/login', { login: c.data.code, password: c.data.password });
    return { id: c.data.id, cl };
  };
  const D = await mk('Dora Story', 'dorastory@example.com');
  const E = await mk('Enzo Story', 'enzostory@example.com');
  const fd = new FormData();
  fd.append('caption', 'Para o story');
  fd.append('photos', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'f.png');
  const post = await (await fetch(`${base}/api/social/posts`, { method: 'POST', body: fd, headers: { Cookie: D.cl.cookie } })).json();
  assert.equal((await E.cl.post(`/api/social/posts/${post.id}/story`)).status, 403, 'outro profissional não coloca no story dele');
  const pt = client();
  await pt.post('/api/auth/patient/login', { cpf: '453.178.287-91', password: '123456' });
  assert.equal((await pt.post(`/api/social/posts/${post.id}/story`)).status, 403, 'paciente também não');
  const st = await D.cl.post(`/api/social/posts/${post.id}/story`);
  assert.equal(st.status, 201);
  assert.equal(st.data.kind, 'post');
  assert.equal(st.data.post.id, post.id);
  await pt.post(`/api/social/follow/${D.id}`);
  const g = (await pt.get('/api/social/stories')).data.groups.find((x) => x.professional.id === D.id);
  assert.equal(g.items[0].post.caption, 'Para o story', 'quem segue vê a publicação no story');
  // apagar o story não apaga a foto da publicação
  const { UPLOAD_DIR } = require('../server/upload');
  await D.cl.del(`/api/social/stories/${st.data.id}`);
  await new Promise((ok) => setTimeout(ok, 50));
  assert.ok(fs.existsSync(path.join(UPLOAD_DIR, path.basename(post.image))), 'foto da publicação continua');
  // apagar a publicação apaga os stories dela
  await D.cl.post(`/api/social/posts/${post.id}/story`);
  await D.cl.del(`/api/social/posts/${post.id}`);
  assert.equal((await pt.get('/api/social/stories')).data.groups.filter((x) => x.professional.id === D.id).length, 0);
});

test('Acolia Brasil: o admin publica, todos seguem (sem deixar de seguir) e o perfil mostra seguidores pacientes e profissionais', async () => {
  const { db } = require('../server/db');
  const O = require('../server/official');
  const offId = O.officialId();
  const mkPro = async (name, email) => {
    const c = await admin.post('/api/admin/professionals', { name, profession: 'Psicólogo(a)', registry: `R-${email}`, email, phone: '11933330000', state: 'SP', city: 'Campinas' });
    const cl = client();
    await cl.post('/api/auth/professional/login', { login: c.data.code, password: c.data.password });
    return { id: c.data.id, cl };
  };
  const P = await mkPro('Paula Oficial', 'paulaof@example.com');
  const pt = client();
  await pt.post('/api/auth/patient/login', { cpf: '453.178.287-91', password: '123456' });

  // Não aparece na vitrine nem na lista de profissionais do admin; ninguém entra nele
  assert.ok(!(await pt.get('/api/professionals?state=todos')).data.items.some((p) => p.id === offId));
  assert.ok(!(await admin.get('/api/admin/professionals')).data.items.some((p) => p.id === offId));
  assert.equal((await admin.get(`/api/admin/professionals/${offId}`)).status, 404);
  const row = O.officialRow();
  assert.equal((await client().post('/api/auth/professional/login', { login: row.code, password: 'x' })).status, 401);
  assert.equal((await pt.post('/api/chat/conversations', { professional_id: offId })).status, 404, 'sem mensagem');

  // Admin publica (com carrossel) e define o Instagram; profissional/paciente não publicam por essa rota
  const fd = new FormData();
  fd.append('caption', 'Bem-vindos à Acolia!');
  fd.append('photos', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 1])], { type: 'image/png' }), 'a.png');
  fd.append('photos', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 2])], { type: 'image/png' }), 'b.png');
  let res = await fetch(`${base}/api/admin/official/posts`, { method: 'POST', body: fd, headers: { Cookie: admin.cookie } });
  const op = await res.json();
  assert.equal(res.status, 201, JSON.stringify(op));
  assert.equal(op.images.length, 2);
  res = await fetch(`${base}/api/admin/official/posts`, { method: 'POST', body: new FormData(), headers: { Cookie: pt.cookie } });
  assert.equal(res.status, 401);
  assert.equal((await admin.post('/api/admin/official/instagram', { instagram: 'https://instagram.com/acoliabrasil' })).data.instagram, 'acoliabrasil');

  // Aparece no feed de todo mundo (paciente e profissional), sem botão Seguir
  for (const who of [pt, P.cl]) {
    const it = (await who.get('/api/social/feed')).data.items.find((p) => p.id === op.id);
    assert.ok(it, 'publicação oficial no feed');
    assert.equal(it.follow, 'official');
    assert.equal(it.author.name, 'Acolia Brasil');
    assert.equal(it.author.official, true);
  }
  // Curte e comenta; o admin vê e apaga o comentário
  await pt.post(`/api/social/posts/${op.id}/like`);
  const cm = (await pt.post(`/api/social/posts/${op.id}/comments`, { body: 'Que legal!' })).data;
  const adm = (await admin.get('/api/admin/official')).data;
  assert.equal(adm.items[0].likes, 1);
  assert.equal(adm.items[0].comments, 1);
  assert.equal((await admin.get(`/api/admin/official/posts/${op.id}/comments`)).data.items[0].body, 'Que legal!');
  assert.equal((await admin.del(`/api/admin/official/comments/${cm.id}`)).status, 200);

  // Não dá para deixar de seguir
  assert.equal((await pt.del(`/api/social/follow/${offId}`)).status, 400);
  assert.equal((await pt.post(`/api/social/follow/${offId}`)).data.following, true);

  // Perfil: seguidores pacientes (ativos) e profissionais (licença em dia); sai quem perde a licença
  const count = () => ({
    patients: db.prepare("SELECT COUNT(*) n FROM patients WHERE status = 'ativo' AND is_test = 0").get().n,
    pros: db.prepare("SELECT COUNT(*) n FROM professionals WHERE status = 'aprovado' AND subscription_until >= date('now', '-1 day') AND is_test = 0").get().n,
  });
  let prof = (await pt.get('/api/professionals/acolia')).data;
  assert.equal(prof.official, true);
  assert.equal(prof.name, 'Acolia Brasil');
  assert.equal(prof.instagram, 'acoliabrasil');
  assert.equal(prof.followers_patients, count().patients);
  assert.equal(prof.followers_professionals, count().pros);
  assert.equal(prof.following, true);
  assert.equal(prof.price_cents, undefined, 'sem valores/consulta');
  const before = prof.followers_professionals;
  db.prepare("UPDATE professionals SET subscription_until = date('now', '-2 day') WHERE id = ?").run(P.id); // venceu e passou o dia a mais
  prof = (await pt.get(`/api/professionals/${offId}`)).data;
  assert.equal(prof.followers_professionals, before - 1, 'licença vencida some da contagem');
  db.prepare("UPDATE professionals SET subscription_until = date('now', '+30 day') WHERE id = ?").run(P.id);

  // Todas as publicações no perfil (logado); visitante com o bloqueio de sempre
  assert.equal((await pt.get(`/api/social/professionals/${offId}/posts`)).data.items.length, 1);
  const vis = (await anon.get(`/api/social/professionals/${offId}/posts`)).data;
  assert.equal(vis.locked, true);
  assert.equal(vis.items.length, 0, 'com 1 publicação, visitante não vê nenhuma aberta');
  assert.equal((await anon.get('/api/professionals/acolia')).data.locked, true);
  const page = await fetch(`${base}/acolia`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('Acolia Brasil — perfil oficial'));

  // Admin apaga a publicação
  assert.equal((await admin.del(`/api/admin/official/posts/${op.id}`)).status, 200);
  assert.ok(!(await pt.get('/api/social/feed')).data.items.some((p) => p.id === op.id));
});

test('Reels: profissional publica vídeo de até 2 min; aparece no feed, na aba Reels e no perfil separado das fotos', async () => {
  const c = await admin.post('/api/admin/professionals', { name: 'Rafa Reels', profession: 'Psicólogo(a)', registry: 'R-reels', email: 'rafareels@example.com', phone: '11944440000', state: 'SP', city: 'Campinas' });
  const pro = client();
  await pro.post('/api/auth/professional/login', { login: c.data.code, password: c.data.password });
  const sendReel = async (who, duration, caption = 'Meu vídeo') => {
    const fd = new FormData();
    fd.append('caption', caption);
    fd.append('duration', String(duration));
    fd.append('poster', new Blob([Buffer.from([0xff, 0xd8, 0xff, 1])], { type: 'image/jpeg' }), 'capa.jpg');
    fd.append('video', new Blob([Buffer.from('fake-mp4-video')], { type: 'video/mp4' }), 'v.mp4');
    const res = await fetch(`${base}/api/social/reels`, { method: 'POST', body: fd, headers: { Cookie: who.cookie } });
    return { status: res.status, data: await res.json() };
  };
  const pt = client();
  await pt.post('/api/auth/patient/login', { cpf: '453.178.287-91', password: '123456' });
  assert.equal((await sendReel(pt, 10)).status, 403, 'paciente não publica');
  assert.equal((await sendReel(pro, 126)).status, 400, 'no máximo 2 minutos');
  const r = await sendReel(pro, 118);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.kind, 'reel');
  assert.ok(r.data.video.startsWith('/uploads/') && r.data.video.endsWith('.mp4'));
  assert.ok(r.data.image.endsWith('.jpg'), 'capa do vídeo');

  // Uma foto também, para ver a separação no perfil
  const fd = new FormData();
  fd.append('photos', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'f.png');
  await fetch(`${base}/api/social/posts`, { method: 'POST', body: fd, headers: { Cookie: pro.cookie } });

  // Aba Reels: só vídeos, de todo mundo (mesmo sem seguir), sem repetir o que já mostrou
  const reels = (await pt.get('/api/social/reels')).data;
  assert.ok(reels.items.some((p) => p.id === r.data.id));
  assert.ok(reels.items.every((p) => p.kind === 'reel'));
  assert.ok(!(await pt.get(`/api/social/reels?sug=${r.data.id}`)).data.items.some((p) => p.id === r.data.id));
  // Aba "Seguindo": só de quem a pessoa segue (ainda não segue o Rafa)
  assert.ok(!(await pt.get('/api/social/reels?scope=following')).data.items.some((p) => p.id === r.data.id));
  await pt.post(`/api/social/follow/${c.data.id}`);
  const fol = (await pt.get('/api/social/reels?scope=following&avatars=1')).data;
  assert.ok(fol.items.some((p) => p.id === r.data.id), 'depois de seguir, aparece em Seguindo');
  assert.equal(fol.following_avatars[0].id, c.data.id, 'fotinho de quem segue');
  await pt.del(`/api/social/follow/${c.data.id}`);
  // No feed (como sugestão) com o vídeo
  const inFeed = (await pt.get('/api/social/feed')).data.items.find((p) => p.id === r.data.id);
  assert.ok(inFeed && inFeed.video, 'reel aparece no feed');
  // Curtir e comentar funcionam igual
  assert.equal((await pt.post(`/api/social/posts/${r.data.id}/like`)).data.likes, 1);
  assert.equal((await pt.post(`/api/social/posts/${r.data.id}/comments`, { body: 'Ótimo vídeo' })).status, 201);

  // Perfil: fotos e vídeos separados (4 de cada)
  const prof = (await pt.get(`/api/professionals/${c.data.id}`)).data;
  assert.equal(prof.posts_count, 2);
  assert.equal(prof.photos_count, 1);
  assert.equal(prof.reels_count, 1);
  assert.equal(prof.gallery_posts.length, 1);
  assert.equal(prof.reels_posts[0].id, r.data.id);
  const onlyReels = (await pt.get(`/api/social/professionals/${c.data.id}/posts?kind=reel`)).data.items;
  assert.deepEqual(onlyReels.map((x) => x.kind), ['reel']);
  const onlyPhotos = (await pt.get(`/api/social/professionals/${c.data.id}/posts?kind=photo`)).data.items;
  assert.deepEqual(onlyPhotos.map((x) => x.kind), ['photo']);

  // O dono coloca o vídeo no story (abre o vídeo)
  const st = await pro.post(`/api/social/posts/${r.data.id}/story`);
  assert.equal(st.status, 201);
  assert.equal(st.data.post.kind, 'reel');

  // Apagar remove o vídeo
  assert.equal((await pro.del(`/api/social/posts/${r.data.id}`)).status, 200);
  const file = require('node:path').join(tmp, 'uploads', require('node:path').basename(r.data.video));
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(fs.existsSync(file), false, 'arquivo do vídeo apagado');
});

test('reel em pedaços: continua de onde parou (internet caiu / app no fundo) e publica no fim', async () => {
  const c = await admin.post('/api/admin/professionals', { name: 'Pedro Pedaços', profession: 'Psicólogo(a)', registry: 'R-chunk', email: 'pedaco@example.com', phone: '11955550000', state: 'SP', city: 'Campinas' });
  const pro = client();
  await pro.post('/api/auth/professional/login', { login: c.data.code, password: c.data.password });
  const video = Buffer.from('0123456789'.repeat(1000)); // 10 KB
  let r = await pro.post('/api/social/uploads', { mime: 'video/mp4', size: video.length });
  assert.equal(r.status, 201);
  const id = r.data.id;
  const put = async (offset, buf) => {
    const res = await fetch(`${base}/api/social/uploads/${id}?offset=${offset}`, { method: 'PUT', body: buf, headers: { Cookie: pro.cookie, 'Content-Type': 'application/octet-stream' } });
    return { status: res.status, data: await res.json() };
  };
  assert.equal((await put(0, video.subarray(0, 4000))).data.received, 4000);
  // Pedaço fora de ordem (ex.: reenvio depois da internet cair): responde quanto já chegou
  const wrong = await put(1000, video.subarray(1000, 2000));
  assert.equal(wrong.status, 409);
  assert.equal(wrong.data.received, 4000);
  // O aparelho pergunta quanto chegou e continua
  assert.equal((await pro.get(`/api/social/uploads/${id}`)).data.received, 4000);
  const finish = async () => {
    const fd = new FormData();
    fd.append('caption', 'Enviado aos poucos');
    fd.append('duration', '42');
    fd.append('photo', new Blob([Buffer.from([0xff, 0xd8, 0xff, 2])], { type: 'image/jpeg' }), 'capa.jpg');
    const res = await fetch(`${base}/api/social/uploads/${id}/finish`, { method: 'POST', body: fd, headers: { Cookie: pro.cookie } });
    return { status: res.status, data: await res.json() };
  };
  assert.equal((await finish()).status, 409, 'ainda não chegou inteiro');
  assert.equal((await put(4000, video.subarray(4000))).data.received, video.length);
  // Outro profissional não mexe no envio
  const other = client();
  await other.post('/api/auth/professional/login', { login: c.data.code, password: c.data.password });
  const done = await finish();
  assert.equal(done.status, 201, JSON.stringify(done.data));
  assert.equal(done.data.kind, 'reel');
  assert.equal(done.data.caption, 'Enviado aos poucos');
  const saved = fs.readFileSync(require('node:path').join(tmp, 'uploads', require('node:path').basename(done.data.video)));
  assert.ok(saved.equals(video), 'o vídeo chegou inteiro e igual');
  assert.equal((await pro.get(`/api/social/uploads/${id}`)).status, 404, 'envio encerrado');
  const pt = client();
  await pt.post('/api/auth/patient/login', { cpf: '453.178.287-91', password: '123456' });
  assert.equal((await pt.post('/api/social/uploads', { mime: 'video/mp4', size: 10 })).status, 403, 'paciente não envia');
});

test('fotos antigas: o sistema mede a foto e grava o formato do feed mais próximo (4:5, 1:1 ou 1,91:1)', async () => {
  const { db } = require('../server/db');
  const path = require('node:path');
  // PNG 1200×628 (paisagem) e PNG 800×1000 (retrato), como se fossem publicações antigas sem formato
  const png = (w, h) => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
    return b;
  };
  fs.writeFileSync(path.join(tmp, 'uploads', 'velha-paisagem.png'), png(1200, 628));
  fs.writeFileSync(path.join(tmp, 'uploads', 'velha-retrato.png'), png(800, 1000));
  const pro = db.prepare("SELECT id FROM professionals WHERE status = 'aprovado' LIMIT 1").get().id;
  const a = Number(db.prepare('INSERT INTO posts (professional_id, image) VALUES (?, ?)').run(pro, '/uploads/velha-paisagem.png').lastInsertRowid);
  const b = Number(db.prepare('INSERT INTO posts (professional_id, image) VALUES (?, ?)').run(pro, '/uploads/velha-retrato.png').lastInsertRowid);
  await require('../server/routes/social').fixOldAspects();
  assert.equal(db.prepare('SELECT aspect FROM posts WHERE id = ?').get(a).aspect, '1.91:1');
  assert.equal(db.prepare('SELECT aspect FROM posts WHERE id = ?').get(b).aspect, '4:5');
});

test('admin apaga a conta de verdade: some tudo e a pessoa pode criar a conta de novo', async () => {
  const { db } = require('../server/db');
  // Profissional com publicação, seguidor e conversa
  const c = await admin.post('/api/admin/professionals', { name: 'Bia Apagada', profession: 'Psicólogo(a)', registry: 'CRP 06/99999', email: 'bia.apagar@example.com', phone: '11966660000', state: 'SP', city: 'Campinas' });
  const pro = client();
  await pro.post('/api/auth/professional/login', { login: c.data.code, password: c.data.password });
  const fd = new FormData();
  fd.append('photos', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'f.png');
  const post = await (await fetch(`${base}/api/social/posts`, { method: 'POST', body: fd, headers: { Cookie: pro.cookie } })).json();
  // Paciente novo que curte, comenta, segue e conversa
  const CPF = '583.920.174-04';
  const pt = client();
  const regR = await pt.post("/api/auth/patient/register", { name: "Caio Apagado", cpf: CPF, state: "SP", city: "Campinas", password: "123456" });
  assert.equal(regR.status, 201, JSON.stringify(regR.data));
  await pt.post(`/api/social/posts/${post.id}/like`);
  await pt.post(`/api/social/posts/${post.id}/comments`, { body: 'Oi' });
  await pt.post(`/api/social/follow/${c.data.id}`);
  const conv = (await pt.post('/api/chat/conversations', { professional_id: c.data.id })).data;
  await pt.post(`/api/chat/conversations/${conv.id}/messages`, { body: 'Mensagem do paciente' });
  const ptId = db.prepare('SELECT id FROM patients WHERE cpf = ?').get(CPF.replace(/\D/g, '')).id;

  // Apaga o paciente: curtidas, comentários, seguir e o conteúdo das mensagens somem; CPF livre
  assert.equal((await admin.post(`/api/admin/patients/${ptId}/delete`)).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM post_likes WHERE role = 'patient' AND user_id = ?").get(ptId).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM post_comments WHERE role = 'patient' AND user_id = ?").get(ptId).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM follows WHERE follower_role = 'patient' AND follower_id = ?").get(ptId).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND sender_role = 'patient' AND kind <> 'deleted'").get(conv.id).n, 0);
  assert.equal((await pt.get('/api/auth/me')).data.role, null, 'sessão encerrada');
  assert.equal((await client().post('/api/auth/patient/register', { name: 'Caio Apagado', cpf: CPF, state: 'SP', city: 'Campinas', password: '123456' })).status, 201, 'pode criar a conta de novo');

  // Apaga o profissional: publicações somem (com o arquivo) e e-mail/registro ficam livres
  const file = require('node:path').join(tmp, 'uploads', require('node:path').basename(post.image));
  assert.equal((await admin.post(`/api/admin/professionals/${c.data.id}/delete`)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts WHERE professional_id = ?').get(c.data.id).n, 0);
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(fs.existsSync(file), false, 'foto apagada');
  assert.equal((await client().post('/api/auth/professional/login', { login: c.data.code, password: c.data.password })).status, 401);
  const again = await admin.post('/api/admin/professionals', { name: 'Bia Apagada', profession: 'Psicólogo(a)', registry: 'CRP 06/99999', email: 'bia.apagar@example.com', phone: '11966660000', state: 'SP', city: 'Campinas' });
  assert.equal(again.status, 201, 'pode ser cadastrada de novo com o mesmo e-mail e registro');
});

test('conta bloqueada pode se excluir pela tela de bloqueio', async () => {
  const CPF = '862.314.110-52';
  const pt = client();
  assert.equal((await pt.post('/api/auth/patient/register', { name: 'Dora Bloqueada', cpf: CPF, state: 'SP', city: 'Campinas', password: '123456' })).status, 201);
  const { db } = require('../server/db');
  const id = db.prepare('SELECT id FROM patients WHERE cpf = ?').get(CPF.replace(/\D/g, '')).id;
  await admin.post(`/api/admin/patients/${id}/status`, { status: 'bloqueado' });
  assert.equal((await pt.get('/api/auth/me')).data.account.blocked, 'admin');
  assert.equal((await pt.post('/api/patient/delete', { cpf: '111.111.111-11' })).status, 400, 'CPF errado não apaga');
  assert.equal((await pt.post('/api/patient/delete', { cpf: CPF })).status, 200, 'confirma com o próprio CPF');
  assert.equal(db.prepare('SELECT status FROM patients WHERE id = ?').get(id).status, 'excluido');
});

test('espaço do disco: só o administrador vê (paciente, profissional e visitante não)', async () => {
  const a = await admin.get('/api/admin/stats');
  assert.equal(a.status, 200);
  assert.ok(a.data.usage && a.data.usage.parts, 'admin vê o espaço usado');
  const pat = client();
  await pat.post('/api/auth/patient/login', { cpf: '453.178.287-91', password: '123456' });
  const pro = client();
  await pro.post('/api/auth/professional/login', { login: '123456789', password: '123456789' });
  for (const who of [anon, pat, pro]) {
    const r = await who.get('/api/admin/stats');
    assert.equal(r.status, 401);
    assert.equal(r.data.usage, undefined);
    const me = await who.get('/api/auth/me');
    assert.ok(!JSON.stringify(me.data).includes('usage'), 'nada de espaço no /me');
  }
});

test('limite de publicações: ao passar, a mais antiga sai; o admin muda o limite e o excesso é apagado', async () => {
  const { db } = require('../server/db');
  const path = require('node:path');
  // Começa com 15 fotos e 10 vídeos
  assert.deepEqual((await admin.get('/api/admin/limits')).data, { photo: 15, reel: 10 });
  const c = await admin.post('/api/admin/professionals', { name: 'Lia Limite', profession: 'Psicólogo(a)', registry: 'R-limite', email: 'lia.limite@example.com', phone: '11955554444', state: 'SP', city: 'Campinas' });
  const pro = client();
  await pro.post('/api/auth/professional/login', { login: c.data.code, password: c.data.password });
  const photo = async (i) => {
    const fd = new FormData();
    fd.append('caption', `Foto ${i}`);
    fd.append('photos', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, i])], { type: 'image/png' }), 'f.png');
    return (await fetch(`${base}/api/social/posts`, { method: 'POST', body: fd, headers: { Cookie: pro.cookie } })).json();
  };
  const reel = async (i) => {
    const fd = new FormData();
    fd.append('caption', `Vídeo ${i}`);
    fd.append('poster', new Blob([Buffer.from([0xff, 0xd8, 0xff, i])], { type: 'image/jpeg' }), 'c.jpg');
    fd.append('video', new Blob([Buffer.from(`video-${i}`)], { type: 'video/mp4' }), 'v.mp4');
    return (await fetch(`${base}/api/social/reels`, { method: 'POST', body: fd, headers: { Cookie: pro.cookie } })).json();
  };
  // Admin baixa para 3 fotos e 2 vídeos (para o teste ser rápido)
  assert.equal((await admin.post('/api/admin/limits', { photo: 3, reel: 2 })).status, 200);
  const photos = [];
  for (let i = 1; i <= 4; i++) photos.push(await photo(i));
  const count = (kind) => db.prepare('SELECT COUNT(*) n FROM posts WHERE professional_id = ? AND kind = ?').get(c.data.id, kind).n;
  assert.equal(count('photo'), 3, 'no máximo 3');
  assert.equal(db.prepare('SELECT 1 FROM posts WHERE id = ?').get(photos[0].id), undefined, 'a 1ª (mais antiga) saiu');
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(fs.existsSync(path.join(tmp, 'uploads', path.basename(photos[0].image))), false, 'arquivo apagado (libera espaço)');
  const reels = [];
  for (let i = 1; i <= 3; i++) reels.push(await reel(i));
  assert.equal(count('reel'), 2);
  assert.equal(db.prepare('SELECT 1 FROM posts WHERE id = ?').get(reels[0].id), undefined, 'o vídeo mais antigo saiu');
  assert.deepEqual((await pro.get('/api/social/limits')).data, { photo: { max: 3, used: 3 }, reel: { max: 2, used: 2 } });
  // Diminuir o limite: mostra quantas vão sair e apaga as mais antigas na hora
  const prev = (await admin.get('/api/admin/limits?photo=1&reel=1')).data;
  assert.ok(prev.would_remove.photo >= 2 && prev.would_remove.reel >= 1);
  const r = (await admin.post('/api/admin/limits', { photo: 1, reel: 1 })).data;
  assert.ok(r.removed >= 3);
  assert.equal(count('photo'), 1);
  assert.equal(count('reel'), 1);
  assert.equal(db.prepare('SELECT caption FROM posts WHERE professional_id = ? AND kind = ?').get(c.data.id, 'photo').caption, 'Foto 4', 'fica a mais nova');
  // Paciente e profissional não mudam o limite
  assert.equal((await pro.post('/api/admin/limits', { photo: 99, reel: 99 })).status, 401);
  // Volta ao padrão combinado (15 fotos e 10 vídeos)
  assert.equal((await admin.post('/api/admin/limits', { photo: 15, reel: 10 })).status, 200);
});

test('reel: mais de 70 MB é recusado (inteiro ou em pedaços)', async () => {
  const pro = client();
  await pro.post('/api/auth/professional/login', { login: '123456789', password: '123456789' });
  const r = await pro.post('/api/social/uploads', { mime: 'video/mp4', size: 70 * 1024 * 1024 + 1 });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /70 MB/);
  assert.equal((await pro.post('/api/social/uploads', { mime: 'video/mp4', size: 69 * 1024 * 1024 })).status, 201, 'até 70 MB tudo bem');
});

test('chat: apagar para mim, limpar conversa, bloquear (só mensagens) e conta apagada some com tudo', async () => {
  const { db } = require('../server/db');
  const created = await admin.post('/api/admin/professionals', { name: 'Téo Chat', profession: 'Psicólogo(a)', registry: 'R-chatblk', email: 'teo.chat@example.com', phone: '11922223333', state: 'SP', city: 'Campinas' });
  const pro = client();
  await pro.post('/api/auth/professional/login', { login: created.data.code, password: created.data.password });
  const pt = client();
  await pt.post('/api/auth/patient/login', { cpf: '453.178.287-91', password: '123456' });
  const conv = (await pt.post('/api/chat/conversations', { professional_id: created.data.id })).data;
  const send = (who, body) => who.post(`/api/chat/conversations/${conv.id}/messages`, { body });
  const a = (await send(pt, 'Oi, tudo bem?')).data;
  const b = (await send(pro, 'Olá! Tudo sim.')).data;
  const msgs = async (who) => (await who.get(`/api/chat/conversations/${conv.id}/messages`)).data.items.map((m) => m.body);

  // Apagar para mim: some só para mim; quando os dois apagam, sai do banco
  assert.equal((await pro.post(`/api/chat/messages/${a.id}/delete`, { for: 'me' })).status, 200);
  assert.ok(!(await msgs(pro)).includes('Oi, tudo bem?'));
  assert.ok((await msgs(pt)).includes('Oi, tudo bem?'), 'o paciente ainda vê');
  await pt.post(`/api/chat/messages/${a.id}/delete`, { for: 'me' });
  assert.equal(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(a.id), undefined, 'os dois apagaram: saiu do banco');

  // Limpar conversa: some tudo para mim, o outro continua vendo
  await pt.post(`/api/chat/conversations/${conv.id}/clear`);
  assert.equal((await msgs(pt)).length, 0);
  assert.ok((await msgs(pro)).includes('Olá! Tudo sim.'));

  // Profissional bloqueia o paciente: ninguém manda mensagem; a conversa vai para "Bloqueados"
  let r = await pro.post(`/api/chat/conversations/${conv.id}/block`);
  assert.equal(r.data.blocked_by_me, true);
  assert.equal(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(b.id), undefined, 'bloqueou: a conversa foi limpa (e o paciente já tinha limpado)');
  assert.equal((await send(pt, 'Oi?')).status, 403, 'bloqueado não manda mensagem');
  assert.equal((await send(pro, 'teste')).status, 403, 'quem bloqueou também não, até desbloquear');
  assert.equal((await pt.get(`/api/chat/conversations/${conv.id}`)).data.blocked_me, true);
  assert.equal((await pro.get('/api/chat/conversations')).data.blocked_count, 1);
  assert.equal((await pro.get('/api/chat/blocks')).data.items[0].conversation_id, conv.id);
  // Bloqueio é só das mensagens: o paciente continua vendo o profissional
  assert.equal((await pt.get(`/api/professionals/${created.data.id}`)).status, 200);
  // Desbloquear
  r = await pro.del(`/api/chat/conversations/${conv.id}/block`);
  assert.equal(r.data.blocked_by_me, false);
  assert.equal((await send(pt, 'Voltei')).status, 201);
  // Paciente também bloqueia o profissional
  await pt.post(`/api/chat/conversations/${conv.id}/block`);
  assert.equal((await send(pro, 'Oi')).status, 403);
  await pt.del(`/api/chat/conversations/${conv.id}/block`);

  // Conta apagada: a conversa inteira some (mensagens dos dois lados)
  await send(pro, 'Mensagem do profissional');
  await admin.post(`/api/admin/professionals/${created.data.id}/delete`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id = ?').get(conv.id).n, 0);
  assert.equal(db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conv.id), undefined);
});
