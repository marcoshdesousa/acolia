'use strict';
// Avisos da Acolia (admin): aparecem no sininho de pacientes, profissionais (e das secretárias deles)
// ou de todos. Texto e, se quiser, uma foto (vídeo não).
const express = require('express');
const { db, tx } = require('../db');
const U = require('../util');
const rt = require('../realtime');

db.exec(`CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY,
  audience TEXT NOT NULL,                  -- patient | professional | all
  text TEXT NOT NULL,
  image TEXT,
  sent_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const AUD = { patient: 'Pacientes', professional: 'Profissionais', all: 'Todos' };
const admin = express.Router();

// Foto do aviso: sobe antes e volta o endereço
admin.post('/photo', async (req, res) => {
  const url = await require('../upload').handlePhoto(req, res);
  res.status(201).json({ image: url });
});

admin.post('/', (req, res) => {
  const audience = AUD[req.body.audience] ? req.body.audience : null;
  if (!audience) throw new U.HttpError(400, 'Escolha para quem vai o aviso.');
  const text = U.cleanText(req.body.text, 2000);
  if (!text) throw new U.HttpError(400, 'Escreva o aviso.');
  const image = /^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(String(req.body.image || '')) ? req.body.image : null;
  const to = [];
  if (audience !== 'professional') for (const r of db.prepare("SELECT id FROM patients WHERE status = 'ativo'").all()) to.push(['patient', r.id]);
  if (audience !== 'patient') for (const r of db.prepare("SELECT id FROM professionals WHERE status IN ('aprovado', 'restrito', 'bloqueado')").all()) to.push(['professional', r.id]);
  const notice = tx(() => {
    const info = db.prepare('INSERT INTO notices (audience, text, image, sent_count) VALUES (?, ?, ?, ?)').run(audience, text, image, to.length);
    const id = Number(info.lastInsertRowid);
    const ins = db.prepare("INSERT INTO notifications (recipient_role, recipient_id, type, notice_id) VALUES (?, ?, 'aviso', ?)");
    for (const [role, uid] of to) ins.run(role, uid, id);
    return db.prepare('SELECT * FROM notices WHERE id = ?').get(id);
  });
  const push = require('../push');
  for (const [role, uid] of to) {
    rt.emit(`${role}:${uid}`, 'social:notification', { type: 'aviso' });
    push.notify(role, uid, { title: '📣 Aviso da Acolia', body: text.length > 140 ? `${text.slice(0, 137)}…` : text, url: role === 'patient' ? '/app' : '/painel', tag: `aviso-${notice.id}` });
  }
  res.status(201).json(notice);
});

admin.get('/', (_req, res) => res.json({ items: db.prepare('SELECT * FROM notices ORDER BY id DESC LIMIT 100').all() }));

admin.delete('/:id', (req, res) => {
  const n = db.prepare('SELECT * FROM notices WHERE id = ?').get(Number(req.params.id));
  if (!n) throw new U.HttpError(404, 'Aviso não encontrado.');
  db.prepare('DELETE FROM notifications WHERE notice_id = ?').run(n.id);
  db.prepare('DELETE FROM notices WHERE id = ?').run(n.id);
  res.json({ ok: true });
});

const get = (id) => db.prepare('SELECT id, text, image, created_at FROM notices WHERE id = ?').get(id) || null;
module.exports = { admin, get };
