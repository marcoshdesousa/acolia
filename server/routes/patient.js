'use strict';
const express = require('express');
const { db } = require('../db');
const U = require('../util');
const A = require('../auth');
const { handlePhoto, removePhoto } = require('../upload');
const { ownPatient, VISIBLE_SQL } = require('../serialize');
const { requirePassword } = require('./auth');
const rt = require('../realtime');

const router = express.Router();
router.use(A.requireRole('patient'));

router.put('/profile', (req, res) => {
  const display = U.cleanText(req.body.display_name, 60);
  db.prepare('UPDATE patients SET display_name = ? WHERE id = ?').run(display, req.auth.user.id);
  const me = db.prepare('SELECT * FROM patients WHERE id = ?').get(req.auth.user.id);
  broadcastIdentity(me);
  res.json(ownPatient(me));
});

router.post('/photo', async (req, res) => {
  const url = await handlePhoto(req, res);
  removePhoto(req.auth.user.photo);
  db.prepare('UPDATE patients SET photo = ? WHERE id = ?').run(url, req.auth.user.id);
  const me = db.prepare('SELECT * FROM patients WHERE id = ?').get(req.auth.user.id);
  broadcastIdentity(me);
  res.json(ownPatient(me));
});

// A própria pessoa exclui a conta. Os dados pessoais são apagados; as mensagens
// continuam para o profissional (não podem ser apagadas), com o nome "Conta excluída".
router.post('/delete', (req, res) => {
  const me = req.auth.user;
  // Confirmação: o próprio CPF (ou a senha)
  const byCpf = req.body.cpf !== undefined;
  const ok = byCpf ? U.onlyDigits(req.body.cpf) === me.cpf : U.verifyPassword(req.body.password || '', me.password_hash);
  if (!ok) throw new U.HttpError(400, byCpf ? 'CPF não confere com o da sua conta.' : 'Senha incorreta.');
  wipePatient(me);
  A.destroySession(req, res);
  res.json({ ok: true });
});

// Apaga os dados pessoais (usado pela própria pessoa e, nas contas de teste, pelo admin)
function wipePatient(me) {
  // Apaga tudo: curtidas, comentários, quem seguia e o conteúdo das mensagens que mandou.
  // O CPF fica livre para criar uma conta nova.
  require('./social').purgeUserSocial('patient', me.id);
  require('./chat').eraseMessagesOf('patient', me.id);
  removePhoto(me.photo);
  db.prepare("DELETE FROM favorites WHERE patient_id = ?").run(me.id);
  db.prepare(`UPDATE patients SET status = 'excluido', name = 'Conta excluída', display_name = '', cpf = ?, cpf_name_verified = 0,
    state = '', city = '', city_norm = '', photo = NULL, password_hash = '!' WHERE id = ?`).run(`excluido-${me.id}`, me.id);
  broadcastIdentity(me);
  A.destroyUserSessions('patient', me.id);
  require('../push').removeUser('patient', me.id);
}

router.post('/password', (req, res) => {
  if (!U.verifyPassword(req.body.current || '', req.auth.user.password_hash)) throw new U.HttpError(400, 'Senha atual incorreta.');
  requirePassword(req.body.password);
  db.prepare('UPDATE patients SET password_hash = ? WHERE id = ?').run(U.hashPassword(req.body.password), req.auth.user.id);
  res.json({ ok: true });
});

router.post('/favorites/:id', (req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare(`SELECT id FROM professionals p WHERE id = ? AND ${VISIBLE_SQL}`).get(id);
  if (!p) throw new U.HttpError(404, 'Profissional não encontrado.');
  db.prepare('INSERT OR IGNORE INTO favorites (patient_id, professional_id) VALUES (?, ?)').run(req.auth.user.id, id);
  res.json({ ok: true, favorite: true });
});

router.delete('/favorites/:id', (req, res) => {
  db.prepare('DELETE FROM favorites WHERE patient_id = ? AND professional_id = ?').run(req.auth.user.id, Number(req.params.id));
  res.json({ ok: true, favorite: false });
});

// Atualiza nome/foto do paciente nas conversas abertas dos profissionais
function broadcastIdentity(me) {
  const convs = db.prepare('SELECT id, professional_id FROM conversations WHERE patient_id = ?').all(me.id);
  for (const c of convs) {
    rt.emit(`professional:${c.professional_id}`, 'conversation:peer', { conversation_id: c.id });
  }
}

module.exports = { router, wipePatient };
