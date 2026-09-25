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
const cleanInstagram = (v) => require('../social').clean('instagram', v);

const SESSION_MINUTES = [30, 40, 45, 50, 60, 90, 120];

function toCents(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw new U.HttpError(400, 'Valor inválido.');
  return Math.round(n * 100);
}

router.get('/me', (req, res) => {
  const me = ownProfessional(req.auth.user);
  // Secretária: sem o código único e sem a chave Pix
  if (req.auth.secretary) { delete me.code; delete me.pix_key; me.secretary = { login: req.auth.secretary.login }; }
  res.json(me);
});

// ---------- Secretária (versão 1.1.3): uma por profissional; login e senha gerados pelo sistema ----------
const SEC = require('../secretary');
router.get('/secretary', (req, res) => res.json({ secretary: SEC.ofPro(req.auth.user.id) }));
router.post('/secretary', (req, res) => {
  const creds = SEC.create(req.auth.user.id);
  res.status(201).json({ secretary: SEC.ofPro(req.auth.user.id), ...creds });
});
router.post('/secretary/password', (req, res) => {
  const creds = SEC.resetPassword(req.auth.user.id);
  res.json({ secretary: SEC.ofPro(req.auth.user.id), ...creds });
});
router.delete('/secretary', (req, res) => { SEC.remove(req.auth.user.id); res.json({ secretary: null }); });

