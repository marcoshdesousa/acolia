'use strict';
const express = require('express');
const { db } = require('../db');
const U = require('../util');
const A = require('../auth');
const { verifyCpfName, isConfigured: cpfApiConfigured } = require('../cpf');
const { ownProfessional, ownPatient } = require('../serialize');
const { validateRegistry, verifyRegistry, isApiConfigured: registryApiConfigured } = require('../registry');
const { handleDocument, removeDocument } = require('../upload');

const router = express.Router();
const { HttpError } = U;

const PROFESSIONS = ['Psicólogo(a)', 'Psicanalista', 'Psiquiatra', 'Psicoterapeuta', 'Neuropsicólogo(a)', 'Terapeuta'];

function requirePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 6) throw new HttpError(400, 'A senha precisa ter pelo menos 6 caracteres.');
  if (pw.length > 200) throw new HttpError(400, 'Senha muito longa.');
}

function validateLocation(state, city) {
  if (!U.isUf(state)) throw new HttpError(400, 'Selecione o estado (UF).');
  const c = U.cleanText(city, 80);
  if (c.length < 2) throw new HttpError(400, 'Informe o município.');
  return { state: state.toUpperCase(), city: c };
}

// ---------- Paciente ----------
router.post('/patient/register', async (req, res) => {
  const name = U.cleanText(req.body.name, 120);
  const cpf = U.onlyDigits(req.body.cpf);
  if (!U.isFullName(name)) throw new HttpError(400, 'Informe seu nome completo (nome e sobrenome), igual ao do CPF.');
  if (!U.isValidCpf(cpf)) throw new HttpError(400, 'CPF inválido. Confira os números digitados.');
  const { state, city } = validateLocation(req.body.state, req.body.city);
  requirePassword(req.body.password);
  if (db.prepare('SELECT 1 FROM patients WHERE cpf = ?').get(cpf)) throw new HttpError(409, 'Já existe uma conta com este CPF. Faça login ou recupere sua senha.');

  let verified = 0;
  if (cpfApiConfigured()) {
    const r = await verifyCpfName(cpf, name);
    if (r.error) throw new HttpError(503, 'Não foi possível confirmar seu CPF agora. Tente novamente em alguns minutos.');
    if (!r.match) throw new HttpError(400, r.message || 'O nome informado não confere com o CPF.');
    verified = 1;
  }

  const info = db.prepare(`INSERT INTO patients (name, cpf, cpf_name_verified, state, city, city_norm, password_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(name, cpf, verified, state, city, U.norm(city), U.hashPassword(req.body.password));
  A.createSession(res, 'patient', Number(info.lastInsertRowid));
  res.status(201).json({ ok: true });
});

router.post('/patient/login', (req, res) => {
  const cpf = U.onlyDigits(req.body.cpf);
  const key = `pat:${req.ip}:${cpf}`;
  A.checkLoginRate(key);
  const p = db.prepare('SELECT * FROM patients WHERE cpf = ?').get(cpf);
  if (!p || !U.verifyPassword(req.body.password || '', p.password_hash)) {
    A.registerLoginFailure(key);
    throw new HttpError(401, 'CPF ou senha incorretos.');
  }
  if (p.status !== 'ativo') throw new HttpError(403, 'Sua conta está bloqueada. Fale com a administração.');
  A.clearLoginFailures(key);
  A.createSession(res, 'patient', p.id);
  res.json({ ok: true });
});

// Esqueci a senha: confere CPF + nome completo e gera uma senha aleatória
router.post('/patient/recover', (req, res) => {
  const cpf = U.onlyDigits(req.body.cpf);
  const key = `rec:${req.ip}`;
  A.checkLoginRate(key);
  const p = db.prepare('SELECT * FROM patients WHERE cpf = ?').get(cpf);
  if (!p || U.norm(p.name) !== U.norm(req.body.name)) {
    A.registerLoginFailure(key);
    throw new HttpError(400, 'Os dados não conferem. Verifique o CPF e o nome completo.');
  }
  if (p.status !== 'ativo') throw new HttpError(403, 'Sua conta está bloqueada. Fale com a administração.');
  const password = U.randomPassword(10);
  db.prepare('UPDATE patients SET password_hash = ? WHERE id = ?').run(U.hashPassword(password), p.id);
  A.destroyUserSessions('patient', p.id);
  res.json({ ok: true, password });
});

// ---------- Profissional ----------
function newProfessionalCode() {
  for (;;) {
    const code = U.randomMixedCode(8);
    if (!db.prepare('SELECT 1 FROM professionals WHERE code = ?').get(code)) return code;
  }
}

function validateProfessionalInput(body) {
  const name = U.cleanText(body.name, 120);
  const profession = U.cleanText(body.profession, 60);
  const registry = U.cleanText(body.registry, 40);
  const email = U.cleanText(body.email, 160).toLowerCase();
  const phone = U.onlyDigits(body.phone);
  if (!U.isFullName(name)) throw new HttpError(400, 'Informe nome e sobrenome.');
  if (!PROFESSIONS.includes(profession)) throw new HttpError(400, 'Selecione sua profissão.');
  if (registry.length < 3) throw new HttpError(400, 'Informe o número do seu registro profissional (CRP, CRM etc.).');
  if (!U.isValidEmail(email)) throw new HttpError(400, 'E-mail inválido.');
  if (phone.length < 10 || phone.length > 13) throw new HttpError(400, 'Informe o WhatsApp com DDD.');
  const { state, city } = validateLocation(body.state, body.city);
  if (db.prepare('SELECT 1 FROM professionals WHERE email = ?').get(email)) throw new HttpError(409, 'Este e-mail já está cadastrado.');
  return { name, profession, registry, email, phone, state, city };
}

function insertProfessional(d, passwordHash, status, subscriptionUntil = null) {
  const code = newProfessionalCode();
  const info = db.prepare(`INSERT INTO professionals
    (code, name, profession, registry, email, phone, password_hash, status, state, city, city_norm, subscription_until,
     document_file, registry_verified, legal_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(code, d.name, d.profession, d.registry, d.email, d.phone, passwordHash, status, d.state, d.city, U.norm(d.city), subscriptionUntil,
      d.document_file || null, d.registry_verified ? 1 : 0, d.name);
  return { id: Number(info.lastInsertRowid), code };
}

// Autocadastro: o registro (CRP/CRM) precisa ser válido e do mesmo estado, e a
// foto da carteirinha é obrigatória. (Cadastro feito pelo admin não passa por aqui.)
router.post('/professional/register', async (req, res) => {
  const documentFile = await handleDocument(req, res);
  try {
    if (!documentFile) throw new HttpError(400, 'Envie a foto da sua carteirinha profissional (frente, com nome e número legíveis).');
    const d = validateProfessionalInput(req.body);
    requirePassword(req.body.password);
    const reg = validateRegistry(d.profession, req.body.registry, d.state);
    if (db.prepare('SELECT 1 FROM professionals WHERE registry = ?').get(reg.registry)) {
      throw new HttpError(409, `Já existe um cadastro com o ${reg.registry}. Se é você, entre na sua conta ou fale com a administração.`);
    }
    let verified = false;
    if (reg.council && registryApiConfigured()) {
      const r = await verifyRegistry(reg, d.name);
      if (r.error) throw new HttpError(503, 'Não foi possível consultar o conselho agora. Tente novamente em alguns minutos.');
      if (!r.match) throw new HttpError(400, r.message || 'Registro não confere.');
      verified = true;
    }
    const { code } = insertProfessional({ ...d, registry: reg.registry, document_file: documentFile, registry_verified: verified },
      U.hashPassword(req.body.password), 'pendente');
    res.status(201).json({ ok: true, code });
  } catch (e) {
    removeDocument(documentFile);
    throw e;
  }
});

router.post('/professional/login', (req, res) => {
  const login = U.cleanText(req.body.login, 160);
  const key = `pro:${req.ip}:${login.toLowerCase()}`;
  A.checkLoginRate(key);
  const p = db.prepare('SELECT * FROM professionals WHERE code = ? OR email = ?').get(login.toUpperCase(), login.toLowerCase());
  if (!p || !U.verifyPassword(req.body.password || '', p.password_hash)) {
    A.registerLoginFailure(key);
    throw new HttpError(401, 'Código/e-mail ou senha incorretos.');
  }
  A.clearLoginFailures(key);
  if (p.status === 'pendente') throw new HttpError(403, 'Seu cadastro ainda está em análise. Você poderá entrar assim que a administração aprovar.');
  if (p.status === 'recusado') throw new HttpError(403, 'Seu cadastro não foi aprovado. Fale com a administração.');
  if (p.status === 'bloqueado') throw new HttpError(403, 'Seu acesso está bloqueado. Fale com a administração.');
  A.createSession(res, 'professional', p.id);
  res.json({ ok: true });
});

// ---------- Administrador ----------
router.post('/admin/login', (req, res) => {
  const username = U.cleanText(req.body.username, 60);
  const key = `adm:${req.ip}`;
  A.checkLoginRate(key);
  const a = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!a || !U.verifyPassword(req.body.password || '', a.password_hash)) {
    A.registerLoginFailure(key);
    throw new HttpError(401, 'Usuário ou senha incorretos.');
  }
  A.clearLoginFailures(key);
  A.createSession(res, 'admin', a.id);
  res.json({ ok: true });
});

// ---------- Comum ----------
router.post('/logout', (req, res) => {
  A.destroySession(req, res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.auth) return res.json({ role: null });
  const { role, user } = req.auth;
  if (role === 'admin') return res.json({ role, user: { id: user.id, username: user.username } });
  if (role === 'professional') return res.json({ role, user: ownProfessional(user) });
  return res.json({ role, user: ownPatient(user) });
});

module.exports = { router, PROFESSIONS, validateProfessionalInput, insertProfessional, requirePassword, validateLocation };
