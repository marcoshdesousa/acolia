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
  // Menos internet: JSON da API compactado
  app.use('/api', require('./compress').compressJson);
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

  // Respostas da API nunca ficam guardadas no navegador (ex.: depois de sair, não mostra a conta antiga)
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  // Conta bloqueada: só consegue ver quem é (tela de bloqueio), sair e excluir a própria conta
  const BLOCKED_OK = ['/auth/me', '/auth/logout', '/config', '/professional/delete', '/patient/delete', '/push/unsubscribe'];
  app.use('/api', (req, _res, next) => {
    if (req.auth?.blocked && !BLOCKED_OK.includes(req.path)) {
      return next(Object.assign(new U.HttpError(423, 'Perfil bloqueado. Fale com a administração.'), { blocked: true }));
    }
    next();
  });
  // Secretária (versão 1.1.3): o que ela não pode fazer é barrado aqui; e as mensagens que ela manda
  // ficam marcadas (o pedido inteiro "sabe" que foi ela)
  const SEC = require('./secretary');
  app.use(SEC.guard);
  app.use((req, _res, next) => SEC.ctx.run({ secretaryId: req.auth?.secretary?.id || null }, next));
  require('./blocklist'); // lista de bloqueados (cria a tabela e inclui quem já estava bloqueado)
  app.use('/api/auth', require('./routes/auth').router);
  app.use('/api', require('./routes/public').router);
  app.use('/api/patient', require('./routes/patient').router);
  app.use('/api/professional', require('./routes/professional').router);
  app.use('/api/chat', require('./routes/chat').router);
  app.use('/api/support', require('./routes/support').router); // Suporte Acolia (conversa fixa no topo)
  app.use('/api/social', require('./routes/social').router);
  app.use('/api/push', require('./routes/push').router);
  app.use('/api/calls', require('./routes/calls').router);
  app.use('/api/agenda', require('./routes/agenda').router); // agenda, consultas e pagamento por Pix
  app.use('/api/admin', require('./routes/admin').router);
  app.use('/api/docs', require('./routes/docs').router); // atestado, receita e encaminhamento
  app.use('/api', (_req, _res, next) => next(new U.HttpError(404, 'Rota não encontrada.')));

  // Fotos: se não estiverem no disco (servidor reiniciou), baixa da nuvem
  app.get('/uploads/:name', async (req, _res, next) => {
    await cloud.ensureLocalFile('uploads', path.join(UPLOAD_DIR, path.basename(req.params.name)));
    next();
  });
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', immutable: true }));
  const pub = path.join(__dirname, '..', 'public');
  // Páginas, CSS e JS já compactados (Brotli/gzip) e imagens com cache no aparelho
  app.use(require('./compress').staticCompressed(pub));
  app.use(express.static(pub, { extensions: ['html'], maxAge: '1d' }));
  // Publicação compartilhada (aviãozinho): qualquer pessoa vê. A página já sai com a prévia
  // (foto, nome e descrição) para aparecer bonita no WhatsApp e em outras redes.
  const postHtml = require('node:fs').readFileSync(path.join(pub, 'post.html'), 'utf8');
  app.get('/p/:id', (req, res) => {
    const { db } = require('./db');
    const safe = (t, n) => U.cleanText(t, n).replace(/[<>&"]/g, '');
    const post = db.prepare('SELECT po.*, p.name, p.profession FROM posts po JOIN professionals p ON p.id = po.professional_id WHERE po.id = ?').get(Number(req.params.id));
    let html = postHtml;
    if (post && require('./routes/social').socialPro(post.professional_id)) {
      const origin = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
      const title = safe(`${post.name} na Acolia`, 120);
      const desc = safe(post.caption || `Veja a publicação de ${post.name} (${post.profession}) na Acolia.`, 200);
      const img = `${origin}${post.thumb || post.image || '/img/app-icon-512.png'}`; // texto: usa o ícone da Acolia
      html = html
        .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
        .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${desc}">`)
        .replace(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${title}">`)
        .replace(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${desc}">`)
        .replace(/<meta property="og:image"[^>]*>/, `<meta property="og:image" content="${img}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${origin}/p/${post.id}">
  <meta name="twitter:card" content="summary_large_image">`);
    }
    res.type('html').send(html);
  });
  // Verificação pública de documento (QR Code do atestado/receita/encaminhamento)
  app.get('/v/:code', (_req, res) => res.sendFile(path.join(pub, 'verificar.html')));
  // Link próprio do profissional: site.com/<slug> abre o perfil dele
  const profileHtml = require('node:fs').readFileSync(path.join(pub, 'profissional.html'), 'utf8');
  app.get(/^\/([a-zA-Z0-9-]{3,40})\/?$/, (req, res, next) => {
    const { db } = require('./db');
    const slug = req.params[0].toLowerCase();
    const p = db.prepare("SELECT name, profession, registry, city, state, status FROM professionals WHERE slug = ? AND status <> 'excluido'").get(slug);
    if (!p) return next();
    const official = p.status === 'oficial';
    const title = U.cleanText(official ? `${p.name} — perfil oficial | Acolia` : `${p.name} — ${p.profession} | Acolia`, 160).replace(/[<>&"]/g, '');
    const desc = U.cleanText(official ? 'Perfil oficial da Acolia: saúde mental ao seu alcance. Veja as publicações.'
      : `${p.profession}${p.registry ? ` (${p.registry})` : ''}. Veja o perfil e agende sua consulta online pela Acolia.`, 300).replace(/[<>&"]/g, '');
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
    res.status(status).json({ error: status >= 500 ? 'Erro interno. Tente novamente.' : err.message, ...(err.blocked ? { blocked: true } : {}) });
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
  require('./launchReset').runOnce(); // início oficial: zera as contas de teste/antigas (uma vez só)
  require('./official').officialId(); // cria o perfil oficial Acolia Brasil (uma vez só)
  // Contas de teste (Profissional Teste, Paciente Teste e a secretária de teste): apagadas a pedido do
  // dono, uma vez. Não são mais criadas sozinhas na subida do servidor: só pelos botões do admin
  // ("Recriar contas de teste" / "Preparar o teste de novo").
  require('./testAccounts').removeTestAccountsOnce();
  // …e recriadas depois, a pedido do dono (uma vez), com a agenda e o Asaas simulado de antes
  if (process.env.TEST_ACCOUNTS !== '0') require('./testAgenda').recreateOnce();
  require('./handles').backfill(); // todo paciente tem um @ (o Paciente Teste é @pacienteteste)
  // Stories somem depois de 24 h
  const { cleanupStories } = require('./routes/social');
  cleanupStories();
  setInterval(cleanupStories, 60 * 60 * 1000).unref();
  // Agenda: prazos do Pix, chamada automática, ausência do profissional, consultas concluídas
  const agenda = require('./agenda');
  setInterval(() => agenda.sweep(), 20 * 1000).unref();
  // Fotos antigas: grava o formato do feed (4:5, 1:1 ou 1,91:1) para aparecerem recortadas certinho
  require('./routes/social').fixOldAspects().catch((e) => console.error('[formatos]', e.message));
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
