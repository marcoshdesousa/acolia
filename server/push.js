'use strict';
// Notificações no celular/computador (Web Push), mesmo com o app fechado.
// As chaves (VAPID) são criadas uma vez e guardadas no banco — não precisa configurar nada.
const webpush = require('web-push');
const { db } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  keys TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(role, user_id);
`);

function setting(key, make) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row) return row.value;
  const value = make();
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
  return value;
}

const vapid = JSON.parse(setting('vapid', () => JSON.stringify(webpush.generateVAPIDKeys())));
webpush.setVapidDetails(process.env.PUSH_CONTACT || 'mailto:contato@acolia.com.br', vapid.publicKey, vapid.privateKey);

function publicKey() { return vapid.publicKey; }

function subscribe(role, userId, sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw Object.assign(new Error('Inscrição de notificação inválida.'), { status: 400 });
  }
  db.prepare(`INSERT INTO push_subscriptions (role, user_id, endpoint, keys) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET role = excluded.role, user_id = excluded.user_id, keys = excluded.keys`)
    .run(role, userId, sub.endpoint, JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }));
}

function unsubscribe(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(String(endpoint || ''));
}

function removeUser(role, userId) {
  db.prepare('DELETE FROM push_subscriptions WHERE role = ? AND user_id = ?').run(role, userId);
}

// Envia para todos os aparelhos da pessoa. Nunca derruba a requisição que chamou.
function notify(role, userId, payload) {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE role = ? AND user_id = ?').all(role, userId);
  const body = JSON.stringify(payload);
  for (const s of subs) {
    webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, body, { TTL: 60 * 60 * 24, urgency: 'high' })
      .catch((e) => {
        if (e.statusCode === 404 || e.statusCode === 410) unsubscribe(s.endpoint); // aparelho desinstalou ou revogou
        else console.error('[push] falha ao enviar:', e.statusCode || e.message);
      });
  }
}

module.exports = { publicKey, subscribe, unsubscribe, removeUser, notify };
