'use strict';
const express = require('express');
const { db } = require('../db');
const U = require('../util');
const A = require('../auth');
const { VISIBLE_SQL } = require('../serialize');
const rt = require('../realtime');

const router = express.Router();
router.use(A.requireRole('patient', 'professional'));

const MSG_COLS = 'id, conversation_id, sender_role, kind, body, read_at, created_at';

// O profissional só enxerga a conversa depois que o paciente manda a primeira mensagem
// (o profissional nunca inicia conversa nem vê quem só abriu o chat).
const PATIENT_WROTE = "EXISTS (SELECT 1 FROM messages pm WHERE pm.conversation_id = c.id AND pm.sender_role = 'patient')";

function side(req) {
  return req.auth.role === 'patient'
    ? { col: 'patient_id', archivedCol: 'archived_by_patient', other: 'professional' }
    : { col: 'professional_id', archivedCol: 'archived_by_professional', other: 'patient' };
}

function loadConversation(req, id) {
  const s = side(req);
  const onlyWritten = req.auth.role === 'professional' ? ` AND ${PATIENT_WROTE}` : '';
  const c = db.prepare(`SELECT * FROM conversations c WHERE id = ? AND ${s.col} = ?${onlyWritten}`).get(Number(id), req.auth.user.id);
  if (!c) throw new U.HttpError(404, 'Conversa não encontrada.');
  return c;
}

function peerOf(role, c) {
  if (role === 'patient') {
    const p = db.prepare('SELECT id, name, photo, profession, status FROM professionals WHERE id = ?').get(c.professional_id);
    return { id: p.id, name: p.name, photo: p.photo, subtitle: p.profession, active: ['aprovado', 'restrito'].includes(p.status) };
  }
  const p = db.prepare('SELECT id, name, display_name, photo, city, state, status FROM patients WHERE id = ?').get(c.patient_id);
  return { id: p.id, name: p.display_name || p.name, full_name: p.name, photo: p.photo, subtitle: `${p.city} - ${p.state}`, active: p.status === 'ativo' };
}

function summarize(role, c) {
  const s = role === 'patient' ? 'archived_by_patient' : 'archived_by_professional';
  const last = db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1`).get(c.id) || null;
  const other = role === 'patient' ? 'professional' : 'patient';
  const unread = db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND sender_role = ? AND read_at IS NULL').get(c.id, other).n;
  return { id: c.id, archived: !!c[s], peer: peerOf(role, c), last_message: last, unread, updated_at: c.last_message_at || c.created_at };
}

router.get('/conversations', (req, res) => {
  const s = side(req);
  const archived = req.query.archived === '1' ? 1 : 0;
  const onlyWritten = req.auth.role === 'professional' ? ` AND ${PATIENT_WROTE}` : '';
  const rows = db.prepare(`SELECT * FROM conversations c WHERE ${s.col} = ? AND ${s.archivedCol} = ?${onlyWritten}
    ORDER BY COALESCE(last_message_at, created_at) DESC`).all(req.auth.user.id, archived);
  const archivedUnread = db.prepare(`SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.${s.col} = ? AND c.${s.archivedCol} = 1 AND m.sender_role = ? AND m.read_at IS NULL`).get(req.auth.user.id, s.other).n;
  const archivedCount = db.prepare(`SELECT COUNT(*) n FROM conversations c WHERE ${s.col} = ? AND ${s.archivedCol} = 1${onlyWritten}`).get(req.auth.user.id).n;
  res.json({ items: rows.map((c) => summarize(req.auth.role, c)), archived_count: archivedCount, archived_unread: archivedUnread });
});

router.get('/conversations/:id', (req, res) => {
  res.json(summarize(req.auth.role, loadConversation(req, req.params.id)));
});

// Paciente abre (ou retoma) conversa com um profissional
router.post('/conversations', (req, res) => {
  if (req.auth.role !== 'patient') throw new U.HttpError(403, 'Somente pacientes iniciam conversas.');
  const proId = Number(req.body.professional_id);
  let c = db.prepare('SELECT * FROM conversations WHERE patient_id = ? AND professional_id = ?').get(req.auth.user.id, proId);
  if (!c) {
    const p = db.prepare(`SELECT id FROM professionals p WHERE id = ? AND ${VISIBLE_SQL}`).get(proId);
    if (!p) throw new U.HttpError(404, 'Profissional indisponível no momento.');
    const info = db.prepare('INSERT INTO conversations (patient_id, professional_id) VALUES (?, ?)').run(req.auth.user.id, proId);
    c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(info.lastInsertRowid));
  } else if (c.archived_by_patient) {
    db.prepare('UPDATE conversations SET archived_by_patient = 0 WHERE id = ?').run(c.id);
    c.archived_by_patient = 0;
  }
  res.json(summarize('patient', c));
});

router.get('/conversations/:id/messages', (req, res) => {
  const c = loadConversation(req, req.params.id);
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const limit = Math.min(Number(req.query.limit) || 60, 200);
  const rows = db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?`).all(c.id, before, limit);
  res.json({ items: rows.reverse(), has_more: rows.length === limit });
});

