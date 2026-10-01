'use strict';
// Painel da clínica: dados do perfil, logo, link, senha e excluir a conta.
// O nome e o CPF/CNPJ do responsável só a administração muda (como o CPF do profissional).
const express = require('express');
const { db } = require('../db');
const U = require('../util');
const A = require('../auth');
const C = require('../clinics');

const router = express.Router();
router.use(A.requireRole('clinic'));
const me = (req) => db.prepare('SELECT * FROM clinics WHERE id = ?').get(req.auth.user.id);

router.get('/me', (req, res) => res.json(C.ownClinic(me(req))));

router.put('/profile', async (req, res) => {
  const cur = me(req);
  const b = req.body || {};
  const { validateLocation } = require('./auth');
  const email = U.cleanText(b.email ?? cur.email, 160).toLowerCase();
  if (!U.isValidEmail(email)) throw new U.HttpError(400, 'E-mail inválido.');
  if (db.prepare("SELECT 1 FROM clinics WHERE email = ? AND id <> ? AND status <> 'excluido'").get(email, cur.id)) throw new U.HttpError(409, 'Este e-mail já está em uso em outra clínica.');
  const phone = U.onlyDigits(b.phone ?? cur.phone);
  if (phone.length < 10 || phone.length > 13) throw new U.HttpError(400, 'Informe o WhatsApp com DDD.');
  const { state, city } = validateLocation(b.state ?? cur.state, b.city ?? cur.city);
  const address = U.cleanText(b.address ?? cur.address, 250);
  if (address.length < 5) throw new U.HttpError(400, 'Informe o endereço completo da clínica.');
  const maps = require('../maps');
  const mapsUrl = maps.cleanMapsUrl(b.maps_url ?? cur.maps_url);
  // Link do Maps é opcional: sem ele, o mapa usa o endereço
  const fallback = `${address}, ${city} - ${state}`;
  const mapsQuery = mapsUrl && mapsUrl === cur.maps_url && cur.maps_query && address === cur.address ? cur.maps_query : maps.mapQuery(mapsUrl ? await maps.resolveShort(mapsUrl) : '', fallback);
  const hasDoctors = b.has_doctors === undefined ? cur.has_doctors : (b.has_doctors === true || b.has_doctors === '1' || b.has_doctors === 1 ? 1 : 0);
  const doctors = hasDoctors ? C.parseDoctors(b.doctors ?? cur.doctors) : [];
  if (hasDoctors && !doctors.length) throw new U.HttpError(400, 'Escolha quais médicos atendem na clínica (ou marque que não tem).');
  const social = require('../social').fromBody(b, cur);
  db.prepare(`UPDATE clinics SET email = ?, phone = ?, state = ?, city = ?, city_norm = ?, address = ?, maps_url = ?, maps_query = ?, has_doctors = ?, doctors = ?,
      bio = ?, instagram = ?, tiktok = ?, x_handle = ?, youtube = ? WHERE id = ?`)
    .run(email, phone, state, city, U.norm(city), address, mapsUrl, mapsQuery, hasDoctors, JSON.stringify(doctors), U.cleanText(b.bio ?? cur.bio, 1500),
      social.instagram, social.tiktok, social.x_handle, social.youtube, cur.id);
  res.json(C.ownClinic(me(req)));
});

router.post('/logo', async (req, res) => {
  const { handlePhoto, removePhoto } = require('../upload');
  const url = await handlePhoto(req, res);
  const old = me(req).logo;
  db.prepare('UPDATE clinics SET logo = ? WHERE id = ?').run(url, req.auth.user.id);
  if (old) removePhoto(old);
  res.json(C.ownClinic(me(req)));
});

router.post('/slug', (req, res) => {
  const S = require('../slug');
  const slug = S.validateSlug(req.body.slug);
  if (S.slugTaken(db, slug, { clinicId: req.auth.user.id })) throw new U.HttpError(409, 'Este link já está em uso. Tente outro.');
  db.prepare('UPDATE clinics SET slug = ? WHERE id = ?').run(slug, req.auth.user.id);
  res.json(C.ownClinic(me(req)));
});

router.post('/password', (req, res) => {
  const cur = me(req);
  if (!U.verifyPassword(req.body.current || '', cur.password_hash)) throw new U.HttpError(400, 'A senha atual está incorreta.');
  require('./auth').requirePassword(req.body.password);
  db.prepare('UPDATE clinics SET password_hash = ? WHERE id = ?').run(U.hashPassword(req.body.password), cur.id);
  res.json({ ok: true });
});

// A própria clínica apaga a conta (confirma com o código de acesso). O CPF/CNPJ fica livre.
function wipeClinic(c) {
  require('../upload').removePhoto(c.logo);
  // Some tudo do feed: publicações, stories, seguidores, curtidas e comentários da clínica; e os vínculos com profissionais
  require('./social').purgeUserSocial('clinic', c.id);
  db.prepare('DELETE FROM clinic_members WHERE clinic_id = ?').run(c.id);
  db.prepare(`UPDATE clinics SET status = 'excluido', name = 'Clínica removida', doc = NULL, responsible = '', email = ?, phone = '', logo = NULL, bio = '',
    address = '', maps_url = '', maps_query = '', doctors = '[]', slug = NULL, password_hash = '!', code = ?, instagram = '', tiktok = '', x_handle = '', youtube = '' WHERE id = ?`)
    .run(`excluido-${c.id}@removido.acolia`, `excluido-c${c.id}`, c.id);
  A.destroyUserSessions('clinic', c.id);
}
router.post('/delete', (req, res) => {
  const cur = me(req);
  if (String(req.body.code || '').trim().toUpperCase() !== cur.code) throw new U.HttpError(400, 'O código de acesso não confere.');
  wipeClinic(cur);
  res.json({ ok: true });
});

module.exports = { router, wipeClinic };
