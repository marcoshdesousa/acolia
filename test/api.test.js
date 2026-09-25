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
process.env.SKIP_OWNER_TEST = '1';

const { start } = require('../server');
const { isValidCpf } = require('../server/util');
const { io: ioClient } = require('socket.io-client');

let server;
let base;

// Cliente HTTP com "cookie jar" simples
function client() {
  let cookie = '';
  // Cadastro e perfil de profissional exigem ao menos uma especialidade: quando o teste não manda, vai uma padrão
  const SP_URLS = ['/api/admin/professionals', '/api/professional/profile', '/api/auth/professional/register'];
  const call = async (method, url, body) => {
    if (body && SP_URLS.includes(url) && !('specialties' in body)) body = { ...body, specialties: ['Ansiedade'] };
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
    if (SP_URLS.includes(url) && !('specialties' in fields)) fields = { ...fields, specialties: JSON.stringify(['Ansiedade']) };
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
let CRP_SEQ = 30000; // CRPs válidos e diferentes para os profissionais criados nos testes
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
  let r = await pat.post('/api/auth/patient/register', { name: 'Maria Souza', cpf: '123.456.789-00', state: 'PA', city: 'Parauapebas', birth_date: '1990-05-10', password: '123456' });
  assert.equal(r.status, 400);
  r = await pat.post('/api/auth/patient/register', { name: 'Maria', cpf: CPF_A, state: 'PA', city: 'Parauapebas', birth_date: '1990-05-10', password: '123456' });
  assert.equal(r.status, 400);
  r = await pat.post('/api/auth/patient/register', { name: 'Maria Souza', cpf: CPF_A, state: 'PA', city: 'Parauapebas', birth_date: '1990-05-10', password: '123456' });
  assert.equal(r.status, 201);
  r = await anon.post('/api/auth/patient/register', { name: 'Outra Pessoa', cpf: CPF_A, state: 'PA', city: 'Parauapebas', birth_date: '1990-05-10', password: '123456' });
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
  // Psicanalista (sem conselho): não precisa de carteirinha nem de número de registro
  r = await anon.form('/api/auth/professional/register', { ...PRO, profession: 'Psicanalista', registry: '', email: 'psicanalista.semcart@example.com' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const row = require('../server/db').db.prepare('SELECT registry, document_file FROM professionals WHERE email = ?').get('psicanalista.semcart@example.com');
  assert.equal(row.registry, '');
  assert.equal(row.document_file, null);
  require('../server/db').db.prepare('DELETE FROM professionals WHERE email = ?').run('psicanalista.semcart@example.com'); // não atrapalha os próximos testes
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
  r = await pro.post('/api/auth/professional/login', { login: proCode, password: 'qualquer' });
  assert.equal(r.status, 403);
  assert.equal(r.data.pending, true, 'em análise: avisa (ainda não tem senha)');
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
  // A primeira senha é gerada na aprovação (o admin manda pelo WhatsApp); ele entra e troca
  assert.equal(r.data.new_password.length, 10);
  const first = client();
  assert.equal((await first.post('/api/auth/professional/login', { login: proCode, password: r.data.new_password })).status, 200);
  assert.equal((await first.post('/api/professional/password', { current: r.data.new_password, password: 'segredo1' })).status, 200);
  r = await admin.post(`/api/admin/professionals/${proId}/status`, { status: 'aprovado' });
  assert.equal(r.data.new_password, null, 'reaprovar não troca a senha');
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
  assert.equal(r.data.packages, undefined, 'pacotes saíram (consulta avulsa; pacote se combina pelo chat)');
  assert.equal(r.data.name, 'João Pereira');
});

test('vitrine: visitante vê o básico (com o "Sobre"), mas não valores, sessões nem localização; paciente vê tudo', async () => {
  let r = await anon.get('/api/professionals');
  assert.equal(r.data.items.length, 1);
  const p = r.data.items[0];
  assert.equal(p.locked, true);
  assert.equal(p.price_cents, undefined);
  assert.equal(p.city, undefined, 'localização só com conta');
  assert.equal(p.state, undefined);
  assert.equal(p.clinic_address, undefined);
  assert.equal(p.bio, 'Atendo adultos.', '"Sobre" aparece para todos');
  assert.ok(p.specialties && p.profession && 'instagram' in p && 'accepts_insurance' in p && p.followers_count >= 1, 'especialidades, profissão, Instagram, plano e seguidores aparecem');
  r = await anon.get(`/api/professionals/${proId}`);
  assert.equal(r.data.price_cents, undefined);
  assert.equal(r.data.has_price, true);
  assert.equal(r.data.has_packages, undefined, 'sem pacotes');
  assert.equal(r.data.package_sessions, undefined);
  assert.equal(r.data.session_minutes, undefined);
  assert.equal(r.data.city, undefined);
  assert.equal(JSON.stringify(r.data).includes('520'), false, 'valor do pacote não vaza');
  assert.equal(JSON.stringify(r.data).includes('Parauapebas'), false, 'cidade não vaza');

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
  await other.post('/api/auth/patient/register', { name: 'Carlos Lima', cpf: CPF_B, state: 'SP', city: 'São Paulo', birth_date: '1990-05-10', password: '123456' });
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

test('paciente: recuperar senha com nome + CPF + nascimento e escolher a nova', async () => {
  let r = await anon.post('/api/auth/patient/recover', { cpf: CPF_A, name: 'Maria Errada', birth_date: '1990-05-10', password: 'nova123' });
  assert.equal(r.status, 400);
  r = await anon.post('/api/auth/patient/recover', { cpf: CPF_A, name: 'maria souza', birth_date: '1991-01-01', password: 'nova123' });
  assert.equal(r.status, 400, 'nascimento errado');
  r = await anon.post('/api/auth/patient/recover', { cpf: CPF_A, name: 'maria souza', birth_date: '1990-05-10', password: 'nova123' });
  assert.equal(r.status, 200);
  const newPw = 'nova123';
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
  // Visitante sem conta: não vê local nem valor, então filtro por estado/valor e ordem por valor não valem
  const v = client();
  const all = (await v.get('/api/professionals')).data.items.map((x) => x.name);
  let r2 = await v.get('/api/professionals?state=SP&sort=preco_menor');
  assert.deepEqual(r2.data.items.map((x) => x.name), all, 'estado e ordem por valor ignorados');
  assert.equal(r2.data.items[0].price_cents, undefined);
  assert.equal(r2.data.items[0].city, undefined);
  r2 = await v.get('/api/professionals?max_price=100');
  assert.deepEqual(r2.data.items.map((x) => x.name), all, 'valor máximo ignorado');
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
  await p.post('/api/auth/patient/register', { name: 'Paula Lima', cpf: CPF_C, state: 'SP', city: 'Campinas', birth_date: '1990-05-10', password: '123456' });
  let r = await p.post('/api/patient/delete', { password: 'errada' });
  assert.equal(r.status, 400);
  r = await p.post('/api/patient/delete', { password: '123456' });
  assert.equal(r.status, 200);
  assert.equal((await p.get('/api/auth/me')).data.role, null, 'saiu da conta');
  r = await client().post('/api/auth/patient/login', { cpf: CPF_C, password: '123456' });
  assert.equal(r.status, 401);
  r = await client().post('/api/auth/patient/register', { name: 'Paula Lima', cpf: CPF_C, state: 'SP', city: 'Campinas', birth_date: '1990-05-10', password: '123456' });
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
  await pt.post('/api/auth/patient/register', { name: 'Rita Souza', cpf: '453.178.287-91', state: 'SP', city: 'Campinas', birth_date: '1990-05-10', password: '123456' });
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
    name: 'Lia Campos', profession: 'Psicólogo(a)', registry: 'CRP 06/20010', email: 'lia@example.com', phone: '11966665555', state: 'SP', city: 'Campinas',
  });
  const lp = client();
  await lp.post('/api/auth/professional/login', { login: created.data.code, password: created.data.password });
  const pf = { name: 'Lia Campos', phone: '11966665555', state: 'SP', city: 'Campinas', bio: '', specialties: ['Adultos'], price: '120' };
  let r = await lp.put('/api/professional/profile', { ...pf, session_minutes: 50, instagram: 'https://www.instagram.com/lia.psi/' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.instagram, 'lia.psi', 'guarda só o @');
  assert.equal(r.data.session_minutes, 50);
  r = await lp.put('/api/professional/profile', { ...pf, session_minutes: 50, instagram: '@lia psi!' });
  assert.equal(r.status, 400, 'Instagram inválido');
  r = await lp.put('/api/professional/profile', { ...pf, session_minutes: 51, instagram: '@lia.psi' });
  assert.equal(r.status, 400, 'duração fora da lista');
  await lp.put('/api/professional/profile', { ...pf, session_minutes: 50, instagram: '@lia.psi' });
  // Outras redes: cada link só no campo da própria rede; o @ basta
  r = await lp.put('/api/professional/profile', { ...pf, instagram: '@lia.psi', x: 'https://www.youtube.com/@liapsi' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /YouTube/);
  r = await lp.put('/api/professional/profile', { ...pf, instagram: '@lia.psi', tiktok: 'https://www.instagram.com/lia.psi' });
  assert.equal(r.status, 400, 'link do Instagram no TikTok');
  r = await lp.put('/api/professional/profile', { ...pf, instagram: '@lia.psi', youtube: 'https://youtu.be/abc123' });
  assert.equal(r.status, 400, 'link de vídeo no lugar do canal');
  r = await lp.put('/api/professional/profile', { ...pf, instagram: '@lia.psi', tiktok: 'tiktok.com/@lia.psi', x: 'https://twitter.com/liapsi', youtube: '@liapsi' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.social.map((x) => x.url), ['https://www.instagram.com/lia.psi/', 'https://www.tiktok.com/@lia.psi', 'https://x.com/liapsi', 'https://www.youtube.com/@liapsi']);
  r = await lp.put('/api/professional/profile', { ...pf, session_minutes: 50 });
  assert.equal(r.data.social.length, 4, 'sem os campos, as redes ficam como estão');
  // Mensagens prontas: até 10, vazias saem
  r = await lp.put('/api/professional/quick-replies', { items: ['Olá! Tudo bem?', '  ', 'Minha agenda está no perfil.'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.items, ['Olá! Tudo bem?', 'Minha agenda está no perfil.']);
  assert.deepEqual((await lp.get('/api/professional/quick-replies')).data.items, r.data.items);
  r = await lp.put('/api/professional/quick-replies', { items: Array.from({ length: 11 }, (_, i) => `m${i}`) });
  assert.equal(r.status, 400, 'no máximo 10');

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
    name: 'Davi Nunes', profession: 'Psicólogo(a)', registry: 'CRP 06/20011', email: 'davi@example.com', phone: '11955554444', state: 'SP', city: 'Campinas',
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
    name: 'Eva Prado', profession: 'Psicólogo(a)', registry: 'CRP 06/20012', email: 'eva@example.com', phone: '11944443333', state: 'SP', city: 'Campinas',
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
  const reg = await other.post('/api/auth/patient/register', { name: 'Tomas Reis', cpf: '987.654.320-29', state: 'SP', city: 'Campinas', birth_date: '1990-05-10', password: '123456' });
  assert.equal(reg.status, 201);
  assert.equal((await listen(other)).status, 404, 'outro paciente logado não ouve');
});

test('apagar mensagem: só quem enviou, para todos; o conteúdo sai do banco', async () => {
  const created = await admin.post('/api/admin/professionals', {
    name: 'Gil Souto', profession: 'Psicólogo(a)', registry: 'CRP 06/20013', email: 'gil@example.com', phone: '11933332222', state: 'SP', city: 'Campinas',
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
  assert.equal((await gp.get('/api/chat/unread')).data.unread, 0, 'mensagem apagada não conta como nova');
  const convList = (await gp.get('/api/chat/conversations')).data.items.find((c) => c.id === conv.id);
  assert.equal(convList.unread, 0, 'nem no número da conversa');

  const { db } = require('../server/db');
  const row = db.prepare('SELECT kind, body FROM messages WHERE id = ?').get(m1.id);
  assert.deepEqual({ kind: row.kind, body: row.body }, { kind: 'deleted', body: '' }, 'texto apagado do banco');
  const mine = (await pt.get(`/api/chat/conversations/${conv.id}/messages`)).data.items;
  assert.ok(mine.length === 2 && mine.every((m) => m.kind === 'deleted' && m.body === ''), 'quem apagou também vê "Mensagem apagada"');
  assert.equal((await pt.post(`/api/chat/messages/${m1.id}/delete`)).status, 200, 'apagar de novo (toque duplo) não dá erro');
  assert.equal((await pt.post('/api/chat/messages/999999/delete')).status, 200, 'mensagem que já saiu do banco não dá erro');
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
  const reg = await other.post('/api/auth/patient/register', { name: 'Ivo Lima', cpf: '123.456.700-88', state: 'SP', city: 'Sorocaba', birth_date: '1990-05-10', password: '123456' });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  r = await other.get('/api/professionals?auto=1');
  assert.equal(r.data.state, 'SP');
  assert.equal(r.data.city, null, 'sem profissionais no município, filtra só o estado');
  // Paciente de um estado sem nenhum profissional: mostra o Brasil todo
  const far = client();
  assert.equal((await far.post('/api/auth/patient/register', { name: 'Ana Acre', cpf: '987.654.321-00', state: 'AC', city: 'Rio Branco', birth_date: '1990-05-10', password: '123456' })).status, 201);
  r = await far.get('/api/professionals?auto=1');
  assert.equal(r.data.state, null);
  assert.equal(r.data.widened, 'brasil');
  assert.ok(r.data.items.length > 0 && r.data.items.some((p) => p.state === 'SP'), 'vê profissionais de outros estados');
});

test('v1.2 — seguir, feed (não vistas primeiro), curtir, comentar, stories e notificações', async () => {
  const mk = async (name, email) => {
    const c = await admin.post('/api/admin/professionals', { name, profession: 'Psicólogo(a)', registry: `CRP 06/${++CRP_SEQ}`, email, phone: '11922221111', state: 'SP', city: 'Campinas' });
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

  // Stories: não dá mais para enviar da galeria; o story sai de uma publicação do próprio profissional
  // (foto, reel ou texto). Quem segue vê e curte.
  const story = async (who, type) => {
    const fd = new FormData();
    fd.append('media', new Blob([Buffer.from('fake')], { type }), type.startsWith('video') ? 'v.mp4' : 'f.png');
    const res = await fetch(`${base}/api/social/stories`, { method: 'POST', body: fd, headers: { Cookie: who.cookie } });
    return { status: res.status, data: await res.json() };
  };
  assert.equal((await story(pt, 'image/png')).status, 403);
  const gal = await story(A.cl, 'video/mp4');
  assert.equal(gal.status, 403, 'da galeria não');
  assert.match(gal.data.error, /publica/);
  const txt = (await A.cl.post('/api/social/texts', { text: 'Texto para o story', font: 'manuscrita' })).data;
  const s1 = await A.cl.post(`/api/social/posts/${txt.id}/story`);
  assert.equal(s1.status, 201, 'texto vai para o story');
  assert.equal(s1.data.post.kind, 'text');
  assert.equal(s1.data.post.font, 'manuscrita');
  assert.equal(s1.data.post.image, null);
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
  const c = await admin.post('/api/admin/professionals', { name: 'Caro Sel', profession: 'Psicólogo(a)', registry: 'CRP 06/20020', email: 'carosel@example.com', phone: '11922220000', state: 'SP', city: 'Campinas' });
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
    const c = await admin.post('/api/admin/professionals', { name, profession: 'Psicólogo(a)', registry: `CRP 06/${++CRP_SEQ}`, email, phone: '11911110000', state: 'SP', city: 'Campinas' });
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
    const c = await admin.post('/api/admin/professionals', { name, profession: 'Psicólogo(a)', registry: `CRP 06/${++CRP_SEQ}`, email, phone: '11933330000', state: 'SP', city: 'Campinas' });
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

test('Reels: profissional publica vídeo de até 1 min 30 s; aparece no feed, na aba Reels e no perfil separado das fotos', async () => {
  const c = await admin.post('/api/admin/professionals', { name: 'Rafa Reels', profession: 'Psicólogo(a)', registry: 'CRP 06/20021', email: 'rafareels@example.com', phone: '11944440000', state: 'SP', city: 'Campinas' });
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
  assert.equal((await sendReel(pro, 95)).status, 400, 'profissional: no máximo 1 min 30 s');
  const r = await sendReel(pro, 88);
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
  const c = await admin.post('/api/admin/professionals', { name: 'Pedro Pedaços', profession: 'Psicólogo(a)', registry: 'CRP 06/20022', email: 'pedaco@example.com', phone: '11955550000', state: 'SP', city: 'Campinas' });
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
  const regR = await pt.post("/api/auth/patient/register", { name: "Caio Apagado", cpf: CPF, state: "SP", city: "Campinas", birth_date: "1990-05-10", password: "123456" });
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
  assert.equal((await client().post('/api/auth/patient/register', { name: 'Caio Apagado', cpf: CPF, state: 'SP', city: 'Campinas', birth_date: '1990-05-10', password: '123456' })).status, 201, 'pode criar a conta de novo');

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
  assert.equal((await pt.post('/api/auth/patient/register', { name: 'Dora Bloqueada', cpf: CPF, state: 'SP', city: 'Campinas', birth_date: '1990-05-10', password: '123456' })).status, 201);
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
  const c = await admin.post('/api/admin/professionals', { name: 'Lia Limite', profession: 'Psicólogo(a)', registry: 'CRP 06/20023', email: 'lia.limite@example.com', phone: '11955554444', state: 'SP', city: 'Campinas' });
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

test('reel: sem limite de tamanho (só a duração conta)', async () => {
  const pro = client();
  await pro.post('/api/auth/professional/login', { login: '123456789', password: '123456789' });
  assert.equal((await pro.post('/api/social/uploads', { mime: 'video/mp4', size: 900 * 1024 * 1024 })).status, 201, 'vídeo grande também pode');
});

test('chat: apagar para mim, limpar conversa, bloquear (só mensagens) e conta apagada some com tudo', async () => {
  const { db } = require('../server/db');
  const created = await admin.post('/api/admin/professionals', { name: 'Téo Chat', profession: 'Psicólogo(a)', registry: 'CRP 06/20024', email: 'teo.chat@example.com', phone: '11922223333', state: 'SP', city: 'Campinas' });
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

test('documentos: quem pode emitir o quê, envio no chat, verificação pública e cancelamento', async () => {
  const mk = async (name, profession, registry, email) => {
    const c = await admin.post('/api/admin/professionals', { name, profession, registry, email, phone: '11911112222', state: 'SP', city: 'Campinas' });
    const cl = client();
    await cl.post('/api/auth/professional/login', { login: c.data.code, password: c.data.password });
    return { id: c.data.id, cl };
  };
  const psiq = await mk('Dra. Paula Psiq', 'Psiquiatra', 'CRM-SP 123456', 'paula.psiq@example.com');
  const psico = await mk('Rui Psico', 'Psicólogo(a)', 'CRP 06/111111', 'rui.psico@example.com');
  const analista = await mk('Ana Lista', 'Psicanalista', 'Registro 999', 'ana.lista@example.com');
  const pt = client();
  const CPF = '453.178.287-91';
  await pt.post('/api/auth/patient/login', { cpf: CPF, password: '123456' });
  const conv = async (pro) => {
    const c = (await pt.post('/api/chat/conversations', { professional_id: pro.id })).data;
    await pt.post(`/api/chat/conversations/${c.id}/messages`, { body: 'Olá' });
    return c.id;
  };
  const cPsiq = await conv(psiq);
  const cPsico = await conv(psico);
  const cAna = await conv(analista);
  const kinds = async (pro, cid) => (await pro.cl.get(`/api/docs/options/${cid}`)).data.kinds.map((k) => k.kind);
  assert.deepEqual(await kinds(psiq, cPsiq), ['atestado', 'receita', 'encaminhamento'], 'psiquiatra: tudo');
  assert.deepEqual(await kinds(psico, cPsico), ['atestado', 'encaminhamento'], 'psicólogo: sem receita');
  assert.deepEqual(await kinds(analista, cAna), ['encaminhamento'], 'psicanalista: só encaminhamento');
  const opt = (await psiq.cl.get(`/api/docs/options/${cPsiq}`)).data;
  assert.equal(opt.patient.cpf, CPF, 'CPF do paciente já vem preenchido');
  assert.equal(opt.patient.name, 'Rita Souza', 'nome oficial do cadastro');
  assert.equal(opt.patient.birth_date, '1990-05-10', 'nascimento do cadastro');

  const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  assert.equal((await psiq.cl.post('/api/docs', { patient_name: 'Rita Souza Lima', cpf: CPF, birth_date: '1990-05-10', attended_at: '2026-09-20T14:30', conversation_id: cPsiq, kind: 'atestado' })).status, 400, 'sem assinatura não envia');
  const base0 = { patient_name: 'Rita Souza Lima', cpf: CPF, birth_date: '1990-05-10', attended_at: '2026-09-20T14:30', signature: SIG };
  assert.equal((await psico.cl.post('/api/docs', { ...base0, conversation_id: cPsico, kind: 'receita', items: [{ name: 'X', instructions: 'y' }] })).status, 403, 'psicólogo não receita');
  assert.equal((await analista.cl.post('/api/docs', { ...base0, conversation_id: cAna, kind: 'atestado' })).status, 403, 'psicanalista não dá atestado');
  assert.equal((await psiq.cl.post('/api/docs', { ...base0, conversation_id: cPsiq, kind: 'atestado', cid: 'F41.1' })).status, 400, 'CID só com autorização');

  // Receita do psiquiatra: vai no chat e o paciente abre completa
  let r = await psiq.cl.post('/api/docs', { ...base0, patient_name: 'Outro Nome', cpf: '529.982.247-25', birth_date: '2001-01-01', conversation_id: cPsiq, kind: 'receita', items: [{ name: 'Sertralina', dose: '50 mg', qty: '30 comprimidos', instructions: '1 comprimido pela manhã' }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const code = r.data.code;
  assert.match(code, /^AC-[A-Z2-9]{8}$/);
  const msgs = (await pt.get(`/api/chat/conversations/${cPsiq}/messages`)).data.items;
  assert.ok(msgs.some((m) => m.kind === 'doc' && m.body.startsWith(code)), 'o documento chega na conversa');
  const full = (await pt.get(`/api/docs/${code}`)).data;
  assert.equal(full.masked, false);
  assert.equal(full.data.cpf, CPF);
  assert.equal(full.data.patient_name, 'Rita Souza', 'o nome vem do cadastro, não do que o profissional digitar');
  assert.equal(full.data.birth_date, '1990-05-10', 'o nascimento vem do cadastro');
  assert.equal(full.data.professional.registry, 'CRM-SP 123456');
  assert.equal(full.data.items[0].name, 'Sertralina');
  assert.ok(full.qr.includes('<svg'), 'QR Code');
  assert.equal(full.signature, SIG, 'a assinatura vai junto');
  // Verificação pública (qualquer pessoa com o código): CPF mascarado, sem nascimento
  const pub = (await anon.get(`/api/docs/${code.toLowerCase()}`)).data;
  assert.equal(pub.masked, true);
  assert.equal(pub.data.cpf, '***.178.287-**');
  assert.equal(pub.data.birth_date, '');
  assert.equal(pub.revoked, false);
  const page = await fetch(`${base}/v/${code}`);
  assert.equal(page.status, 200);
  // Atestado do psicólogo e encaminhamento do psicanalista
  r = await psico.cl.post('/api/docs', { ...base0, conversation_id: cPsico, kind: 'atestado', cid: 'F41.1', cid_authorized: true });
  assert.equal(r.status, 201);
  assert.equal((await pt.get(`/api/docs/${r.data.code}`)).data.title, 'Atestado psicológico');
  r = await analista.cl.post('/api/docs', { ...base0, conversation_id: cAna, kind: 'encaminhamento', specialty: 'Psiquiatra', modality: 'online' });
  assert.equal(r.status, 201);
  // Apagar para todos a mensagem do documento: fica cancelado na verificação
  const docMsg = msgs.find((m) => m.kind === 'doc');
  await psiq.cl.post(`/api/chat/messages/${docMsg.id}/delete`, { for: 'everyone' });
  assert.equal((await anon.get(`/api/docs/${code}`)).data.revoked, true);
  // Outro profissional não emite na conversa dos outros
  assert.equal((await psico.cl.post('/api/docs', { ...base0, conversation_id: cPsiq, kind: 'atestado' })).status, 404);
  // Conta de teste: emite tudo, mas sai marcado como teste (sem validade)
  const { db } = require('../server/db');
  db.prepare('UPDATE professionals SET is_test = 1 WHERE id = ?').run(analista.id);
  assert.deepEqual(await kinds(analista, cAna), ['atestado', 'receita', 'encaminhamento'], 'conta de teste: tudo');
  r = await analista.cl.post('/api/docs', { ...base0, conversation_id: cAna, kind: 'receita', items: [{ name: 'Teste', instructions: '1 ao dia' }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const tdoc = (await anon.get(`/api/docs/${r.data.code}`)).data;
  assert.equal(tdoc.data.test, true, 'marcado como teste');
  db.prepare('UPDATE professionals SET is_test = 0 WHERE id = ?').run(analista.id);
});

test('paciente: nascimento obrigatório no cadastro (menor pode), não muda; região muda', async () => {
  const pt = client();
  const CPF = '714.602.380-01';
  const base1 = { name: 'Lia Menor Silva', cpf: CPF, state: 'SP', city: 'Campinas', password: '123456' };
  assert.equal((await pt.post('/api/auth/patient/register', base1)).status, 400, 'sem nascimento não cria');
  assert.equal((await pt.post('/api/auth/patient/register', { ...base1, birth_date: '2999-01-01' })).status, 400, 'data no futuro');
  assert.equal((await pt.post('/api/auth/patient/register', { ...base1, birth_date: '2013-02-30' })).status, 400, 'data que não existe');
  const kid = new Date(Date.now() - 10 * 365 * 864e5).toISOString().slice(0, 10);
  assert.equal((await pt.post('/api/auth/patient/register', { ...base1, birth_date: kid })).status, 201, 'menor de idade pode criar conta');
  let me = (await pt.get('/api/auth/me')).data.user;
  assert.equal(me.birth_date, kid);
  assert.equal((await pt.post('/api/patient/birth-date', { birth_date: '2000-01-01' })).status, 400, 'não muda depois');
  const r = await pt.put('/api/patient/profile', { display_name: 'Lia', state: 'RJ', city: 'Niterói', name: 'Outro Nome', cpf: '52998224725', birth_date: '2000-01-01' });
  assert.equal(r.status, 200);
  assert.equal(r.data.state, 'RJ');
  assert.equal(r.data.city, 'Niterói');
  assert.equal(r.data.name, 'Lia Menor Silva', 'nome do CPF não muda');
  assert.equal(r.data.birth_date, kid, 'nascimento não muda');
  me = (await pt.get('/api/auth/me')).data.user;
  assert.equal(me.cpf_masked, '***.602.380-**', 'CPF não muda');
});

test('bloqueio fica na lista: apagar a própria conta não libera; admin apagar libera', async () => {
  const { db } = require('../server/db');
  const CPF = '100.007.919-89';
  const pdata = { name: 'Bia Bloqueio', cpf: CPF, birth_date: '1990-01-01', state: 'SP', city: 'Campinas', password: '123456' };
  // paciente: cria, admin bloqueia, ela apaga a conta e cria de novo → nasce bloqueada
  let pt = client();
  assert.equal((await pt.post('/api/auth/patient/register', pdata)).status, 201);
  let id = db.prepare('SELECT id FROM patients WHERE cpf = ?').get('10000791989').id;
  assert.equal((await admin.post(`/api/admin/patients/${id}/status`, { status: 'bloqueado' })).status, 200);
  assert.equal((await pt.post('/api/patient/delete', { cpf: CPF })).status, 200, 'bloqueada consegue apagar a conta');
  pt = client();
  assert.equal((await pt.post('/api/auth/patient/register', pdata)).status, 201, 'consegue criar de novo…');
  assert.equal((await pt.get('/api/auth/me')).data.account.blocked, 'admin', '…mas já nasce bloqueada');
  id = db.prepare('SELECT id FROM patients WHERE cpf = ?').get('10000791989').id;
  // admin desbloqueia → libera
  await admin.post(`/api/admin/patients/${id}/status`, { status: 'ativo' });
  assert.ok(!(await pt.get('/api/auth/me')).data.account.blocked, 'desbloqueada pelo admin');
  // bloqueia de novo e o ADMIN apaga → pode criar de novo, sem bloqueio
  await admin.post(`/api/admin/patients/${id}/status`, { status: 'bloqueado' });
  assert.equal((await admin.post(`/api/admin/patients/${id}/delete`)).status, 200);
  pt = client();
  assert.equal((await pt.post('/api/auth/patient/register', pdata)).status, 201);
  assert.ok(!(await pt.get('/api/auth/me')).data.account.blocked, 'admin apagou: conta nova normal');

  // profissional: cadastro em análise → login avisa com o WhatsApp de atendimento
  const PRO2 = { name: 'Caio Bloqueio', profession: 'Psicanalista', registry: '', email: 'caio.bloq@example.com', phone: '(11) 97777-1234', state: 'SP', city: 'Campinas', password: 'segredo1' };
  let r = await anon.form('/api/auth/professional/register', PRO2);
  assert.equal(r.status, 201);
  assert.equal(r.data.blocked, false);
  assert.ok(r.data.support, 'cadastro devolve o WhatsApp de atendimento');
  const code = r.data.code;
  let pro = client();
  r = await pro.post('/api/auth/professional/login', { login: code, password: 'x' });
  assert.equal(r.status, 403);
  assert.equal(r.data.pending, true);
  assert.ok(r.data.support);
  const pid = db.prepare('SELECT id FROM professionals WHERE code = ?').get(code).id;
  // admin bloqueia; ele entra, apaga a conta e se cadastra de novo → nasce bloqueado
  await admin.post(`/api/admin/professionals/${pid}/status`, { status: 'bloqueado' });
  const pw = (await admin.post(`/api/admin/professionals/${pid}/reset-password`)).data.password;
  assert.equal((await pro.post('/api/auth/professional/login', { login: code, password: pw })).status, 200);
  assert.equal((await pro.post('/api/professional/delete', { code })).status, 200);
  r = await anon.form('/api/auth/professional/register', { ...PRO2, email: 'outro.email@example.com' });
  assert.equal(r.status, 201);
  assert.equal(r.data.blocked, true, 'mesmo WhatsApp de conta bloqueada: nasce bloqueado');
  assert.equal(db.prepare('SELECT status FROM professionals WHERE code = ?').get(r.data.code).status, 'bloqueado');
  // admin apaga essa conta → pode se cadastrar de novo (e volta para a análise)
  const pid2 = db.prepare('SELECT id FROM professionals WHERE code = ?').get(r.data.code).id;
  await admin.post(`/api/admin/professionals/${pid2}/delete`);
  r = await anon.form('/api/auth/professional/register', { ...PRO2, email: 'terceiro@example.com' });
  assert.equal(r.data.blocked, false);
  assert.equal(db.prepare('SELECT status FROM professionals WHERE code = ?').get(r.data.code).status, 'pendente', 'volta para a aprovação');
  for (const e of ['terceiro@example.com']) db.prepare("DELETE FROM professionals WHERE email = ?").run(e);
});

test('profissional muda WhatsApp e e-mail; profissão, registro e código não', async () => {
  const c = await admin.post('/api/admin/professionals', { name: 'Lia Contato', profession: 'Psicólogo(a)', registry: 'CRP 06/77777', email: 'lia.contato@example.com', phone: '11911110000', state: 'SP', city: 'Campinas' });
  const p = client();
  await p.post('/api/auth/professional/login', { login: c.data.code, password: c.data.password });
  const me = (await p.get('/api/professional/me')).data;
  const body = { name: 'Lia Contato', phone: '11922223333', email: 'NOVO.lia@example.com', state: 'SP', city: 'Campinas', profession: 'Psiquiatra', registry: 'CRM-SP 1', code: 'ABC' };
  const r = await p.put('/api/professional/profile', body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = (await p.get('/api/professional/me')).data;
  assert.equal(after.phone, '11922223333');
  assert.equal(after.email, 'novo.lia@example.com');
  assert.equal(after.profession, 'Psicólogo(a)', 'profissão não muda');
  assert.equal(after.registry, me.registry, 'registro não muda');
  assert.equal(after.code, c.data.code, 'código não muda');
  assert.equal((await p.put('/api/professional/profile', { ...body, email: 'joao@example.com' })).status, 409, 'e-mail de outra conta');
});

test('plano de saúde: o profissional liga/desliga e aparece no perfil (online também)', async () => {
  const c = await admin.post('/api/admin/professionals', { name: 'Rui Plano', profession: 'Psicólogo(a)', registry: 'CRP 06/66666', email: 'rui.plano@example.com', phone: '11933334444', state: 'SP', city: 'Campinas' });
  const p = client();
  await p.post('/api/auth/professional/login', { login: c.data.code, password: c.data.password });
  const base = { name: 'Rui Plano', phone: '11933334444', state: 'SP', city: 'Campinas' };
  let r = await p.put('/api/professional/profile', { ...base, accepts_insurance: true });
  assert.equal(r.data.accepts_insurance, true, 'aceita plano mesmo atendendo só online');
  assert.equal(r.data.has_clinic, false);
  assert.equal((await anon.get(`/api/professionals/${c.data.id}`)).data.accepts_insurance, true, 'visitante vê que aceita plano');
  r = await p.put('/api/professional/profile', { ...base, accepts_insurance: false });
  assert.equal(r.data.accepts_insurance, false);
});

test('admin não cadastra CRP/CRM inválido; profissão sem conselho entra sem registro', async () => {
  const base = { name: 'Nina Registro', email: 'nina.reg@example.com', phone: '11912121212', state: 'SP', city: 'Campinas' };
  assert.equal((await admin.post('/api/admin/professionals', { ...base, profession: 'Psicólogo(a)', registry: 'X-1' })).status, 400, 'CRP inválido');
  assert.equal((await admin.post('/api/admin/professionals', { ...base, profession: 'Psicólogo(a)', registry: 'CRP 10/12346' })).status, 400, 'CRP de outro estado');
  assert.equal((await admin.post('/api/admin/professionals', { ...base, profession: 'Psiquiatra', registry: 'CRM-PA 12345' })).status, 400, 'CRM de outro estado');
  assert.equal((await admin.post('/api/admin/professionals', { ...base, profession: 'Psicólogo(a)', registry: '' })).status, 400, 'psicólogo sem CRP');
  const ok = await admin.post('/api/admin/professionals', { ...base, profession: 'Psicanalista', registry: '' });
  assert.equal(ok.status, 201, 'psicanalista sem registro');
  assert.ok(ok.data.password, 'o admin recebe a senha gerada');
});

test('conta apagada some de tudo: conversa, atendimentos, curtida, comentário, seguidor; volta só se escrever de novo', async () => {
  const { db } = require('../server/db');
  const c = await admin.post('/api/admin/professionals', { name: 'Olga Some', profession: 'Psicanalista', registry: '', email: 'olga.some@example.com', phone: '11915151515', state: 'SP', city: 'Campinas' });
  const pro = client();
  await pro.post('/api/auth/professional/login', { login: c.data.code, password: c.data.password });
  const fd = new FormData(); fd.append('photo', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'f.png'); fd.append('caption', 'oi');
  const post = await (await fetch(`${base}/api/social/posts`, { method: 'POST', body: fd, headers: { Cookie: pro.cookie } })).json();
  const CPF = '100.015.838-16';
  const reg = { name: 'Ugo Some', cpf: CPF, birth_date: '1990-01-01', state: 'SP', city: 'Campinas', password: '123456' };
  let pt = client();
  assert.equal((await pt.post('/api/auth/patient/register', reg)).status, 201);
  await pt.post(`/api/social/follow/${c.data.id}`);
  await pt.post(`/api/social/posts/${post.id}/like`);
  await pt.post(`/api/social/posts/${post.id}/comments`, { body: 'Muito bom' });
  const conv = (await pt.post('/api/chat/conversations', { professional_id: c.data.id })).data;
  await pt.post(`/api/chat/conversations/${conv.id}/messages`, { body: 'Olá' });
  await pro.post('/api/calls', { patient_label: 'Ugo Some', conversation_id: conv.id });
  assert.equal((await pro.get('/api/chat/conversations')).data.items.length, 1);
  // apaga a própria conta
  assert.equal((await pt.post('/api/patient/delete', { cpf: CPF })).status, 200);
  assert.equal((await pro.get('/api/chat/conversations')).data.items.length, 0, 'a conversa sumiu para o profissional');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM calls WHERE conversation_id = ?').get(conv.id).n, 0, 'atendimentos da conversa sumiram');
  const p2 = (await pro.get(`/api/social/posts/${post.id}`)).data;
  assert.equal(p2.likes, 0, 'curtida sumiu');
  assert.equal((await pro.get(`/api/social/posts/${post.id}/comments`)).data.items.length, 0, 'comentário sumiu');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM follows WHERE professional_id = ?').get(c.data.id).n, 0, 'deixou de seguir');
  assert.ok(!JSON.stringify((await pro.get('/api/social/notifications')).data).includes('Ugo'), 'nome não aparece nas notificações');
  // cria de novo: só aparece para o profissional se escrever de novo
  pt = client();
  assert.equal((await pt.post('/api/auth/patient/register', reg)).status, 201);
  assert.equal((await pro.get('/api/chat/conversations')).data.items.length, 0, 'não volta sozinho');
  const conv2 = (await pt.post('/api/chat/conversations', { professional_id: c.data.id })).data;
  await pt.post(`/api/chat/conversations/${conv2.id}/messages`, { body: 'Oi de novo' });
  const items = (await pro.get('/api/chat/conversations')).data.items;
  assert.equal(items.length, 1, 'escreveu de novo: aparece');
  assert.equal((await pro.get(`/api/chat/conversations/${items[0].id}/messages`)).data.items.length, 1, 'só a mensagem nova (as antigas não voltam)');
});

test('Acolia Brasil publica vídeo (reel) pelo admin e ele aparece nos Reels', async () => {
  const fd = new FormData();
  fd.append('video', new Blob([Buffer.from('fake-mp4-video')], { type: 'video/mp4' }), 'v.mp4');
  fd.append('poster', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'c.png');
  fd.append('caption', 'Bem-vindo à Acolia'); fd.append('duration', '30');
  let r = await fetch(`${base}/api/admin/official/reels`, { method: 'POST', body: fd, headers: { Cookie: admin.cookie } });
  const d = await r.json();
  assert.equal(r.status, 201, JSON.stringify(d));
  assert.equal(d.kind, 'reel');
  const long = new FormData();
  long.append('video', new Blob([Buffer.from('x')], { type: 'video/mp4' }), 'v.mp4');
  long.append('poster', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'c.png');
  long.append('duration', '300');
  r = await fetch(`${base}/api/admin/official/reels`, { method: 'POST', body: long, headers: { Cookie: admin.cookie } });
  assert.equal(r.status, 400, 'mais de 2 minutos não');
  const mid = new FormData();
  mid.append('video', new Blob([Buffer.from('x')], { type: 'video/mp4' }), 'v.mp4');
  mid.append('poster', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'c.png');
  mid.append('duration', '110');
  r = await fetch(`${base}/api/admin/official/reels`, { method: 'POST', body: mid, headers: { Cookie: admin.cookie } });
  assert.equal(r.status, 201, 'admin: até 2 minutos (1 min 50 s pode)');
  const pt = client();
  await pt.post('/api/auth/patient/register', { name: 'Vera Reels', cpf: '100.023.747-81', birth_date: '1990-01-01', state: 'SP', city: 'Campinas', password: '123456' });
  const reels = (await pt.get('/api/social/reels')).data.items;
  assert.ok(reels.some((x) => x.id === d.id), 'aparece nos Reels do paciente');
  assert.equal((await pt.post('/api/admin/official/reels')).status, 401, 'paciente não publica pelo admin');
  // envio em partes (vídeo grande pelo painel)
  const video = Buffer.alloc(9 * 1024 * 1024, 7);
  const s = await admin.post('/api/admin/official/uploads', { mime: 'video/mp4', size: video.length });
  assert.equal(s.status, 201, JSON.stringify(s.data));
  for (let off = 0; off < video.length; off += 4 * 1024 * 1024) {
    const part = video.subarray(off, off + 4 * 1024 * 1024);
    const pr = await fetch(`${base}/api/admin/official/uploads/${s.data.id}?offset=${off}`, { method: 'PUT', body: part, headers: { Cookie: admin.cookie, 'Content-Type': 'application/octet-stream' } });
    assert.equal(pr.status, 200, await pr.text());
  }
  const fin = new FormData();
  fin.append('photo', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'c.png');
  fin.append('caption', 'Vídeo grande'); fin.append('duration', '100');
  r = await fetch(`${base}/api/admin/official/uploads/${s.data.id}/finish`, { method: 'POST', body: fin, headers: { Cookie: admin.cookie } });
  const big = await r.json();
  assert.equal(r.status, 201, JSON.stringify(big));
  assert.equal(big.kind, 'reel');
  assert.ok((await pt.get('/api/social/reels')).data.items.some((x) => x.id === big.id), 'vídeo em partes aparece nos Reels');
});

test('publicação de texto: profissional e Acolia Brasil, 4 fontes, até 3.000 caracteres; legenda até 1.700', async () => {
  const c = await admin.post('/api/admin/professionals', { name: 'Teo Texto', profession: 'Psicanalista', registry: '', email: 'teo.texto@example.com', phone: '11916161616', state: 'SP', city: 'Campinas' });
  const pro = client();
  await pro.post('/api/auth/professional/login', { login: c.data.code, password: c.data.password });
  const grande = 'x'.repeat(3001);
  let r = await pro.post('/api/social/texts', { text: grande, font: 'manuscrita' });
  assert.equal(r.status, 400, 'mais de 3.000 caracteres não');
  assert.match(r.data.error, /3\.000/);
  const longo = 'Reflexão do dia.\n' + 'Cuidar da mente é um ato diário. '.repeat(90); // ~2.900 caracteres
  assert.ok(longo.length <= 3000);
  r = await pro.post('/api/social/texts', { text: longo, font: 'manuscrita' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.kind, 'text');
  assert.equal(r.data.font, 'manuscrita');
  assert.equal(r.data.caption.length, longo.trim().length, 'texto inteiro, sem corte');
  assert.equal((await pro.post('/api/social/texts', { text: '  ', font: 'classica' })).status, 400, 'texto vazio não');
  r = await pro.post('/api/social/texts', { text: 'Oi', font: 'comic-sans' });
  assert.equal(r.data.font, 'padrao', 'fonte fora das 4 vira a padrão');
  // perfil conta textos e mostra na aba
  const prof = (await pro.get(`/api/professionals/${c.data.id}`)).data;
  assert.equal(prof.photos_count, 2, 'textos entram em Publicações (sem aba própria)');
  assert.equal(prof.texts_count, undefined);
  const list = (await pro.get(`/api/social/professionals/${c.data.id}/posts?kind=photo`)).data;
  assert.equal(list.items.length, 2);
  assert.ok(list.items.every((x) => x.kind === 'text'));
  assert.ok(list.items[0].caption.length <= 300, 'na grade vai só o começo');
  // texto também vai para o story (pela estrela)
  assert.equal((await pro.post(`/api/social/posts/${r.data.id}/story`)).status, 201);
  // paciente não publica texto
  const pt = client();
  await pt.post('/api/auth/patient/register', { name: 'Iara Texto', cpf: '100.031.656-47', birth_date: '1990-01-01', state: 'SP', city: 'Campinas', password: '123456' });
  assert.equal((await pt.post('/api/social/texts', { text: 'x' })).status, 403);
  // Acolia Brasil também publica texto
  r = await admin.post('/api/admin/official/texts', { text: 'Bem-vindos! 💚', font: 'destaque' });
  assert.equal(r.status, 201);
  assert.equal(r.data.kind, 'text');
  // legenda de foto: até 1.700 caracteres
  const fd = new FormData();
  fd.append('photo', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'f.png');
  fd.append('caption', 'x'.repeat(5000));
  const post = await (await fetch(`${base}/api/social/posts`, { method: 'POST', body: fd, headers: { Cookie: pro.cookie } })).json();
  assert.equal(post.caption.length, 1700, 'legenda fica em 1.700');
});

test('feed: novidade primeiro (a mais nova no topo); as já vistas vêm misturadas e a lista não repete nem pula', async () => {
  const c = await admin.post('/api/admin/professionals', { name: 'Fabi Feed', profession: 'Psicanalista', registry: '', email: 'fabi.feed@example.com', phone: '11917171717', state: 'SP', city: 'Campinas' });
  const pro = client();
  await pro.post('/api/auth/professional/login', { login: c.data.code, password: c.data.password });
  const ids = [];
  for (let i = 0; i < 30; i++) ids.push((await pro.post('/api/social/texts', { text: `Texto ${i}` })).data.id);
  const pt = client();
  const cpf = (() => { // CPF válido novo
    const d = [3, 1, 4, 1, 5, 9, 2, 6, 5];
    const dv = (arr) => { const s = arr.reduce((a, n, i) => a + n * (arr.length + 1 - i), 0); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
    d.push(dv(d)); d.push(dv(d)); return d.join('');
  })();
  assert.equal((await pt.post('/api/auth/patient/register', { name: 'Gil Feed', cpf, birth_date: '1990-01-01', state: 'SP', city: 'Campinas', password: '123456' })).status, 201);
  await pt.post(`/api/social/follow/${c.data.id}`);
  const mine = (items) => items.filter((p) => !p.suggested && p.author.id === c.data.id).map((p) => p.id);
  // tudo novo: a mais nova primeiro
  let d = (await pt.get('/api/social/feed')).data;
  assert.equal(mine(d.items)[0], ids[29], 'a última publicada aparece primeiro');
  // viu tudo -> a ordem vira uma mistura (não é mais do mais novo para o mais velho)
  await pt.post('/api/social/seen', { ids });
  const all = async (seed) => {
    const got = []; let offset = 0; let snap = 0; let more = true;
    while (more) {
      const r = (await pt.get(`/api/social/feed?offset=${offset}&seed=${seed}&snap=${snap}`)).data;
      got.push(...mine(r.items)); offset += r.main_count; snap = r.snap; more = r.has_more && r.main_count > 0;
    }
    return got;
  };
  const a = await all(111), b = await all(222);
  assert.equal(new Set(a).size, 30, 'mostra as 30, sem repetir');
  assert.notDeepEqual(a, [...ids].reverse(), 'já vistas não ficam na ordem de sempre');
  assert.notDeepEqual(a, b, 'cada vez que abre, outra mistura');
  // publicação nova volta para o topo
  const novo = (await pro.post('/api/social/texts', { text: 'Novidade' })).data.id;
  d = (await pt.get('/api/social/feed')).data;
  assert.equal(mine(d.items)[0], novo, 'novidade no topo');
  // rolando: o que foi visto no meio do caminho não faz a lista pular itens
  const r1 = (await pt.get('/api/social/feed?offset=0&seed=5')).data;
  await pt.post('/api/social/seen', { ids: mine(r1.items) });
  const r2 = (await pt.get(`/api/social/feed?offset=${r1.main_count}&seed=5&snap=${r1.snap}`)).data;
  const r3 = (await pt.get(`/api/social/feed?offset=${r1.main_count + r2.main_count}&seed=5&snap=${r1.snap}`)).data;
  const seq = [...mine(r1.items), ...mine(r2.items), ...mine(r3.items)];
  assert.equal(new Set(seq).size, seq.length, 'sem repetir');
  assert.equal(seq.length, 31, 'todas as 31 apareceram');
});

test('cadastro do profissional: escolhe o plano mensal de R$ 30 (plano inválido não passa) e o admin vê o plano', async () => {
  const mk = (plan, email, phone) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ name: 'Paulo Plano Silva', profession: 'Psicanalista', email, phone, state: 'SP', city: 'Campinas', specialties: '["Luto"]' })) fd.append(k, v);
    if (plan) fd.append('plan', plan);
    return fetch(`${base}/api/auth/professional/register`, { method: 'POST', body: fd });
  };
  let r = await mk('ouro-999', 'plano.x@example.com', '11918181818');
  assert.equal(r.status, 400, 'plano que não existe');
  assert.match((await r.json()).error, /plano/i);
  r = await mk('mensal-30', 'plano.ok@example.com', '11918181819');
  assert.equal(r.status, 201);
  const { code } = await r.json();
  const list = (await admin.get('/api/admin/professionals?status=pendente')).data;
  const it = (list.items || list).find((x) => x.code === code);
  const det = (await admin.get(`/api/admin/professionals/${it.id}`)).data;
  assert.match(det.plan, /R\$ 30/);
  await admin.post(`/api/admin/professionals/${it.id}/delete`);
});

test('mensagem a partir de um post: o paciente envia a publicação só para quem publicou; profissional não envia post', async () => {
  const mkPro = async (name, email, phone) => {
    const c = await admin.post('/api/admin/professionals', { name, profession: 'Psicanalista', registry: '', email, phone, state: 'SP', city: 'Campinas' });
    const cl = client(); await cl.post('/api/auth/professional/login', { login: c.data.code, password: c.data.password });
    return { id: c.data.id, cl };
  };
  const A = await mkPro('Ana Post Lima', 'ana.post@example.com', '11919191911');
  const B = await mkPro('Beto Post Reis', 'beto.post@example.com', '11919191912');
  const pa = (await A.cl.post('/api/social/texts', { text: 'Reflexão da Ana', font: 'classica' })).data;
  const pb = (await B.cl.post('/api/social/texts', { text: 'Reflexão do Beto' })).data;
  const pt = client();
  const cpf = (() => { const d = [2, 7, 1, 8, 2, 8, 1, 8, 3]; const dv = (a) => { const s = a.reduce((x, n, i) => x + n * (a.length + 1 - i), 0); const r = (s * 10) % 11; return r === 10 ? 0 : r; }; d.push(dv(d)); d.push(dv(d)); return d.join(''); })();
  assert.equal((await pt.post('/api/auth/patient/register', { name: 'Lia Post Souza', cpf, birth_date: '1992-02-02', state: 'SP', city: 'Campinas', password: '123456' })).status, 201);
  const conv = (await pt.post('/api/chat/conversations', { professional_id: A.id })).data;
  // publicação da própria Ana: vai, com foto/texto, nome e começo da legenda
  let r = await pt.post(`/api/chat/conversations/${conv.id}/messages`, { kind: 'post', post_id: pa.id });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.kind, 'post');
  assert.equal(r.data.post.id, pa.id);
  assert.equal(r.data.post.author, 'Ana Post Lima');
  assert.match(r.data.post.caption, /Reflexão da Ana/);
  // publicação de outro profissional para a Ana: não
  r = await pt.post(`/api/chat/conversations/${conv.id}/messages`, { kind: 'post', post_id: pb.id });
  assert.equal(r.status, 403);
  // publicação que não existe
  assert.equal((await pt.post(`/api/chat/conversations/${conv.id}/messages`, { kind: 'post', post_id: 999999 })).status, 404);
  // tocar de novo no mesmo post não repete
  r = await pt.post(`/api/chat/conversations/${conv.id}/messages`, { kind: 'post', post_id: pa.id });
  assert.equal(r.data.already, true);
  assert.equal((await pt.get(`/api/chat/conversations/${conv.id}/messages`)).data.items.filter((m) => m.kind === 'post').length, 1);
  // a Ana vê o cartão da publicação e não pode mandar post
  const msgs = (await A.cl.get(`/api/chat/conversations/${conv.id}/messages`)).data.items;
  assert.equal(msgs.find((m) => m.kind === 'post').post.id, pa.id);
  assert.equal((await A.cl.post(`/api/chat/conversations/${conv.id}/messages`, { kind: 'post', post_id: pa.id })).status, 403, 'profissional não envia post');
  // profissional não conversa com profissional
  assert.ok((await B.cl.post('/api/chat/conversations', { professional_id: A.id })).status >= 400);
  // publicação apagada depois: a mensagem mostra "indisponível"
  await A.cl.del(`/api/social/posts/${pa.id}`);
  const after = (await pt.get(`/api/chat/conversations/${conv.id}/messages`)).data.items.find((m) => m.kind === 'post');
  assert.equal(after.post, null);
});

test('meus pacientes: só quem fez consulta com o profissional; filtro por nome ou CPF; PDF e planilha', async () => {
  const { db } = require('../server/db');
  const mkPro = async (name, email, phone) => {
    const c = await admin.post('/api/admin/professionals', { name, profession: 'Psicanalista', registry: '', email, phone, state: 'SP', city: 'Campinas' });
    const cl = client(); await cl.post('/api/auth/professional/login', { login: c.data.code, password: c.data.password });
    return { id: c.data.id, cl };
  };
  const cpfOf = (d) => { const dv = (a) => { const s = a.reduce((x, n, i) => x + n * (a.length + 1 - i), 0); const r = (s * 10) % 11; return r === 10 ? 0 : r; }; d.push(dv(d)); d.push(dv(d)); return d.join(''); };
  const mkPat = async (name, digits) => {
    const cl = client(); const cpf = cpfOf(digits);
    const r = await cl.post('/api/auth/patient/register', { name, cpf, birth_date: '1990-04-15', state: 'SP', city: 'Campinas', password: '123456' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return { cl, cpf };
  };
  const A = await mkPro('Olga Lista Prado', 'olga.lista@example.com', '11920202021');
  const B = await mkPro('Caio Lista Melo', 'caio.lista@example.com', '11920202022');
  const P1 = await mkPat('Renata Consulta Dias', [6, 0, 2, 1, 7, 3, 9, 4, 1]);
  const P2 = await mkPat('Tiago Semconsulta Lopes', [7, 1, 3, 2, 8, 4, 0, 5, 2]);
  const conv = async (P, pro) => {
    const c = (await P.cl.post('/api/chat/conversations', { professional_id: pro.id })).data;
    await P.cl.post(`/api/chat/conversations/${c.id}/messages`, { body: 'Olá' });
    return c.id;
  };
  const call = async (pro, convId, label, started) => {
    const r = await pro.cl.post('/api/calls', { conversation_id: convId, patient_label: label });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    if (started) db.prepare("UPDATE calls SET started_at = datetime('now') WHERE id = ?").run(r.data.id);
    await pro.cl.post(`/api/calls/${r.data.id}/end`);
  };
  await call(A, await conv(P1, A), 'Renata', true);
  await call(A, await conv(P2, A), 'Tiago', false); // código gerado, mas a consulta não aconteceu
  await call(B, await conv(P2, B), 'Tiago', true);   // consulta com outro profissional
  let list = (await A.cl.get('/api/professional/patients')).data.items;
  assert.deepEqual(list.map((p) => p.name), ['Renata Consulta Dias'], 'só quem fez consulta com ela');
  assert.equal(list[0].consultas, 1);
  assert.equal(list[0].birth_date, '15/04/1990');
  assert.match(list[0].cpf, /^\d{3}\.\d{3}\.\d{3}-\d{2}$/);
  assert.equal((await B.cl.get('/api/professional/patients')).data.items[0].name, 'Tiago Semconsulta Lopes', 'cada um vê só os seus');
  // filtro por nome (sem acento/maiúscula) e por CPF (com ou sem pontos)
  assert.equal((await A.cl.get('/api/professional/patients?q=renata dias')).data.items.length, 0, 'nome precisa estar na ordem');
  assert.equal((await A.cl.get('/api/professional/patients?q=RENATA CONSULTA')).data.items.length, 1);
  assert.equal((await A.cl.get(`/api/professional/patients?q=${P1.cpf.slice(0, 6)}`)).data.items.length, 1);
  assert.equal((await A.cl.get(`/api/professional/patients?q=${encodeURIComponent(list[0].cpf)}`)).data.items.length, 1);
  assert.equal((await A.cl.get('/api/professional/patients?q=fulano')).data.items.length, 0);
  // planilha e PDF
  let r = await fetch(`${base}/api/professional/patients.csv`, { headers: { Cookie: A.cl.cookie } });
  const csvText = await r.text();
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.ok(csvText.includes('Renata Consulta Dias') && !csvText.includes('Tiago'));
  // o PDF é montado na hora e enviado: nenhum arquivo novo fica gravado no servidor
  const listFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).sort() : []);
  const dataDir = require('../server/paths').DATA_DIR;
  const before = listFiles(dataDir).filter((f) => !/acolia\.db/.test(f));
  r = await fetch(`${base}/api/professional/patients.pdf?q=renata`, { headers: { Cookie: A.cl.cookie } });
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  const pdf = Buffer.from(await r.arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.toString('latin1').includes('Renata Consulta Dias'));
  assert.ok(pdf.toString('latin1').includes('Total: 1 paciente'), 'total no fim do PDF');
  assert.deepEqual(listFiles(dataDir).filter((f) => !/acolia\.db/.test(f)), before, 'PDF não fica salvo no servidor');
  // período: consultas em datas diferentes (gravadas em UTC; o filtro usa o horário de Brasília)
  const c1 = (await P1.cl.get('/api/chat/conversations')).data.items.find((x) => x.peer.id === A.id).id;
  const mkAt = async (utc) => {
    const r = await A.cl.post('/api/calls', { conversation_id: c1, patient_label: 'Renata' });
    db.prepare('UPDATE calls SET started_at = ? WHERE id = ?').run(utc, r.data.id);
    await A.cl.post(`/api/calls/${r.data.id}/end`);
  };
  await mkAt('2026-01-10 15:00:00');
  await mkAt('2026-02-01 02:30:00'); // 31/01 às 23:30 em Brasília
  let d = (await A.cl.get('/api/professional/patients?from=2026-01-01&to=2026-01-31')).data;
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].consultas, 2, 'as duas de janeiro (uma é 31/01 à noite em Brasília)');
  assert.equal(d.items[0].ultima, '31/01/2026');
  assert.deepEqual(d.totals, { patients: 1, consultations: 2 });
  assert.equal(d.period, 'de 01/01/2026 a 31/01/2026');
  d = (await A.cl.get('/api/professional/patients?from=2026-02-01&to=2026-02-28')).data;
  assert.equal(d.items.length, 0, 'fevereiro sem consultas');
  d = (await A.cl.get('/api/professional/patients')).data;
  assert.equal(d.totals.consultations, 3, 'tudo: 3 consultas');
  r = await fetch(`${base}/api/professional/patients.csv?from=2026-01-01&to=2026-01-31`, { headers: { Cookie: A.cl.cookie } });
  const csvJan = await r.text();
  assert.ok(csvJan.includes('"Total de consultas";"2"') && csvJan.includes('de 01/01/2026 a 31/01/2026'));
  // paciente não acessa
  assert.ok((await P1.cl.get('/api/professional/patients')).status >= 401, 'paciente não acessa');
});

// Por último: apaga tudo (é o que acontece uma vez só no início oficial da plataforma)
test('especialidades: pelo menos uma no cadastro e no perfil, sem máximo, filtro e busca', async () => {
  const { ALL } = require('../server/specialties');
  assert.ok(ALL.length > 200, 'lista grande de especialidades');
  const cfg = (await client().get('/api/config')).data;
  assert.ok(cfg.specialties.length >= 4 && cfg.specialties.every((g) => g.name && g.items.length));
  // Cadastro pelo site: sem especialidade não passa
  const anon = client();
  const base0 = { name: 'Nara Esp Lima', profession: 'Psicanalista', email: 'nara.esp@example.com', phone: '11917171717', state: 'SP', city: 'Campinas', plan: 'mensal-30' };
  let r = await anon.form('/api/auth/professional/register', { ...base0, specialties: '[]' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /pelo menos uma especialidade/);
  r = await anon.form('/api/auth/professional/register', { ...base0, specialties: JSON.stringify(['Inventada que não existe']) });
  assert.equal(r.status, 400, 'só vale especialidade da lista');
  // Admin também exige; guarda na ordem escolhida, sem repetir, com o nome certinho da lista
  r = await admin.post('/api/admin/professionals', { name: 'Otto Esp Braga', profession: 'Psicólogo(a)', registry: 'CRP 06/30123', email: 'otto.esp@example.com', phone: '11916161616', state: 'SP', city: 'Campinas', specialties: [] });
  assert.equal(r.status, 400);
  const many = ['tea (transtorno do espectro autista)', 'Crianças', 'Adultos', 'Casais', 'Terapia cognitivo-comportamental (TCC)', 'Crianças'];
  r = await admin.post('/api/admin/professionals', { name: 'Otto Esp Braga', profession: 'Psicólogo(a)', registry: 'CRP 06/30123', email: 'otto.esp@example.com', phone: '11916161616', state: 'SP', city: 'Campinas', specialties: many });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const otto = client();
  await otto.post('/api/auth/professional/login', { login: r.data.code, password: r.data.password });
  let me = (await otto.get('/api/professional/me')).data;
  assert.equal(me.specialties, 'TEA (transtorno do espectro autista), Crianças, Adultos, Casais, Terapia cognitivo-comportamental (TCC)');
  // Perfil: acrescenta e tira à vontade, mas não pode ficar sem nenhuma; profissão não muda
  const prof = { name: 'Otto Esp Braga', phone: '11916161616', state: 'SP', city: 'Campinas', bio: '', price: '' };
  r = await otto.put('/api/professional/profile', { ...prof, specialties: [] });
  assert.equal(r.status, 400);
  r = await otto.put('/api/professional/profile', { ...prof, profession: 'Psiquiatra', specialties: [...ALL.slice(0, 40), 'TEA (transtorno do espectro autista)'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.profession, 'Psicólogo(a)');
  assert.equal(r.data.specialties.split(', ').length, 41, 'sem limite máximo');
  r = await otto.put('/api/professional/profile', { ...prof, specialties: ['TEA (transtorno do espectro autista)', 'Crianças', 'Casais', 'Luto'] });
  assert.equal(r.data.specialties, 'TEA (transtorno do espectro autista), Crianças, Casais, Luto');
  // Filtro: mostra quem tem todas as escolhidas; a busca por texto também acha
  const pac = client();
  const ids = async (qs) => (await pac.get(`/api/professionals?state=todos&${qs}`)).data.items.map((p) => p.id);
  const ottoId = me.id;
  assert.ok((await ids(`specialties=${encodeURIComponent('Crianças|Casais')}`)).includes(ottoId));
  assert.ok(!(await ids(`specialties=${encodeURIComponent('Crianças|Idosos')}`)).includes(ottoId), 'precisa ter todas');
  assert.ok((await ids('q=autista')).includes(ottoId), 'busca pelo texto acha');
  assert.ok((await ids('q=casais')).includes(ottoId));
  // Visitante: só as 2 primeiras + o total (o "+N" pede conta); "Sobre" longo vem resumido
  const longBio = 'Atendo crianças e famílias. '.repeat(30);
  await otto.put('/api/professional/profile', { ...prof, bio: longBio, specialties: ['TEA (transtorno do espectro autista)', 'Crianças', 'Casais', 'Luto'] });
  const vis = (await client().get(`/api/professionals/${ottoId}`)).data;
  assert.equal(vis.specialties, 'TEA (transtorno do espectro autista), Crianças');
  assert.equal(vis.specialties_total, 4);
  assert.equal(vis.bio_more, true);
  assert.ok(vis.bio.length < 280 && vis.bio.endsWith('…'), 'texto inteiro não sai para o visitante');
  const logged = (await otto.get(`/api/professionals/${ottoId}`)).data; // com conta vê tudo
  assert.equal(logged.specialties.split(', ').length, 4);
  assert.equal(logged.bio, longBio.trim());
  // Reels: no perfil o visitante não vê nenhum; pelo link compartilhado (WhatsApp etc.) vê normalmente
  const { db } = require('../server/db');
  const reelId = Number(db.prepare("INSERT INTO posts (professional_id, image, caption, kind, video) VALUES (?, '/uploads/capa.jpg', 'v', 'reel', '/uploads/v.mp4')").run(ottoId).lastInsertRowid);
  db.prepare("INSERT INTO posts (professional_id, image, caption, kind, video) VALUES (?, '/uploads/capa.jpg', 'v', 'reel', '/uploads/v2.mp4')").run(ottoId);
  const vis2 = (await client().get(`/api/professionals/${ottoId}`)).data;
  assert.deepEqual(vis2.reels, []);
  assert.equal(vis2.reels_hidden, 2);
  const vr = (await client().get(`/api/social/professionals/${ottoId}/posts?kind=reel`)).data;
  assert.equal(vr.items.length, 0);
  const shared = (await client().get(`/api/social/posts/${reelId}`)).data;
  assert.equal(shared.locked, true);
  assert.equal(shared.video, '/uploads/v.mp4', 'link compartilhado toca o vídeo para qualquer pessoa');
});

test('versão 1.1.2: dono da publicação manda mensagem para o paciente que comentou; perfis de profissionais nos comentários', async () => {
  const mkPro = async (name, email, phone, crp) => {
    const r = await admin.post('/api/admin/professionals', { name, profession: 'Psicólogo(a)', registry: crp, email, phone, state: 'SP', city: 'Campinas' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const cl = client();
    await cl.post('/api/auth/professional/login', { login: r.data.code, password: r.data.password });
    return { cl, id: r.data.id };
  };
  const A = await mkPro('Alice Dono Prado', 'alice.dono@example.com', '11915151515', 'CRP 06/40111');
  const B = await mkPro('Bruno Outro Prado', 'bruno.outro@example.com', '11914141414', 'CRP 06/40222');
  const pt = client();
  const reg = await pt.post('/api/auth/patient/register', { name: 'Clara Comenta Dias', cpf: '274.658.193-00', state: 'SP', city: 'Campinas', birth_date: '1992-03-04', password: '123456' });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  const post = (await A.cl.post('/api/social/texts', { text: 'Cuidar de si é importante.', font: 'padrao' })).data;
  const cPat = (await pt.post(`/api/social/posts/${post.id}/comments`, { body: 'Preciso de ajuda com ansiedade' })).data;
  const cB = (await B.cl.post(`/api/social/posts/${post.id}/comments`, { body: 'Ótimo texto!' })).data;
  const cA = (await A.cl.post(`/api/social/posts/${post.id}/comments`, { body: 'Obrigada!' })).data;
  const view = async (cl) => Object.fromEntries((await cl.get(`/api/social/posts/${post.id}/comments`)).data.items.map((c) => [c.id, c]));
  // Dono (A): pode mandar mensagem para o paciente e abrir o perfil de B
  let v = await view(A.cl);
  assert.equal(v[cPat.id].can_message, true);
  assert.equal(v[cB.id].can_open_profile, true);
  assert.equal(v[cB.id].can_message, false, 'profissional não manda mensagem para profissional');
  // Outro profissional (B): não toca no paciente, mas abre o perfil do dono
  v = await view(B.cl);
  assert.equal(v[cPat.id].can_message, false);
  assert.equal(v[cPat.id].can_open_profile, false);
  assert.equal(v[cA.id].can_open_profile, true);
  // Paciente: só toca no profissional que postou
  v = await view(pt);
  assert.equal(v[cA.id].can_open_profile, true, 'dono da publicação');
  assert.equal(v[cB.id].can_open_profile, false, 'outro profissional que comentou: não');
  // Abrir a conversa: só o dono, só com paciente que comentou
  assert.equal((await B.cl.post('/api/chat/conversations', { comment_id: cPat.id })).status, 403, 'outro profissional não');
  assert.equal((await A.cl.post('/api/chat/conversations', { comment_id: cB.id })).status, 403, 'comentário de profissional não');
  assert.equal((await A.cl.post('/api/chat/conversations', { professional_id: B.id })).status, 403);
  const conv = (await A.cl.post('/api/chat/conversations', { comment_id: cPat.id })).data;
  assert.ok(conv.id);
  assert.ok((await A.cl.get('/api/chat/conversations')).data.items.some((c) => c.id === conv.id), 'aparece para o profissional');
  assert.ok(!(await pt.get('/api/chat/conversations')).data.items.some((c) => c.id === conv.id), 'paciente ainda não vê (sem mensagem)');
  assert.equal((await pt.get(`/api/chat/conversations/${conv.id}`)).status, 404);
  let r = await A.cl.post(`/api/chat/conversations/${conv.id}/messages`, { body: 'Olá, Clara! Vi seu comentário. Posso te ajudar.' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const list = (await pt.get('/api/chat/conversations')).data.items;
  assert.ok(list.some((c) => c.id === conv.id && c.unread === 1), 'depois da mensagem o paciente vê, com 1 nova');
  r = await pt.post(`/api/chat/conversations/${conv.id}/messages`, { body: 'Oi! Obrigada.' });
  assert.equal(r.status, 201);
  // Abrir de novo pelo comentário volta para a mesma conversa
  assert.equal((await A.cl.post('/api/chat/conversations', { comment_id: cPat.id })).data.id, conv.id);
});

test('versão 1.1.3: secretária do profissional — login gerado, responde no lugar dele, com limites', async () => {
  const r0 = await admin.post('/api/admin/professionals', { name: 'Sara Secretaria Lima', profession: 'Psicólogo(a)', registry: 'CRP 06/40333', email: 'sara.sec@example.com', phone: '11913131313', state: 'SP', city: 'Campinas' });
  assert.equal(r0.status, 201, JSON.stringify(r0.data));
  const pro = client();
  await pro.post('/api/auth/professional/login', { login: r0.data.code, password: r0.data.password });
  // Cria: login e senha aleatórios, uma por profissional
  let r = await pro.post('/api/professional/secretary');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const { login, password } = r.data;
  assert.match(login, /^secretaria\.[a-z0-9]{6}$/);
  assert.ok(password.length >= 10);
  assert.equal(r.data.secretary.login, login, 'já volta com a secretária criada');
  assert.equal((await pro.post('/api/professional/secretary')).status, 409, 'só uma secretária');
  assert.equal((await pro.get('/api/professional/secretary')).data.secretary.login, login);
  // Entra no mesmo lugar do profissional
  const sec = client();
  assert.equal((await sec.post('/api/auth/professional/login', { login, password: 'errada123' })).status, 401);
  r = await sec.post('/api/auth/professional/login', { login: login.toUpperCase(), password });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const me = (await sec.get('/api/auth/me')).data;
  assert.equal(me.role, 'professional');
  assert.equal(me.user.id, r0.data.id);
  assert.ok(me.secretary && !me.user.code, 'secretária não vê o código único');
  assert.equal((await sec.get('/api/professional/me')).data.code, undefined);
  // Paciente escreve; a secretária responde; o profissional vê o selo, o paciente não
  const pt = client();
  assert.equal((await pt.post('/api/auth/patient/register', { name: 'Paula Paciente Rocha', cpf: '862.883.667-57', state: 'SP', city: 'Campinas', birth_date: '1990-01-02', password: '123456' })).status, 201);
  const conv = (await pt.post('/api/chat/conversations', { professional_id: r0.data.id })).data;
  await pt.post(`/api/chat/conversations/${conv.id}/messages`, { body: 'Oi, tem horário?' });
  assert.ok((await sec.get('/api/chat/conversations')).data.items.some((c) => c.id === conv.id), 'secretária vê as conversas dele');
  r = await sec.post(`/api/chat/conversations/${conv.id}/messages`, { body: 'Olá! Sou a secretária, vou verificar.' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.sender_role, 'professional');
  const proMsgs = (await pro.get(`/api/chat/conversations/${conv.id}/messages`)).data.items;
  assert.ok(proMsgs.at(-1).secretary_id, 'profissional vê que foi a secretária');
  const patMsgs = (await pt.get(`/api/chat/conversations/${conv.id}/messages`)).data.items;
  assert.equal(patMsgs.at(-1).body, 'Olá! Sou a secretária, vou verificar.');
  assert.equal(patMsgs.at(-1).secretary_id, undefined, 'paciente não vê diferença');
  // Pode: publicar e ver a agenda (sem a chave Pix)
  assert.equal((await sec.post('/api/social/texts', { text: 'Aviso do consultório.', font: 'padrao' })).status, 201);
  r = await sec.get('/api/agenda/settings');
  assert.equal(r.status, 200);
  assert.equal(r.data.pix_key, '');
  // Não pode: perfil, senha, conta, secretária, Asaas, chave Pix, chamadas
  const pf = { name: 'Outro Nome Qualquer', phone: '11913131313', state: 'SP', city: 'Campinas', bio: '', specialties: ['Adultos'], price: '120' };
  // Perfil: muda redes sociais, plano de saúde, localização e clínica; nome, contato, especialidades, "Sobre" e valor ficam
  r = await sec.put('/api/professional/profile', { ...pf, bio: 'Texto novo', specialties: ['Adultos', 'Casais'], price: '999', email: 'outro@example.com',
    instagram: '@sara.consultorio', accepts_insurance: true, state: 'RJ', city: 'Niterói', has_clinic: true, clinic_name: 'Clínica Sara', clinic_address: 'Rua das Flores, 10' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = (await pro.get('/api/professional/me')).data;
  assert.equal(after.name, 'Sara Secretaria Lima');
  assert.equal(after.email, 'sara.sec@example.com');
  assert.equal(after.bio, '');
  assert.equal(after.price_cents, null);
  assert.equal(after.instagram, 'sara.consultorio');
  assert.equal(after.accepts_insurance, true);
  assert.equal(after.state, 'RJ');
  assert.equal(after.clinic_name, 'Clínica Sara');
  for (const [m, url, body] of [['post', '/api/professional/photo', {}], ['post', '/api/professional/password', { current: 'x', password: 'nova123' }],
    ['post', '/api/professional/delete', {}], ['post', '/api/professional/secretary', {}], ['del', '/api/professional/secretary'],
    ['put', '/api/agenda/asaas', { enabled: false }], ['post', '/api/agenda/asaas', { key: 'x' }], ['put', '/api/agenda/settings', { pix_key: 'minha@pix' }],
    ['post', '/api/calls', { patient_label: 'Teste' }]]) {
    const x = await sec[m](url, body);
    assert.equal(x.status, 403, `${m} ${url} → ${x.status}`);
  }
  assert.equal((await pro.get('/api/professional/me')).data.name, 'Sara Secretaria Lima', 'perfil intacto');
  // Nova senha: a secretária sai na hora
  r = await pro.post('/api/professional/secretary/password');
  assert.equal(r.status, 200);
  assert.equal((await sec.get('/api/auth/me')).data.role, null, 'sessão antiga caiu');
  assert.equal((await sec.post('/api/auth/professional/login', { login, password: r.data.password })).status, 200);
  // Apagar: sai de novo e o login deixa de existir
  assert.equal((await pro.del('/api/professional/secretary')).status, 200);
  assert.equal((await sec.get('/api/auth/me')).data.role, null);
  assert.equal((await sec.post('/api/auth/professional/login', { login, password: r.data.password })).status, 401);
});

test('início oficial: apaga contas e conteúdo uma vez só; admin e Acolia Brasil ficam; CPF fica livre', async () => {
  const { db } = require('../server/db');
  const R = require('../server/launchReset');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM patients').get().n > 0);
  db.prepare('DELETE FROM settings WHERE key = ?').run(R.KEY);
  const before = R.runOnce();
  assert.ok(before.patients > 0 && before.professionals > 0);
  for (const t of ['patients', 'posts', 'messages', 'conversations', 'stories', 'follows', 'documents']) {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, `${t} vazio`);
  }
  assert.deepEqual(db.prepare('SELECT status FROM professionals').all().map((r) => r.status), ['oficial']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admins').get().n, 1);
  assert.equal(R.runOnce(), null, 'não roda de novo');
  const again = client();
  assert.equal((await again.post('/api/auth/patient/register', { name: 'Maria Souza', cpf: CPF_A, birth_date: '1990-05-10', state: 'PA', city: 'Parauapebas', password: '123456' })).status, 201, 'CPF livre para criar de novo');
  const t = (await admin.post('/api/admin/test-accounts')).data;
  assert.equal(t.created.professional, true, 'admin reativa as contas de teste pelo botão');
});
