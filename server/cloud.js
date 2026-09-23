'use strict';
// Guarda os dados fora do servidor, no Supabase Storage (plano grátis).
//
// Serve para hospedagens sem disco permanente (ex.: Render grátis), que apagam
// tudo quando o site reinicia. Com SUPABASE_URL e SUPABASE_SERVICE_KEY definidos:
//  - ao ligar, o banco é baixado do Supabase antes de o site abrir;
//  - depois de cada alteração, uma cópia do banco é enviada (alguns segundos depois);
//  - fotos e carteirinhas também são enviadas e baixadas quando precisar;
//  - uma cópia extra por dia fica guardada em db/diario/AAAA-MM-DD.db.
const fs = require('node:fs');
const path = require('node:path');

const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || '';
const BUCKET = process.env.SUPABASE_BUCKET || 'acolia-dados';
const DB_OBJECT = 'db/acolia.db';

const enabled = Boolean(URL_BASE && KEY);
let restored = false; // só envia cópias depois de restaurar com sucesso (evita sobrescrever com banco vazio)

// Chaves novas do Supabase ("sb_secret_…") vão só no cabeçalho apikey;
// as antigas ("service_role", um JWT) também vão como Bearer.
function headers(extra = {}) {
  const auth = KEY.startsWith('sb_') ? {} : { Authorization: `Bearer ${KEY}` };
  return { ...auth, apikey: KEY, ...extra };
}

async function request(method, urlPath, { body, headers: h } = {}) {
  const res = await fetch(`${URL_BASE}/storage/v1/${urlPath}`, {
    method, body, headers: headers(h), signal: AbortSignal.timeout(60000),
  });
  return res;
}

function isNotFound(res, text) {
  return res.status === 404 || (res.status === 400 && /not.?found/i.test(text));
}

async function ensureBucket() {
  const res = await request('POST', 'bucket', {
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
    headers: { 'Content-Type': 'application/json' },
  });
  if (res.ok) return;
  const text = await res.text();
  if (/already exists|duplicate/i.test(text) || res.status === 409) return;
  throw new Error(`Supabase: não foi possível criar o bucket (${res.status}) ${text.slice(0, 200)}`);
}

async function put(objectPath, data, contentType = 'application/octet-stream') {
  const res = await request('POST', `object/${BUCKET}/${objectPath}`, {
    body: data, headers: { 'Content-Type': contentType, 'x-upsert': 'true', 'Cache-Control': 'no-cache' },
  });
  if (!res.ok) throw new Error(`Supabase: falha ao enviar ${objectPath} (${res.status}) ${(await res.text()).slice(0, 200)}`);
}

// Retorna Buffer ou null se o arquivo não existe
async function get(objectPath) {
  const res = await request('GET', `object/${BUCKET}/${objectPath}`);
  if (res.ok) return Buffer.from(await res.arrayBuffer());
  const text = await res.text();
  if (isNotFound(res, text)) return null;
  throw new Error(`Supabase: falha ao baixar ${objectPath} (${res.status}) ${text.slice(0, 200)}`);
}

async function remove(objectPath) {
  await request('DELETE', `object/${BUCKET}`, {
    body: JSON.stringify({ prefixes: [objectPath] }), headers: { 'Content-Type': 'application/json' },
  }).catch(() => {});
}

// Baixa o banco antes de abri-lo. Se der erro de rede, NÃO continua (para não
// começar com banco vazio e apagar a cópia boa na próxima sincronização).
async function restoreDb(dbFile) {
  if (!enabled) return;
  await ensureBucket();
  const data = await get(DB_OBJECT);
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  if (data) {
    for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
    fs.writeFileSync(dbFile, data);
    console.log(`[nuvem] banco restaurado do Supabase (${(data.length / 1024).toFixed(0)} KB)`);
  } else {
    console.log('[nuvem] nenhum banco salvo ainda no Supabase — começando do zero');
  }
  restored = true;
}

// ---------- Cópia do banco depois das alterações ----------
let db = null;
let timer = null;
let running = null;
let pending = false;
let lastDaily = '';

function attachDb(database) { db = database; }

async function backupNow() {
  if (!enabled || !restored || !db) return;
  if (running) { pending = true; return running; }
  running = (async () => {
    const tmp = path.join(require('node:os').tmpdir(), `acolia-snap-${process.pid}.db`);
    try {
      fs.rmSync(tmp, { force: true });
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const data = fs.readFileSync(tmp);
      await put(DB_OBJECT, data);
      const day = new Date().toISOString().slice(0, 10);
      if (day !== lastDaily) {
        await put(`db/diario/${day}.db`, data);
        lastDaily = day;
      }
    } catch (e) {
      console.error('[nuvem] falha ao salvar cópia do banco:', e.message);
      pending = true; // tenta de novo na próxima
    } finally {
      fs.rmSync(tmp, { force: true });
      running = null;
    }
  })();
  await running;
  if (pending) { pending = false; scheduleBackup(5000); }
}

function scheduleBackup(delay = 2000) {
  if (!enabled || !restored) return;
  clearTimeout(timer);
  timer = setTimeout(backupNow, delay);
}

async function flush() {
  if (!enabled || !restored) return;
  await Promise.all([...pendingUploads]);
  clearTimeout(timer);
  if (running) await running;
  await backupNow();
}

// ---------- Arquivos (fotos e carteirinhas) ----------
const pendingUploads = new Set();
function uploadFile(folder, localFile) {
  if (!enabled) return;
  const type = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.wav': 'audio/wav', '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.mp3': 'audio/mpeg' }[path.extname(localFile)] || 'application/octet-stream';
  const p = fs.promises.readFile(localFile)
    .then((data) => put(`${folder}/${path.basename(localFile)}`, data, type))
    .catch((e) => console.error('[nuvem] falha ao enviar arquivo:', e.message))
    .finally(() => pendingUploads.delete(p));
  pendingUploads.add(p);
}

function removeFile(folder, name) {
  if (enabled && name) remove(`${folder}/${path.basename(name)}`);
}

// Garante que o arquivo exista localmente (baixa do Supabase se preciso). Retorna true/false.
async function ensureLocalFile(folder, localFile) {
  if (fs.existsSync(localFile)) return true;
  if (!enabled) return false;
  try {
    const data = await get(`${folder}/${path.basename(localFile)}`);
    if (!data) return false;
    fs.mkdirSync(path.dirname(localFile), { recursive: true });
    fs.writeFileSync(localFile, data);
    return true;
  } catch (e) {
    console.error('[nuvem] falha ao baixar arquivo:', e.message);
    return false;
  }
}

module.exports = {
  enabled, restoreDb, attachDb, scheduleBackup, flush, backupNow, uploadFile, removeFile, ensureLocalFile,
};
