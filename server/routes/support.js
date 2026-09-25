'use strict';
// Suporte Acolia: conversa fixa no topo das mensagens de profissionais (e secretárias) e pacientes
// com a equipe Acolia, respondida pelo painel do administrador.
// - O usuário manda texto, foto (só aqui) e áudio. Não há Pix, documentos, agendamento nem
//   mensagens prontas. Dá para apagar a própria mensagem e limpar a conversa (só para si);
//   não dá para arquivar, bloquear nem apagar a conversa.
// - O admin responde quem escreveu e pode mandar uma mensagem para TODOS os profissionais de uma vez
//   (pacientes só recebem resposta depois de escreverem).
const express = require('express');
const { db, tx } = require('../db');
const U = require('../util');
const A = require('../auth');
const rt = require('../realtime');

db.exec(`
CREATE TABLE IF NOT EXISTS support_threads (
  id INTEGER PRIMARY KEY,
  user_role TEXT NOT NULL,                 -- patient | professional
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at TEXT,
  last_user_message_at TEXT,               -- a caixa do admin só mostra quem já escreveu
  UNIQUE (user_role, user_id)
);
CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,                    -- user | admin
  secretary_id INTEGER,                    -- mandada pela secretária do profissional
  kind TEXT NOT NULL DEFAULT 'text',       -- text | image | audio | deleted
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  read_at TEXT,
  hidden_for_user INTEGER NOT NULL DEFAULT 0,
  broadcast INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_support_msg ON support_messages(thread_id, id);
`);

const NAME = 'Suporte Acolia';
const COLS = 'id, sender, secretary_id, kind, body, created_at, read_at, broadcast';

function threadOf(role, userId, create = true) {
  let t = db.prepare('SELECT * FROM support_threads WHERE user_role = ? AND user_id = ?').get(role, userId);
  if (!t && create) {
    const info = db.prepare('INSERT INTO support_threads (user_role, user_id) VALUES (?, ?)').run(role, userId);
    t = db.prepare('SELECT * FROM support_threads WHERE id = ?').get(Number(info.lastInsertRowid));
  }
  return t || null;
}

// Como o usuário vê a mensagem (mesmo formato do chat: sender_role = o papel dele ou 'admin')
const forUser = (role) => (m) => ({ ...m, sender_role: m.sender === 'user' ? role : 'admin' });
const forAdmin = (t) => (m) => ({ ...m, sender_role: m.sender === 'admin' ? 'admin' : t.user_role });

function userOf(t) {
  if (t.user_role === 'patient') {
    const p = db.prepare('SELECT id, name, handle, photo, status, is_test FROM patients WHERE id = ?').get(t.user_id);
    return p ? { id: p.id, role: 'patient', name: p.name, handle: p.handle || '', full_name: p.name, photo: p.photo, active: p.status === 'ativo', is_test: !!p.is_test } : null;
  }
  const p = db.prepare('SELECT id, name, photo, status, profession, is_test FROM professionals WHERE id = ?').get(t.user_id);
  return p ? { id: p.id, role: 'professional', name: p.name, photo: p.photo, profession: p.profession, active: ['aprovado', 'restrito', 'bloqueado'].includes(p.status), is_test: !!p.is_test } : null;
}

function insert(t, sender, kind, body, extra = {}) {
  const info = db.prepare('INSERT INTO support_messages (thread_id, sender, secretary_id, kind, body, broadcast) VALUES (?, ?, ?, ?, ?, ?)')
    .run(t.id, sender, extra.secretaryId || null, kind, body, extra.broadcast ? 1 : 0);
  const m = db.prepare(`SELECT ${COLS} FROM support_messages WHERE id = ?`).get(Number(info.lastInsertRowid));
  db.prepare(`UPDATE support_threads SET last_message_at = ?${sender === 'user' ? ', last_user_message_at = ?' : ''} WHERE id = ?`)
    .run(...(sender === 'user' ? [m.created_at, m.created_at, t.id] : [m.created_at, t.id]));
  // Tempo real: o usuário (e a secretária, que fica na mesma sala do profissional) e o admin
  rt.emit(`${t.user_role}:${t.user_id}`, 'support:new', forUser(t.user_role)(m));
  rt.emit('admin', 'support:new', { thread_id: t.id, message: forAdmin(t)(m) });
  if (sender === 'admin') {
    const text = kind === 'image' ? '📷 Enviou uma foto' : kind === 'audio' ? '🎤 Enviou um áudio' : body;
    require('../push').notify(t.user_role, t.user_id, {
      title: NAME, body: text.length > 140 ? `${text.slice(0, 137)}…` : text,
      url: t.user_role === 'patient' ? '/app#chat/suporte' : '/painel#conversas/suporte', tag: 'suporte',
    });
  }
  return m;
}

