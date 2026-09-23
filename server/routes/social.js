'use strict';
// Versão 1.2 — Início estilo Instagram: publicações (fotos com legenda), stories (foto ou
// vídeo de até 20 s, somem em 24 h), seguir profissionais, curtir, comentar e notificações.
// Só profissionais publicam; pacientes e profissionais seguem, curtem e comentam.
const express = require('express');
const { db } = require('../db');
const U = require('../util');
const A = require('../auth');
const rt = require('../realtime');
const { VISIBLE_SQL, freeGalleryCount, PROFILE_POSTS } = require('../serialize');
const { handlePhoto, handlePhotos, handleMedia, handleReel, removePhoto } = require('../upload');
const REEL_MAX_SECS = 2 * 60; // Reels: vídeos de até 2 minutos (e 70 MB)
const O = require('../official');

const router = express.Router();
const STORY_HOURS = 24;
const PAGE = 12;

// ---------- Quem é quem ----------
const who = (req) => ({ role: req.auth.role, id: req.auth.user.id });
const isPro = (req) => req.auth?.role === 'professional';

// Nome público: profissional com nome completo; paciente só com o 1º e o 2º nome + cidade
function actor(role, id) {
  if (role === 'professional' && O.isOfficial(id)) {
    return { role, id: O.officialId(), name: O.NAME, subtitle: 'Perfil oficial', photo: O.PHOTO, slug: O.SLUG, official: true };
  }
  if (role === 'professional') {
    const p = db.prepare('SELECT id, name, photo, profession, slug FROM professionals WHERE id = ?').get(id);
    if (!p) return { role, id, name: 'Profissional', subtitle: '', photo: null };
    return { role, id: p.id, name: p.name, subtitle: p.profession, photo: p.photo, slug: p.slug };
  }
  const p = db.prepare('SELECT id, name, display_name, photo, city, state, status FROM patients WHERE id = ?').get(id);
  if (!p || p.status === 'excluido') return { role, id, name: 'Conta excluída', subtitle: '', photo: null };
  const words = String(p.display_name || p.name).trim().split(/\s+/).slice(0, 2).join(' ');
  return { role, id: p.id, name: words, subtitle: p.city && p.state ? `${p.city} - ${p.state}` : '', photo: p.photo };
}

function notify(toRole, toId, type, from, extra = {}) {
  if (toRole === from.role && toId === from.id) return; // não avisa a própria pessoa
  if (toRole === 'professional' && O.isOfficial(toId)) return; // o perfil oficial não tem sininho
  const info = db.prepare(`INSERT INTO notifications (recipient_role, recipient_id, type, actor_role, actor_id, post_id, story_id, comment_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(toRole, toId, type, from.role, from.id, extra.post_id || null, extra.story_id || null, extra.comment_id || null);
  rt.emit(`${toRole}:${toId}`, 'social:notification', { id: Number(info.lastInsertRowid), type });
}

// ---------- Publicações ----------
function visiblePro(id) {
  return db.prepare(`SELECT * FROM professionals p WHERE id = ? AND ${VISIBLE_SQL}`).get(id);
}
// Quem pode ter publicações vistas: profissional visível ou o perfil oficial da Acolia
const socialPro = (id) => (O.isOfficial(id) ? O.officialRow() : visiblePro(id));

// A pessoa segue este profissional? 'self' (é ela), 'official' (Acolia Brasil: todos seguem) ou true/false
function followState(proId, me) {
  if (!me) return undefined;
  if (me.role === 'professional' && me.id === proId) return 'self';
  if (O.isOfficial(proId)) return 'official';
  return !!db.prepare('SELECT 1 FROM follows WHERE follower_role = ? AND follower_id = ? AND professional_id = ?').get(me.role, me.id, proId);
}

// Fotos da publicação na ordem (carrossel); publicações antigas têm só a capa
function postImages(p) {
  const rows = db.prepare('SELECT image FROM post_images WHERE post_id = ? ORDER BY position').all(p.id).map((r) => r.image);
  return rows.length ? rows : [p.image];
}
const imageCount = (postId) => Math.max(1, db.prepare('SELECT COUNT(*) n FROM post_images WHERE post_id = ?').get(postId).n);

function postOut(p, me) {
  const likes = db.prepare('SELECT COUNT(*) n FROM post_likes WHERE post_id = ?').get(p.id).n;
  const comments = db.prepare('SELECT COUNT(*) n FROM post_comments WHERE post_id = ?').get(p.id).n;
  const liked = me ? !!db.prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND role = ? AND user_id = ?').get(p.id, me.role, me.id) : false;
  return {
    id: p.id, kind: p.kind || 'photo', aspect: p.aspect || null, image: p.image, images: postImages(p), caption: p.caption, created_at: p.created_at,
    video: p.kind === 'reel' ? p.video : undefined, duration: p.kind === 'reel' ? p.duration : undefined,
    likes, comments, liked,
    mine: !!me && me.role === 'professional' && me.id === p.professional_id,
    author: actor('professional', p.professional_id),
    follow: followState(p.professional_id, me),
  };
}

function loadPost(req, id) {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(id));
  if (!p) throw new U.HttpError(404, 'Publicação não encontrada.');
  const mine = isPro(req) && req.auth.user.id === p.professional_id;
  if (!mine && !socialPro(p.professional_id)) throw new U.HttpError(404, 'Publicação não encontrada.');
  return p;
}

// Grade do perfil: visitante vê só até 2 fotos (regra da galeria) e não abre nenhuma
router.get('/professionals/:id/posts', (req, res) => {
  const proId = Number(req.params.id);
  const mine = isPro(req) && req.auth.user.id === proId;
  if (!mine && !socialPro(proId)) throw new U.HttpError(404, 'Profissional não encontrado.');
  // ?kind=photo (fotos) | reel (vídeos); sem kind = tudo
  const kind = ['photo', 'reel'].includes(req.query.kind) ? req.query.kind : null;
  const kindSql = kind ? `AND kind = '${kind}'` : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM posts WHERE professional_id = ? ${kindSql}`).get(proId).n;
  if (!req.auth || !['patient', 'professional'].includes(req.auth.role)) {
    const first = db.prepare(`SELECT image, kind FROM posts WHERE professional_id = ? ${kindSql} ORDER BY id DESC LIMIT ${PROFILE_POSTS}`).all(proId);
    const free = freeGalleryCount(first.length);
    return res.json({ locked: true, total, items: first.slice(0, free).map((r) => ({ image: r.image, kind: r.kind })), hidden: total - free });
  }
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = Math.min(60, Number(req.query.limit) || PAGE);
  const rows = db.prepare(`SELECT id, image, thumb, kind FROM posts WHERE professional_id = ? ${kindSql} ORDER BY id DESC LIMIT ? OFFSET ?`).all(proId, limit, offset);
  res.json({ locked: false, total, items: rows.map((r) => ({ ...r, count: r.kind === 'reel' ? 1 : imageCount(r.id) })), has_more: offset + rows.length < total });
});

