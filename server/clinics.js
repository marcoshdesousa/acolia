'use strict';
// Clínicas (versão 1.3): conta própria (login com código único ou e-mail + senha), pré-cadastro pelo
// site e aprovação pela administração, como o profissional. Plano: R$ 49,90 a cada 30 dias.
// Cada clínica tem nome, CPF ou CNPJ do responsável (um cadastro de clínica por documento), logo,
// endereço escrito, município/estado e o link do Google Maps. Pode dizer se também tem médicos
// (e quais especialidades). Os profissionais da mente entram na clínica por convite (etapa seguinte).
const { db } = require('./db');
const U = require('./util');

db.exec(`CREATE TABLE IF NOT EXISTS clinics (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente',   -- pendente | aprovado | recusado | bloqueado | excluido
  name TEXT NOT NULL,
  doc_type TEXT NOT NULL,                      -- cpf | cnpj
  doc TEXT,                                    -- só números; NULL quando apagada (libera o documento)
  responsible TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  logo TEXT,
  bio TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  city TEXT NOT NULL,
  city_norm TEXT NOT NULL,
  address TEXT NOT NULL,
  maps_url TEXT NOT NULL DEFAULT '',
  maps_query TEXT NOT NULL DEFAULT '',
  has_doctors INTEGER NOT NULL DEFAULT 0,
  doctors TEXT NOT NULL DEFAULT '[]',          -- especialidades médicas que atendem na clínica
  slug TEXT,
  plan TEXT NOT NULL DEFAULT 'clinica-4990',
  subscription_until TEXT,
  instagram TEXT NOT NULL DEFAULT '', tiktok TEXT NOT NULL DEFAULT '', x_handle TEXT NOT NULL DEFAULT '', youtube TEXT NOT NULL DEFAULT '',
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clinics_place ON clinics(state, city_norm);
CREATE INDEX IF NOT EXISTS idx_clinics_doc ON clinics(doc);`);

const PLANS = { 'clinica-4990': 'Clínica — R$ 49,90 a cada 30 dias' };
const NO_PASSWORD = '!sem-senha';
// Especialidades médicas (só médicos) que a clínica pode dizer que tem, além dos profissionais da mente
const DOCTORS = ['Clínico geral', 'Cardiologista', 'Cirurgião geral', 'Dermatologista', 'Endocrinologista', 'Gastroenterologista', 'Geriatra',
  'Ginecologista e obstetra', 'Infectologista', 'Nefrologista', 'Neurologista', 'Nutrólogo', 'Oftalmologista', 'Oncologista', 'Ortopedista',
  'Otorrinolaringologista', 'Pediatra', 'Pneumologista', 'Reumatologista', 'Urologista'];

// CNPJ: 14 dígitos com os dois verificadores
function isValidCnpj(v) {
  const c = U.onlyDigits(v);
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const dv = (base) => {
    const w = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const s = base.split('').reduce((n, d, i) => n + Number(d) * w[i], 0) % 11;
    return s < 2 ? 0 : 11 - s;
  };
  const d1 = dv(c.slice(0, 12));
  return d1 === Number(c[12]) && dv(c.slice(0, 12) + d1) === Number(c[13]);
}
// CPF ou CNPJ do responsável → { type, doc } (ou erro)
function parseDoc(v) {
  const d = U.onlyDigits(v);
  if (d.length === 11 && U.isValidCpf(d)) return { type: 'cpf', doc: d };
  if (d.length === 14 && isValidCnpj(d)) return { type: 'cnpj', doc: d };
  throw new U.HttpError(400, 'Informe um CPF ou CNPJ válido do responsável pela clínica.');
}
const fmtDoc = (type, d) => (!d ? '' : type === 'cnpj' ? d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : U.formatCpf(d));
const docTaken = (doc, exceptId = 0) => !!db.prepare("SELECT 1 FROM clinics WHERE doc = ? AND status <> 'excluido' AND id <> ?").get(doc, exceptId);
const parseDoctors = (v) => {
  let list = v;
  if (typeof v === 'string') { try { list = JSON.parse(v); } catch { list = v.split(','); } }
  return [...new Set((Array.isArray(list) ? list : []).map((x) => String(x).trim()).filter((x) => DOCTORS.includes(x)))];
};
const doctorsOf = (c) => { try { return JSON.parse(c.doctors || '[]'); } catch { return []; } };

function newCode() {
  for (;;) {
    const code = 'C' + U.randomMixedCode(7);
    if (!db.prepare('SELECT 1 FROM clinics WHERE code = ?').get(code) && !db.prepare('SELECT 1 FROM professionals WHERE code = ?').get(code)) return code;
  }
}

// Aparece para os pacientes: aprovada e com a mensalidade em dia (1 dia a mais de tolerância)
const VISIBLE_SQL = "c.status = 'aprovado' AND c.subscription_until IS NOT NULL AND c.subscription_until >= date('now', '-1 day')";
const isVisible = (c) => c.status === 'aprovado' && !!c.subscription_until && c.subscription_until >= U.addDaysISO(U.todayISO(), -1);

