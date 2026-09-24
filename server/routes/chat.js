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
const PATIENT_WROTE = 'c.patient_wrote = 1';

// ---------- Apagar e bloquear ----------
// Apagar mensagem (uma a uma, só as suas): é para todos — o conteúdo sai do banco e os DOIS lados
// veem "Mensagem apagada". "Limpar conversa": some só para quem limpou (o outro continua vendo).
// Quando os dois lados limparam a mesma mensagem, ela sai do banco de vez (junto com o áudio).
const hideCol = (role) => (role === 'patient' ? 'hidden_for_patient' : 'hidden_for_professional');
function removeAudioFile(m) {
  if (m.kind !== 'audio') return;
  const file = String(m.body).split('|')[0];
  if (!/^[a-f0-9]{32}\.[a-z0-9]+$/.test(file)) return;
  const { AUDIO_DIR } = require('../upload');
  require('node:fs').promises.unlink(require('node:path').join(AUDIO_DIR, file)).catch(() => {});
  require('../cloud').removeFile('audio', file);
}
function purgeHidden(conversationId) {
  const rows = db.prepare('SELECT id, kind, body FROM messages WHERE conversation_id = ? AND hidden_for_patient = 1 AND hidden_for_professional = 1').all(conversationId);
  for (const m of rows) {
    removeAudioFile(m);
    db.prepare('DELETE FROM messages WHERE id = ?').run(m.id);
  }
  return rows.length;
}
// Bloqueio (só mensagens): quem bloqueou e quem foi bloqueado não trocam mais mensagens
function blocksOf(c) {
  const rows = db.prepare('SELECT blocker_role FROM chat_blocks WHERE conversation_id = ?').all(c.id).map((r) => r.blocker_role);
  return { patient: rows.includes('patient'), professional: rows.includes('professional') };
}
function assertCanSend(role, c) {
  const b = blocksOf(c);
  const other = role === 'patient' ? 'professional' : 'patient';
  if (b[role]) throw new U.HttpError(403, `Você bloqueou este ${other === 'patient' ? 'paciente' : 'profissional'}. Desbloqueie para mandar mensagens.`);
  if (b[other]) throw new U.HttpError(403, 'Não é possível enviar mensagens nesta conversa.');
}

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
  const hc = hideCol(role);
  const last = db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE conversation_id = ? AND ${hc} = 0 ORDER BY id DESC LIMIT 1`).get(c.id) || null;
  const other = role === 'patient' ? 'professional' : 'patient';
  const unread = db.prepare(`SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND sender_role = ? AND read_at IS NULL AND ${hc} = 0`).get(c.id, other).n;
  const b = blocksOf(c);
  return { id: c.id, archived: !!c[s], peer: peerOf(role, c), last_message: last, unread, updated_at: c.last_message_at || c.created_at,
    blocked_by_me: b[role], blocked_me: b[other] };
}

router.get('/conversations', (req, res) => {
  const s = side(req);
  const archived = req.query.archived === '1' ? 1 : 0;
  const onlyWritten = req.auth.role === 'professional' ? ` AND ${PATIENT_WROTE}` : '';
  const notBlocked = 'AND NOT EXISTS (SELECT 1 FROM chat_blocks b WHERE b.conversation_id = c.id AND b.blocker_role = ?)';
  const rows = db.prepare(`SELECT * FROM conversations c WHERE ${s.col} = ? AND ${s.archivedCol} = ?${onlyWritten} ${notBlocked}
    ORDER BY COALESCE(last_message_at, created_at) DESC`).all(req.auth.user.id, archived, req.auth.role);
  const blockedCount = db.prepare(`SELECT COUNT(*) n FROM conversations c JOIN chat_blocks b ON b.conversation_id = c.id AND b.blocker_role = ?
    WHERE c.${s.col} = ?`).get(req.auth.role, req.auth.user.id).n;
  const archivedUnread = db.prepare(`SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.${s.col} = ? AND c.${s.archivedCol} = 1 AND m.sender_role = ? AND m.read_at IS NULL AND m.${hideCol(req.auth.role)} = 0`).get(req.auth.user.id, s.other).n;
  const archivedCount = db.prepare(`SELECT COUNT(*) n FROM conversations c WHERE ${s.col} = ? AND ${s.archivedCol} = 1${onlyWritten}`).get(req.auth.user.id).n;
  res.json({ items: rows.map((c) => summarize(req.auth.role, c)), archived_count: archivedCount, archived_unread: archivedUnread, blocked_count: blockedCount });
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
  const rows = db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE conversation_id = ? AND id < ? AND ${hideCol(req.auth.role)} = 0 ORDER BY id DESC LIMIT ?`).all(c.id, before, limit);
  res.json({ items: rows.reverse(), has_more: rows.length === limit });
});