// Publicação aberta pelo link compartilhado: qualquer pessoa vê a foto e a descrição.
// Curtir e comentar pedem conta (sem conta não vê os comentários, só o número).
router.get('/posts/:id', (req, res) => {
  const logged = req.auth && ['patient', 'professional'].includes(req.auth.role);
  const p = loadPost(logged ? req : {}, req.params.id);
  if (logged) return res.json(postOut(p, who(req)));
  const out = postOut(p, null);
  res.json({ ...out, locked: true });
});

router.use(A.requireRole('patient', 'professional'));

// Feed: publicações de quem a pessoa segue, as próprias (profissional) e as da Acolia Brasil
// (todos seguem). Primeiro as que ela ainda não viu (mais novas no topo), depois as já vistas.
// No meio, de vez em quando, aparecem publicações de outros profissionais que ela não segue
// (sugestões, com o botão Seguir). Quando acabam as de quem ela segue, o feed continua só com
// sugestões — assim quem não segue ninguém também vê publicações.
// ?sug=1,2,3 = sugestões que o aparelho já mostrou (para não repetir).
router.get('/feed', (req, res) => {
  const me = who(req);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const official = O.officialId();
  const rows = db.prepare(`
    SELECT po.*, (SELECT 1 FROM post_views v WHERE v.post_id = po.id AND v.role = ? AND v.user_id = ?) AS seen
    FROM posts po JOIN professionals p ON p.id = po.professional_id
    WHERE (${VISIBLE_SQL} AND po.professional_id IN (SELECT professional_id FROM follows WHERE follower_role = ? AND follower_id = ?))
       OR (? = 'professional' AND po.professional_id = ?)
       OR po.professional_id = ?
    ORDER BY seen IS NOT NULL, po.id DESC
    LIMIT ? OFFSET ?`).all(me.role, me.id, me.role, me.id, me.role, me.id, official, PAGE + 1, offset);
  const mainMore = rows.length > PAGE;
  const main = rows.slice(0, PAGE);

  // Sugestões: poucas no meio (0 a 2 a cada página); se acabou o resto, a página inteira
  const shown = String(req.query.sug || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(-500);
  const want = mainMore ? Math.floor(Math.random() * 3) : PAGE - main.length;
  let sug = [];
  if (want > 0 || !mainMore) {
    sug = db.prepare(`
      SELECT po.*, (SELECT 1 FROM post_views v WHERE v.post_id = po.id AND v.role = ? AND v.user_id = ?) AS seen
      FROM posts po JOIN professionals p ON p.id = po.professional_id
      WHERE ${VISIBLE_SQL} AND po.professional_id <> ?
        AND NOT (? = 'professional' AND po.professional_id = ?)
        AND po.professional_id NOT IN (SELECT professional_id FROM follows WHERE follower_role = ? AND follower_id = ?)
        AND po.id NOT IN (SELECT value FROM json_each(?))
      ORDER BY seen IS NOT NULL, RANDOM()
      LIMIT ?`).all(me.role, me.id, official, me.role, me.id, me.role, me.id, JSON.stringify(shown), want + 1);
  }
  const sugMore = sug.length > want;
  sug = sug.slice(0, Math.max(0, want));

  // Espalha as sugestões em posições aleatórias (nunca como a primeira do feed)
  const items = main.map((p) => ({ ...postOut(p, me), seen: !!p.seen }));
  for (const p of sug) {
    const at = items.length < 2 ? items.length : 1 + Math.floor(Math.random() * items.length);
    items.splice(at, 0, { ...postOut(p, me), seen: !!p.seen, suggested: true });
  }
  const following = db.prepare('SELECT COUNT(*) n FROM follows WHERE follower_role = ? AND follower_id = ?').get(me.role, me.id).n;
  res.json({ items, main_count: main.length, has_more: mainMore || sugMore, following });
});

// O aparelho avisa quais publicações apareceram na tela
router.post('/seen', (req, res) => {
  const me = who(req);
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).slice(0, 100).map(Number).filter(Number.isInteger);
  const ins = db.prepare('INSERT OR IGNORE INTO post_views (post_id, role, user_id) SELECT id, ?, ? FROM posts WHERE id = ?');
  for (const id of ids) ins.run(me.role, me.id, id);
  res.json({ ok: true });
});


