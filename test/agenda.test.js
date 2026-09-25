'use strict';
// Agenda, consultas e pagamento por Pix (automático pelo Asaas do profissional ou manual pelo chat).
// O Asaas é simulado por um servidor falso e o relógio é controlado pelo teste.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acolia-agenda-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'senha-admin-123';
process.env.TEST_ACCOUNTS = '0';
process.env.SKIP_OWNER_TEST = '1';
delete process.env.PAYMENT_SECRET;
process.env.ALLOW_ASAAS_SANDBOX = '1'; // o Asaas falso usa chave de teste

// ---------- Asaas falso ----------
const fake = { keys: new Set(['$aact_hmlg_chave_de_teste_valida_123456']), payments: new Map(), customers: [], seq: 0, failRefund: false, calls: [] };
const asaasServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    fake.calls.push(`${req.method} ${req.url}`);
    if (!fake.keys.has(req.headers.access_token)) return send(401, { errors: [{ description: 'Chave de API inválida' }] });
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const json = body ? JSON.parse(body) : {};
    if (p === '/finance/balance') return send(200, { balance: 0 });
    if (p === '/myAccount/commercialInfo') return send(200, { name: 'Consultório Teste' });
    if (p === '/customers' && req.method === 'GET') return send(200, { data: fake.customers.filter((c) => c.cpfCnpj === u.searchParams.get('cpfCnpj')) });
    if (p === '/customers' && req.method === 'POST') { const c = { id: `cus_${++fake.seq}`, ...json }; fake.customers.push(c); return send(200, c); }
    if (p === '/payments' && req.method === 'POST') {
      if (json.billingType !== 'PIX') return send(400, { errors: [{ description: 'só Pix' }] });
      const pay = { id: `pay_${++fake.seq}`, status: 'PENDING', ...json };
      fake.payments.set(pay.id, pay);
      return send(200, pay);
    }
    let m = /^\/payments\/([^/]+)(\/.*)?$/.exec(p);
    if (m) {
      const pay = fake.payments.get(m[1]);
      if (!pay) return send(404, { errors: [{ description: 'não encontrada' }] });
      if (m[2] === '/pixQrCode') return send(200, { encodedImage: 'iVBORw0KGgoAAAANSUhEUg==', payload: `00020126PIX-${pay.id}`, expirationDate: '2030-12-31' });
      if (m[2] === '/refund') {
        if (fake.failRefund) return send(400, { errors: [{ description: 'Saldo insuficiente' }] });
        pay.status = 'REFUNDED';
        return send(200, pay);
      }
      if (req.method === 'DELETE') { pay.status = 'DELETED'; return send(200, { deleted: true }); }
      return send(200, pay);
    }
    return send(404, { errors: [{ description: 'rota' }] });
  });
});

const { start } = require('../server');
const G = require('../server/agenda');
let server;
let base;
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
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { get: (u) => call('GET', u), post: (u, b = {}) => call('POST', u, b), put: (u, b = {}) => call('PUT', u, b), del: (u) => call('DELETE', u), get cookie() { return cookie; } };
}

// Relógio: segunda-feira, 07/01/2030, 09:00 em Brasília (12:00 UTC)
let clock = Date.parse('2030-01-07T12:00:00.000Z');
const advance = (minutes) => { clock += minutes * 60e3; };
const at = (date, hm) => new Date(Date.parse(`${date}T${hm}:00.000Z`) + 3 * 3600e3).toISOString(); // horário de Brasília → ISO

