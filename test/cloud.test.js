'use strict';
// Simula o Supabase Storage e confere que as contas sobrevivem a um reinício
// do servidor com o disco apagado (como no Render grátis).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const objects = new Map();
let failGets = false;
let mock;
let mockUrl;

before(async () => {
  mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (req.headers.apikey !== 'chave-teste') { res.writeHead(401); return res.end('{}'); }
    const url = decodeURIComponent(req.url);
    if (req.method === 'POST' && url === '/storage/v1/bucket') { res.writeHead(200); return res.end('{}'); }
    const m = url.match(/^\/storage\/v1\/object\/acolia-dados\/(.+)$/);
    if (m && req.method === 'POST') { objects.set(m[1], body); res.writeHead(200); return res.end('{}'); }
    if (m && req.method === 'GET') {
      if (failGets) { res.writeHead(500); return res.end('{"message":"erro"}'); }
      if (!objects.has(m[1])) { res.writeHead(400); return res.end('{"error":"not_found","message":"Object not found"}'); }
      res.writeHead(200); return res.end(objects.get(m[1]));
    }
    if (req.method === 'DELETE' && url === '/storage/v1/object/acolia-dados') {
      for (const p of JSON.parse(body).prefixes) objects.delete(p);
      res.writeHead(200); return res.end('[]');
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => mock.listen(0, r));
  mockUrl = `http://localhost:${mock.address().port}`;
});
after(() => mock.close());

function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acolia-cloud-'));
  const child = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: '0', DATA_DIR: dir, ADMIN_PASSWORD: 'senha-admin-123', SUPABASE_URL: mockUrl, SUPABASE_SERVICE_KEY: 'chave-teste' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/rodando em (http:\/\/localhost:\d+)/);
      if (m) resolve(m[1]);
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => reject(Object.assign(new Error(`saiu com código ${code}: ${out}`), { code })));
  });
  const stop = () => new Promise((r) => { child.on('exit', r); child.kill('SIGTERM'); });
  return { ready, stop, dir, child };
}

async function post(base, url, body, cookie) {
  const res = await fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
  });
  return { status: res.status, cookie: (res.headers.get('set-cookie') || '').split(';')[0], data: await res.json() };
}

test('contas e fotos continuam depois de reiniciar com o disco apagado', async () => {
  const s1 = startServer();
  const base1 = await s1.ready;
  const reg = await post(base1, '/api/auth/patient/register', { name: 'Maria Souza', cpf: '52998224725', state: 'PA', city: 'Parauapebas', password: '123456' });
  assert.equal(reg.status, 201);
  const fd = new FormData();
  fd.append('photo', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], { type: 'image/jpeg' }), 'foto.jpg');
  const up = await fetch(`${base1}/api/patient/photo`, { method: 'POST', body: fd, headers: { Cookie: reg.cookie } });
  const photo = (await up.json()).photo;
  assert.ok(photo);
  await s1.stop(); // SIGTERM salva a última cópia
  assert.ok(objects.has('db/acolia.db'), 'banco enviado para a nuvem');
  assert.ok([...objects.keys()].some((k) => k.startsWith('db/diario/')), 'cópia diária');
  fs.rmSync(s1.dir, { recursive: true, force: true }); // "disco apagado"

  const s2 = startServer();
  const base2 = await s2.ready;
  try {
    const login = await post(base2, '/api/auth/patient/login', { cpf: '529.982.247-25', password: '123456' });
    assert.equal(login.status, 200, 'a conta continua existindo');
    const img = await fetch(base2 + photo);
    assert.equal(img.status, 200, 'a foto volta da nuvem');
    const admin = await post(base2, '/api/auth/admin/login', { username: 'admin', password: 'senha-admin-123' });
    assert.equal(admin.status, 200);
  } finally {
    await s2.stop();
    fs.rmSync(s2.dir, { recursive: true, force: true });
  }
});

test('se a nuvem falhar ao ligar, o site não abre com banco vazio', async () => {
  failGets = true;
  const s = startServer();
  await assert.rejects(s.ready, (e) => e.code === 1);
  failGets = false;
  assert.ok(objects.has('db/acolia.db'), 'a cópia boa não foi apagada');
  fs.rmSync(s.dir, { recursive: true, force: true });
});