// Uma publicação por vez, com 1 a 10 fotos (carrossel) e uma descrição para todas
router.post('/posts', async (req, res) => {
  if (!isPro(req)) throw new U.HttpError(403, 'Só profissionais publicam.');
  const urls = await handlePhotos(req, res);
  const p = createPost(req.auth.user.id, urls, req.body.caption, req.body.aspect);
  res.status(201).json(postOut(p, who(req)));
});

const ASPECTS = ['4:5', '1:1', '1.91:1']; // Retrato 1080×1350 · Quadrado 1080×1080 · Paisagem 1080×566
const IMG = require('../imageSize');
const uploadFile = (url) => require('node:path').join(require('../upload').UPLOAD_DIR, require('node:path').basename(url));
function aspectOfUpload(url) {
  const s = url ? IMG.fileSize(uploadFile(url)) : null;
  return s ? IMG.bestAspect(s.w, s.h) : null;
}

// Publicações antigas (de antes dos formatos): mede a 1ª foto e grava o formato mais próximo.
// O feed então mostra a foto recortada pelo centro nesse formato. As fotos em si não mudam.
async function fixOldAspects() {
  const cloud = require('../cloud');
  const rows = db.prepare("SELECT id, image FROM posts WHERE kind = 'photo' AND aspect IS NULL").all();
  let fixed = 0;
  for (const r of rows) {
    await cloud.ensureLocalFile('uploads', uploadFile(r.image)).catch(() => false);
    const a = aspectOfUpload(r.image);
    if (a) { db.prepare('UPDATE posts SET aspect = ? WHERE id = ? AND aspect IS NULL').run(a, r.id); fixed++; }
  }
  if (rows.length) console.log(`[formatos] ${fixed} de ${rows.length} publicações antigas ajustadas ao formato do feed`);
  return fixed;
}
// ---------- Limite de publicações por profissional ----------
// Cada profissional guarda no máximo N publicações de fotos e N vídeos (o admin define; começa
// com 15 fotos e 10 vídeos). Ao publicar além do limite, a mais antiga é apagada (com os
// arquivos) para a nova entrar. A Acolia Brasil (perfil oficial) não tem limite.
const LIMIT_DEFAULTS = { photo: 15, reel: 10 };
function getLimits() {
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const read = (k, d) => {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    const n = r ? Number(r.value) : d;
    return Number.isInteger(n) && n > 0 ? n : d;
  };
  return { photo: read('limit_photo_posts', LIMIT_DEFAULTS.photo), reel: read('limit_reel_posts', LIMIT_DEFAULTS.reel) };
}
function setLimits({ photo, reel }) {
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  up.run('limit_photo_posts', String(photo));
  up.run('limit_reel_posts', String(reel));
}
// Publicações que passam do limite (as mais antigas) — de um profissional ou de todos
function overLimit(kind, max, proId = null) {
  return db.prepare(`SELECT po.* FROM posts po WHERE po.kind = ? AND po.professional_id <> ? ${proId ? 'AND po.professional_id = ?' : ''}
    AND (SELECT COUNT(*) FROM posts n WHERE n.professional_id = po.professional_id AND n.kind = po.kind AND n.id > po.id) >= ?`)
    .all(...[kind, O.officialId(), ...(proId ? [proId] : []), max]);
}
function enforceLimits(proId = null) {
  const lim = getLimits();
  let removed = 0;
  for (const kind of ['photo', 'reel']) {
    for (const p of overLimit(kind, lim[kind], proId)) { deletePostFully(p); removed++; }
  }
  return removed;
}

