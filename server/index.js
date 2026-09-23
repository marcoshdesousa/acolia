'use strict';
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const U = require('./util');
const cloud = require('./cloud');
// Os módulos que abrem o banco são carregados só depois de restaurá-lo da nuvem (ver start()).

// Cria o administrador geral na primeira execução
function ensureAdmin() {
  const { db } = require('./db');
  const username = process.env.ADMIN_USER || 'admin';
  if (db.prepare('SELECT 1 FROM admins').get()) return;
  const password = process.env.ADMIN_PASSWORD || U.randomPassword(12);
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, U.hashPassword(password));
  console.log('\n==============================================');
  console.log(' Administrador geral criado');
  console.log(`   usuário: ${username}`);
  console.log(`   senha:   ${process.env.ADMIN_PASSWORD ? '(a definida em ADMIN_PASSWORD)' : password}`);
  console.log(' Troque a senha no painel /admin após entrar.');
  console.log('==============================================\n');
}

function createApp() {
  const { attachSession } = require('./auth');
  const { UPLOAD_DIR } = require('./upload');
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  // Depois de qualquer alteração bem-sucedida, agenda uma cópia do banco na nuvem
  app.use((req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      res.on('finish', () => { if (res.statusCode < 400) cloud.scheduleBackup(); });
    }
    next();
  });
  app.use(attachSession);

  // Bloqueia requisições de outros sites que tentem usar o cookie (CSRF)
  app.use('/api', (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return next(new U.HttpError(403, 'Origem não permitida.'));
    next();
  });

  app.use('/api/auth', require('./routes/auth').router);
  app.use('/api', require('./routes/public').router);
  app.use('/api/patient', require('./routes/patient').router);
  app.use('/api/professional', require('./routes/professional').router);
  app.use('/api/chat', require('./routes/chat').router);
  app.use('/api/social', require('./routes/social').router);
  app.use('/api/push', require('./routes/push').router);
  app.use('/api/calls', require('./routes/calls').router);
  app.use('/api/admin', require('./routes/admin').router);
  app.use('/api', (_req, _res, next) => next(new U.HttpError(404, 'Rota não encontrada.')));

  // Fotos: se não estiverem no disco (servidor reiniciou), baixa da nuvem
  app.get('/uploads/:name', async (req, _res, next) => {
    await cloud.ensureLocalFile('uploads', path.join(UPLOAD_DIR, path.basename(req.params.name)));
    next();
  });
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', immutable: true }));
  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub, { extensions: ['html'] }));
  // Publicação compartilhada (aviãozinho): só abre para quem tem conta
  app.get('/p/:id', (_req, res) => res.sendFile(path.join(pub, 'post.html')));
  // Link próprio do profissional: site.com/<slug> abre o perfil dele
  const profileHtml = require('node:fs').readFileSync(path.join(pub, 'profissional.html'), 'utf8');
  app.get(/^\/([a-zA-Z0-9-]{3,40})\/?$/, (req, res, next) => {
    const { db } = require('./db');
    const slug = req.params[0].toLowerCase();
    const p = db.prepare("SELECT name, profession, registry, city, state FROM professionals WHERE slug = ? AND status <> 'excluido'").get(slug);
    if (!p) return next();
    const title = U.cleanText(`${p.name} — ${p.profession} | Acolia`, 160).replace(/[<>&"]/g, '');
    const desc = U.cleanText(`${p.profession} (${p.registry}). Veja o perfil, valores e agende sua consulta online pela Acolia.`, 300).replace(/[<>&"]/g, '');
    const html = profileHtml
      .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>
  <meta name="description" content="${desc}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${desc}">
  <meta property="og:image" content="/img/app-icon-512.png">
  <meta property="og:type" content="profile">`)
      .replace('<body>', `<body data-slug="${slug}">`);
    res.type('html').send(html);
  });

  app.use((_req, res) => res.status(404).sendFile(path.join(pub, '404.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Erro interno. Tente novamente.' : err.message });
  });
  return app;
}

async function start(port = Number(process.env.PORT) || 3000) {
  const paths = require('./paths');
  await cloud.restoreDb(paths.DB_FILE);
  const st = paths.storageStatus();
  console.log(`[dados] ${st.label}${st.permanent ? '' : ' — ATENÇÃO: não é permanente, adicione um disco no Render'}`);
  const { setupSocket } = require('./socket');
  ensureAdmin();
  if (process.env.TEST_ACCOUNTS !== '0') require('./testAccounts').seedOnce();
  // Stories somem depois de 24 h
  const { cleanupStories } = require('./routes/social');
  cleanupStories();
  setInterval(cleanupStories, 60 * 60 * 1000).unref();
  const app = createApp();
  const server = http.createServer(app);
  setupSocket(server);
  return new Promise((resolve) => server.listen(port, () => {
    console.log(`Acolia rodando em http://localhost:${server.address().port}`);
    resolve(server);
  }));
}

// Ao desligar (atualização ou o servidor "dormindo"), salva a última cópia na nuvem
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[${signal}] salvando dados e desligando…`);
  await cloud.flush().catch((e) => console.error(e));
  process.exit(0);
}

if (require.main === module) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  start().catch((e) => {
    console.error('Não foi possível iniciar:', e.message);
    process.exit(1);
  });
}

module.exports = { createApp, start };
