'use strict';
// Área administrativa. Por segurança/sigilo, NÃO existe aqui nenhuma rota que
// leia mensagens ou dados de atendimentos (chamadas).
const express = require('express');
const { db } = require('../db');
const U = require('../util');
const A = require('../auth');
const { isVisible } = require('../serialize');
const { validateProfessionalInput, insertProfessional, requirePassword } = require('./auth');
const { endCall } = require('./calls');
const path = require('node:path');
const { DOC_DIR } = require('../upload');

const router = express.Router();
router.use(A.requireRole('admin'));
// Suporte Acolia: caixa de entrada do admin (responder e mandar para todos os profissionais)
router.use('/support', require('./support').admin);
// Avisos no sininho (pacientes, profissionais ou todos)
router.use('/notices', require('./notices').admin);
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
    price_cents: p.price_cents, has_clinic: !!p.has_clinic,
    clinic_name: p.clinic_name, clinic_address: p.clinic_address, subscription_until: p.subscription_until,
    visible: isVisible(p), admin_note: p.admin_note, created_at: p.created_at,
    has_document: !!p.document_file, document_is_pdf: /\.pdf$/.test(p.document_file || ''),
    registry_verified: !!p.registry_verified, legal_name: p.legal_name || p.name, slug: p.slug, is_test: !!p.is_test,
    plan: p.plan ? (require('./auth').PLANS[p.plan] || p.plan) : null,
  };
}

function adminPatient(p) {
  return {
    id: p.id, name: p.name, display_name: p.display_name, handle: p.handle || '', cpf: U.formatCpf(p.cpf), cpf_name_verified: !!p.cpf_name_verified,
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

// Quanto espaço está sendo usado no disco (fotos, vídeos, áudios, documentos, banco).
// Conta os arquivos de verdade; guarda o resultado por 5 segundos (só para não repetir a conta
// várias vezes ao abrir a tela — logo depois de publicar ou apagar, o número já aparece certo).
let usageCache = { at: 0, data: null };
function diskUsage() {
  if (Date.now() - usageCache.at < 5e3 && usageCache.data) return usageCache.data;
  const fs = require('node:fs');
  const path = require('node:path');
  const { DATA_DIR } = require('../paths');
  const sizeOf = (dir, pick = () => true) => {
    let total = 0;
    let count = 0;
    try {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!f.isFile() || !pick(f.name)) continue;
        try { total += fs.statSync(path.join(dir, f.name)).size; count++; } catch { /* sumiu */ }
      }
    } catch { /* pasta não existe */ }
    return { bytes: total, count };
  };
  const up = path.join(DATA_DIR, 'uploads');
  const isVideo = (n) => /\.(mp4|mov|webm)$/i.test(n);
  const parts = {
    fotos: sizeOf(up, (n) => !isVideo(n)),
    videos: sizeOf(up, isVideo),
    audios: sizeOf(path.join(DATA_DIR, 'audio')),
    fotos_chat: sizeOf(path.join(DATA_DIR, 'chat-photos')),
    documentos: sizeOf(path.join(DATA_DIR, 'documents')),
    envios: sizeOf(path.join(DATA_DIR, 'uploads-parts')),
    banco: sizeOf(DATA_DIR, (n) => /\.db(-wal|-shm)?$/.test(n)),
  };
  let disk = null;
  // Tamanho do disco só quando é o disco permanente (no Render: /var/data); fora dele seria o disco da máquina
  if (['disco'].includes(require('../paths').storageStatus().mode)) try {
    const st = fs.statfsSync(DATA_DIR);
    disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
  } catch { /* sem informação do disco */ }
  const used = Object.values(parts).reduce((a, b) => a + b.bytes, 0);
  usageCache = { at: Date.now(), data: { used, parts, disk } };
  return usageCache.data;
}