function createPost(proId, urls, caption, aspect) {
  if (!ASPECTS.includes(aspect)) aspect = aspectOfUpload(urls[0]); // sem formato: mede a foto e escolhe o mais próximo
  const info = db.prepare('INSERT INTO posts (professional_id, image, caption, aspect) VALUES (?, ?, ?, ?)')
    .run(proId, urls[0], U.cleanText(caption, 2200), ASPECTS.includes(aspect) ? aspect : null);
  const id = Number(info.lastInsertRowid);
  urls.forEach((u, i) => db.prepare('INSERT INTO post_images (post_id, position, image) VALUES (?, ?, ?)').run(id, i, u));
  if (!O.isOfficial(proId)) enforceLimits(proId); // passou do limite: a mais antiga sai
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
}

// ---------- Reels (vídeos de até 2 minutos e 70 MB) ----------
// O vídeo vai junto com a capa (um quadro tirado no aparelho) e a duração
function createReel(proId, media, caption, duration) {
  const info = db.prepare("INSERT INTO posts (professional_id, image, caption, kind, video, duration) VALUES (?, ?, ?, 'reel', ?, ?)")
    .run(proId, media.poster, U.cleanText(caption, 2200), media.video, duration);
  if (!O.isOfficial(proId)) enforceLimits(proId); // passou do limite: o vídeo mais antigo sai
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(info.lastInsertRowid));
}

router.post('/reels', async (req, res) => {
  if (!isPro(req)) throw new U.HttpError(403, 'Só profissionais publicam.');
  const media = await handleReel(req, res);
  const secs = Number(req.body.duration) || 0;
  if (secs > REEL_MAX_SECS + 1) {
    removePhoto(media.video);
    removePhoto(media.poster);
    throw new U.HttpError(400, 'O vídeo pode ter no máximo 2 minutos.');
  }
  res.status(201).json(postOut(createReel(req.auth.user.id, media, req.body.caption, secs || null), who(req)));
});

// ---------- Envio do reel em pedaços (segundo plano, continua de onde parou) ----------
// 1) start: reserva o envio  2) PUT de pedaços em ordem  3) finish: capa + descrição → publica.
// Se a internet cair ou o app for para o fundo, o aparelho pergunta quanto já chegou e continua.
const UP = require('../upload');
const CHUNK_MAX = 8 * 1024 * 1024;
function ownUpload(req) {
  const u = db.prepare('SELECT * FROM upload_sessions WHERE id = ? AND professional_id = ?').get(String(req.params.id), req.auth.user.id);
  if (!u) throw new U.HttpError(404, 'Envio não encontrado. Comece de novo.');
  return u;
}

router.post('/uploads', (req, res) => {
  if (!isPro(req)) throw new U.HttpError(403, 'Só profissionais publicam.');
  const mime = String(req.body.mime || '').split(';')[0];
  const size = Number(req.body.size);
  if (!UP.VIDEO_EXT[mime]) throw new U.HttpError(400, 'Envie um vídeo MP4, MOV ou WEBM.');
  if (!(size > 0) || size > UP.REEL_MAX_MB * 1024 * 1024) throw new U.HttpError(400, `Vídeo muito grande (máximo ${UP.REEL_MAX_MB} MB).`);
  const id = require('node:crypto').randomBytes(16).toString('hex');
  require('node:fs').writeFileSync(UP.partPath(id), Buffer.alloc(0));
  db.prepare("INSERT INTO upload_sessions (id, professional_id, kind, mime, size) VALUES (?, ?, 'reel', ?, ?)").run(id, req.auth.user.id, mime, size);
  res.status(201).json({ id, received: 0, size });
});

router.get('/uploads/:id', (req, res) => {
  const u = ownUpload(req);
  res.json({ id: u.id, received: u.received, size: u.size });
});

// Um pedaço: ?offset= tem que ser exatamente o que já chegou (senão responde quanto chegou)
router.put('/uploads/:id', express.raw({ type: 'application/octet-stream', limit: CHUNK_MAX }), (req, res) => {
  const u = ownUpload(req);
  const offset = Number(req.query.offset);
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (offset !== u.received) return res.status(409).json({ received: u.received, size: u.size });
  if (u.received + buf.length > u.size) throw new U.HttpError(400, 'O vídeo ficou maior do que o informado.');
  require('node:fs').appendFileSync(UP.partPath(u.id), buf);
  db.prepare('UPDATE upload_sessions SET received = received + ? WHERE id = ?').run(buf.length, u.id);
  res.json({ received: u.received + buf.length, size: u.size });
});

