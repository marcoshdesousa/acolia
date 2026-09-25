'use strict';
const express = require('express');
const { db } = require('../db');
const U = require('../util');
const A = require('../auth');
const { handlePhoto, removePhoto } = require('../upload');
const { ownPatient, VISIBLE_SQL } = require('../serialize');
const { requirePassword, validateLocation } = require('./auth');
const rt = require('../realtime');

const router = express.Router();
router.use(A.requireRole('patient'));

// Pode mudar: o @ (único) e onde mora (estado/município).
// Não muda: nome completo do CPF, CPF e data de nascimento (vão nos documentos). O nome que aparece
// para os profissionais é sempre o nome registrado (não existe mais "nome exibido").
router.put('/profile', (req, res) => {
  if (req.body.handle !== undefined) {
    const H = require('../handles');
    const h = H.assertFree(H.validate(req.body.handle), req.auth.user.id);
    db.prepare('UPDATE patients SET handle = ? WHERE id = ?').run(h, req.auth.user.id);
  }
  if (req.body.state !== undefined || req.body.city !== undefined) {
    const { state, city } = validateLocation(req.body.state, req.body.city);
    db.prepare('UPDATE patients SET state = ?, city = ?, city_norm = ? WHERE id = ?').run(state, city, U.norm(city), req.auth.user.id);
  }
  const me = db.prepare('SELECT * FROM patients WHERE id = ?').get(req.auth.user.id);
  broadcastIdentity(me);
  res.json(ownPatient(me));
});

// Sugestão de @ livre (botão "Gerar @")
router.get('/handle/suggest', (req, res) => res.json({ handle: require('../handles').generate(req.auth.user.name, req.auth.user.id) }));

// Contas antigas (sem data de nascimento): informa uma vez só. Depois não muda mais.
router.post('/birth-date', (req, res) => {
  if (req.auth.user.birth_date) throw new U.HttpError(400, 'A data de nascimento já foi informada e não pode ser alterada.');
  const birth = String(req.body.birth_date || '');
  if (!U.isValidBirthDate(birth)) throw new U.HttpError(400, 'Informe uma data de nascimento válida.');
  db.prepare('UPDATE patients SET birth_date = ? WHERE id = ? AND birth_date IS NULL').run(birth, req.auth.user.id);
  res.json(ownPatient(db.prepare('SELECT * FROM patients WHERE id = ?').get(req.auth.user.id)));
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
  require('./support').purge('patient', me.id);
  require('../agenda').onAccountGone('patient', me.id);
  require('./chat').eraseMessagesOf('patient', me.id);
  db.prepare('DELETE FROM pro_patient_hidden WHERE patient_id = ?').run(me.id);
  removePhoto(me.photo);
  db.prepare("DELETE FROM favorites WHERE patient_id = ?").run(me.id);
  db.prepare(`UPDATE patients SET status = 'excluido', name = 'Conta excluída', display_name = '', handle = NULL, cpf = ?, cpf_name_verified = 0, birth_date = NULL,
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