function summary(role, userId) {
  const t = threadOf(role, userId, false);
  const base = { name: NAME, photo: '/img/logo-simbolo.png' };
  if (!t) return { ...base, unread: 0, last_message: null };
  const last = db.prepare(`SELECT ${COLS} FROM support_messages WHERE thread_id = ? AND hidden_for_user = 0 ORDER BY id DESC LIMIT 1`).get(t.id);
  const unread = db.prepare("SELECT COUNT(*) n FROM support_messages WHERE thread_id = ? AND sender = 'admin' AND read_at IS NULL AND hidden_for_user = 0").get(t.id).n;
  return { ...base, unread, last_message: last ? forUser(role)(last) : null };
}

// ---------- Usuário (paciente, profissional e secretária) ----------
const router = express.Router();
router.use(A.requireRole('patient', 'professional'));
const me = (req) => ({ role: req.auth.role, id: req.auth.user.id });

router.get('/', (req, res) => res.json(summary(me(req).role, me(req).id)));

router.get('/messages', (req, res) => {
  const { role, id } = me(req);
  const t = threadOf(role, id, false);
  if (!t) return res.json({ items: [], has_more: false });
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const limit = 60;
  const rows = db.prepare(`SELECT ${COLS} FROM support_messages WHERE thread_id = ? AND hidden_for_user = 0 AND id < ? ORDER BY id DESC LIMIT ?`).all(t.id, before, limit);
  res.json({ items: rows.reverse().map(forUser(role)).map((m) => (role === 'patient' ? { ...m, secretary_id: undefined } : m)), has_more: rows.length === limit });
});

const secId = (req) => req.auth.secretary?.id || null;

router.post('/messages', (req, res) => {
  const { role, id } = me(req);
  const body = U.cleanText(req.body.body, 4000);
  if (!body) throw new U.HttpError(400, 'Mensagem vazia.');
  res.status(201).json(forUser(role)(insert(threadOf(role, id), 'user', 'text', body, { secretaryId: secId(req) })));
});

// Foto (só no suporte: para mostrar um erro, por exemplo)
router.post('/photo', async (req, res) => {
  const { role, id } = me(req);
  const url = await require('../upload').handlePhoto(req, res);
  res.status(201).json(forUser(role)(insert(threadOf(role, id), 'user', 'image', url, { secretaryId: secId(req) })));
});

router.post('/audio', async (req, res) => {
  const { role, id } = me(req);
  const file = await require('../upload').handleAudio(req, res);
  const secs = Math.max(1, Math.min(600, Math.round(Number(req.body.duration) || 0)));
  const peaks = /^[0-9]{1,64}$/.test(String(req.body.peaks || '')) ? req.body.peaks : '';
  res.status(201).json(forUser(role)(insert(threadOf(role, id), 'user', 'audio', `${file}|${secs}|${peaks}`, { secretaryId: secId(req) })));
});

// Ouvir um áudio do suporte: só o dono da conversa
router.get('/audio/:file', async (req, res) => {
  const { role, id } = me(req);
  const t = threadOf(role, id, false);
  await sendAudio(res, t, req.params.file);
});