router.post('/uploads/:id/finish', async (req, res) => {
  const u = ownUpload(req);
  if (u.received !== u.size) return res.status(409).json({ error: 'O vídeo ainda não chegou inteiro.', received: u.received, size: u.size });
  const poster = await handlePhoto(req, res); // campo "photo" = capa; junto vêm caption e duration
  const secs = Number(req.body.duration) || 0;
  if (secs > REEL_MAX_SECS + 1) {
    removePhoto(poster);
    discardUpload(u.id);
    throw new U.HttpError(400, 'O vídeo pode ter no máximo 2 minutos.');
  }
  const video = UP.finishPart(u.id, u.mime);
  db.prepare('DELETE FROM upload_sessions WHERE id = ?').run(u.id);
  res.status(201).json(postOut(createReel(req.auth.user.id, { video, poster }, req.body.caption, secs || null), who(req)));
});

router.delete('/uploads/:id', (req, res) => {
  discardUpload(ownUpload(req).id);
  res.json({ ok: true });
});

function discardUpload(id) {
  db.prepare('DELETE FROM upload_sessions WHERE id = ?').run(id);
  require('node:fs').promises.unlink(UP.partPath(id)).catch(() => {});
}
// Envios abandonados há mais de 3 dias são apagados (roda junto com a limpeza dos stories)
function cleanupUploads() {
  for (const u of db.prepare("SELECT id FROM upload_sessions WHERE created_at < datetime('now', '-3 days')").all()) discardUpload(u.id);
}

// Quanto o profissional já usou do limite (aparece na hora de publicar)
router.get('/limits', (req, res) => {
  const lim = getLimits();
  const used = (kind) => (isPro(req) ? db.prepare('SELECT COUNT(*) n FROM posts WHERE professional_id = ? AND kind = ?').get(req.auth.user.id, kind).n : 0);
  res.json({ photo: { max: lim.photo, used: used('photo') }, reel: { max: lim.reel, used: used('reel') } });
});

// Aba Reels: vídeos de todos os profissionais (e da Acolia Brasil) em ordem aleatória,
// primeiro os que a pessoa ainda não viu. ?sug=1,2,3 = já mostrados (não repete).
router.get('/reels', (req, res) => {
  const me = who(req);
  const shown = String(req.query.sug || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(-500);
  const size = 6;
  // ?scope=following: só de quem a pessoa segue (e da Acolia Brasil, que todos seguem)
  const following = req.query.scope === 'following';
  const FOLLOWED = 'SELECT professional_id FROM follows WHERE follower_role = ? AND follower_id = ?';
  const who_ = following
    ? `((${VISIBLE_SQL} AND po.professional_id IN (${FOLLOWED})) OR po.professional_id = ?)`
    : `((${VISIBLE_SQL}) OR po.professional_id = ? OR (? = 'professional' AND po.professional_id = ?))`;
  const whoArgs = following ? [me.role, me.id, O.officialId()] : [O.officialId(), me.role, me.id];
  const rows = db.prepare(`
    SELECT po.*, (SELECT 1 FROM post_views v WHERE v.post_id = po.id AND v.role = ? AND v.user_id = ?) AS seen
    FROM posts po JOIN professionals p ON p.id = po.professional_id
    WHERE po.kind = 'reel' AND ${who_}
      AND po.id NOT IN (SELECT value FROM json_each(?))
    ORDER BY seen IS NOT NULL, ${following ? 'po.id DESC' : 'RANDOM()'}
    LIMIT ?`).all(me.role, me.id, ...whoArgs, JSON.stringify(shown), size + 1);
  const out = { items: rows.slice(0, size).map((p) => ({ ...postOut(p, me), seen: !!p.seen })), has_more: rows.length > size };
  // Fotinhos de quem a pessoa segue com vídeos (aparecem ao lado de "Seguindo")
  if (req.query.avatars === '1') {
    out.following_avatars = db.prepare(`SELECT po.professional_id AS id, MAX(po.id) AS last FROM posts po JOIN professionals p ON p.id = po.professional_id
      WHERE po.kind = 'reel' AND ${VISIBLE_SQL} AND po.professional_id IN (${FOLLOWED})
      GROUP BY po.professional_id ORDER BY last DESC LIMIT 3`).all(me.role, me.id).map((r) => actor('professional', r.id));
  }
  res.json(out);
});

// Miniatura (até ~600 px) usada na prévia do link compartilhado
router.post('/posts/:id/thumb', async (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!p || !isPro(req) || p.professional_id !== req.auth.user.id) throw new U.HttpError(404, 'Publicação não encontrada.');
  const url = await handlePhoto(req, res);
  if (p.thumb) removePhoto(p.thumb);
  db.prepare('UPDATE posts SET thumb = ? WHERE id = ?').run(url, p.id);
  res.json({ ok: true });
});

router.delete('/posts/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!p || !isPro(req) || p.professional_id !== req.auth.user.id) throw new U.HttpError(404, 'Publicação não encontrada.');
  deletePostFully(p);
  res.json({ ok: true });
});

