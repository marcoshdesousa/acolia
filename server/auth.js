'use strict';
const crypto = require('node:crypto');
const { db } = require('./db');
const { HttpError } = require('./util');

const COOKIE = 'acolia_sid';
const SESSION_DAYS = 30;

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

// secretaryId: a secretária entra como o profissional dela, com a sessão marcada (versão 1.1.3)
function createSession(res, role, userId, secretaryId = null) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  db.prepare('INSERT INTO sessions (token, role, user_id, expires_at, secretary_id) VALUES (?, ?, ?, ?, ?)').run(token, role, userId, expires, secretaryId);
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  return token;
}

function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function destroyUserSessions(role, userId) {
  db.prepare('DELETE FROM sessions WHERE role = ? AND user_id = ?').run(role, userId);
}

// Retorna {role, user} a partir do cabeçalho Cookie, validando se a conta continua ativa.
// Conta bloqueada (pelo admin ou assinatura vencida) só volta com allowBlocked (as páginas
// mostram a tela de bloqueio); chat, chamadas e o resto da API não aceitam.
function sessionFromCookie(cookieHeader, { allowBlocked = false } = {}) {
  const token = parseCookies(cookieHeader)[COOKIE];
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  let user;
  if (s.role === 'admin') user = db.prepare('SELECT id, username FROM admins WHERE id = ?').get(s.user_id);
  else if (s.role === 'professional') {
    user = db.prepare('SELECT * FROM professionals WHERE id = ?').get(s.user_id);
    if (user && !['aprovado', 'restrito', 'bloqueado'].includes(user.status)) user = null;
  } else if (s.role === 'patient') {
    user = db.prepare('SELECT * FROM patients WHERE id = ?').get(s.user_id);
    if (user && !['ativo', 'bloqueado'].includes(user.status)) user = null;
  }
  if (!user) return null;
  // Secretária: a conta dela precisa continuar existindo (o profissional pode apagar ou trocar a senha)
  let secretary = null;
  if (s.secretary_id) {
    secretary = db.prepare('SELECT id, login FROM secretaries WHERE id = ? AND professional_id = ?').get(s.secretary_id, s.user_id);
    if (!secretary) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); return null; }
  }
  const blocked = require('./accountState').stateOf(s.role, user).blocked || null;
  if (blocked && !allowBlocked) return null;
  return { role: s.role, user, token, blocked, secretary };
}

function attachSession(req, _res, next) {
  req.auth = sessionFromCookie(req.headers.cookie, { allowBlocked: true });
  next();
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) return next(new HttpError(401, 'Faça login para continuar.'));
    next();
  };
}

// Limite simples de tentativas de login por IP + identificador
const attempts = new Map();
function checkLoginRate(key) {
  const now = Date.now();
  const a = attempts.get(key) || { n: 0, until: 0, first: now };
  if (a.until > now) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
  return a;
}
function registerLoginFailure(key) {
  const now = Date.now();
  const a = attempts.get(key) || { n: 0, until: 0, first: now };
  if (now - a.first > 15 * 60e3) { a.n = 0; a.first = now; }
  a.n += 1;
  if (a.n >= 8) { a.until = now + 10 * 60e3; a.n = 0; a.first = now; }
  attempts.set(key, a);
}
function clearLoginFailures(key) { attempts.delete(key); }

setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  const now = Date.now();
  for (const [k, a] of attempts) if (a.until < now && now - a.first > 15 * 60e3) attempts.delete(k);
}, 60 * 60e3).unref();

module.exports = {
  createSession, destroySession, destroyUserSessions, sessionFromCookie, attachSession, requireRole,
  checkLoginRate, registerLoginFailure, clearLoginFailures,
};
