'use strict';
// Área administrativa. Por segurança/sigilo, NÃO existe aqui nenhuma rota que
// leia mensagens ou dados de atendimentos (chamadas).
const express = require('express');
const { db } = require('../db');
const U = require('../util');
const A = require('../auth');
const { isVisible, parsePackages } = require('../serialize');
const { validateProfessionalInput, insertProfessional, requirePassword } = require('./auth');
const { endCall } = require('./calls');
const path = require('node:path');
const { DOC_DIR } = require('../upload');

const router = express.Router();
router.use(A.requireRole('admin'));
// O perfil oficial (Acolia Brasil) não aparece nem é mexido pelas telas de profissionais
router.use('/professionals/:id', (req, _res, next) => {
  if (require('../official').isOfficial(req.params.id)) return next(new U.HttpError(404, 'Profissional não encontrado.'));
  next();
});

const PRO_STATUSES = ['pendente', 'aprovado', 'recusado', 'restrito', 'bloqueado'];

function adminPro(p) {
  return {
    id: p.id, code: p.code, name: p.name, profession: p.profession, registry: p.registry, email: p.email, phone: p.phone,
    status: p.status, state: p.state, city: p.city, photo: p.photo, bio: p.bio, specialties: p.specialties,
    price_cents: p.price_cents, packages: parsePackages(p.packages), has_clinic: !!p.has_clinic,
    clinic_name: p.clinic_name, clinic_address: p.clinic_address, subscription_until: p.subscription_until,
    visible: isVisible(p), admin_note: p.admin_note, created_at: p.created_at,
    has_document: !!p.document_file, document_is_pdf: /\.pdf$/.test(p.document_file || ''),
    registry_verified: !!p.registry_verified, legal_name: p.legal_name || p.name, slug: p.slug, is_test: !!p.is_test,
  };
}

function adminPatient(p) {
  return {
    id: p.id, name: p.name, display_name: p.display_name, cpf: U.formatCpf(p.cpf), cpf_name_verified: !!p.cpf_name_verified,
    state: p.state, city: p.city, photo: p.photo, status: p.status, created_at: p.created_at, is_test: !!p.is_test,
  };
}

function filterRows(rows, q) {
  const state = U.isUf(q.state) ? q.state.toUpperCase() : '';
  const city = U.norm(q.city);
  const text = U.norm(q.q);
  const digits = U.onlyDigits(q.q);
  const matchesText = (r) => !text
    || U.norm(`${r.name} ${r.email || ''} ${r.code || ''} ${r.registry || ''}`).includes(text)
    || (digits.length >= 3 && (r.cpf || '').includes(digits));
  return rows.filter((r) => (!state || r.state === state) && (!city || r.city_norm === city) && matchesText(r));
}

// Onde os dados estão sendo guardados (para o admin conferir se é permanente)
const storageInfo = () => require('../paths').storageStatus();

router.get('/stats', (_req, res) => {
  const g = (sql) => db.prepare(sql).get().n;
  res.json({
    patients: g('SELECT COUNT(*) n FROM patients'),
    patients_blocked: g("SELECT COUNT(*) n FROM patients WHERE status = 'bloqueado'"),
    professionals: g("SELECT COUNT(*) n FROM professionals WHERE status <> 'oficial'"),
    pending: g("SELECT COUNT(*) n FROM professionals WHERE status = 'pendente'"),
    approved: g("SELECT COUNT(*) n FROM professionals WHERE status = 'aprovado'"),
    visible: g("SELECT COUNT(*) n FROM professionals WHERE status = 'aprovado' AND subscription_until >= date('now')"),
    overdue: g("SELECT COUNT(*) n FROM professionals WHERE status = 'aprovado' AND (subscription_until IS NULL OR subscription_until < date('now'))"),
    conversations: g('SELECT COUNT(*) n FROM conversations'),
    messages: g('SELECT COUNT(*) n FROM messages'),
    storage: storageInfo(),
  });
});

// Estados e municípios existentes, para os filtros
router.get('/locations', (_req, res) => {
  const rows = db.prepare(`SELECT state, city FROM patients UNION SELECT state, city FROM professionals WHERE state <> ''`).all();
  const map = {};
  for (const r of rows) {
    map[r.state] ||= new Set();
    map[r.state].add(r.city);
  }
  const out = {};
  for (const [uf, set] of Object.entries(map)) out[uf] = [...set].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  res.json(out);
});