function deletePostFully(p) {
  db.prepare('DELETE FROM notifications WHERE post_id = ?').run(p.id);
  const imgs = postImages(p);
  for (const st of db.prepare("SELECT id FROM stories WHERE kind = 'post' AND post_id = ?").all(p.id)) {
    db.prepare('DELETE FROM notifications WHERE story_id = ?').run(st.id);
    db.prepare('DELETE FROM stories WHERE id = ?').run(st.id);
  }
  db.prepare('DELETE FROM posts WHERE id = ?').run(p.id);
  new Set([p.image, ...imgs]).forEach(removePhoto);
  if (p.thumb) removePhoto(p.thumb);
  if (p.video) removePhoto(p.video);
}

router.post('/posts/:id/like', (req, res) => {
  const p = loadPost(req, req.params.id);
  const me = who(req);
  const r = db.prepare('INSERT OR IGNORE INTO post_likes (post_id, role, user_id) VALUES (?, ?, ?)').run(p.id, me.role, me.id);
  if (r.changes) notify('professional', p.professional_id, 'like_post', me, { post_id: p.id });
  res.json(postOut(p, me));
});

router.delete('/posts/:id/like', (req, res) => {
  const p = loadPost(req, req.params.id);
  const me = who(req);
  db.prepare('DELETE FROM post_likes WHERE post_id = ? AND role = ? AND user_id = ?').run(p.id, me.role, me.id);
  res.json(postOut(p, me));
});

// ---------- Comentários (só texto) ----------
function commentOut(c, me, postOwner) {
  return {
    id: c.id, body: c.body, created_at: c.created_at, author: actor(c.role, c.user_id),
    can_delete: (c.role === me.role && c.user_id === me.id) || (me.role === 'professional' && me.id === postOwner),
  };
}

router.get('/posts/:id/comments', (req, res) => {
  const p = loadPost(req, req.params.id);
  const rows = db.prepare('SELECT * FROM post_comments WHERE post_id = ? ORDER BY id').all(p.id);
  res.json({ items: rows.map((c) => commentOut(c, who(req), p.professional_id)) });
});

router.post('/posts/:id/comments', (req, res) => {
  const p = loadPost(req, req.params.id);
  const me = who(req);
  const body = U.cleanText(req.body.body, 500);
  if (!body) throw new U.HttpError(400, 'Escreva um comentário.');
  const info = db.prepare('INSERT INTO post_comments (post_id, role, user_id, body) VALUES (?, ?, ?, ?)').run(p.id, me.role, me.id, body);
  const c = db.prepare('SELECT * FROM post_comments WHERE id = ?').get(Number(info.lastInsertRowid));
  notify('professional', p.professional_id, 'comment', me, { post_id: p.id, comment_id: c.id });
  res.status(201).json(commentOut(c, me, p.professional_id));
});