async function sendAudio(res, t, file) {
  file = String(file);
  if (!t || !/^[a-f0-9]{32}\.(wav|webm|ogg|m4a|aac|mp3)$/.test(file)) throw new U.HttpError(404, 'Áudio não encontrado.');
  if (!db.prepare("SELECT 1 FROM support_messages WHERE thread_id = ? AND kind = 'audio' AND body LIKE ?").get(t.id, `${file}|%`)) throw new U.HttpError(404, 'Áudio não encontrado.');
  const { AUDIO_DIR } = require('../upload');
  const full = require('node:path').join(AUDIO_DIR, file);
  if (!(await require('../cloud').ensureLocalFile('audio', full))) throw new U.HttpError(404, 'Áudio não encontrado.');
  const types = { wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg' };
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(full, { headers: { 'Content-Type': types[file.split('.').pop()] } });
}

// Apagar a própria mensagem (para todos: vira "Mensagem apagada")
router.post('/messages/:id/delete', (req, res) => {
  const { role, id } = me(req);
  const t = threadOf(role, id, false);
  const m = t && db.prepare("SELECT * FROM support_messages WHERE id = ? AND thread_id = ? AND sender = 'user'").get(Number(req.params.id), t.id);
  if (!m) throw new U.HttpError(404, 'Mensagem não encontrada.');
  db.prepare("UPDATE support_messages SET kind = 'deleted', body = '' WHERE id = ?").run(m.id);
  rt.emit('admin', 'support:changed', { thread_id: t.id });
  res.json({ ok: true });
});

// Limpar a conversa (só para o usuário; o suporte continua vendo o histórico)
router.post('/clear', (req, res) => {
  const { role, id } = me(req);
  const t = threadOf(role, id, false);
  if (t) db.prepare('UPDATE support_messages SET hidden_for_user = 1 WHERE thread_id = ?').run(t.id);
  res.json({ ok: true });
});

router.post('/read', (req, res) => {
  const { role, id } = me(req);
  const t = threadOf(role, id, false);
  if (t) db.prepare("UPDATE support_messages SET read_at = datetime('now') WHERE thread_id = ? AND sender = 'admin' AND read_at IS NULL").run(t.id);
  res.json({ ok: true });
});

// ---------- Admin ----------
const admin = express.Router();

admin.get('/threads', (req, res) => {
  const rows = db.prepare('SELECT * FROM support_threads WHERE last_user_message_at IS NOT NULL ORDER BY last_message_at DESC LIMIT 300').all();
  const who = req.query.role === 'patient' || req.query.role === 'professional' ? req.query.role : '';
  const items = rows.filter((t) => !who || t.user_role === who).map((t) => {
    const last = db.prepare(`SELECT ${COLS} FROM support_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1`).get(t.id);
    const unread = db.prepare("SELECT COUNT(*) n FROM support_messages WHERE thread_id = ? AND sender = 'user' AND read_at IS NULL").get(t.id).n;
    return { id: t.id, user: userOf(t), unread, last_message: last ? forAdmin(t)(last) : null, last_message_at: t.last_message_at };
  }).filter((x) => x.user);
  res.json({ items, unread: items.reduce((n, x) => n + x.unread, 0) });
});

const loadThread = (id) => {
  const t = db.prepare('SELECT * FROM support_threads WHERE id = ?').get(Number(id));
  if (!t) throw new U.HttpError(404, 'Conversa não encontrada.');
  return t;
};

admin.get('/threads/:id/messages', (req, res) => {
  const t = loadThread(req.params.id);
  const rows = db.prepare(`SELECT ${COLS} FROM support_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 200`).all(t.id);
  db.prepare("UPDATE support_messages SET read_at = datetime('now') WHERE thread_id = ? AND sender = 'user' AND read_at IS NULL").run(t.id);
  res.json({ thread: { id: t.id, user: userOf(t) }, items: rows.reverse().map(forAdmin(t)) });
});

admin.post('/threads/:id/messages', (req, res) => {
  const t = loadThread(req.params.id);
  const body = U.cleanText(req.body.body, 4000);
  if (!body) throw new U.HttpError(400, 'Mensagem vazia.');
  res.status(201).json(forAdmin(t)(insert(t, 'admin', 'text', body)));
});

admin.post('/threads/:id/photo', async (req, res) => {
  const t = loadThread(req.params.id);
  const url = await require('../upload').handlePhoto(req, res);
  res.status(201).json(forAdmin(t)(insert(t, 'admin', 'image', url)));
});

admin.get('/threads/:id/audio/:file', async (req, res) => sendAudio(res, loadThread(req.params.id), req.params.file));

admin.post('/messages/:id/delete', (req, res) => {
  const m = db.prepare("SELECT * FROM support_messages WHERE id = ? AND sender = 'admin'").get(Number(req.params.id));
  if (!m) throw new U.HttpError(404, 'Mensagem não encontrada.');
  db.prepare("UPDATE support_messages SET kind = 'deleted', body = '' WHERE id = ?").run(m.id);
  const t = loadThread(m.thread_id);
  rt.emit(`${t.user_role}:${t.user_id}`, 'support:changed', {});
  res.json({ ok: true });
});

// Mensagem para TODOS os profissionais (aparece na conversa de suporte de cada um)
admin.post('/broadcast-professionals', (req, res) => {
  const body = U.cleanText(req.body.body, 4000);
  if (!body) throw new U.HttpError(400, 'Escreva a mensagem.');
  const pros = db.prepare("SELECT id FROM professionals WHERE status IN ('aprovado', 'restrito', 'bloqueado')").all();
  tx(() => { for (const p of pros) insert(threadOf('professional', p.id), 'admin', 'text', body, { broadcast: true }); });
  res.json({ sent: pros.length });
});

// Conta apagada: some a conversa de suporte dela
function purge(role, id) {
  const t = threadOf(role, id, false);
  if (t) {
    db.prepare('DELETE FROM support_messages WHERE thread_id = ?').run(t.id);
    db.prepare('DELETE FROM support_threads WHERE id = ?').run(t.id);
  }
}

module.exports = { router, admin, summary, purge, NAME };
