'use strict';
const express = require('express');
const { db } = require('../db');
const U = require('../util');
const A = require('../auth');
const { handlePhoto, removePhoto, removeDocument } = require('../upload');
const { ownProfessional, parseGallery, GALLERY_SLOTS } = require('../serialize');
const { requirePassword, validateLocation } = require('./auth');
const rt = require('../realtime');

const router = express.Router();
router.use(A.requireRole('professional'));

// Aceita "@nome", "nome" ou o link do perfil; guarda só o nome de usuário
function cleanInstagram(v) {
  let h = String(v || '').trim();
  const m = h.match(/instagram\.com\/([^/?#\s]+)/i);
  if (m) h = m[1];
  h = h.replace(/^@+/, '');
  if (!h) return '';
  if (!/^[A-Za-z0-9._]{1,30}$/.test(h)) throw new U.HttpError(400, 'Instagram inválido. Digite só o seu @ (letras, números, ponto e _).');
  return h;
}

const SESSION_MINUTES = [30, 40, 45, 50, 60, 90, 120];

function toCents(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw new U.HttpError(400, 'Valor inválido.');
  return Math.round(n * 100);
}

router.get('/me', (req, res) => res.json(ownProfessional(req.auth.user)));

router.put('/profile', async (req, res) => {
  const b = req.body;
  const name = U.cleanText(b.name, 120);
  if (!U.isFullName(name)) throw new U.HttpError(400, 'Informe nome e sobrenome.');
  // Pode encurtar o nome (ex.: só nome e sobrenome), mas só com palavras do nome da carteirinha
  const legal = new Set(U.norm(req.auth.user.legal_name || req.auth.user.name).split(' '));
  if (!U.norm(name).split(' ').every((w) => legal.has(w))) {
    throw new U.HttpError(400, `Use apenas partes do seu nome registrado (${req.auth.user.legal_name || req.auth.user.name}).`);
  }
  // Profissão e registro (carteirinha) só a administração altera
  const { profession, registry } = req.auth.user;
  const phone = U.onlyDigits(b.phone);
  if (phone.length < 10 || phone.length > 13) throw new U.HttpError(400, 'Informe o WhatsApp com DDD.');
  const { state, city } = validateLocation(b.state, b.city);
  const price = toCents(b.price);

  const packages = (Array.isArray(b.packages) ? b.packages : []).slice(0, 10).map((pk) => {
    const sessions = Number.parseInt(pk.sessions, 10);
    if (!Number.isInteger(sessions) || sessions < 2 || sessions > 100) throw new U.HttpError(400, 'Cada pacote precisa ter de 2 a 100 sessões.');
    const cents = toCents(pk.price);
    if (!cents) throw new U.HttpError(400, 'Informe o valor de cada pacote.');
    return { sessions, price_cents: cents, description: U.cleanText(pk.description, 120) };
  });

  const hasClinic = b.has_clinic ? 1 : 0;
  const clinicName = hasClinic ? U.cleanText(b.clinic_name, 120) : '';
  const clinicAddress = hasClinic ? U.cleanText(b.clinic_address, 250) : '';
  if (hasClinic && clinicAddress.length < 5) throw new U.HttpError(400, 'Informe o endereço da clínica.');
  const maps = require('../maps');
  let mapsUrl = hasClinic ? maps.cleanMapsUrl(b.maps_url) : '';
  let mapsQuery = '';
  if (mapsUrl) {
    // Só consulta o link curto de novo se ele mudou
    const prev = req.auth.user;
    mapsQuery = prev.maps_url === mapsUrl && prev.maps_query ? prev.maps_query : maps.mapQuery(await maps.resolveShort(mapsUrl));
  }

  const minutes = b.session_minutes ? Number(b.session_minutes) : null;
  if (minutes !== null && !SESSION_MINUTES.includes(minutes)) throw new U.HttpError(400, 'Escolha a duração da sessão.');
  const instagram = cleanInstagram(b.instagram);

  db.prepare(`UPDATE professionals SET name=?, profession=?, registry=?, phone=?, bio=?, specialties=?, price_cents=?, packages=?,
      state=?, city=?, city_norm=?, has_clinic=?, clinic_name=?, clinic_address=?, pix_key=?, session_minutes=?, instagram=?, maps_url=?, maps_query=? WHERE id=?`)
    .run(name, profession, registry, phone, U.cleanText(b.bio, 2000), U.cleanText(b.specialties, 300), price, JSON.stringify(packages),
      state, city, U.norm(city), hasClinic, clinicName, clinicAddress, U.cleanText(b.pix_key, 140), minutes, instagram, mapsUrl, mapsQuery, req.auth.user.id);
  res.json(ownProfessional(db.prepare('SELECT * FROM professionals WHERE id = ?').get(req.auth.user.id)));
});

router.post('/photo', async (req, res) => {
  const url = await handlePhoto(req, res);
  removePhoto(req.auth.user.photo);
  db.prepare('UPDATE professionals SET photo = ? WHERE id = ?').run(url, req.auth.user.id);
  for (const c of db.prepare('SELECT id, patient_id FROM conversations WHERE professional_id = ?').all(req.auth.user.id)) {
    rt.emit(`patient:${c.patient_id}`, 'conversation:peer', { conversation_id: c.id });
  }
  res.json(ownProfessional(db.prepare('SELECT * FROM professionals WHERE id = ?').get(req.auth.user.id)));
});

// Galeria: Foto 1 a Foto 6 (cada posição pode ser trocada ou removida)
function gallerySlot(req) {
  const slot = Number(req.params.slot);
  if (!Number.isInteger(slot) || slot < 1 || slot > GALLERY_SLOTS) throw new U.HttpError(400, 'Foto inválida.');
  return slot - 1;
}

router.post('/gallery/:slot', async (req, res) => {
  const i = gallerySlot(req);
  const url = await handlePhoto(req, res);
  const me = db.prepare('SELECT * FROM professionals WHERE id = ?').get(req.auth.user.id);
  const g = parseGallery(me.gallery);
  removePhoto(g[i]);
  g[i] = url;
  db.prepare('UPDATE professionals SET gallery = ? WHERE id = ?').run(JSON.stringify(g), me.id);
  res.json(ownProfessional(db.prepare('SELECT * FROM professionals WHERE id = ?').get(me.id)));
});

router.delete('/gallery/:slot', (req, res) => {
  const i = gallerySlot(req);
  const me = db.prepare('SELECT * FROM professionals WHERE id = ?').get(req.auth.user.id);
  const g = parseGallery(me.gallery);
  removePhoto(g[i]);
  g[i] = null;
  db.prepare('UPDATE professionals SET gallery = ? WHERE id = ?').run(JSON.stringify(g), me.id);
  res.json(ownProfessional(db.prepare('SELECT * FROM professionals WHERE id = ?').get(me.id)));
});

// O profissional exclui a própria conta: sai da vitrine, os dados pessoais são apagados
// e as conversas continuam para os pacientes com o nome "Profissional removido".
router.post('/delete', (req, res) => {
  const me = req.auth.user;
  if (!U.verifyPassword(req.body.password || '', me.password_hash)) throw new U.HttpError(400, 'Senha incorreta.');
  wipeProfessional(me);
  A.destroySession(req, res);
  res.json({ ok: true });
});

// Apaga os dados pessoais (usado pelo próprio profissional e, nas contas de teste, pelo admin)
function wipeProfessional(me) {
  const active = db.prepare("SELECT * FROM calls WHERE professional_id = ? AND status = 'ativo'").get(me.id);
  if (active) require('./calls').endCall(active);
  removePhoto(me.photo);
  parseGallery(me.gallery).forEach(removePhoto);
  removeDocument(me.document_file);
  db.prepare(`UPDATE professionals SET status = 'excluido', name = 'Profissional removido', legal_name = NULL, registry = ?, email = ?,
    phone = '', bio = '', specialties = '', photo = NULL, document_file = NULL, pix_key = '', clinic_name = '', clinic_address = '',
    has_clinic = 0, instagram = '', gallery = '[]', maps_url = '', maps_query = '', password_hash = '!' WHERE id = ?`).run(`excluido-${me.id}`, `excluido-${me.id}@removido.acolia`, me.id);
  db.prepare('DELETE FROM favorites WHERE professional_id = ?').run(me.id);
  for (const c of db.prepare('SELECT id, patient_id FROM conversations WHERE professional_id = ?').all(me.id)) {
    rt.emit(`patient:${c.patient_id}`, 'conversation:peer', { conversation_id: c.id });
  }
  A.destroyUserSessions('professional', me.id);
  require('../push').removeUser('professional', me.id);
}

router.post('/slug', (req, res) => {
  const slug = require('../slug').validateSlug(req.body.slug);
  const taken = db.prepare('SELECT 1 FROM professionals WHERE slug = ? AND id <> ?').get(slug, req.auth.user.id);
  if (taken) throw new U.HttpError(409, 'Este link já está em uso por outro profissional. Tente outro.');
  db.prepare('UPDATE professionals SET slug = ? WHERE id = ?').run(slug, req.auth.user.id);
  res.json(ownProfessional(db.prepare('SELECT * FROM professionals WHERE id = ?').get(req.auth.user.id)));
});

router.post('/password', (req, res) => {
  if (!U.verifyPassword(req.body.current || '', req.auth.user.password_hash)) throw new U.HttpError(400, 'Senha atual incorreta.');
  requirePassword(req.body.password);
  db.prepare('UPDATE professionals SET password_hash = ? WHERE id = ?').run(U.hashPassword(req.body.password), req.auth.user.id);
  res.json({ ok: true });
});

module.exports = { router, wipeProfessional };