// Quem comentou apaga o próprio comentário; o dono da publicação apaga qualquer um
router.delete('/comments/:id', (req, res) => {
  const me = who(req);
  const c = db.prepare('SELECT c.*, p.professional_id AS owner FROM post_comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ?').get(Number(req.params.id));
  if (!c) throw new U.HttpError(404, 'Comentário não encontrado.');
  const allowed = (c.role === me.role && c.user_id === me.id) || (me.role === 'professional' && me.id === c.owner);
  if (!allowed) throw new U.HttpError(403, 'Você só pode apagar os seus comentários.');
  db.prepare('DELETE FROM notifications WHERE comment_id = ?').run(c.id);
  db.prepare('DELETE FROM post_comments WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

// ---------- Seguir ----------
// Seguidores de um profissional: quem segue + 1 (a Acolia Brasil segue todos os profissionais)
function followInfo(proId, me) {
  if (O.isOfficial(proId)) return { followers: O.publicOfficial().followers_count, following: !!me, official: true };
  return {
    followers: db.prepare('SELECT COUNT(*) n FROM follows WHERE professional_id = ?').get(proId).n + 1,
    following: me ? !!db.prepare('SELECT 1 FROM follows WHERE follower_role = ? AND follower_id = ? AND professional_id = ?').get(me.role, me.id, proId) : false,
  };
}

router.post('/follow/:id', (req, res) => {
  const me = who(req);
  const proId = Number(req.params.id);
  if (me.role === 'professional' && me.id === proId) throw new U.HttpError(400, 'Você não pode seguir a si mesmo.');
  if (O.isOfficial(proId)) return res.json(followInfo(proId, me)); // já segue (todo mundo segue)
  if (!visiblePro(proId)) throw new U.HttpError(404, 'Profissional não encontrado.');
  const r = db.prepare('INSERT OR IGNORE INTO follows (follower_role, follower_id, professional_id) VALUES (?, ?, ?)').run(me.role, me.id, proId);
  if (r.changes) notify('professional', proId, 'follow', me);
  res.json(followInfo(proId, me));
});

router.delete('/follow/:id', (req, res) => {
  const me = who(req);
  const proId = Number(req.params.id);
  if (O.isOfficial(proId)) throw new U.HttpError(400, 'Todos seguem a Acolia Brasil — não dá para deixar de seguir.');
  db.prepare('DELETE FROM follows WHERE follower_role = ? AND follower_id = ? AND professional_id = ?').run(me.role, me.id, proId);
  res.json(followInfo(proId, me));
});

// ---------- Stories ----------
const STORY_ALIVE = `created_at >= strftime('%Y-%m-%d %H:%M:%f', 'now', '-${STORY_HOURS} hours')`;

// Story de publicação (kind = 'post'): mostra a capa e leva para a publicação
function storyOut(s, me) {
  let post = null;
  if (s.kind === 'post' && s.post_id) {
    const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(s.post_id);
    if (p) post = { id: p.id, image: p.image, caption: p.caption, count: p.kind === 'reel' ? 1 : imageCount(p.id), kind: p.kind };
  }
  return {
    id: s.id, media: s.media, kind: s.kind, created_at: s.created_at, post,
    liked: !!db.prepare('SELECT 1 FROM story_likes WHERE story_id = ? AND role = ? AND user_id = ?').get(s.id, me.role, me.id),
    likes: me.role === 'professional' && me.id === s.professional_id
      ? db.prepare('SELECT COUNT(*) n FROM story_likes WHERE story_id = ?').get(s.id).n : undefined,
  };
}

// Barra de stories: o próprio profissional primeiro, depois quem a pessoa segue
router.get('/stories', (req, res) => {
  const me = who(req);
  const pros = db.prepare(`SELECT DISTINCT s.professional_id AS id FROM stories s JOIN professionals p ON p.id = s.professional_id
    WHERE s.${STORY_ALIVE} AND ((${VISIBLE_SQL} AND s.professional_id IN (SELECT professional_id FROM follows WHERE follower_role = ? AND follower_id = ?))
      OR (? = 'professional' AND s.professional_id = ?))`).all(me.role, me.id, me.role, me.id);
  const groups = pros.map(({ id }) => {
    const items = db.prepare(`SELECT * FROM stories WHERE professional_id = ? AND ${STORY_ALIVE} ORDER BY id`).all(id);
    return { professional: actor('professional', id), mine: me.role === 'professional' && me.id === id, items: items.map((s) => storyOut(s, me)), last: items.at(-1)?.id || 0 };
  });
  groups.sort((a, b) => (b.mine - a.mine) || (b.last - a.last));
  res.json({ groups, can_post: me.role === 'professional' });
});

router.post('/stories', async (req, res) => {
  if (!isPro(req)) throw new U.HttpError(403, 'Só profissionais postam stories.');
  const m = await handleMedia(req, res);
  const secs = Number(req.body.duration) || 0;
  if (m.kind === 'video' && secs > 20.9) {
    removePhoto(m.url);
    throw new U.HttpError(400, 'O vídeo do story pode ter no máximo 20 segundos.');
  }
  const info = db.prepare('INSERT INTO stories (professional_id, media, kind) VALUES (?, ?, ?)').run(req.auth.user.id, m.url, m.kind);
  res.status(201).json(storyOut(db.prepare('SELECT * FROM stories WHERE id = ?').get(Number(info.lastInsertRowid)), who(req)));
});

router.delete('/stories/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM stories WHERE id = ?').get(Number(req.params.id));
  if (!s || !isPro(req) || s.professional_id !== req.auth.user.id) throw new U.HttpError(404, 'Story não encontrado.');
  db.prepare('DELETE FROM notifications WHERE story_id = ?').run(s.id);
  db.prepare('DELETE FROM stories WHERE id = ?').run(s.id);
  if (s.kind !== 'post') removePhoto(s.media);
  res.json({ ok: true });
});

// Colocar a própria publicação no story (só o dono da publicação)
router.post('/posts/:id/story', (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!p) throw new U.HttpError(404, 'Publicação não encontrada.');
  if (!isPro(req) || p.professional_id !== req.auth.user.id) throw new U.HttpError(403, 'Só quem publicou pode colocar esta publicação no story.');
  const info = db.prepare("INSERT INTO stories (professional_id, media, kind, post_id) VALUES (?, ?, 'post', ?)").run(p.professional_id, p.image, p.id);
  res.status(201).json(storyOut(db.prepare('SELECT * FROM stories WHERE id = ?').get(Number(info.lastInsertRowid)), who(req)));
});

function loadStory(id) {
  const s = db.prepare(`SELECT * FROM stories WHERE id = ? AND ${STORY_ALIVE}`).get(Number(id));
  if (!s) throw new U.HttpError(404, 'Este story não está mais disponível.');
  return s;
}

router.post('/stories/:id/like', (req, res) => {
  const s = loadStory(req.params.id);
  const me = who(req);
  const r = db.prepare('INSERT OR IGNORE INTO story_likes (story_id, role, user_id) VALUES (?, ?, ?)').run(s.id, me.role, me.id);
  if (r.changes) notify('professional', s.professional_id, 'like_story', me, { story_id: s.id });
  res.json(storyOut(s, me));
});

router.delete('/stories/:id/like', (req, res) => {
  const s = loadStory(req.params.id);
  const me = who(req);
  db.prepare('DELETE FROM story_likes WHERE story_id = ? AND role = ? AND user_id = ?').run(s.id, me.role, me.id);
  res.json(storyOut(s, me));
});