function postMessage(req, c, kind, body) {
  const role = req.auth.role;
  const sender = req.auth.user;
  const info = db.prepare('INSERT INTO messages (conversation_id, sender_role, kind, body) VALUES (?, ?, ?, ?)').run(c.id, role, kind, body);
  const msg = db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE id = ?`).get(Number(info.lastInsertRowid));
  db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(msg.created_at, c.id);
  rt.emit(`patient:${c.patient_id}`, 'message:new', msg);
  rt.emit(`professional:${c.professional_id}`, 'message:new', msg);
  // Notificação no aparelho de quem recebe
  const to = role === 'patient' ? ['professional', c.professional_id, `/painel#conversas/${c.id}`] : ['patient', c.patient_id, `/app#chat/${c.id}`];
  const from = role === 'patient' ? (sender.display_name || sender.name) : sender.name;
  const text = kind === 'pix' ? 'Enviou a chave Pix para pagamento' : kind === 'call' ? 'Enviou um código de atendimento'
    : kind === 'audio' ? '🎤 Enviou um áudio' : body;
  require('../push').notify(to[0], to[1], {
    title: from, body: text.length > 140 ? `${text.slice(0, 137)}…` : text, url: to[2], tag: `conversa-${c.id}`,
  });
  return msg;
}

router.post('/conversations/:id/messages', (req, res) => {
  const c = loadConversation(req, req.params.id);
  const peer = peerOf(req.auth.role, c);
  if (!peer.active) throw new U.HttpError(403, 'Esta conta não está mais ativa na plataforma.');
  let kind = 'text';
  let body = U.cleanText(req.body.body, 4000);
  if (req.body.kind === 'pix') {
    if (req.auth.role !== 'professional') throw new U.HttpError(403, 'Somente o profissional envia a chave Pix.');
    if (!req.auth.user.pix_key) throw new U.HttpError(400, 'Cadastre sua chave Pix no seu perfil primeiro.');
    kind = 'pix';
    body = req.auth.user.pix_key;
  }
  if (!body) throw new U.HttpError(400, 'Mensagem vazia.');
  res.status(201).json(postMessage(req, c, kind, body));
});

// Mensagem de voz (os dois podem mandar; fotos e vídeos não existem no chat).
// body = "arquivo|segundos|ondas" (ondas = até 64 dígitos 0-9 com a altura das barrinhas, estilo WhatsApp)
router.post('/conversations/:id/audio', async (req, res) => {
  const c = loadConversation(req, req.params.id);
  const peer = peerOf(req.auth.role, c);
  if (!peer.active) throw new U.HttpError(403, 'Esta conta não está mais ativa na plataforma.');
  const { handleAudio } = require('../upload');
  const file = await handleAudio(req, res);
  const secs = Math.max(1, Math.min(600, Math.round(Number(req.body.duration) || 0)));
  const peaks = /^[0-9]{1,64}$/.test(String(req.body.peaks || '')) ? req.body.peaks : '';
  res.status(201).json(postMessage(req, c, 'audio', `${file}|${secs}|${peaks}`));
});

