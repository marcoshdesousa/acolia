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

// CPF já usado: a tela mostra "Entrar na sua conta" ou "Redefinir senha".
// Paciente e profissional são separados: o mesmo CPF pode ter uma conta de cada.
// Conta apagada libera o CPF; conta bloqueada continua ocupando (não dá para criar outra).
function cpfTaken(role) {
  return Object.assign(new HttpError(409, 'Já existe uma conta com este CPF.'), { extra: { cpf_exists: true, role } });
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
  // WhatsApp: para os lembretes da consulta (não aparece para ninguém)
  const phone = U.onlyDigits(req.body.phone);
  if (phone.length < 10 || phone.length > 13) throw new HttpError(400, 'Informe o seu WhatsApp com DDD.');
  requirePassword(req.body.password);
  if (db.prepare('SELECT 1 FROM patients WHERE cpf = ?').get(cpf)) throw cpfTaken('patient');
  // @ do paciente: o que ele escolheu (se estiver livre) ou um gerado pelo nome
  const H = require('../handles');
  const handle = String(req.body.handle || '').trim() ? H.assertFree(H.validate(req.body.handle)) : H.generate(name);

  let verified = 0;
  if (cpfApiConfigured()) {
    const r = await verifyCpfName(cpf, name);
    if (r.error) throw new HttpError(503, 'Não foi possível confirmar seu CPF agora. Tente novamente em alguns minutos.');
    if (!r.match) throw new HttpError(400, r.message || 'O nome informado não confere com o CPF.');
    verified = 1;
  }

  // CPF bloqueado pela administração (mesmo que tenha apagado a conta antiga): a conta nasce bloqueada
  const status = require('../blocklist').isBlocked('patient', { cpf }) ? 'bloqueado' : 'ativo';
  const info = db.prepare(`INSERT INTO patients (name, cpf, cpf_name_verified, birth_date, state, city, city_norm, password_hash, status, handle, phone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(name, cpf, verified, birth, state, city, U.norm(city), U.hashPassword(req.body.password), status, handle, phone);
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
  const cpf = U.onlyDigits(body.cpf);
  const email = U.cleanText(body.email, 160).toLowerCase();
  const phone = U.onlyDigits(body.phone);
  if (!U.isFullName(name)) throw new HttpError(400, 'Informe nome e sobrenome.');
  if (!PROFESSIONS.includes(profession)) throw new HttpError(400, 'Selecione sua profissão.');
  // CPF: obrigatório (no autocadastro e no cadastro feito pelo admin)
  if (!U.isValidCpf(cpf)) throw new HttpError(400, 'CPF inválido. Confira os números digitados.');
  if (db.prepare("SELECT 1 FROM professionals WHERE cpf = ? AND status <> 'excluido'").get(cpf)) throw cpfTaken('professional');
  // Registro/carteirinha: obrigatório só para quem tem conselho (CRP: psicólogo e neuropsicólogo; CRM: psiquiatra)
  if (require('../registry').councilFor(profession) && registry.length < 3) throw new HttpError(400, 'Informe o número do seu registro profissional (CRP ou CRM).');
  if (!U.isValidEmail(email)) throw new HttpError(400, 'E-mail inválido.');
  if (phone.length < 10 || phone.length > 13) throw new HttpError(400, 'Informe o WhatsApp com DDD.');
  const { state, city } = validateLocation(body.state, body.city);
  // Especialidades: pelo menos uma da lista (sem máximo)
  const specialties = require('../specialties').parse(body.specialties);
  if (db.prepare('SELECT 1 FROM professionals WHERE email = ?').get(email)) throw new HttpError(409, 'Este e-mail já está cadastrado.');
  return { name, profession, registry, cpf, email, phone, state, city, specialties };
}

function insertProfessional(d, passwordHash, status, subscriptionUntil = null) {
  const code = newProfessionalCode();
  const info = db.prepare(`INSERT INTO professionals
    (code, name, profession, registry, cpf, email, phone, password_hash, status, state, city, city_norm, subscription_until,
     document_file, registry_verified, legal_name, slug, specialties)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(code, d.name, d.profession, d.registry, d.cpf || null, d.email, d.phone, passwordHash, status, d.state, d.city, U.norm(d.city), subscriptionUntil,
      d.document_file || null, d.registry_verified ? 1 : 0, d.name, require('../slug').uniqueSlug(db, d.name),
      require('../specialties').store(d.specialties || []));
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
    // O mesmo registro pode aparecer em mais de um cadastro (com CPFs diferentes): quem manda é o CPF
    let verified = false;
    if (reg.council && registryApiConfigured()) {
      const r = await verifyRegistry(reg, d.name);
      if (r.error) throw new HttpError(503, 'Não foi possível consultar o conselho agora. Tente novamente em alguns minutos.');
      if (!r.match) throw new HttpError(400, r.message || 'Registro não confere.');
      verified = true;
    }
    if (!needsCard && documentFile) removeDocument(documentFile); // quem não tem conselho não precisa (nem guarda) carteirinha
    // Bloqueado pela administração antes (mesmo CPF, e-mail, registro ou WhatsApp): a conta nasce bloqueada
    const blocked = require('../blocklist').isBlocked('professional', { cpf: d.cpf, email: d.email, registry: reg.registry, phone: d.phone });
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
  // Secretária (versão 1.1.3): entra no mesmo lugar, com o login e a senha que o profissional gerou
  const sec = require('../secretary').byLogin(login);
  if (sec) {
    if (!U.verifyPassword(req.body.password || '', sec.password_hash)) {
      A.registerLoginFailure(key);
      throw new HttpError(401, 'Código/e-mail ou senha incorretos.');
    }
    const owner = db.prepare('SELECT status FROM professionals WHERE id = ?').get(sec.professional_id);
    if (!owner || !['aprovado', 'restrito', 'bloqueado'].includes(owner.status)) throw new HttpError(403, 'A conta do profissional desta secretária não está ativa.');
    A.clearLoginFailures(key);
    db.prepare("UPDATE secretaries SET last_login_at = datetime('now') WHERE id = ?").run(sec.id);
    A.createSession(res, 'professional', sec.professional_id, sec.id);
    return res.json({ ok: true, secretary: true });
  }
  const p = db.prepare("SELECT * FROM professionals WHERE (code = ? OR email = ?) AND status NOT IN ('oficial', 'clinica')").get(login.toUpperCase(), login.toLowerCase());
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

// ---------- Clínica (versão 1.3) ----------
// Pré-cadastro pelo site (com a logo): fica em análise e a administração manda a senha pelo WhatsApp
router.post('/clinic/register', async (req, res) => {
  const { handlePhoto } = require('../upload');
  const C = require('../clinics');
  const logo = await handlePhoto(req, res).catch((e) => { throw new HttpError(400, e.message === 'Selecione uma foto.' ? 'Envie a logo da clínica.' : e.message); });
  try {
    const b = req.body || {};
    const name = U.cleanText(b.name, 120);
    if (name.length < 2) throw new HttpError(400, 'Informe o nome da clínica.');
    // Cadastro simples: nome, logo, CPF/CNPJ do dono, contato e endereço. O resto (mapa, médicos, sobre) ela completa no painel.
    const responsible = U.cleanText(b.responsible, 120);
    if (responsible && !U.isFullName(responsible)) throw new HttpError(400, 'Informe o nome completo do responsável.');
    const { type, doc } = C.parseDoc(b.doc);
    if (C.docTaken(doc)) throw Object.assign(new HttpError(409, 'Já existe uma clínica com este CPF/CNPJ.'), { extra: { doc_exists: true, role: 'clinic' } });
    const email = U.cleanText(b.email, 160).toLowerCase();
    if (!U.isValidEmail(email)) throw new HttpError(400, 'E-mail inválido.');
    if (db.prepare("SELECT 1 FROM clinics WHERE email = ? AND status <> 'excluido'").get(email)) throw new HttpError(409, 'Este e-mail já está cadastrado em outra clínica.');
    const phone = U.onlyDigits(b.phone);
    if (phone.length < 10 || phone.length > 13) throw new HttpError(400, 'Informe o WhatsApp da clínica com DDD.');
    const { state, city } = validateLocation(b.state, b.city);
    const address = U.cleanText(b.address, 250);
    if (address.length < 5) throw new HttpError(400, 'Informe o endereço completo da clínica.');
    const maps = require('../maps');
    const mapsUrl = maps.cleanMapsUrl(b.maps_url); // opcional: sem link, o mapa usa o endereço
    const hasDoctors = b.has_doctors === '1' || b.has_doctors === 'true' || b.has_doctors === true ? 1 : 0;
    const doctors = hasDoctors ? C.parseDoctors(b.doctors) : [];
    if (hasDoctors && !doctors.length) throw new HttpError(400, 'Escolha quais médicos atendem na clínica (ou marque que não tem).');
    const plan = String(b.plan || 'clinica-4990');
    if (!C.PLANS[plan]) throw new HttpError(400, 'Selecione um plano.');
    const mapsQuery = maps.mapQuery(mapsUrl ? await maps.resolveShort(mapsUrl) : '', `${address}, ${city} - ${state}`);
    const code = C.newCode();
    db.prepare(`INSERT INTO clinics (code, password_hash, status, name, doc_type, doc, responsible, email, phone, logo, bio, state, city, city_norm, address, maps_url, maps_query, has_doctors, doctors, slug, plan)
      VALUES (?, ?, 'pendente', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(code, C.NO_PASSWORD, name, type, doc, responsible, email, phone, logo, U.cleanText(b.bio, 1500), state, city, U.norm(city), address, mapsUrl, mapsQuery,
        hasDoctors, JSON.stringify(doctors), require('../slug').uniqueSlug(db, name, 0, { clinic: true }), plan);
    res.status(201).json({ ok: true, code, support: require('../accountState').SUPPORT_WHATSAPP });
  } catch (e) {
    require('../upload').removePhoto(logo);
    throw e;
  }
});

router.post('/clinic/login', (req, res) => {
  const C = require('../clinics');
  const login = U.cleanText(req.body.login, 160);
  const key = `cli:${req.ip}:${login.toLowerCase()}`;
  A.checkLoginRate(key);
  const c = db.prepare("SELECT * FROM clinics WHERE (code = ? OR email = ?) AND status <> 'excluido'").get(login.toUpperCase(), login.toLowerCase());
  if (c && c.status === 'pendente') {
    return res.status(403).json({ error: 'Os dados da clínica estão sendo analisados pela nossa equipe. Você recebe a senha pelo WhatsApp assim que o cadastro for aprovado.',
      pending: true, support: require('../accountState').SUPPORT_WHATSAPP, name: c.name, code: c.code, clinic: true });
  }
  if (c && c.password_hash === C.NO_PASSWORD) { A.registerLoginFailure(key); throw new HttpError(401, 'A clínica ainda não tem senha. Fale com o nosso atendimento no WhatsApp para receber.'); }
  if (!c || !U.verifyPassword(req.body.password || '', c.password_hash)) { A.registerLoginFailure(key); throw new HttpError(401, 'Código/e-mail ou senha incorretos.'); }
  A.clearLoginFailures(key);
  if (c.status === 'recusado') throw new HttpError(403, 'O cadastro da clínica não foi aprovado. Fale com a administração.');
  A.createSession(res, 'clinic', c.id);
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
  if (role === 'clinic') return res.json({ role, user: require('../clinics').ownClinic(user), account });
  if (role === 'professional') {
    // Secretária: usa o painel do profissional, sem o código único (e a tela sabe que é ela)
    if (req.auth.secretary) {
      const u = ownProfessional(user);
      delete u.code; delete u.pix_key;
      return res.json({ role, user: u, account, secretary: { login: req.auth.secretary.login } });
    }
    return res.json({ role, user: ownProfessional(user), account });
  }
  return res.json({ role, user: ownPatient(user), account });
});

module.exports = { PLANS, NO_PASSWORD, router, PROFESSIONS, validateProfessionalInput, insertProfessional, requirePassword, validateLocation };
