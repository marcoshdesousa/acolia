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

const NO_PASSWORD = '!sem-senha'; // profissional que ainda não recebeu a primeira senha

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
  const birth = String(req.body.birth_date || '');
  if (!U.isValidBirthDate(birth)) throw new HttpError(400, 'Informe sua data de nascimento.');
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

  // CPF bloqueado pela administração (mesmo que tenha apagado a conta antiga): a conta nasce bloqueada
  const status = require('../blocklist').isBlocked('patient', { cpf }) ? 'bloqueado' : 'ativo';
  const info = db.prepare(`INSERT INTO patients (name, cpf, cpf_name_verified, birth_date, state, city, city_norm, password_hash, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(name, cpf, verified, birth, state, city, U.norm(city), U.hashPassword(req.body.password), status);
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
  // Bloqueado entra, mas só vê a tela de bloqueio (falar com a administração / excluir a conta)
  if (!['ativo', 'bloqueado'].includes(p.status)) throw new HttpError(403, 'Esta conta foi excluída.');
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
  const birth = String(req.body.birth_date || '');
  if (!p || U.norm(p.name) !== U.norm(req.body.name) || (p.birth_date && p.birth_date !== birth)) {
    A.registerLoginFailure(key);
    throw new HttpError(400, 'Os dados não conferem. Verifique o nome completo, o CPF e a data de nascimento.');
  }
  if (!p.birth_date) throw new HttpError(400, 'Sua conta ainda não tem data de nascimento. Fale com o nosso atendimento para recuperar a senha.');
  if (p.status !== 'ativo') throw new HttpError(403, 'Sua conta está bloqueada. Fale com a administração.');
  requirePassword(req.body.password); // a pessoa escolhe a senha nova
  A.clearLoginFailures(key);
  db.prepare('UPDATE patients SET password_hash = ? WHERE id = ?').run(U.hashPassword(req.body.password), p.id);
  A.destroyUserSessions('patient', p.id);
  res.json({ ok: true });
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
  // Registro/carteirinha: obrigatório só para quem tem conselho (CRP: psicólogo e neuropsicólogo; CRM: psiquiatra)
  if (require('../registry').councilFor(profession) && registry.length < 3) throw new HttpError(400, 'Informe o número do seu registro profissional (CRP ou CRM).');
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
     document_file, registry_verified, legal_name, slug)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(code, d.name, d.profession, d.registry, d.email, d.phone, passwordHash, status, d.state, d.city, U.norm(d.city), subscriptionUntil,
      d.document_file || null, d.registry_verified ? 1 : 0, d.name, require('../slug').uniqueSlug(db, d.name));
  return { id: Number(info.lastInsertRowid), code };
}

// Autocadastro: para psicólogo, neuropsicólogo (CRP) e psiquiatra (CRM) o registro precisa ser
// válido e do mesmo estado, e a foto da carteirinha é obrigatória. Psicanalista, psicoterapeuta e
// terapeuta não têm conselho: não precisam de carteirinha. (Cadastro feito pelo admin não passa por aqui.)
// Planos que o profissional escolhe no cadastro (por enquanto, um só)
const PLANS = { 'mensal-30': 'Mensal — R$ 30,00 a cada 30 dias' };

router.post('/professional/register', async (req, res) => {
  const documentFile = await handleDocument(req, res);
  try {
    const d = validateProfessionalInput(req.body);
    const plan = String(req.body.plan || 'mensal-30');
    if (!PLANS[plan]) throw new HttpError(400, 'Selecione um plano.');
    // O profissional não cria senha no cadastro: a administração gera a primeira senha ao aprovar
    // e manda pelo WhatsApp. Depois de entrar, ele pode trocar em Conta.
    const needsCard = !!require('../registry').councilFor(d.profession);
    if (needsCard && !documentFile) throw new HttpError(400, 'Envie a foto da sua carteirinha profissional (frente, com nome e número legíveis).');
    const reg = validateRegistry(d.profession, req.body.registry, d.state);
    if (reg.registry && db.prepare('SELECT 1 FROM professionals WHERE registry = ?').get(reg.registry)) {
      throw new HttpError(409, `Já existe um cadastro com o ${reg.registry}. Se é você, entre na sua conta ou fale com a administração.`);
    }
    let verified = false;
    if (reg.council && registryApiConfigured()) {
      const r = await verifyRegistry(reg, d.name);
      if (r.error) throw new HttpError(503, 'Não foi possível consultar o conselho agora. Tente novamente em alguns minutos.');
      if (!r.match) throw new HttpError(400, r.message || 'Registro não confere.');
      verified = true;
    }
    if (!needsCard && documentFile) removeDocument(documentFile); // quem não tem conselho não precisa (nem guarda) carteirinha
    // Bloqueado pela administração antes (mesmo e-mail, registro ou WhatsApp): a conta nasce bloqueada
    const blocked = require('../blocklist').isBlocked('professional', { email: d.email, registry: reg.registry, phone: d.phone });
    const { id, code } = insertProfessional({ ...d, registry: reg.registry, document_file: needsCard ? documentFile : null, registry_verified: verified },
      NO_PASSWORD, blocked ? 'bloqueado' : 'pendente');
    db.prepare('UPDATE professionals SET plan = ? WHERE id = ?').run(plan, id);
    res.status(201).json({ ok: true, code, blocked, support: require('../accountState').SUPPORT_WHATSAPP });
  } catch (e) {
    removeDocument(documentFile);
    throw e;
  }
});

router.post('/professional/login', (req, res) => {
  const login = U.cleanText(req.body.login, 160);
  const key = `pro:${req.ip}:${login.toLowerCase()}`;
  A.checkLoginRate(key);
  const p = db.prepare("SELECT * FROM professionals WHERE (code = ? OR email = ?) AND status <> 'oficial'").get(login.toUpperCase(), login.toLowerCase());
  // Cadastro em análise: ainda não tem senha — mostra o aviso com o WhatsApp de atendimento
  if (p && p.status === 'pendente') {
    return res.status(403).json({ error: 'Seus dados estão sendo analisados pela nossa equipe. Você recebe sua senha pelo WhatsApp assim que o cadastro for aprovado.',
      pending: true, support: require('../accountState').SUPPORT_WHATSAPP, name: p.name, code: p.code });
  }
  if (p && p.password_hash === NO_PASSWORD) {
    A.registerLoginFailure(key);
    throw new HttpError(401, 'Você ainda não tem senha. Fale com o nosso atendimento no WhatsApp para receber a sua.');
  }
  if (!p || !U.verifyPassword(req.body.password || '', p.password_hash)) {
    A.registerLoginFailure(key);
    throw new HttpError(401, 'Código/e-mail ou senha incorretos.');
  }
  A.clearLoginFailures(key);
  if (p.status === 'recusado') throw new HttpError(403, 'Seu cadastro não foi aprovado. Fale com a administração.');
  if (p.status === 'excluido') throw new HttpError(401, 'Código/e-mail ou senha incorretos.');
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
  // account: bloqueio e aviso de renovação (+ WhatsApp do atendimento da Acolia)
  const account = { ...require('../accountState').stateOf(role, user), support: require('../accountState').SUPPORT_WHATSAPP };
  if (role === 'professional') return res.json({ role, user: ownProfessional(user), account });
  return res.json({ role, user: ownPatient(user), account });
});

module.exports = { PLANS, NO_PASSWORD, router, PROFESSIONS, validateProfessionalInput, insertProfessional, requirePassword, validateLocation };
