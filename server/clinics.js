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

function publicClinic(c, { loggedIn = false } = {}) {
  const maps = require('./maps');
  return {
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

module.exports = { PLANS, NO_PASSWORD, DOCTORS, isValidCnpj, parseDoc, fmtDoc, docTaken, parseDoctors, doctorsOf, newCode, VISIBLE_SQL, isVisible, publicClinic, ownClinic };