// Ouvir um áudio: só quem participa da conversa
router.get('/audio/:file', async (req, res) => {
  const file = String(req.params.file);
  if (!/^[a-f0-9]{32}\.(wav|webm|ogg|m4a|aac|mp3)$/.test(file)) throw new U.HttpError(404, 'Áudio não encontrado.');
  const s = side(req);
  const ok = db.prepare(`SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.kind = 'audio' AND m.body LIKE ? AND c.${s.col} = ?`).get(`${file}|%`, req.auth.user.id);
  if (!ok) throw new U.HttpError(404, 'Áudio não encontrado.');
  const { AUDIO_DIR } = require('../upload');
  const full = require('node:path').join(AUDIO_DIR, file);
  if (!(await require('../cloud').ensureLocalFile('audio', full))) throw new U.HttpError(404, 'Áudio não encontrado.');
  const types = { wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg' };
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(full, { headers: { 'Content-Type': types[file.split('.').pop()] } });
});

// Apagar a própria mensagem (para todos), a qualquer momento. O conteúdo sai do banco
// (e o arquivo do áudio é apagado); no lugar fica "Mensagem apagada".
router.post('/messages/:id/delete', (req, res) => {
  const role = req.auth.role;
  const s = side(req);
  const m = db.prepare(`SELECT m.*, c.patient_id, c.professional_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = ? AND c.${s.col} = ?`).get(Number(req.params.id), req.auth.user.id);
  if (!m) throw new U.HttpError(404, 'Mensagem não encontrada.');
  if (m.sender_role !== role) throw new U.HttpError(403, 'Você só pode apagar as mensagens que você enviou.');
  if (m.kind === 'deleted') return res.json({ ok: true });
  if (m.kind === 'audio') {
    const file = m.body.split('|')[0];
    if (/^[a-f0-9]{32}\.[a-z0-9]+$/.test(file)) {
      const { AUDIO_DIR } = require('../upload');
      require('node:fs').promises.unlink(require('node:path').join(AUDIO_DIR, file)).catch(() => {});
      require('../cloud').removeFile('audio', file);
    }
  }
  db.prepare("UPDATE messages SET kind = 'deleted', body = '' WHERE id = ?").run(m.id);
  const payload = { id: m.id, conversation_id: m.conversation_id };
  rt.emit(`patient:${m.patient_id}`, 'message:deleted', payload);
  rt.emit(`professional:${m.professional_id}`, 'message:deleted', payload);
  require('../cloud').scheduleBackup();
  res.json({ ok: true });
});

router.post('/conversations/:id/read', (req, res) => {
  const c = loadConversation(req, req.params.id);
  const other = side(req).other;
  const r = db.prepare("UPDATE messages SET read_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE conversation_id = ? AND sender_role = ? AND read_at IS NULL").run(c.id, other);
  if (r.changes) rt.emit(`${other}:${other === 'patient' ? c.patient_id : c.professional_id}`, 'message:read', { conversation_id: c.id });
  res.json({ ok: true });
});

router.post('/conversations/:id/archive', (req, res) => {
  const c = loadConversation(req, req.params.id);
  const s = side(req);
  db.prepare(`UPDATE conversations SET ${s.archivedCol} = ? WHERE id = ?`).run(req.body.archived ? 1 : 0, c.id);
  res.json({ ok: true, archived: !!req.body.archived });
});

router.get('/unread', (req, res) => {
  const s = side(req);
  const n = db.prepare(`SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.${s.col} = ? AND m.sender_role = ? AND m.read_at IS NULL`).get(req.auth.user.id, s.other).n;
  res.json({ unread: n });
});

// Conta apagada: o conteúdo de tudo o que a pessoa mandou é apagado (texto, áudio, Pix…).
// Para a outra pessoa fica "Mensagem apagada".
function eraseMessagesOf(role, userId) {
  const col = role === 'patient' ? 'patient_id' : 'professional_id';
  const rows = db.prepare(`SELECT m.id, m.kind, m.body FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.${col} = ? AND m.sender_role = ? AND m.kind <> 'deleted'`).all(userId, role);
  for (const m of rows) {
    if (m.kind === 'audio') {
      const file = m.body.split('|')[0];
      if (/^[a-f0-9]{32}\.[a-z0-9]+$/.test(file)) {
        const { AUDIO_DIR } = require('../upload');
        require('node:fs').promises.unlink(require('node:path').join(AUDIO_DIR, file)).catch(() => {});
        require('../cloud').removeFile('audio', file);
      }
    }
    db.prepare("UPDATE messages SET kind = 'deleted', body = '' WHERE id = ?").run(m.id);
  }
  return rows.length;
}

module.exports = { router, postMessage, loadConversation, eraseMessagesOf };
