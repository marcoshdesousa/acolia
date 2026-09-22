'use strict';
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { db } = require('./db');
const U = require('./util');
const { attachSession } = require('./auth');
const { UPLOAD_DIR } = require('./upload');
const { setupSocket } = require('./socket');

// Cria o administrador geral na primeira execução
function ensureAdmin() {
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
  app.use('/api/calls', require('./routes/calls').router);
  app.use('/api/admin', require('./routes/admin').router);
  app.use('/api', (_req, _res, next) => next(new U.HttpError(404, 'Rota não encontrada.')));

  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', immutable: true }));
  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub, { extensions: ['html'] }));
  app.use((_req, res) => res.status(404).sendFile(path.join(pub, '404.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Erro interno. Tente novamente.' : err.message });
  });
  return app;
}

function start(port = Number(process.env.PORT) || 3000) {
  ensureAdmin();
  const app = createApp();
  const server = http.createServer(app);
  setupSocket(server);
  return new Promise((resolve) => server.listen(port, () => {
    console.log(`Acolia rodando em http://localhost:${server.address().port}`);
    resolve(server);
  }));
}

if (require.main === module) start();

module.exports = { createApp, start };