// ---------- Profissionais ----------
router.get('/professionals', (req, res) => {
  let rows = db.prepare("SELECT * FROM professionals WHERE status <> 'oficial' ORDER BY created_at DESC").all();
  if ([...PRO_STATUSES, 'excluido'].includes(req.query.status)) rows = rows.filter((r) => r.status === req.query.status);
  if (req.query.status === 'vencido') rows = rows.filter((r) => r.status === 'aprovado' && !isVisible(r));
  rows = filterRows(rows, req.query);
  res.json({ items: rows.map(adminPro) });
});

router.get('/professionals/:id', (req, res) => {
  const p = db.prepare("SELECT * FROM professionals WHERE id = ? AND status <> 'oficial'").get(Number(req.params.id));
  if (!p) throw new U.HttpError(404, 'Profissional não encontrado.');
  res.json(adminPro(p));
});

// Administrador cadastra um profissional diretamente (já aprovado)
router.post('/professionals', (req, res) => {
  const d = validateProfessionalInput(req.body);
  const password = req.body.password ? String(req.body.password) : U.randomPassword(10);
  requirePassword(password);
  const until = U.addDaysISO(U.todayISO(), Number(req.body.days) > 0 ? Math.min(Number(req.body.days), 3650) : 30);
  const { id, code } = insertProfessional(d, U.hashPassword(password), 'aprovado', until);
  res.status(201).json({ id, code, password });
});

router.post('/professionals/:id/status', (req, res) => {
  const p = db.prepare('SELECT * FROM professionals WHERE id = ?').get(Number(req.params.id));
  if (!p) throw new U.HttpError(404, 'Profissional não encontrado.');
  const status = req.body.status;
  if (!PRO_STATUSES.includes(status) || status === 'pendente') throw new U.HttpError(400, 'Status inválido.');
  if (p.status === 'excluido') throw new U.HttpError(400, 'Esta conta foi excluída pelo próprio profissional.');
  let until = p.subscription_until;
  // Na primeira aprovação, libera o primeiro período de mensalidade
  if (status === 'aprovado' && !until) until = U.addDaysISO(U.todayISO(), 30);
  db.prepare('UPDATE professionals SET status = ?, subscription_until = ? WHERE id = ?').run(status, until, p.id);
  if (['bloqueado', 'recusado'].includes(status)) {
    A.destroyUserSessions('professional', p.id);
    const active = db.prepare("SELECT * FROM calls WHERE professional_id = ? AND status = 'ativo'").get(p.id);
    if (active) endCall(active);
  }
  res.json(adminPro(db.prepare('SELECT * FROM professionals WHERE id = ?').get(p.id)));
});

// Mensalidade: define a data até quando está pago, ou soma dias
router.post('/professionals/:id/subscription', (req, res) => {
  const p = db.prepare('SELECT * FROM professionals WHERE id = ?').get(Number(req.params.id));
  if (!p) throw new U.HttpError(404, 'Profissional não encontrado.');
  let until;
  if (req.body.until === null) until = null;
  else if (req.body.until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.until)) throw new U.HttpError(400, 'Data inválida.');
    until = req.body.until;
  } else {
    const days = Number(req.body.add_days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new U.HttpError(400, 'Quantidade de dias inválida.');
    const base = p.subscription_until && p.subscription_until > U.todayISO() ? p.subscription_until : U.todayISO();
    until = U.addDaysISO(base, days);
  }
  db.prepare('UPDATE professionals SET subscription_until = ? WHERE id = ?').run(until, p.id);
  res.json(adminPro(db.prepare('SELECT * FROM professionals WHERE id = ?').get(p.id)));
});

// Foto/PDF da carteirinha enviada no cadastro (só o admin vê)
router.get('/professionals/:id/document', async (req, res) => {
  const p = db.prepare('SELECT document_file FROM professionals WHERE id = ?').get(Number(req.params.id));
  if (!p?.document_file) throw new U.HttpError(404, 'Carteirinha não enviada.');
  const ok = await require('../cloud').ensureLocalFile('documents', path.join(DOC_DIR, path.basename(p.document_file)));
  if (!ok) throw new U.HttpError(404, 'Arquivo da carteirinha não encontrado.');
  res.setHeader('Cache-Control', 'private, no-store');
  res.sendFile(path.join(DOC_DIR, path.basename(p.document_file)));
});

// O admin pode definir o registro livremente
router.post('/professionals/:id/registry', (req, res) => {
  const registry = U.cleanText(req.body.registry, 40);
  if (registry.length < 2) throw new U.HttpError(400, 'Informe o registro.');
  const r = db.prepare('UPDATE professionals SET registry = ? WHERE id = ?').run(registry, Number(req.params.id));
  if (!r.changes) throw new U.HttpError(404, 'Profissional não encontrado.');
  res.json(adminPro(db.prepare('SELECT * FROM professionals WHERE id = ?').get(Number(req.params.id))));
});