// ---------- Mensagens prontas (até 10): no chat, o "+" ao lado do campo de digitar coloca a mensagem inteira ----------
const QUICK_MAX = 10;
const QUICK_LEN = 1000;
function quickOf(pro) {
  try { const l = JSON.parse(pro.quick_replies || '[]'); return Array.isArray(l) ? l.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
router.get('/quick-replies', (req, res) => res.json({ items: quickOf(req.auth.user), max: QUICK_MAX }));
router.put('/quick-replies', (req, res) => {
  if (!Array.isArray(req.body.items)) throw new U.HttpError(400, 'Envie a lista de mensagens.');
  const items = req.body.items.map((t) => String(t ?? '').replace(/\r\n/g, '\n').trim()).filter(Boolean);
  if (items.length > QUICK_MAX) throw new U.HttpError(400, `Você pode deixar até ${QUICK_MAX} mensagens prontas.`);
  if (items.some((t) => t.length > QUICK_LEN)) throw new U.HttpError(400, `Cada mensagem pronta pode ter até ${QUICK_LEN} letras.`);
  db.prepare('UPDATE professionals SET quick_replies = ? WHERE id = ?').run(JSON.stringify(items), req.auth.user.id);
  res.json({ items, max: QUICK_MAX });
});

router.put('/profile', async (req, res) => {
  let b = req.body;
  // Secretária (versão 1.1.3): muda só redes sociais, plano de saúde, localização e clínica.
  // Nome, WhatsApp, e-mail, especialidades, "Sobre você" e valor continuam os do profissional.
  if (req.auth.secretary) {
    const u = req.auth.user;
    b = { ...b, name: u.name, phone: u.phone, email: u.email, bio: u.bio, specialties: u.specialties,
      price: u.price_cents != null ? (u.price_cents / 100).toFixed(2).replace('.', ',') : '' };
  }
  const name = U.cleanText(b.name, 120);
  if (!U.isFullName(name)) throw new U.HttpError(400, 'Informe nome e sobrenome.');
  // Pode encurtar o nome (ex.: só nome e sobrenome), mas só com palavras do nome da carteirinha
  const legal = new Set(U.norm(req.auth.user.legal_name || req.auth.user.name).split(' '));
  if (!U.norm(name).split(' ').every((w) => legal.has(w))) {
    throw new U.HttpError(400, `Use apenas partes do seu nome registrado (${req.auth.user.legal_name || req.auth.user.name}).`);
  }
  // Profissão, registro (carteirinha) e código só a administração altera. WhatsApp e e-mail ele muda.
  const { profession, registry } = req.auth.user;
  const phone = U.onlyDigits(b.phone);
  if (phone.length < 10 || phone.length > 13) throw new U.HttpError(400, 'Informe o WhatsApp com DDD.');
  let email = req.auth.user.email;
  if (b.email !== undefined) {
    email = U.cleanText(b.email, 160).toLowerCase();
    if (!U.isValidEmail(email)) throw new U.HttpError(400, 'E-mail inválido.');
    if (db.prepare('SELECT 1 FROM professionals WHERE email = ? AND id <> ?').get(email, req.auth.user.id)) throw new U.HttpError(409, 'Este e-mail já está em uso em outra conta.');
  }
  const { state, city } = validateLocation(b.state, b.city);
  const price = toCents(b.price);
  // Especialidades: pode acrescentar e tirar à vontade, mas fica pelo menos uma
  const specialties = require('../specialties').parse(b.specialties, req.auth.user.specialties);

  const packages = []; // pacotes saíram: a consulta pela agenda é avulsa (pacote se combina pelo chat)

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

  // Duração e chave Pix agora ficam em Consultas (a tela do perfil não manda mais; mantém o que já tem)
  const minutes = b.session_minutes === undefined ? req.auth.user.session_minutes : (b.session_minutes ? Number(b.session_minutes) : null);
  if (minutes !== null && !SESSION_MINUTES.includes(minutes)) throw new U.HttpError(400, 'Escolha a duração da sessão.');
  const pixKey = b.pix_key === undefined ? req.auth.user.pix_key : U.cleanText(b.pix_key, 140);
  // Redes sociais: cada uma só aceita o @ ou o link da própria rede
  const social = require('../social').fromBody(b, req.auth.user);

  db.prepare(`UPDATE professionals SET name=?, profession=?, registry=?, phone=?, bio=?, specialties=?, price_cents=?, packages=?,
      state=?, city=?, city_norm=?, has_clinic=?, clinic_name=?, clinic_address=?, pix_key=?, session_minutes=?, instagram=?, maps_url=?, maps_query=? WHERE id=?`)
    .run(name, profession, registry, phone, U.cleanText(b.bio, 2000), require('../specialties').store(specialties), price, JSON.stringify(packages),
      state, city, U.norm(city), hasClinic, clinicName, clinicAddress, pixKey, minutes, social.instagram, mapsUrl, mapsQuery, req.auth.user.id);
  db.prepare('UPDATE professionals SET tiktok = ?, x_handle = ?, youtube = ? WHERE id = ?').run(social.tiktok, social.x_handle, social.youtube, req.auth.user.id);
  // Plano de saúde: o profissional escolhe (vale para online e presencial; detalhes ele combina pelo chat)
  db.prepare('UPDATE professionals SET email = ?, accepts_insurance = ? WHERE id = ?').run(email, b.accepts_insurance ? 1 : 0, req.auth.user.id);
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
  // Confirmação: o código de acesso da conta (ou a senha)
  const byCode = req.body.code !== undefined;
  const ok = byCode ? String(req.body.code).trim().toUpperCase() === String(me.code).toUpperCase() : U.verifyPassword(req.body.password || '', me.password_hash);
  if (!ok) throw new U.HttpError(400, byCode ? 'Código não confere com o da sua conta.' : 'Senha incorreta.');
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
  // Apaga tudo: publicações, reels, stories, curtidas, comentários, seguidores e o conteúdo das
  // mensagens que ele mandou. E-mail, registro, código e link ficam livres para um cadastro novo.
  require('./social').purgeUserSocial('professional', me.id);
  require('../secretary').remove(me.id);
  require('../agenda').onAccountGone('professional', me.id);
  // Agenda e pagamento automático saem junto (inclusive o Asaas simulado da conta de teste)
  db.prepare('DELETE FROM pro_payment WHERE professional_id = ?').run(me.id);
  db.prepare('DELETE FROM agenda_hours WHERE professional_id = ?').run(me.id);
  db.prepare('DELETE FROM agenda_blocks WHERE professional_id = ?').run(me.id);
  require('./chat').eraseMessagesOf('professional', me.id);
  db.prepare(`UPDATE professionals SET status = 'excluido', name = 'Profissional removido', legal_name = NULL, registry = ?, email = ?,
    phone = '', bio = '', specialties = '', photo = NULL, document_file = NULL, pix_key = '', clinic_name = '', clinic_address = '',
    has_clinic = 0, instagram = '', tiktok = '', x_handle = '', youtube = '', quick_replies = '[]', gallery = '[]', maps_url = '', maps_query = '', password_hash = '!', code = ?, slug = NULL,
    packages = '[]', price_cents = NULL, session_minutes = NULL, admin_note = '', city = '', city_norm = '', state = '' WHERE id = ?`)
    .run(`excluido-${me.id}`, `excluido-${me.id}@removido.acolia`, `excluido-${me.id}`, me.id);
  db.prepare('DELETE FROM favorites WHERE professional_id = ?').run(me.id);
  db.prepare("DELETE FROM calls WHERE professional_id = ? AND status <> 'ativo'").run(me.id); // histórico de atendimentos some junto
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

// ---------- Meus pacientes: quem já fez consulta (chamada iniciada) com este profissional ----------
// Filtro por nome completo ou CPF; dá para baixar em PDF ou planilha (Excel). Só os pacientes dele.
// Período (datas do Brasil, AAAA-MM-DD): conta só as consultas feitas entre "de" e "até".
// As consultas ficam gravadas em UTC; o Brasil (Brasília) está 3 h atrás.
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
function attendedPatients(proId, { q = '', from = '', to = '' } = {}) {
  const f = isDate(from) ? from : null;
  const t = isDate(to) ? to : null;
  const rows = db.prepare(`
    WITH att AS (
      SELECT COALESCE(ca.conversation_id,
        (SELECT m.conversation_id FROM messages m WHERE m.kind = 'call' AND m.body = ca.patient_code LIMIT 1)) AS conv,
        datetime(ca.started_at, '-3 hours') AS at
      FROM calls ca WHERE ca.professional_id = ? AND ca.started_at IS NOT NULL
        AND (? IS NULL OR ca.started_at >= datetime(? || ' 00:00:00', '+3 hours'))
        AND (? IS NULL OR ca.started_at <= datetime(? || ' 23:59:59', '+3 hours')))
    SELECT pa.id, pa.name, pa.cpf, pa.birth_date, pa.city, pa.state, COUNT(*) AS consultas, MIN(att.at) AS primeira, MAX(att.at) AS ultima
    FROM att JOIN conversations c ON c.id = att.conv AND c.professional_id = ?
    JOIN patients pa ON pa.id = c.patient_id AND pa.status <> 'excluido'
    GROUP BY pa.id ORDER BY ultima DESC`).all(proId, f, f, t, t, proId);
  const text = U.norm(q || '').trim();
  const digits = U.onlyDigits(q || '');
  const list = !text ? rows : rows.filter((r) => U.norm(r.name).includes(text) || (digits.length >= 3 && r.cpf.includes(digits)));
  const br = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');
  return list.map((r) => ({
    id: r.id, name: r.name, cpf: U.formatCpf(r.cpf), birth_date: br(r.birth_date), place: `${r.city} - ${r.state}`,
    consultas: r.consultas, primeira: br(r.primeira), ultima: br(r.ultima),
  }));
}
const filtersOf = (query) => ({ q: query.q, from: query.from, to: query.to });
function periodText({ from, to }) {
  const br = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
  if (isDate(from) && isDate(to)) return `de ${br(from)} a ${br(to)}`;
  if (isDate(from)) return `a partir de ${br(from)}`;
  if (isDate(to)) return `até ${br(to)}`;
  return 'todo o período';
}
const totalsOf = (rows) => ({ patients: rows.length, consultations: rows.reduce((a, r) => a + r.consultas, 0) });

const PATIENT_COLS = [['Nome completo', 'name', 30], ['CPF', 'cpf', 13], ['Nascimento', 'birth_date', 10], ['Município', 'place', 20], ['Consultas', 'consultas', 8], ['Primeira', 'primeira', 10], ['Última', 'ultima', 10]];

router.get('/patients', (req, res) => {
  const items = attendedPatients(req.auth.user.id, filtersOf(req.query));
  res.json({ items, totals: totalsOf(items), period: periodText(req.query) });
});
router.get('/patients.csv', (req, res) => {
  const rows = attendedPatients(req.auth.user.id, filtersOf(req.query));
  const tot = totalsOf(rows);
  const e = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [PATIENT_COLS.map((c) => e(c[0])).join(';'), ...rows.map((r) => PATIENT_COLS.map((c) => e(r[c[1]])).join(';')),
    '', e(`Período: ${periodText(req.query)}`),
    `${e('Total de pacientes')};${e(tot.patients)}`, `${e('Total de consultas')};${e(tot.consultations)}`];
  const body = '﻿' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="meus-pacientes.csv"');
  res.send(body);
});
// PDF montado na hora e enviado direto (não fica salvo no servidor); sem limite de páginas
router.get('/patients.pdf', (req, res) => {
  const me = req.auth.user;
  const rows = attendedPatients(me.id, filtersOf(req.query));
  const tot = totalsOf(rows);
  const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
  const pdf = require('../pdfTable').makeTablePdf({
    title: 'Meus pacientes',
    subtitle: `${me.legal_name || me.name} · ${me.profession}${me.registry ? ` · ${me.registry}` : ''} · Período: ${periodText(req.query)} · ${tot.patients} paciente${tot.patients === 1 ? '' : 's'} · ${tot.consultations} consulta${tot.consultations === 1 ? '' : 's'}${req.query.q ? ` · busca: "${String(req.query.q).slice(0, 40)}"` : ''}`,
    columns: PATIENT_COLS.map(([label, key, width]) => ({ label, key, width })),
    rows,
    footer: `Gerado pela plataforma Acolia em ${now}. Documento confidencial: contém dados pessoais de pacientes (LGPD).`,
    summary: `Total: ${tot.patients} paciente${tot.patients === 1 ? '' : 's'} · ${tot.consultations} consulta${tot.consultations === 1 ? '' : 's'} · Período: ${periodText(req.query)}`,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="meus-pacientes.pdf"');
  res.send(pdf);
});

module.exports = { router, wipeProfessional, cleanInstagram };
