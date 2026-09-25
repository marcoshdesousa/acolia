'use strict';
// Versão 1.1.3 — Secretária do profissional.
// Cada profissional pode ter UMA secretária. Login e senha são gerados pelo sistema (aleatórios).
// Ela entra no mesmo lugar do profissional e usa o painel DELE (sessão de profissional marcada com
// secretary_id), com limites: não entra nas chamadas, não mexe no perfil, na senha, na conta, no
// pagamento (Asaas / chave Pix) e não vê o código único. As mensagens que ela manda saem como do
// profissional (o paciente não vê diferença); o profissional e a secretária veem o selo "Secretária".
const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const { db } = require('./db');
const U = require('./util');

db.exec(`CREATE TABLE IF NOT EXISTS secretaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  professional_id INTEGER NOT NULL UNIQUE REFERENCES professionals(id) ON DELETE CASCADE,
  login TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
)`);

// Quem está fazendo o pedido (para marcar as mensagens da secretária sem mudar cada rota)
const ctx = new AsyncLocalStorage();
const current = () => ctx.getStore()?.secretaryId || null;

function newLogin() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  for (;;) {
    const b = crypto.randomBytes(6);
    let s = 'secretaria.';
    for (let i = 0; i < 6; i++) s += abc[b[i] % abc.length];
    if (!db.prepare('SELECT 1 FROM secretaries WHERE login = ?').get(s)) return s;
  }
}

const ofPro = (proId) => db.prepare('SELECT id, login, created_at, last_login_at FROM secretaries WHERE professional_id = ?').get(proId) || null;
const byLogin = (login) => db.prepare('SELECT * FROM secretaries WHERE login = ?').get(String(login || '').trim().toLowerCase()) || null;

// Cria (ou gera nova senha). A senha só aparece nesta hora: depois fica só o "hash".
function create(proId) {
  if (ofPro(proId)) throw new U.HttpError(409, 'Você já tem uma secretária. Para trocar, apague a atual primeiro.');
  const login = newLogin();
  const password = U.randomPassword(10);
  db.prepare('INSERT INTO secretaries (professional_id, login, password_hash) VALUES (?, ?, ?)').run(proId, login, U.hashPassword(password));
  return { login, password };
}
function resetPassword(proId) {
  const s = ofPro(proId);
  if (!s) throw new U.HttpError(404, 'Você ainda não tem secretária.');
  const password = U.randomPassword(10);
  db.prepare('UPDATE secretaries SET password_hash = ? WHERE id = ?').run(U.hashPassword(password), s.id);
  db.prepare('DELETE FROM sessions WHERE secretary_id = ?').run(s.id); // quem estava logada sai
  return { login: s.login, password };
}
function remove(proId) {
  const s = ofPro(proId);
  if (!s) return;
  db.prepare('DELETE FROM sessions WHERE secretary_id = ?').run(s.id);
  db.prepare('DELETE FROM secretaries WHERE id = ?').run(s.id);
}

// ---------- O que a secretária NÃO pode (conferido no servidor) ----------
const DENY = [
  // foto, galeria, link, senha, apagar conta e a própria secretária (o perfil ela muda só em parte: ver routes/professional.js)
  ['POST', /^\/api\/professional\/(photo|gallery\/[^/]+|slug|password|delete)$/, 'mudar o perfil, a senha ou a conta'],
  ['DELETE', /^\/api\/professional\/gallery\/[^/]+$/, 'mudar o perfil'],
  [null, /^\/api\/professional\/secretary(\/.*)?$/, 'mexer na secretária'],
  // pagamento automático (Asaas)
  [null, /^\/api\/agenda\/asaas$/, 'mexer no pagamento automático pelo Pix'],
  // documentos (atestado, receita, encaminhamento): levam a assinatura do profissional
  ['POST', /^\/api\/docs\/?$/, 'enviar documentos (atestado, receita ou encaminhamento): eles levam a assinatura do profissional'],
  ['GET', /^\/api\/docs\/options\/[^/]+$/, 'enviar documentos (atestado, receita ou encaminhamento): eles levam a assinatura do profissional'],
  // chamadas de vídeo
  ['POST', /^\/api\/calls(\/(?!resolve$).*)?$/, 'entrar nas chamadas de vídeo'],
];
function guard(req, _res, next) {
  if (!req.auth?.secretary) return next();
  const path = req.path.startsWith('/api') ? req.path : req.originalUrl.split('?')[0];
  for (const [method, re, what] of DENY) {
    if ((!method || method === req.method) && re.test(path)) return next(new U.HttpError(403, `A secretária não pode ${what}. Só o profissional.`));
  }
  if (req.method === 'PUT' && path === '/api/agenda/settings' && req.body && req.body.pix_key !== undefined) {
    return next(new U.HttpError(403, 'A secretária não pode mudar a chave Pix. Só o profissional.'));
  }
  next();
}

module.exports = { ctx, current, ofPro, byLogin, create, resetPassword, remove, guard };