router.post('/professionals/:id/note', (req, res) => {
  db.prepare('UPDATE professionals SET admin_note = ? WHERE id = ?').run(U.cleanText(req.body.note, 1000), Number(req.params.id));
  res.json({ ok: true });
});

router.post('/professionals/:id/reset-password', (req, res) => {
  const p = db.prepare('SELECT id FROM professionals WHERE id = ?').get(Number(req.params.id));
  if (!p) throw new U.HttpError(404, 'Profissional não encontrado.');
  const password = U.randomPassword(10);
  db.prepare('UPDATE professionals SET password_hash = ? WHERE id = ?').run(U.hashPassword(password), p.id);
  A.destroyUserSessions('professional', p.id);
  res.json({ password });
});

// ---------- Contas de teste ----------
// Só contas marcadas como teste podem ser apagadas pelo admin; contas reais nunca.
router.post('/test-accounts', (_req, res) => {
  const T = require('../testAccounts');
  const created = T.ensureTestAccounts();
  res.json({ created, professional: { login: T.PRO.code, password: T.PRO.password }, patient: { cpf: U.formatCpf(T.PATIENT.cpf), password: T.PATIENT.password } });
});

router.post('/professionals/:id/delete-test', (req, res) => {
  const p = db.prepare('SELECT * FROM professionals WHERE id = ?').get(Number(req.params.id));
  if (!p) throw new U.HttpError(404, 'Profissional não encontrado.');
  if (!p.is_test) throw new U.HttpError(403, 'Só contas de teste podem ser apagadas pelo admin.');
  if (p.status === 'excluido') throw new U.HttpError(400, 'Esta conta já foi apagada.');
  require('./professional').wipeProfessional(p);
  // Libera o código para poder criar a conta de teste de novo
  db.prepare('UPDATE professionals SET code = ?, slug = NULL WHERE id = ?').run(`excluido-${p.id}`, p.id);
  res.json({ ok: true });
});

router.post('/patients/:id/delete-test', (req, res) => {
  const p = db.prepare('SELECT * FROM patients WHERE id = ?').get(Number(req.params.id));
  if (!p) throw new U.HttpError(404, 'Paciente não encontrado.');
  if (!p.is_test) throw new U.HttpError(403, 'Só contas de teste podem ser apagadas pelo admin.');
  if (p.status === 'excluido') throw new U.HttpError(400, 'Esta conta já foi apagada.');
  require('./patient').wipePatient(p);
  res.json({ ok: true });
});

// ---------- Pacientes ----------
router.get('/patients', (req, res) => {
  let rows = db.prepare('SELECT * FROM patients ORDER BY created_at DESC').all();
  if (['ativo', 'bloqueado', 'excluido'].includes(req.query.status)) rows = rows.filter((r) => r.status === req.query.status);
  rows = filterRows(rows, req.query);
  res.json({ items: rows.map(adminPatient) });
});

router.post('/patients/:id/status', (req, res) => {
  const status = req.body.status;
  if (!['ativo', 'bloqueado'].includes(status)) throw new U.HttpError(400, 'Status inválido.');
  const r = db.prepare("UPDATE patients SET status = ? WHERE id = ? AND status <> 'excluido'").run(status, Number(req.params.id));
  if (!r.changes) throw new U.HttpError(404, 'Paciente não encontrado.');
  if (status === 'bloqueado') A.destroyUserSessions('patient', Number(req.params.id));
  res.json({ ok: true, status });
});

router.post('/patients/:id/reset-password', (req, res) => {
  const p = db.prepare('SELECT id FROM patients WHERE id = ?').get(Number(req.params.id));
  if (!p) throw new U.HttpError(404, 'Paciente não encontrado.');
  const password = U.randomPassword(10);
  db.prepare('UPDATE patients SET password_hash = ? WHERE id = ?').run(U.hashPassword(password), p.id);
  A.destroyUserSessions('patient', p.id);
  res.json({ password });
});

// ---------- Exportação (CSV, abre no Excel) ----------
function csv(rows, cols) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return '﻿' + [cols.map((c) => esc(c[0])).join(';'), ...rows.map((r) => cols.map((c) => esc(r[c[1]])).join(';'))].join('\r\n');
}

router.get('/export/patients.csv', (req, res) => {
  const rows = filterRows(db.prepare('SELECT * FROM patients ORDER BY name').all(), req.query).map(adminPatient);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pacientes.csv"');
  res.send(csv(rows, [['Nome', 'name'], ['CPF', 'cpf'], ['UF', 'state'], ['Município', 'city'], ['Status', 'status'], ['Cadastro', 'created_at']]));
});