// Apaga stories vencidos (e os arquivos) — roda de hora em hora
function cleanupStories() {
  cleanupUploads();
  const old = db.prepare(`SELECT * FROM stories WHERE NOT (${STORY_ALIVE})`).all();
  for (const s of old) {
    db.prepare('DELETE FROM notifications WHERE story_id = ?').run(s.id);
    db.prepare('DELETE FROM stories WHERE id = ?').run(s.id);
    if (s.kind !== 'post') removePhoto(s.media);
  }
  return old.length;
}

// ---------- Notificações (no Início, no sininho) ----------
// Curtida em publicação e novo seguidor não mostram quem foi; comentário e curtida no story mostram.
function notifOut(n) {
  const a = n.actor_role ? actor(n.actor_role, n.actor_id) : null;
  const kindOf = n.actor_role === 'patient' ? 'Um paciente' : 'Um profissional';
  let text;
  let showActor = false;
  if (n.type === 'follow') text = `${kindOf} começou a seguir você.`;
  else if (n.type === 'like_post') text = 'Sua publicação recebeu uma curtida.';
  else if (n.type === 'like_story') { text = `${a.name} curtiu seu story.`; showActor = true; }
  else if (n.type === 'comment') {
    const c = n.comment_id ? db.prepare('SELECT body FROM post_comments WHERE id = ?').get(n.comment_id) : null;
    text = `${a.name} comentou: ${c ? c.body.slice(0, 80) : ''}`;
    showActor = true;
  } else text = 'Nova atividade.';
  const post = n.post_id ? db.prepare('SELECT id, image FROM posts WHERE id = ?').get(n.post_id) : null;
  return {
    id: n.id, type: n.type, text, created_at: n.created_at, read: !!n.read_at,
    actor: showActor ? a : null, post: post ? { id: post.id, image: post.image } : null,
  };
}

router.get('/notifications', (req, res) => {
  const me = who(req);
  const rows = db.prepare('SELECT * FROM notifications WHERE recipient_role = ? AND recipient_id = ? ORDER BY id DESC LIMIT 60').all(me.role, me.id);
  res.json({ items: rows.map(notifOut), unread: rows.filter((r) => !r.read_at).length });
});

router.get('/notifications/unread', (req, res) => {
  const me = who(req);
  res.json({ unread: db.prepare('SELECT COUNT(*) n FROM notifications WHERE recipient_role = ? AND recipient_id = ? AND read_at IS NULL').get(me.role, me.id).n });
});

router.post('/notifications/read', (req, res) => {
  const me = who(req);
  db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE recipient_role = ? AND recipient_id = ? AND read_at IS NULL").run(me.role, me.id);
  res.json({ ok: true });
});

// Conta apagada: some tudo o que ela fez no Acolia Feed (publicações, reels e stories com os
// arquivos, curtidas, comentários, seguidores, notificações e envios pela metade)
function purgeUserSocial(role, id) {
  if (role === 'professional') {
    for (const p of db.prepare('SELECT * FROM posts WHERE professional_id = ?').all(id)) deletePostFully(p);
    for (const st of db.prepare('SELECT * FROM stories WHERE professional_id = ?').all(id)) {
      db.prepare('DELETE FROM notifications WHERE story_id = ?').run(st.id);
      db.prepare('DELETE FROM stories WHERE id = ?').run(st.id);
      if (st.kind !== 'post') removePhoto(st.media);
    }
    db.prepare('DELETE FROM follows WHERE professional_id = ?').run(id);
    for (const u of db.prepare('SELECT id FROM upload_sessions WHERE professional_id = ?').all(id)) discardUpload(u.id);
  }
  for (const c of db.prepare('SELECT id FROM post_comments WHERE role = ? AND user_id = ?').all(role, id)) {
    db.prepare('DELETE FROM notifications WHERE comment_id = ?').run(c.id);
  }
  db.prepare('DELETE FROM post_comments WHERE role = ? AND user_id = ?').run(role, id);
  db.prepare('DELETE FROM post_likes WHERE role = ? AND user_id = ?').run(role, id);
  db.prepare('DELETE FROM story_likes WHERE role = ? AND user_id = ?').run(role, id);
  db.prepare('DELETE FROM post_views WHERE role = ? AND user_id = ?').run(role, id);
  db.prepare('DELETE FROM follows WHERE follower_role = ? AND follower_id = ?').run(role, id);
  db.prepare('DELETE FROM notifications WHERE (recipient_role = ? AND recipient_id = ?) OR (actor_role = ? AND actor_id = ?)').run(role, id, role, id);
}

module.exports = { getLimits, setLimits, overLimit, enforceLimits, purgeUserSocial, fixOldAspects, router, followInfo, cleanupStories, actor, visiblePro, socialPro, imageCount, postImages, postOut, commentOut, createPost, deletePostFully };
