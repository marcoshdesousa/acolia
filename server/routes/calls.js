'use strict';
const express = require('express');
const { db, tx } = require('../db');
const U = require('../util');
const A = require('../auth');
const rt = require('../realtime');
const { postMessage, loadConversation } = require('./chat');

const router = express.Router();

function cleanCode(c) {
  return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
}

// Código do paciente = 2 primeiros caracteres do código do profissional + 6 aleatórios
function newPatientCode(proCode) {
  for (;;) {
    const code = proCode.slice(0, 2) + U.randomMixedCode(6);
    const clash = db.prepare("SELECT 1 FROM calls WHERE status = 'ativo' AND patient_code = ?").get(code)
      || db.prepare('SELECT 1 FROM professionals WHERE code = ?').get(code);
    if (!clash) return code;
  }
}

// O profissional pode ter até 2 atendimentos abertos ao mesmo tempo
const MAX_ACTIVE_CALLS = 2;

function activeCalls(proId) {
  return db.prepare("SELECT * FROM calls WHERE professional_id = ? AND status = 'ativo' ORDER BY id").all(proId);
}

function endCall(call) {
  db.prepare("UPDATE calls SET status = 'finalizado', ended_at = datetime('now') WHERE id = ? AND status = 'ativo'").run(call.id);
  rt.emit(`call:${call.id}`, 'call:ended', { id: call.id });
  require('../cloud').scheduleBackup();
  if (rt.io) rt.io.in(`call:${call.id}`).socketsLeave(`call:${call.id}`);
}

// Resolve um código digitado na tela "Entrar no atendimento"
function resolveCode(code, auth) {
  code = cleanCode(code);
  if (code.length < 6) throw new U.HttpError(400, 'Digite o código do atendimento.');
  const pro = db.prepare('SELECT * FROM professionals WHERE code = ?').get(code);
  if (pro) {
    if (auth?.role !== 'professional' || auth.user.id !== pro.id) {
      throw new U.HttpError(403, 'Este é um código de profissional. Entre na sua conta de profissional para iniciar o atendimento.');
    }
    const calls = activeCalls(pro.id);
    if (!calls.length) throw new U.HttpError(404, 'Você não tem atendimento criado. Crie um atendimento no seu painel primeiro.');
    if (calls.length > 1) throw new U.HttpError(409, 'Você tem 2 atendimentos abertos. Entre pelo botão "Entrar na chamada" de cada um no seu painel.');
    return { role: 'host', call: calls[0], pro };
  }
  const call = db.prepare("SELECT * FROM calls WHERE patient_code = ? AND status = 'ativo'").get(code);
  if (!call) throw new U.HttpError(404, 'Código inválido ou atendimento já finalizado. Peça um novo código ao profissional.');
  const p = db.prepare('SELECT * FROM professionals WHERE id = ?').get(call.professional_id);
  // O próprio profissional, logado, entra no atendimento dele pelo código do paciente (como anfitrião)
  if (auth?.role === 'professional' && auth.user.id === p.id) return { role: 'host', call, pro: p };
  return { role: 'guest', call, pro: p };
}

router.post('/resolve', (req, res) => {
  const r = resolveCode(req.body.code, req.auth);
  res.json({
    role: r.role,
    call: { id: r.call.id, patient_label: r.call.patient_label },
    professional: { name: r.pro.name, photo: r.pro.photo, profession: r.pro.profession, registry: r.pro.registry },
  });
});

router.use(A.requireRole('professional'));

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM calls WHERE professional_id = ? ORDER BY id DESC LIMIT 50').all(req.auth.user.id);
  const actives = activeCalls(req.auth.user.id);
  res.json({ active: actives[0] || null, actives, max_active: MAX_ACTIVE_CALLS, items: rows });
});

router.post('/', (req, res) => {
  const label = U.cleanText(req.body.patient_label, 80);
  if (label.length < 2) throw new U.HttpError(400, 'Informe o nome (ou um nome fictício) do paciente.');
  const pro = req.auth.user;
  let conv = null;
  if (req.body.conversation_id) conv = loadConversation(req, req.body.conversation_id);
  const call = tx(() => {
    if (activeCalls(pro.id).length >= MAX_ACTIVE_CALLS) {
      throw new U.HttpError(409, `Você já tem ${MAX_ACTIVE_CALLS} atendimentos em aberto. Finalize um deles antes de criar outro.`);
    }
    const code = newPatientCode(pro.code);
    const info = db.prepare('INSERT INTO calls (professional_id, patient_label, patient_code) VALUES (?, ?, ?)').run(pro.id, label, code);
    return db.prepare('SELECT * FROM calls WHERE id = ?').get(Number(info.lastInsertRowid));
  });
  if (conv) postMessage(req, conv, 'call', call.patient_code);
  res.status(201).json(call);
});

router.post('/:id/end', (req, res) => {
  const call = db.prepare('SELECT * FROM calls WHERE id = ? AND professional_id = ?').get(Number(req.params.id), req.auth.user.id);
  if (!call) throw new U.HttpError(404, 'Atendimento não encontrado.');
  endCall(call);
  res.json({ ok: true });
});

module.exports = { router, resolveCode, endCall, cleanCode };
