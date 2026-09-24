'use strict';
// Início oficial da plataforma (versão 1.2): apaga UMA VEZ SÓ todas as contas criadas até aqui
// (pacientes, profissionais e as contas de teste) e tudo o que elas fizeram — publicações, reels,
// stories, fotos, vídeos, curtidas, comentários, conversas, áudios, documentos, atendimentos.
// Ficam: o administrador, o perfil oficial "Acolia Brasil" (sem as publicações antigas) e as
// configurações. CPFs, e-mails e registros ficam livres para criar a conta de novo.
// As contas de teste não voltam sozinhas: o admin recria no botão "Criar contas de teste".
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('./db');

const KEY = 'launch_reset_v1';

function wipeDir(dir) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try { fs.rmSync(path.join(dir, f), { recursive: true, force: true }); n++; } catch { /* ignora */ }
    }
  } catch { /* pasta não existe */ }
  return n;
}

function runOnce() {
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(KEY)) return null;
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const count = (sql) => db.prepare(sql).get().n;
  const before = {
    patients: count('SELECT COUNT(*) n FROM patients'),
    professionals: count("SELECT COUNT(*) n FROM professionals WHERE status <> 'oficial'"),
    posts: has('posts') ? count('SELECT COUNT(*) n FROM posts') : 0,
    messages: count('SELECT COUNT(*) n FROM messages'),
  };
  db.exec('BEGIN');
  try {
    // Filhos primeiro (chaves estrangeiras)
    for (const t of ['notifications', 'story_likes', 'stories', 'post_views', 'post_likes', 'post_comments', 'post_images', 'posts',
      'follows', 'favorites', 'documents', 'messages', 'chat_blocks', 'calls', 'conversations', 'upload_sessions', 'blocked_identities']) {
      if (has(t)) db.exec(`DELETE FROM ${t}`);
    }
    if (has('push_subscriptions')) db.exec("DELETE FROM push_subscriptions WHERE role <> 'admin'");
    db.exec("DELETE FROM sessions WHERE role <> 'admin'");
    db.exec('DELETE FROM patients');
    db.exec("DELETE FROM professionals WHERE status <> 'oficial'");
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('test_accounts_seeded', ?)").run(new Date().toISOString());
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(KEY, JSON.stringify({ at: new Date().toISOString(), before }));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // Arquivos (fotos, vídeos, áudios, carteirinhas) no disco e na nuvem
  const { DATA_DIR } = require('./paths');
  const files = ['uploads', 'audio', 'documents', 'uploads-parts'].reduce((n, d) => n + wipeDir(path.join(DATA_DIR, d)), 0);
  const cloud = require('./cloud');
  Promise.all(['uploads', 'audio', 'documents'].map((f) => cloud.removeFolder(f).catch(() => 0)))
    .then((r) => { if (cloud.enabled) console.log(`[início oficial] ${r.reduce((a, b) => a + b, 0)} arquivos apagados da nuvem`); });
  cloud.scheduleBackup(500);
  console.log(`[início oficial] apagados: ${before.patients} pacientes, ${before.professionals} profissionais, ${before.posts} publicações, ${before.messages} mensagens, ${files} arquivos do disco`);
  return before;
}

module.exports = { runOnce, KEY };
