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

test('mensagens não podem ser editadas nem removidas do banco (só o conteúdo pode ser apagado)', async () => {
  const r = await pat.del(`/api/chat/conversations/${convId}/messages`);
  assert.equal(r.status, 404);
  const { db } = require('../server/db');
  assert.throws(() => db.prepare('DELETE FROM messages').run(), /não podem ser apagadas/);
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
  assert.equal(list.data.items.length, 0, 'por padrão só aparecem os do estado do paciente (SP)');
  assert.equal(list.data.state, 'SP');
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

test('mensalidade vencida tira da vitrine; restrito/bloqueado', async () => {
  await admin.post(`/api/admin/professionals/${proId}/subscription`, { until: '2020-01-01' });
  assert.equal((await anon.get('/api/professionals')).data.items.length, 0);
  assert.equal((await pro.get('/api/professional/me')).status, 200, 'ainda entra no painel');
  await admin.post(`/api/admin/professionals/${proId}/subscription`, { add_days: 30 });
  assert.equal((await anon.get('/api/professionals')).data.items.length, 1);

  await admin.post(`/api/admin/professionals/${proId}/status`, { status: 'restrito' });
  assert.equal((await anon.get('/api/professionals')).data.items.length, 0);
  assert.equal((await pro.get('/api/professional/me')).status, 200);

  await admin.post(`/api/admin/professionals/${proId}/status`, { status: 'bloqueado' });
  assert.equal((await pro.get('/api/professional/me')).status, 401, 'sessão derrubada');
  const r = await client().post('/api/auth/professional/login', { login: proCode, password: 'segredo1' });
  assert.equal(r.status, 403);
  await admin.post(`/api/admin/professionals/${proId}/status`, { status: 'aprovado' });
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
  const login = await client().post('/api/auth/patient/login', { cpf: CPF_A, password: r.data.password });
  assert.equal(login.status, 403);
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
  const CPF_C = '390.533.447-05';
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

  const upload = async (slot) => {
    const fd = new FormData();
    fd.append('photo', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'f.png');
    const res = await fetch(`${base_}/api/professional/gallery/${slot}`, { method: 'POST', body: fd, headers: { Cookie: lp.cookie } });
    return { status: res.status, data: await res.json() };
  };
  const base_ = base;
  r = await upload(1);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await upload(3);
  assert.equal(r.data.gallery.filter(Boolean).length, 2);
  assert.equal(r.data.gallery.length, 6, 'sempre 6 posições');
  assert.equal((await upload(7)).status, 400, 'no máximo 6');
  r = await lp.del('/api/professional/gallery/1');
  assert.equal(r.data.gallery[0], null);
  assert.ok(r.data.gallery[2]);

  const anonView = (await anon.get(`/api/professionals/${created.data.id}`)).data;
  assert.equal(anonView.session_minutes, undefined, 'duração só com conta');
  assert.equal(anonView.has_session_minutes, true);
  assert.equal(anonView.instagram, 'lia.psi', 'Instagram aparece para todos');
  assert.equal(anonView.gallery.length, 0, 'com 1 foto, ela fica bloqueada');
  assert.equal(anonView.gallery_hidden, 1);
  for (const s of [1, 2, 4]) await upload(s);
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

  let r = await gp.post(`/api/chat/messages/${m1.id}/delete`);
  assert.equal(r.status, 403, 'o profissional não apaga mensagem do paciente');
  r = await pt.post(`/api/chat/messages/${m1.id}/delete`);
  assert.equal(r.status, 200);
  r = await pt.post(`/api/chat/messages/${m2.id}/delete`);
  assert.equal(r.status, 200);

  const { db } = require('../server/db');
  const row = db.prepare('SELECT kind, body FROM messages WHERE id = ?').get(m1.id);
  assert.deepEqual({ ...row }, { kind: 'deleted', body: '' }, 'texto apagado do banco');
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
});