function postMessage(req, c, kind, body) {
  const role = req.auth.role;
  const sender = req.auth.user;
  assertCanSend(role, c);
  const info = db.prepare('INSERT INTO messages (conversation_id, sender_role, kind, body) VALUES (?, ?, ?, ?)').run(c.id, role, kind, body);
  const msg = db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE id = ?`).get(Number(info.lastInsertRowid));
  db.prepare(`UPDATE conversations SET last_message_at = ?${role === 'patient' ? ', patient_wrote = 1' : ''} WHERE id = ?`).run(msg.created_at, c.id);
  rt.emit(`patient:${c.patient_id}`, 'message:new', msg);
  rt.emit(`professional:${c.professional_id}`, 'message:new', msg);
  // Notificação no aparelho de quem recebe
  const to = role === 'patient' ? ['professional', c.professional_id, `/painel#conversas/${c.id}`] : ['patient', c.patient_id, `/app#chat/${c.id}`];
  const from = role === 'patient' ? (sender.display_name || sender.name) : sender.name;
  const text = kind === 'pix' ? 'Enviou a chave Pix para pagamento' : kind === 'call' ? 'Enviou um código de atendimento'
    : kind === 'audio' ? '🎤 Enviou um áudio' : kind === 'doc' ? `📄 Enviou um documento: ${String(body).split('|')[1] || ''}` : body;
  require('../push').notify(to[0], to[1], {
    title: from, body: text.length > 140 ? `${text.slice(0, 137)}…` : text, url: to[2], tag: `conversa-${c.id}`,
  });
  return msg;
}