// ---------- Publicações da clínica (etapa 2) ----------
// Como o perfil oficial da Acolia, cada clínica tem uma linha "autora" em professionals (status 'clinica'):
// assim as publicações, reels, stories, curtidas, comentários e seguidores usam o mesmo caminho dos
// profissionais. Essa linha não aparece na vitrine, não entra no admin e ninguém faz login nela.
try { db.exec('ALTER TABLE clinics ADD COLUMN author_id INTEGER'); } catch { /* já existe */ }
// Senha de acesso único (gerada pelo admin): a clínica cria a dela no 1º acesso
try { db.exec('ALTER TABLE clinics ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0'); } catch { /* já existe */ }
// Profissionais que trabalham na clínica (os convites chegam na etapa 3)
db.exec(`CREATE TABLE IF NOT EXISTS clinic_members (
  clinic_id INTEGER NOT NULL,
  professional_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ativo',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (clinic_id, professional_id)
)`);

function authorOf(clinicId) {
  const c = db.prepare('SELECT id, name, author_id FROM clinics WHERE id = ?').get(Number(clinicId));
  if (!c) return null;
  if (c.author_id && db.prepare("SELECT 1 FROM professionals WHERE id = ? AND status = 'clinica'").get(c.author_id)) return c.author_id;
  const crypto = require('node:crypto');
  const code = `CLINICA${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const info = db.prepare(`INSERT INTO professionals (code, name, legal_name, profession, registry, email, phone, password_hash, status)
    VALUES (?, ?, ?, 'Clínica', '', ?, '', ?, 'clinica')`)
    .run(code, c.name, c.name, `clinica-${code.toLowerCase()}@acolia.invalid`, U.hashPassword(crypto.randomBytes(24).toString('hex')));
  const id = Number(info.lastInsertRowid);
  db.prepare('UPDATE clinics SET author_id = ? WHERE id = ?').run(id, c.id);
  return id;
}
// Linha autora → clínica (ou null se não for de clínica)
const clinicOfAuthor = (authorId) => db.prepare('SELECT * FROM clinics WHERE author_id = ?').get(Number(authorId)) || null;
// Profissionais (visíveis) que trabalham na clínica
function membersOf(clinicId) {
  const { VISIBLE_SQL: PRO_VISIBLE } = require('./serialize');
  return db.prepare(`SELECT p.id, p.name, p.photo, p.profession, p.registry, p.slug FROM clinic_members m JOIN professionals p ON p.id = m.professional_id
    WHERE m.clinic_id = ? AND m.status = 'ativo' AND ${PRO_VISIBLE} ORDER BY p.name`).all(Number(clinicId));
}

function publicClinic(c, { loggedIn = false, viewer = null, full = false } = {}) {
  const maps = require('./maps');
  // Lista ("Clínicas perto de você") não precisa das publicações; o perfil da clínica precisa
  let social = {};
  if (full) {
    const authorId = authorOf(c.id);
    const mineSelf = viewer?.role === 'clinic' && viewer.id === c.id;
    social = {
      author_id: authorId, is_self: mineSelf,
      ...require('./serialize').postsForProfile(authorId, loggedIn),
      following: viewer && !mineSelf ? !!db.prepare('SELECT 1 FROM follows WHERE follower_role = ? AND follower_id = ? AND professional_id = ?').get(viewer.role, viewer.id, authorId) : false,
      professionals: membersOf(c.id),
      viewer_role: loggedIn ? viewer?.role : undefined,
    };
  }
  return {
    ...social,
    id: c.id, kind: 'clinic', name: c.name, slug: c.slug, logo: c.logo, bio: c.bio, state: c.state, city: c.city,
    address: loggedIn ? c.address : '', maps_url: loggedIn ? c.maps_url : '',
    map_embed: loggedIn && c.maps_query ? maps.embedUrl?.(c.maps_query) || '' : '',
    has_doctors: !!c.has_doctors, doctors: c.has_doctors ? doctorsOf(c) : [],
    social: require('./social').list(c), locked: !loggedIn,
  };
}
function ownClinic(c) {
  return {
    id: c.id, kind: 'clinic', code: c.code, status: c.status, name: c.name, doc_type: c.doc_type, doc: fmtDoc(c.doc_type, c.doc), responsible: c.responsible,
    email: c.email, phone: c.phone, logo: c.logo, bio: c.bio, state: c.state, city: c.city, address: c.address, maps_url: c.maps_url,
    has_doctors: !!c.has_doctors, doctors: doctorsOf(c), slug: c.slug, plan: c.plan, plan_label: PLANS[c.plan] || c.plan,
    subscription_until: c.subscription_until, visible: isVisible(c),
    instagram: c.instagram, tiktok: c.tiktok, x_handle: c.x_handle, youtube: c.youtube, social_values: require('./social').values?.(c),
  };
}

module.exports = { authorOf, clinicOfAuthor, membersOf, PLANS, NO_PASSWORD, DOCTORS, isValidCnpj, parseDoc, fmtDoc, docTaken, parseDoctors, doctorsOf, newCode, VISIBLE_SQL, isVisible, publicClinic, ownClinic };