router.get('/export/professionals.csv', (req, res) => {
  const rows = filterRows(db.prepare("SELECT * FROM professionals WHERE status <> 'oficial' ORDER BY name").all(), req.query).map(adminPro);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="profissionais.csv"');
  res.send(csv(rows, [['Nome', 'name'], ['Profissão', 'profession'], ['Registro', 'registry'], ['Código', 'code'], ['E-mail', 'email'],
    ['WhatsApp', 'phone'], ['UF', 'state'], ['Município', 'city'], ['Status', 'status'], ['Mensalidade até', 'subscription_until'], ['Cadastro', 'created_at']]));
});

// ---------- Perfil oficial Acolia Brasil (publicações feitas pela administração) ----------
// A administração só publica e cuida das próprias publicações; não vê o feed nem segue ninguém.
{
  const O = require('../official');
  const S = require('./social');
  const { handlePhoto, handlePhotos, removePhoto } = require('../upload');
  const ownPost = (id) => {
    const p = db.prepare('SELECT * FROM posts WHERE id = ? AND professional_id = ?').get(Number(id), O.officialId());
    if (!p) throw new U.HttpError(404, 'Publicação não encontrada.');
    return p;
  };
  const postRow = (p) => ({
    id: p.id, image: p.image, images: S.postImages(p), caption: p.caption, created_at: p.created_at,
    likes: db.prepare('SELECT COUNT(*) n FROM post_likes WHERE post_id = ?').get(p.id).n,
    comments: db.prepare('SELECT COUNT(*) n FROM post_comments WHERE post_id = ?').get(p.id).n,
  });

  router.get('/official', (req, res) => {
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const rows = db.prepare('SELECT * FROM posts WHERE professional_id = ? ORDER BY id DESC LIMIT 25 OFFSET ?').all(O.officialId(), offset);
    res.json({ profile: O.publicOfficial({ loggedIn: true }), items: rows.slice(0, 24).map(postRow), has_more: rows.length > 24 });
  });

  router.post('/official/instagram', (req, res) => {
    const ig = require('./professional').cleanInstagram(req.body.instagram);
    db.prepare('UPDATE professionals SET instagram = ? WHERE id = ?').run(ig, O.officialId());
    res.json(O.publicOfficial({ loggedIn: true }));
  });

  router.post('/official/posts', async (req, res) => {
    const urls = await handlePhotos(req, res);
    res.status(201).json(postRow(S.createPost(O.officialId(), urls, req.body.caption, req.body.aspect)));
  });

  router.post('/official/posts/:id/thumb', async (req, res) => {
    const p = ownPost(req.params.id);
    const url = await handlePhoto(req, res);
    if (p.thumb) removePhoto(p.thumb);
    db.prepare('UPDATE posts SET thumb = ? WHERE id = ?').run(url, p.id);
    res.json({ ok: true });
  });

  router.delete('/official/posts/:id', (req, res) => {
    S.deletePostFully(ownPost(req.params.id));
    res.json({ ok: true });
  });

  // Comentários nas publicações oficiais: a administração lê e apaga (moderação)
  router.get('/official/posts/:id/comments', (req, res) => {
    const p = ownPost(req.params.id);
    const rows = db.prepare('SELECT * FROM post_comments WHERE post_id = ? ORDER BY id').all(p.id);
    res.json({ items: rows.map((c) => ({ id: c.id, body: c.body, created_at: c.created_at, author: S.actor(c.role, c.user_id) })) });
  });

  router.delete('/official/comments/:id', (req, res) => {
    const c = db.prepare('SELECT c.id FROM post_comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ? AND p.professional_id = ?').get(Number(req.params.id), O.officialId());
    if (!c) throw new U.HttpError(404, 'Comentário não encontrado.');
    db.prepare('DELETE FROM notifications WHERE comment_id = ?').run(c.id);
    db.prepare('DELETE FROM post_comments WHERE id = ?').run(c.id);
    res.json({ ok: true });
  });
}

router.post('/password', (req, res) => {
  const a = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.auth.user.id);
  if (!U.verifyPassword(req.body.current || '', a.password_hash)) throw new U.HttpError(400, 'Senha atual incorreta.');
  if (typeof req.body.password !== 'string' || req.body.password.length < 8) throw new U.HttpError(400, 'A nova senha precisa ter pelo menos 8 caracteres.');
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(U.hashPassword(req.body.password), a.id);
  res.json({ ok: true });
});

module.exports = { router };