router.get('/stats', (_req, res) => {
  const g = (sql) => db.prepare(sql).get().n;
  res.json({
    patients: g('SELECT COUNT(*) n FROM patients'),
    patients_blocked: g("SELECT COUNT(*) n FROM patients WHERE status = 'bloqueado'"),
    professionals: g("SELECT COUNT(*) n FROM professionals WHERE status <> 'oficial'"),
    pending: g("SELECT COUNT(*) n FROM professionals WHERE status = 'pendente'"),
    approved: g("SELECT COUNT(*) n FROM professionals WHERE status = 'aprovado'"),
    visible: g("SELECT COUNT(*) n FROM professionals WHERE status = 'aprovado' AND subscription_until >= date('now', '-1 day')"),
    overdue: g("SELECT COUNT(*) n FROM professionals WHERE status = 'aprovado' AND (subscription_until IS NULL OR subscription_until < date('now', '-1 day'))"),
    conversations: g('SELECT COUNT(*) n FROM conversations'),
    messages: g('SELECT COUNT(*) n FROM messages'),
    storage: storageInfo(),
    usage: diskUsage(),
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
// O admin também não cadastra CRP/CRM inválido: psicólogo, neuropsicólogo e psiquiatra precisam de
// registro válido e do mesmo estado (e, com a consulta ao conselho configurada, o nome tem que bater).
// Psicanalista, psicoterapeuta e terapeuta (sem conselho) podem ser cadastrados sem registro.
router.post('/professionals', async (req, res) => {
  const d = validateProfessionalInput(req.body);
  const R = require('../registry');
  if (R.councilFor(d.profession)) {
    const reg = R.validateRegistry(d.profession, req.body.registry, d.state);
    if (db.prepare('SELECT 1 FROM professionals WHERE registry = ?').get(reg.registry)) {
      throw new U.HttpError(409, `Já existe um cadastro com o ${reg.registry}.`);
    }
    if (R.isApiConfigured()) {
      const v = await R.verifyRegistry(reg, d.name);
      if (v.error) throw new U.HttpError(503, 'Não foi possível consultar o conselho agora. Tente novamente em alguns minutos.');
      if (!v.match) throw new U.HttpError(400, v.message || 'O registro não confere com o nome informado.');
      d.registry_verified = true;
    }
    d.registry = reg.registry;
  }
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
  // Aprovado e ainda sem senha (se cadastrou pelo site): gera a primeira senha para o admin mandar pelo WhatsApp
  let newPassword = null;
  if (status === 'aprovado' && p.password_hash === require('./auth').NO_PASSWORD) {
    newPassword = U.randomPassword(10);
    db.prepare('UPDATE professionals SET password_hash = ? WHERE id = ?').run(U.hashPassword(newPassword), p.id);
  }
  // Bloqueado fica na lista (mesmo que apague a conta e crie outra); qualquer outro status libera
  if (status === 'bloqueado') require('../blocklist').block('professional', p);
  else if (p.status === 'bloqueado') require('../blocklist').unblock('professional', p);
  // Bloqueado: continua conseguindo entrar, mas só vê a tela de bloqueio (o aparelho recarrega na hora)
  if (status === 'bloqueado') require('../realtime').emit(`professional:${p.id}`, 'account:blocked', {});
  if (status === 'recusado') A.destroyUserSessions('professional', p.id);
  if (['bloqueado', 'recusado'].includes(status)) {
    const active = db.prepare("SELECT * FROM calls WHERE professional_id = ? AND status = 'ativo'").get(p.id);
    if (active) endCall(active);
  }
  res.json({ ...adminPro(db.prepare('SELECT * FROM professionals WHERE id = ?').get(p.id)), new_password: newPassword });
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

// Teste da agenda do dono: ver o que está pronto e preparar de novo (não mexe nos horários)
router.get('/test-agenda', (_req, res) => res.json(require('../testAgenda').status()));
router.post('/test-agenda/prepare', (_req, res) => {
  require('../testAgenda').provision({ withHours: false });
  res.json(require('../testAgenda').status());
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

// Apagar a conta de verdade (qualquer conta): some tudo — fotos, publicações, reels, stories,
// curtidas, comentários, dados pessoais e o conteúdo das mensagens que a pessoa mandou.
// CPF / e-mail / registro ficam livres: a pessoa pode criar uma conta nova depois.
router.post('/professionals/:id/delete', (req, res) => {
  const p = db.prepare('SELECT * FROM professionals WHERE id = ?').get(Number(req.params.id));
  if (!p) throw new U.HttpError(404, 'Profissional não encontrado.');
  if (p.status === 'excluido') throw new U.HttpError(400, 'Esta conta já foi apagada.');
  require('../blocklist').unblock('professional', p); // o admin apagou: pode se cadastrar de novo (passa pela aprovação)
  require('./professional').wipeProfessional(p);
  res.json({ ok: true });
});

router.post('/patients/:id/delete', (req, res) => {
  const p = db.prepare('SELECT * FROM patients WHERE id = ?').get(Number(req.params.id));
  if (!p) throw new U.HttpError(404, 'Paciente não encontrado.');
  if (p.status === 'excluido') throw new U.HttpError(400, 'Esta conta já foi apagada.');
  require('../blocklist').unblock('patient', p); // o admin apagou: a pessoa pode criar a conta de novo
  require('./patient').wipePatient(p);
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
  const pat = db.prepare('SELECT * FROM patients WHERE id = ?').get(Number(req.params.id));
  if (status === 'bloqueado') require('../blocklist').block('patient', pat);
  else require('../blocklist').unblock('patient', pat);
  if (status === 'bloqueado') require('../realtime').emit(`patient:${Number(req.params.id)}`, 'account:blocked', {});
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

// ---------- Limite de publicações por profissional ----------
// GET: limites atuais. ?photo=&reel= mostra quantas publicações seriam apagadas com esses números.
router.get('/limits', (req, res) => {
  const S = require('./social');
  const lim = S.getLimits();
  const out = { photo: lim.photo, reel: lim.reel };
  const p = Number(req.query.photo);
  const r = Number(req.query.reel);
  if (Number.isInteger(p) && Number.isInteger(r) && p > 0 && r > 0) {
    out.would_remove = { photo: S.overLimit('photo', p).length, reel: S.overLimit('reel', r).length };
  }
  res.json(out);
});

// POST: salva e já aplica — quem passar do novo limite perde as publicações mais antigas
router.post('/limits', (req, res) => {
  const photo = Number(req.body.photo);
  const reel = Number(req.body.reel);
  const ok = (n) => Number.isInteger(n) && n >= 1 && n <= 500;
  if (!ok(photo) || !ok(reel)) throw new U.HttpError(400, 'Use números de 1 a 500.');
  const S = require('./social');
  S.setLimits({ photo, reel });
  const removed = S.enforceLimits();
  res.json({ photo, reel, removed });
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
    id: p.id, kind: p.kind || 'photo', video: p.video || null, font: p.font || null, image: p.image, images: S.postImages(p), caption: p.caption, created_at: p.created_at,
    likes: db.prepare('SELECT COUNT(*) n FROM post_likes WHERE post_id = ?').get(p.id).n,
    comments: db.prepare('SELECT COUNT(*) n FROM post_comments WHERE post_id = ?').get(p.id).n,
  });

  router.get('/official', (req, res) => {
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const rows = db.prepare('SELECT * FROM posts WHERE professional_id = ? ORDER BY id DESC LIMIT 25 OFFSET ?').all(O.officialId(), offset);
    res.json({ profile: O.publicOfficial({ loggedIn: true }), items: rows.slice(0, 24).map(postRow), has_more: rows.length > 24 });
  });

  // Redes sociais do perfil da Acolia (Instagram, TikTok, X, YouTube)
  router.post(['/official/social', '/official/instagram'], (req, res) => {
    const cur = db.prepare('SELECT * FROM professionals WHERE id = ?').get(O.officialId());
    const v = require('../social').fromBody(req.body, cur);
    db.prepare('UPDATE professionals SET instagram = ?, tiktok = ?, x_handle = ?, youtube = ? WHERE id = ?').run(v.instagram, v.tiktok, v.x_handle, v.youtube, O.officialId());
    res.json(O.publicOfficial({ loggedIn: true }));
  });

  router.post('/official/posts', async (req, res) => {
    const urls = await handlePhotos(req, res);
    res.status(201).json(postRow(S.createPost(O.officialId(), urls, req.body.caption, req.body.aspect)));
  });

  // Texto do perfil oficial (sem foto), com uma das 4 fontes
  router.post('/official/texts', (req, res) => {
    res.status(201).json(postRow(S.createText(O.officialId(), req.body.text, req.body.font)));
  });

  // Vídeo da Acolia Brasil em pedaços (igual ao dos profissionais): aguenta vídeo grande e internet instável
  const UPL = require('../upload');
  const offUpload = (id) => {
    const u = db.prepare('SELECT * FROM upload_sessions WHERE id = ? AND professional_id = ?').get(String(id), O.officialId());
    if (!u) throw new U.HttpError(404, 'Envio não encontrado. Comece de novo.');
    return u;
  };
  router.post('/official/uploads', (req, res) => {
    const mime = String(req.body.mime || '').split(';')[0].toLowerCase();
    const size = Number(req.body.size);
    if (!(mime in UPL.VIDEO_EXT)) throw new U.HttpError(400, 'Envie um vídeo MP4, MOV ou WEBM.');
    if (!(size > 0)) throw new U.HttpError(400, 'Vídeo inválido.');
    const id = require('node:crypto').randomBytes(16).toString('hex');
    require('node:fs').writeFileSync(UPL.partPath(id), Buffer.alloc(0));
    db.prepare("INSERT INTO upload_sessions (id, professional_id, kind, mime, size) VALUES (?, ?, 'reel', ?, ?)").run(id, O.officialId(), mime, size);
    res.status(201).json({ id, received: 0, size });
  });
  router.put('/official/uploads/:id', require('express').raw({ type: 'application/octet-stream', limit: 8 * 1024 * 1024 }), (req, res) => {
    const u = offUpload(req.params.id);
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (Number(req.query.offset) !== u.received) return res.status(409).json({ received: u.received, size: u.size });
    if (u.received + buf.length > u.size) throw new U.HttpError(400, 'O vídeo ficou maior do que o informado.');
    require('node:fs').appendFileSync(UPL.partPath(u.id), buf);
    db.prepare('UPDATE upload_sessions SET received = received + ? WHERE id = ?').run(buf.length, u.id);
    res.json({ received: u.received + buf.length, size: u.size });
  });
  router.post('/official/uploads/:id/finish', async (req, res) => {
    const u = offUpload(req.params.id);
    if (u.received !== u.size) return res.status(409).json({ error: 'O vídeo ainda não chegou inteiro.', received: u.received, size: u.size });
    const poster = await handlePhoto(req, res);
    const secs = Number(req.body.duration) || 0;
    if (secs > S.OFFICIAL_REEL_MAX_SECS + 1) {
      removePhoto(poster);
      db.prepare('DELETE FROM upload_sessions WHERE id = ?').run(u.id);
      require('node:fs').promises.unlink(UPL.partPath(u.id)).catch(() => {});
      throw new U.HttpError(400, 'O vídeo pode ter no máximo 2 minutos.');
    }
    const video = UPL.finishPart(u.id, u.mime);
    db.prepare('DELETE FROM upload_sessions WHERE id = ?').run(u.id);
    res.status(201).json(postRow(S.createReel(O.officialId(), { video, poster }, req.body.caption, secs || null)));
  });

  // Vídeo (reel) do perfil oficial: aparece no feed, nos Reels e no perfil da Acolia Brasil
  router.post('/official/reels', async (req, res) => {
    const UP = require('../upload');
    const media = await UP.handleReel(req, res);
    const secs = Number(req.body.duration) || 0;
    if (!media?.video) throw new U.HttpError(400, 'Escolha um vídeo.');
    if (secs > S.OFFICIAL_REEL_MAX_SECS + 1) {
      UP.removePhoto(media.video); UP.removePhoto(media.poster);
      throw new U.HttpError(400, 'O vídeo pode ter no máximo 2 minutos.');
    }
    res.status(201).json(postRow(S.createReel(O.officialId(), media, req.body.caption, secs || null)));
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