before(async () => {
  await new Promise((ok) => asaasServer.listen(0, ok));
  process.env.ASAAS_BASE_URL = `http://localhost:${asaasServer.address().port}`;
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
  asaasServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const admin = client();
const anon = client();
let P; // profissional (manual)
let Q; // profissional (automático, Asaas)
let ana; // paciente
let bia; // paciente

async function mkPro(name, email, phone, crp, extra = {}) {
  const r = await admin.post('/api/admin/professionals', { name, profession: 'Psicólogo(a)', registry: crp, email, phone, state: 'SP', city: 'Campinas', specialties: ['Ansiedade'] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const cl = client();
  await cl.post('/api/auth/professional/login', { login: r.data.code, password: r.data.password });
  const prof = await cl.put('/api/professional/profile', { name, phone, state: 'SP', city: 'Campinas', bio: '', price: '150', specialties: ['Ansiedade'], ...extra });
  assert.equal(prof.status, 200, JSON.stringify(prof.data));
  return { cl, id: r.data.id };
}
async function mkPatient(name, cpf) {
  const cl = client();
  const r = await cl.post('/api/auth/patient/register', { name, cpf, state: 'SP', city: 'Campinas', birth_date: '1990-01-01', password: 'senha123' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return cl;
}
const HOURS = [1, 2, 3, 4, 5].flatMap((dow) => [{ dow, start: '08:00', end: '12:00' }, { dow, start: '14:00', end: '18:00' }]);
const msgs = async (cl, convId) => (await cl.get(`/api/chat/conversations/${convId}/messages`)).data.items;

test('agenda: profissional abre a agenda e aparece o próximo dia disponível (até sem conta)', async () => {
  await admin.post('/api/auth/admin/login', { username: 'admin', password: 'senha-admin-123' });
  P = await mkPro('Paula Manual Souza', 'paula.manual@example.com', '11911112222', 'CRP 06/51001', { pix_key: 'paula@pix.com', session_minutes: 50 });
  ana = await mkPatient('Ana Lima Castro', '529.982.247-25');
  bia = await mkPatient('Bia Rocha Nunes', '111.444.777-35');
  let r = await anon.get(`/api/agenda/pro/${P.id}/next`);
  assert.equal(r.data.next, null, 'sem horários: nada aparece');
  r = await P.cl.put('/api/agenda/settings', { hours: [{ dow: 1, start: '12:00', end: '08:00' }] });
  assert.equal(r.status, 400, 'fim antes do início');
  r = await P.cl.put('/api/agenda/settings', { hours: [{ dow: 1, start: '08:00', end: '12:00' }, { dow: 1, start: '11:00', end: '13:00' }] });
  assert.equal(r.status, 400, 'horários sobrepostos');
  r = await P.cl.put('/api/agenda/settings', { hours: HOURS, session_minutes: 50, online: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ready, true);
  assert.equal(r.data.mode, 'manual');
  r = await anon.get(`/api/agenda/pro/${P.id}/next`);
  assert.equal(r.data.next.label, 'Hoje');
  assert.equal(r.data.next.first, '09:40', 'horário que já passou (ou em menos de 30 min) não aparece');
  assert.equal((await anon.get(`/api/agenda/pro/${P.id}/month`)).status, 401, 'calendário só com conta');
  r = await ana.get(`/api/agenda/pro/${P.id}/month?ym=2030-01`);
  const day = (d) => r.data.days.find((x) => x.date === d).free;
  assert.equal(day('2030-01-06'), 0, 'dia que passou');
  assert.equal(day('2030-01-12'), 0, 'sábado sem horário');
  assert.ok(day('2030-01-08') >= 8, 'terça cheia');
  r = await ana.get(`/api/agenda/pro/${P.id}/day?date=2030-01-08`);
  // 50 min cada: 11:20 terminaria 12:10 (depois do fim) e não aparece
  assert.deepEqual(r.data.slots.map((s) => s.label), ['08:00', '08:50', '09:40', '10:30', '14:00', '14:50', '15:40', '16:30']);
});

test('descanso entre as consultas: 1 hora de consulta + 15 minutos de descanso', async () => {
  const X = await mkPro('Xavier Pausa Lima', 'xavier.pausa@example.com', '11922223333', 'CRP 06/51003', { pix_key: 'x@pix.com' });
  let r = await X.cl.put('/api/agenda/settings', { hours: [{ dow: 2, start: '08:00', end: '12:00' }], session_minutes: 60, break_minutes: 15, online: true });
  assert.equal(r.data.break_minutes, 15);
  assert.equal((await X.cl.put('/api/agenda/settings', { hours: [], break_minutes: 7 })).status, 400);
  r = await ana.get(`/api/agenda/pro/${X.id}/day?date=2030-01-08`);
  assert.deepEqual(r.data.slots.map((s) => s.label), ['08:00', '09:15', '10:30'], '11:45 terminaria 12:45');
});

test('agenda nova: liga/desliga "Disponível para atendimento online" e cada horário é o início de uma consulta', async () => {
  const Y = await mkPro('Yara Inicio Souza', 'yara.inicio@example.com', '11944445555', 'CRP 06/51004', { pix_key: 'y@pix.com' });
  // 50 min + 10 de descanso: depois das 08:00 o próximo só pode começar às 09:00
  let r = await Y.cl.put('/api/agenda/settings', { session_minutes: 50, break_minutes: 10, starts: { 2: ['08:00', '08:55'] } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /09:00/);
  r = await Y.cl.put('/api/agenda/settings', { session_minutes: 50, break_minutes: 10, starts: { 2: ['08:00', '09:00', '12:00', '23:30'] } });
  assert.equal(r.status, 400, 'terminaria depois da meia-noite');
  r = await Y.cl.put('/api/agenda/settings', { session_minutes: 50, break_minutes: 10, starts: { 2: ['08:00', '09:00', '12:00'], 4: ['14:00'] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.starts, { 2: ['08:00', '09:00', '12:00'], 4: ['14:00'] });
  assert.equal(r.data.ready, false, 'ainda desligada');
  assert.ok(r.data.missing.includes('online'));
  assert.equal((await anon.get(`/api/agenda/pro/${Y.id}/next`)).data.next, null);
  r = await Y.cl.put('/api/agenda/settings', { online: true });
  assert.equal(r.data.ready, true);
  r = await ana.get(`/api/agenda/pro/${Y.id}/day?date=2030-01-08`);
  assert.deepEqual(r.data.slots.map((x) => x.label), ['08:00', '09:00', '12:00'], 'almoço: pulou das 09:50 para as 12:00');
  // Chave Pix do pagamento manual agora fica em Consultas; salvar o perfil (sem os campos) não apaga nem ela nem a duração
  r = await Y.cl.put('/api/agenda/settings', { pix_key: 'yara.nova@pix.com' });
  assert.equal(r.data.pix_key, 'yara.nova@pix.com');
  const me = (await Y.cl.get('/api/professional/me')).data;
  const body = { name: me.name, phone: me.phone, email: me.email, bio: me.bio, specialties: me.specialties, state: me.state, city: me.city, price: '150,00' };
  r = await Y.cl.put('/api/professional/profile', body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = (await Y.cl.get('/api/professional/me')).data;
  assert.equal(after.pix_key, 'yara.nova@pix.com');
  assert.equal(after.session_minutes, 50);
  r = await Y.cl.put('/api/agenda/settings', { online: false });
  assert.equal((await ana.get(`/api/agenda/pro/${Y.id}/day?date=2030-01-08`)).data.slots.length, 0, 'desligou: ninguém marca');
});

test('manual: paciente marca, profissional manda a chave Pix, aprova e a consulta fica marcada', async () => {
  let r = await ana.post('/api/agenda/book', { professional_id: P.id, start: at('2030-01-08', '08:00') });
  assert.equal(r.status, 400, 'precisa aceitar a política');
  r = await ana.post('/api/agenda/book', { professional_id: P.id, start: at('2030-01-08', '08:00'), accept: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const a = r.data;
  assert.equal(a.status, 'aguardando_pix');
  assert.equal((await bia.post('/api/agenda/book', { professional_id: P.id, start: at('2030-01-08', '08:00'), accept: true })).status, 409, 'horário segurado');
  // O profissional vê o pedido no chat
  const conv = (await P.cl.get('/api/chat/conversations')).data.items.find((c) => c.id === a.conversation_id);
  assert.ok(conv, 'conversa aparece para o profissional');
  let m = await msgs(P.cl, a.conversation_id);
  assert.equal(m.at(-1).kind, 'booking');
  assert.equal(m.at(-1).event, 'pedido');
  assert.equal(m.at(-1).booking.can.send_pix, true);
  r = await P.cl.post(`/api/agenda/appointments/${a.id}/send-pix`);
  assert.equal(r.data.status, 'aguardando_pagamento');
  m = await msgs(ana, a.conversation_id);
  assert.equal(m.at(-1).kind, 'pix');
  assert.equal(m.at(-1).body, 'paula@pix.com');
  r = await P.cl.post(`/api/agenda/appointments/${a.id}/manual-result`, { approved: true });
  assert.equal(r.data.status, 'confirmada');
  m = await msgs(ana, a.conversation_id);
  assert.equal(m.at(-1).event, 'agendada');
  r = await ana.get('/api/agenda/appointments');
  assert.equal(r.data.items[0].status, 'confirmada');
  assert.equal(r.data.items[0].can.reschedule, true);
  assert.equal(r.data.items[0].can.cancel, true);
  // O mesmo paciente não marca outro horário que bata com essa consulta (nem com outro profissional)
  Q = await mkPro('Quiteria Auto Melo', 'quiteria.auto@example.com', '11933334444', 'CRP 06/51002', { session_minutes: 50 });
  await Q.cl.put('/api/agenda/settings', { hours: HOURS, session_minutes: 50, online: true });
  r = await ana.post('/api/agenda/book', { professional_id: Q.id, start: at('2030-01-08', '08:00'), accept: true });
  assert.equal(r.status, 409, 'Quitéria ainda não abriu (sem forma de receber)');
});

test('manual: sem a chave Pix em 5 minutos o horário volta; "não aprovado" pergunta se quer tentar de novo', async () => {
  let r = await bia.post('/api/agenda/book', { professional_id: P.id, start: at('2030-01-08', '09:40'), accept: true });
  const a = r.data;
  advance(6);
  await G.sweep();
  r = await bia.get(`/api/agenda/appointments/${a.id}`);
  assert.equal(r.data.status, 'expirada');
  let m = await msgs(bia, a.conversation_id);
  assert.equal(m.at(-1).event, 'sem_resposta');
  assert.ok((await bia.get(`/api/agenda/pro/${P.id}/day?date=2030-01-08`)).data.slots.some((s) => s.label === '09:40'), 'horário liberado');
  // De novo: agora o profissional manda a chave, mas diz que o pagamento não chegou
  r = await bia.post('/api/agenda/book', { professional_id: P.id, start: at('2030-01-08', '09:40'), accept: true });
  const b = r.data;
  await P.cl.post(`/api/agenda/appointments/${b.id}/send-pix`);
  r = await P.cl.post(`/api/agenda/appointments/${b.id}/manual-result`, { approved: false });
  assert.equal(r.data.status, 'pagamento_recusado');
  m = await msgs(bia, b.conversation_id);
  assert.equal(m.at(-1).event, 'recusado');
  assert.equal(m.at(-1).booking.can.retry, true);
  r = await bia.post(`/api/agenda/appointments/${b.id}/retry`, { yes: true });
  assert.equal(r.data.status, 'aguardando_pix', 'volta a esperar a chave Pix');
  await P.cl.post(`/api/agenda/appointments/${b.id}/send-pix`);
  r = await P.cl.post(`/api/agenda/appointments/${b.id}/manual-result`, { approved: true });
  assert.equal(r.data.status, 'confirmada');
});

test('remarcar: só uma vez e até 30 minutos antes; cancelar pede motivo e trava o chat do profissional até o reembolso', async () => {
  const list = (await ana.get('/api/agenda/appointments')).data.items;
  const a = list[0];
  let r = await ana.post(`/api/agenda/appointments/${a.id}/reschedule`, { start: at('2030-01-09', '10:30') });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.reschedules, 1);
  assert.equal(r.data.time, '10:30');
  assert.equal(r.data.can.reschedule, false);
  r = await ana.post(`/api/agenda/appointments/${a.id}/reschedule`, { start: at('2030-01-09', '14:00') });
  assert.equal(r.status, 403, 'segunda remarcação não');
  assert.match(r.data.error, /uma vez/);
  // O horário antigo voltou a ficar livre
  assert.ok((await bia.get(`/api/agenda/pro/${P.id}/day?date=2030-01-08`)).data.slots.some((s) => s.label === '08:00'));
  // Cancelar: precisa de motivo
  r = await ana.post(`/api/agenda/appointments/${a.id}/cancel`, {});
  assert.equal(r.status, 400);
  r = await ana.post(`/api/agenda/appointments/${a.id}/cancel`, { reason: 'outros' });
  assert.equal(r.status, 400, '"outros" pede para contar o motivo');
  r = await ana.post(`/api/agenda/appointments/${a.id}/cancel`, { reason: 'horario' });
  assert.equal(r.data.status, 'reembolso_pendente');
  // Chat travado só para o profissional, só com esta paciente
  let s = await P.cl.post(`/api/chat/conversations/${a.conversation_id}/messages`, { body: 'Mas por quê?' });
  assert.equal(s.status, 403);
  assert.match(s.data.error, /reembolso/);
  assert.equal((await P.cl.get('/api/chat/conversations')).data.items.find((c) => c.id === a.conversation_id).refund_lock, true);
  assert.equal((await ana.post(`/api/chat/conversations/${a.conversation_id}/messages`, { body: 'Obrigada' })).status, 201, 'a paciente escreve normalmente');
  await P.cl.post(`/api/agenda/appointments/${a.id}/refund-done`);
  r = await ana.post(`/api/agenda/appointments/${a.id}/refund-received`, { yes: false });
  assert.equal(r.data.status, 'reembolso_pendente');
  s = await P.cl.post(`/api/chat/conversations/${a.conversation_id}/messages`, { body: 'Já devolvi' });
  assert.equal(s.status, 403, 'continua travado enquanto ela disser que não recebeu');
  await P.cl.post(`/api/agenda/appointments/${a.id}/refund-done`);
  r = await ana.post(`/api/agenda/appointments/${a.id}/refund-received`, { yes: true });
  assert.equal(r.data.status, 'reembolsada');
  s = await P.cl.post(`/api/chat/conversations/${a.conversation_id}/messages`, { body: 'Qualquer coisa, estou aqui.' });
  assert.equal(s.status, 201, 'chat liberado');
});

test('prazo de 30 minutos e "não vou poder atender" do profissional (até 24 horas antes)', async () => {
  const b = (await bia.get('/api/agenda/appointments')).data.items.find((x) => x.status === 'confirmada'); // 08/01 09:40
  // Hoje é 07/01 ~09:06: faltam mais de 24 h → o profissional pode avisar
  let r = await P.cl.post(`/api/agenda/appointments/${b.id}/pro-cancel`, { detail: 'Imprevisto de saúde' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'aguardando_paciente');
  let m = await msgs(bia, b.conversation_id);
  assert.equal(m.at(-1).event, 'pro_cancelou');
  assert.equal(m.at(-1).booking.can.choose, true);
  assert.equal((await P.cl.post(`/api/agenda/appointments/${b.id}/reschedule`, { start: at('2030-01-10', '08:00') })).status, 403, 'profissional não remarca sozinho');
  // A paciente escolhe remarcar (não conta como a remarcação dela)
  r = await bia.post(`/api/agenda/appointments/${b.id}/reschedule`, { start: at('2030-01-07', '14:00') });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'confirmada');
  assert.equal(r.data.reschedules, 0);
  assert.equal(r.data.can.reschedule, true);
  // Menos de 24 h: o profissional não pode mais avisar
  assert.equal((await P.cl.post(`/api/agenda/appointments/${b.id}/pro-cancel`)).status, 403);
  // 13:31 (29 min antes): paciente não remarca nem cancela
  clock = Date.parse(at('2030-01-07', '13:31'));
  r = await bia.get(`/api/agenda/appointments/${b.id}`);
  assert.equal(r.data.can.reschedule, false);
  assert.equal(r.data.can.cancel, false);
  assert.equal((await bia.post(`/api/agenda/appointments/${b.id}/cancel`, { reason: 'horario' })).status, 403);
  assert.equal((await bia.post(`/api/agenda/appointments/${b.id}/reschedule`, { start: at('2030-01-10', '08:00') })).status, 403);
});

test('chamada automática: abre 5 min antes (com aviso na conversa); profissional não entrou em 3 min → reembolso e chamada fechada', async () => {
  const b = (await bia.get('/api/agenda/appointments')).data.items.find((x) => x.status === 'confirmada'); // 07/01 14:00
  clock = Date.parse(at('2030-01-07', '13:54'));
  await G.sweep();
  let r = await bia.get(`/api/agenda/appointments/${b.id}`);
  assert.equal(r.data.call_code, null, '6 minutos antes ainda não abriu');
  clock = Date.parse(at('2030-01-07', '13:55'));
  await G.sweep();
  r = await bia.get(`/api/agenda/appointments/${b.id}`);
  assert.ok(r.data.call_code, 'chamada criada com o código');
  assert.equal(r.data.can.enter_call, true);
  let m = await msgs(bia, b.conversation_id);
  assert.equal(m.at(-1).event, 'chamada');
  clock = Date.parse(at('2030-01-07', '14:03'));
  await G.sweep();
  r = await bia.get(`/api/agenda/appointments/${b.id}`);
  assert.equal(r.data.status, 'reembolso_pendente', 'manual: o profissional precisa devolver');
  assert.equal(r.data.cancel_reason, 'profissional_ausente');
  assert.equal(r.data.call_code, null, 'chamada fechada');
  m = await msgs(bia, b.conversation_id);
  assert.ok(m.some((x) => x.event === 'ausente'));
});

test('automático (Asaas): conecta a chave, paciente paga o Pix dentro da Acolia, cancela e o estorno sai sozinho', async () => {
  let r = await Q.cl.post('/api/agenda/asaas', { key: '$aact_hmlg_chave_errada_000000000000' });
  assert.equal(r.status, 400);
  r = await Q.cl.post('/api/agenda/asaas', { key: '$aact_hmlg_chave_de_teste_valida_123456' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.payment.connected, true);
  assert.equal(r.data.payment.env, 'teste');
  assert.equal(r.data.payment.account_name, 'Consultório Teste');
  assert.equal(r.data.mode, 'auto');
  const { db } = require('../server/db');
  const row = db.prepare('SELECT key_enc FROM pro_payment WHERE professional_id = ?').get(Q.id);
  assert.ok(!row.key_enc.includes('chave_de_teste'), 'chave guardada criptografada');
  clock = Date.parse(at('2030-01-14', '09:00'));
  r = await ana.post('/api/agenda/book', { professional_id: Q.id, start: at('2030-01-15', '10:30'), accept: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const a = r.data;
  assert.equal(a.status, 'aguardando_pagamento');
  assert.equal(a.mode, 'auto');
  assert.ok(a.pix_payload.startsWith('00020126'), 'copia e cola');
  assert.ok(a.pix_image, 'QR Code');
  assert.equal(a.can.pay, true);
  const pay = [...fake.payments.values()].at(-1);
  assert.equal(pay.billingType, 'PIX');
  assert.equal(pay.value, 150);
  r = await ana.get(`/api/agenda/appointments/${a.id}`);
  assert.equal(r.data.status, 'aguardando_pagamento');
  pay.status = 'RECEIVED'; // o paciente pagou no app do banco
  advance(0.1);
  r = await ana.get(`/api/agenda/appointments/${a.id}`);
  assert.equal(r.data.status, 'confirmada', 'confirmou sozinho');
  assert.equal(r.data.pix_image, null);
  const m = await msgs(Q.cl, a.conversation_id);
  assert.equal(m.at(-1).event, 'agendada');
  r = await ana.post(`/api/agenda/appointments/${a.id}/cancel`, { reason: 'nao_preciso' });
  assert.equal(r.data.status, 'reembolsada', 'estorno automático');
  assert.equal(pay.status, 'REFUNDED');
  assert.equal((await Q.cl.post(`/api/chat/conversations/${a.conversation_id}/messages`, { body: 'Tudo bem!' })).status, 201, 'automático não trava o chat');
});

test('automático: Pix não pago em 10 minutos libera o horário; estorno que falha vira pedido ao profissional', async () => {
  let r = await bia.post('/api/agenda/book', { professional_id: Q.id, start: at('2030-01-15', '09:40'), accept: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const a = r.data;
  advance(11);
  await G.sweep();
  r = await bia.get(`/api/agenda/appointments/${a.id}`);
  assert.equal(r.data.status, 'expirada');
  assert.equal([...fake.payments.values()].at(-1).status, 'DELETED', 'cobrança cancelada no Asaas');
  // Proposta do profissional pelo chat
  const conv = a.conversation_id;
  r = await Q.cl.post('/api/agenda/propose', { conversation_id: conv, start: at('2030-01-16', '08:00') });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const p = r.data;
  let m = await msgs(bia, conv);
  assert.equal(m.at(-1).event, 'proposta');
  assert.equal(m.at(-1).booking.can.accept, true);
  r = await bia.post(`/api/agenda/appointments/${p.id}/accept`);
  assert.ok(r.data.pix_payload);
  fake.payments.get([...fake.payments.keys()].at(-1)).status = 'CONFIRMED';
  advance(0.1);
  r = await bia.get(`/api/agenda/appointments/${p.id}`);
  assert.equal(r.data.status, 'confirmada');
  fake.failRefund = true;
  r = await bia.post(`/api/agenda/appointments/${p.id}/cancel`, { reason: 'financeiro' });
  assert.equal(r.data.status, 'reembolso_pendente', 'sem saldo: o profissional devolve pelo Pix');
  assert.equal(r.data.refund_status, 'pedido');
  fake.failRefund = false;
});

test('profissional entra na chamada: sem reembolso e a consulta fica concluída no fim', async () => {
  const { io: ioClient } = require('socket.io-client');
  let r = await bia.post('/api/agenda/book', { professional_id: P.id, start: at('2030-01-16', '14:00'), accept: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const a = r.data;
  await P.cl.post(`/api/agenda/appointments/${a.id}/send-pix`);
  await P.cl.post(`/api/agenda/appointments/${a.id}/manual-result`, { approved: true });
  clock = Date.parse(at('2030-01-16', '13:56'));
  await G.sweep();
  const code = (await bia.get(`/api/agenda/appointments/${a.id}`)).data.call_code;
  assert.ok(code);
  // Secretária (versão 1.1.3): vê a consulta, mas sem código e sem entrar na chamada
  const creds = (await P.cl.post('/api/professional/secretary')).data;
  const sec = client();
  assert.equal((await sec.post('/api/auth/professional/login', { login: creds.login, password: creds.password })).status, 200);
  const sv = (await sec.get(`/api/agenda/appointments/${a.id}`)).data;
  assert.equal(sv.call_code, null);
  assert.equal(sv.can.enter_call, false);
  const ss = ioClient(base, { extraHeaders: { Cookie: sec.cookie }, transports: ['websocket'] });
  const sack = await new Promise((ok) => ss.emit('call:join', { code }, ok));
  assert.match(sack.error || '', /secretária não entra/, 'nem com o código a secretária entra');
  ss.close();
  await P.cl.del('/api/professional/secretary');
  // O profissional entra pela conversa (código da consulta, logado como ele)
  const sock = ioClient(base, { extraHeaders: { Cookie: P.cl.cookie }, transports: ['websocket'] });
  const ack = await new Promise((ok) => sock.emit('call:join', { code }, ok));
  assert.equal(ack.role, 'host', JSON.stringify(ack));
  sock.close();
  // A paciente também entra (senão, depois de 3 minutos, a chamada acaba sem reembolso)
  const psock = ioClient(base, { extraHeaders: { Cookie: bia.cookie }, transports: ['websocket'] });
  const pack = await new Promise((ok) => psock.emit('call:join', { code }, ok));
  assert.equal(pack.role, 'guest', JSON.stringify(pack));
  psock.close();
  clock = Date.parse(at('2030-01-16', '14:05'));
  await G.sweep();
  assert.equal((await bia.get(`/api/agenda/appointments/${a.id}`)).data.status, 'confirmada', 'entrou a tempo: nada de reembolso');
  // O profissional finaliza: consulta concluída na hora, "Chamada finalizada" na conversa e sai das próximas
  const hsock = ioClient(base, { extraHeaders: { Cookie: P.cl.cookie }, transports: ['websocket'] });
  await new Promise((ok) => hsock.emit('call:join', { code }, ok));
  hsock.emit('call:end');
  await new Promise((ok) => setTimeout(ok, 150));
  hsock.close();
  r = await bia.get(`/api/agenda/appointments/${a.id}`);
  assert.equal(r.data.status, 'concluida');
  assert.equal(r.data.call_code, null, 'chamada fechada');
  assert.equal((await msgs(bia, a.conversation_id)).at(-1).event, 'finalizada');
  assert.ok(!(await bia.get('/api/agenda/appointments')).data.items.some((x) => x.id === a.id), 'sai do aviso / próximas');
});

test('regra dos 3 minutos vale para o paciente: não entrou → chamada encerrada, sem reembolso', async () => {
  const { io: ioClient } = require('socket.io-client');
  let r = await bia.post('/api/agenda/book', { professional_id: P.id, start: at('2030-01-23', '14:00'), accept: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const a = r.data;
  await P.cl.post(`/api/agenda/appointments/${a.id}/send-pix`);
  await P.cl.post(`/api/agenda/appointments/${a.id}/manual-result`, { approved: true });
  clock = Date.parse(at('2030-01-23', '13:56'));
  await G.sweep();
  const code = (await bia.get(`/api/agenda/appointments/${a.id}`)).data.call_code;
  assert.ok(code);
  const sock = ioClient(base, { extraHeaders: { Cookie: P.cl.cookie }, transports: ['websocket'] });
  assert.equal((await new Promise((ok) => sock.emit('call:join', { code }, ok))).role, 'host');
  // Finalizar antes de o paciente entrar não fecha a chamada (ele ainda tem os 3 minutos)
  sock.emit('call:end');
  await new Promise((ok) => setTimeout(ok, 150));
  sock.close();
  assert.ok((await bia.get(`/api/agenda/appointments/${a.id}`)).data.call_code, 'continua aberta para o paciente');
  clock = Date.parse(at('2030-01-23', '14:02'));
  await G.sweep();
  assert.equal((await bia.get(`/api/agenda/appointments/${a.id}`)).data.status, 'confirmada', 'ainda dentro dos 3 minutos');
  clock = Date.parse(at('2030-01-23', '14:03'));
  await G.sweep();
  r = await bia.get(`/api/agenda/appointments/${a.id}`);
  assert.equal(r.data.status, 'paciente_ausente');
  assert.equal(r.data.refund_status, null, 'sem reembolso');
  assert.equal(r.data.call_code, null, 'chamada encerrada');
  const m = await msgs(bia, a.conversation_id);
  assert.equal(m.at(-1).event, 'paciente_ausente');
});

test('no site de verdade só vale chave de conta real do Asaas (a de teste não recebe dinheiro)', async () => {
  delete process.env.ALLOW_ASAAS_SANDBOX;
  try {
    const r = await P.cl.post('/api/agenda/asaas', { key: '$aact_hmlg_chave_de_teste_valida_123456' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /TESTE/);
  } finally { process.env.ALLOW_ASAAS_SANDBOX = '1'; }
});

test('contas de teste: Asaas simulado só para o Profissional Teste; teste só marca com teste', async () => {
  delete process.env.ALLOW_ASAAS_SANDBOX; // como no site de verdade
  try {
    assert.equal((await admin.post('/api/admin/test-accounts')).status, 200);
    const tp = client();
    assert.equal((await tp.post('/api/auth/professional/login', { login: '123456789', password: '123456789' })).status, 200);
    const tpt = client();
    assert.equal((await tpt.post('/api/auth/patient/login', { cpf: '000.000.000-00', password: '1234' })).status, 200);
    // Profissional de verdade não usa o simulado nem a chave de teste
    let r = await P.cl.post('/api/agenda/asaas', { key: 'SIMULADO' });
    assert.equal(r.status, 400);
    r = await P.cl.post('/api/agenda/asaas', { key: '$aact_hmlg_chave_de_teste_valida_123456' });
    assert.equal(r.status, 400);
    // Nem o Profissional Teste consegue conectar o simulado (ou chave de teste) pela tela
    assert.equal((await tp.post('/api/agenda/asaas', { key: 'SIMULADO' })).status, 400);
    assert.equal((await tp.post('/api/agenda/asaas', { key: '$aact_hmlg_chave_de_teste_valida_123456' })).status, 400);
    // O servidor deixa o Profissional Teste pronto (ativo, agenda aberta e Asaas simulado)
    const { db } = require('../server/db');
    db.prepare("UPDATE professionals SET status = 'bloqueado' WHERE code = '123456789'").run(); // estava "desativado"
    assert.equal(require('../server/testAgenda').provision(), true);
    r = await tp.get('/api/agenda/settings');
    assert.equal(r.status, 200, 'conta reativada');
    assert.equal(r.data.payment.env, 'simulado');
    assert.equal(r.data.ready, true, JSON.stringify(r.data.missing));
    assert.equal(r.data.mode, 'auto');
    const tpId = (await tp.get('/api/professional/me')).data.id;
    clock = Date.parse(at('2030-01-21', '09:00'));
    // Paciente de verdade não vê o dia disponível nem marca com a conta de teste (e vice-versa)
    assert.equal((await ana.get(`/api/professionals/${tpId}`)).data.next_available, null);
    assert.equal((await ana.post('/api/agenda/book', { professional_id: tpId, start: at('2030-01-22', '08:00'), accept: true })).status, 403);
    assert.equal((await tpt.post('/api/agenda/book', { professional_id: P.id, start: at('2030-01-22', '08:00'), accept: true })).status, 403);
    assert.ok((await tpt.get(`/api/professionals/${tpId}`)).data.next_available, 'o paciente de teste vê');
    // Paciente Teste marca, "paga" pelo simulado e a consulta é confirmada sozinha
    const first = (await tpt.get(`/api/agenda/pro/${tpId}/day?date=2030-01-22`)).data.slots[0].start;
    r = await tpt.post('/api/agenda/book', { professional_id: tpId, start: first, accept: true });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const a = r.data;
    assert.equal(a.simulated, true);
    assert.ok(a.pix_image && a.pix_payload.startsWith('SIMULADO'));
    assert.equal((await ana.post(`/api/agenda/appointments/${a.id}/simulate-pay`)).status, 403, 'outro paciente não mexe');
    r = await tpt.post(`/api/agenda/appointments/${a.id}/simulate-pay`);
    assert.equal(r.data.status, 'confirmada');
    const m = await msgs(tp, a.conversation_id);
    assert.equal(m.at(-1).event, 'agendada');
    // Cancela e o reembolso simulado sai sozinho
    r = await tpt.post(`/api/agenda/appointments/${a.id}/cancel`, { reason: 'nao_preciso' });
    assert.equal(r.data.status, 'reembolsada');
    // Apagou a conta de teste: o Asaas simulado some junto
    const tpRow = db.prepare("SELECT id FROM professionals WHERE code = '123456789'").get();
    assert.equal((await admin.post(`/api/admin/professionals/${tpRow.id}/delete-test`)).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM pro_payment WHERE professional_id = ?').get(tpRow.id).n, 0);
  } finally { process.env.ALLOW_ASAAS_SANDBOX = '1'; }
});

test('conta apagada: consultas futuras são canceladas', async () => {
  const cl = await mkPatient('Caio Some Dias', '274.658.193-00');
  let r = await cl.post('/api/agenda/book', { professional_id: P.id, start: at('2030-01-24', '08:00'), accept: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = r.data.id;
  r = await cl.post('/api/patient/delete', { password: 'senha123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(G.getAppt(id).status, 'cancelada');
  assert.ok((await ana.get(`/api/agenda/pro/${P.id}/day?date=2030-01-24`)).data.slots.some((s) => s.label === '08:00'), 'horário liberado');
});