router.post('/conversations/:id/messages', (req, res) => {
  const c = loadConversation(req, req.params.id);
  const peer = peerOf(req.auth.role, c);
  if (!peer.active) throw new U.HttpError(403, 'Esta conta não está mais ativa na plataforma.');
  assertCanSend(req.auth.role, c);
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
  assertCanSend(req.auth.role, c);
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

// Apagar mensagem. body.for = 'me' (qualquer mensagem, só some para mim) ou 'everyone'
// (só quem enviou: o conteúdo sai do banco, o outro vê "Mensagem apagada" e para mim some).
router.post('/messages/:id/delete', (req, res) => {
  const role = req.auth.role;
  const s = side(req);
  const m = db.prepare(`SELECT m.*, c.patient_id, c.professional_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = ? AND c.${s.col} = ?`).get(Number(req.params.id), req.auth.user.id);
  // Já não existe (apagada em outro aparelho, toque duplo, ou os dois lados já tinham apagado): tudo certo
  if (!m) return res.json({ ok: true, gone: true });
  const mode = req.body.for === 'me' ? 'me' : req.body.for === 'everyone' ? 'everyone' : (m.sender_role === role ? 'everyone' : 'me');
  if (mode === 'everyone') {
    if (m.sender_role !== role) throw new U.HttpError(403, 'Você só pode apagar para todos as mensagens que você enviou.');
    if (m.kind !== 'deleted') {
      removeAudioFile(m);
      // Documento apagado para todos: fica cancelado (a verificação pelo QR mostra "cancelado")
      if (m.kind === 'doc') db.prepare("UPDATE documents SET revoked_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE code = ?").run(String(m.body).split('|')[0]);
      db.prepare("UPDATE messages SET kind = 'deleted', body = '' WHERE id = ?").run(m.id);
    }
    // Os dois lados (e os outros aparelhos de quem apagou) passam a ver "Mensagem apagada"
    const ev = { id: m.id, conversation_id: m.conversation_id };
    rt.emit(`patient:${m.patient_id}`, 'message:deleted', ev);
    rt.emit(`professional:${m.professional_id}`, 'message:deleted', ev);
  } else {
    db.prepare(`UPDATE messages SET ${hideCol(role)} = 1 WHERE id = ?`).run(m.id);
    rt.emit(`${role}:${req.auth.user.id}`, 'message:removed', { id: m.id, conversation_id: m.conversation_id });
    purgeHidden(m.conversation_id);
  }
  require('../cloud').scheduleBackup();
  res.json({ ok: true, for: mode });
});

// Limpar conversa: apaga todas as mensagens só para mim (o outro lado continua vendo)
function clearFor(role, c) {
  db.prepare(`UPDATE messages SET ${hideCol(role)} = 1 WHERE conversation_id = ?`).run(c.id);
  return purgeHidden(c.id);
}
router.post('/conversations/:id/clear', (req, res) => {
  const c = loadConversation(req, req.params.id);
  clearFor(req.auth.role, c);
  res.json({ ok: true });
});

// Bloquear / desbloquear (só as mensagens). Ao bloquear, a conversa é limpa para quem bloqueou.
function notifyBlock(c) {
  rt.emit(`patient:${c.patient_id}`, 'chat:block', { conversation_id: c.id });
  rt.emit(`professional:${c.professional_id}`, 'chat:block', { conversation_id: c.id });
}
router.post('/conversations/:id/block', (req, res) => {
  const c = loadConversation(req, req.params.id);
  db.prepare('INSERT OR IGNORE INTO chat_blocks (conversation_id, blocker_role) VALUES (?, ?)').run(c.id, req.auth.role);
  clearFor(req.auth.role, c);
  notifyBlock(c);
  res.json(summarize(req.auth.role, c));
});
router.delete('/conversations/:id/block', (req, res) => {
  const c = loadConversation(req, req.params.id);
  db.prepare('DELETE FROM chat_blocks WHERE conversation_id = ? AND blocker_role = ?').run(c.id, req.auth.role);
  notifyBlock(c);
  res.json(summarize(req.auth.role, c));
});
// Quem eu bloqueei (para desbloquear)
router.get('/blocks', (req, res) => {
  const s = side(req);
  const rows = db.prepare(`SELECT c.* FROM conversations c JOIN chat_blocks b ON b.conversation_id = c.id AND b.blocker_role = ?
    WHERE c.${s.col} = ? ORDER BY b.created_at DESC`).all(req.auth.role, req.auth.user.id);
  res.json({ items: rows.map((c) => ({ conversation_id: c.id, peer: peerOf(req.auth.role, c) })) });
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
    WHERE c.${s.col} = ? AND m.sender_role = ? AND m.read_at IS NULL AND m.${hideCol(req.auth.role)} = 0
      AND NOT EXISTS (SELECT 1 FROM chat_blocks b WHERE b.conversation_id = c.id AND b.blocker_role = ?)`).get(req.auth.user.id, s.other, req.auth.role).n;
  res.json({ unread: n });
});

// Conta apagada: as conversas dessa pessoa somem por completo — mensagens dos dois lados
// (com os áudios), bloqueios e a própria conversa saem do banco.
function eraseMessagesOf(role, userId) {
  const col = role === 'patient' ? 'patient_id' : 'professional_id';
  let n = 0;
  for (const c of db.prepare(`SELECT id, patient_id, professional_id FROM conversations WHERE ${col} = ?`).all(userId)) {
    for (const m of db.prepare("SELECT id, kind, body FROM messages WHERE conversation_id = ? AND kind = 'audio'").all(c.id)) removeAudioFile(m);
    n += db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(c.id).changes;
    db.prepare('DELETE FROM chat_blocks WHERE conversation_id = ?').run(c.id);
    try { db.prepare('DELETE FROM documents WHERE conversation_id = ?').run(c.id); } catch { /* tabela ainda não existe */ }
    // Atendimentos (videochamadas) criados nesta conversa também somem (levam o nome do paciente)
    for (const call of db.prepare("SELECT * FROM calls WHERE conversation_id = ?").all(c.id)) {
      if (call.status === 'ativo') require('./calls').endCall(call);
      db.prepare('DELETE FROM calls WHERE id = ?').run(call.id);
    }
    db.prepare('DELETE FROM conversations WHERE id = ?').run(c.id);
    rt.emit(`patient:${c.patient_id}`, 'conversation:peer', { conversation_id: c.id });
    rt.emit(`professional:${c.professional_id}`, 'conversation:peer', { conversation_id: c.id });
  }
  return n;
}

module.exports = { router, postMessage, loadConversation, eraseMessagesOf, assertCanSend };
