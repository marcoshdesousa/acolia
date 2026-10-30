'use strict';
// Portais (versão 2.0): um aplicativo, um banco de dados e três portais com logo e cor próprios.
//   psi   → Acolia Psi (saúde mental — tudo o que já existia continua aqui)
//   nutri → Acolia Nutri (nutrição e alimentação)
//   fisio → Acolia Fisio (movimento, fisioterapia, Pilates, yoga…)
//
// Paciente: uma conta só vale nos três (escolhe o portal e troca quando quiser).
// Profissional e clínica: cada conta é de UM portal (definido no cadastro). Quem atua em mais de uma área
// cria uma conta em cada portal (com o mesmo CPF), cada uma com a sua mensalidade, secretária e login.
//
// Ligar/desligar: settings.portals_enabled ('1' ligado, '0' desligado). Desligado, o site volta a ser o
// de antes (só Psi, página inicial antiga). "Desistir dos portais" no admin apaga o que é do Nutri e do
// Fisio e desliga (ver server/routes/admin.js).
const { db } = require('./db');

const KEYS = ['psi', 'nutri', 'fisio'];

const PORTALS = {
  psi: {
    key: 'psi', name: 'Acolia Psi', short: 'Psi', area: 'Saúde mental',
    who: 'Psicólogos, psicanalistas, terapeutas e psiquiatras',
    tagline: 'Saúde mental ao seu alcance',
    logo: '/img/logo-completo.png', symbol: '/img/logo-simbolo.png',
    professions: ['Psicólogo(a)', 'Psicanalista', 'Psiquiatra', 'Psicoterapeuta', 'Neuropsicólogo(a)', 'Terapeuta'],
    publish_scope: 'da área da mente e da saúde mental',
  },
  nutri: {
    key: 'nutri', name: 'Acolia Nutri', short: 'Nutri', area: 'Nutrição e alimentação',
    who: 'Nutricionistas, nutrólogos e alimentação saudável',
    tagline: 'Nutrição para uma vida melhor',
    logo: '/img/portal-nutri.png', symbol: '/img/portal-nutri-simbolo.png',
    professions: ['Nutricionista', 'Nutrólogo(a)', 'Técnico(a) em Nutrição', 'Chef de alimentação saudável', 'Educador(a) de hábitos alimentares'],
    publish_scope: 'da área da nutrição, da alimentação e da saúde',
  },
  fisio: {
    key: 'fisio', name: 'Acolia Fisio', short: 'Fisio', area: 'Movimento e reabilitação',
    who: 'Fisioterapia, Pilates, yoga e personal',
    tagline: 'Movimento para uma vida melhor',
    logo: '/img/portal-fisio.png', symbol: '/img/portal-fisio-simbolo.png',
    professions: ['Fisioterapeuta', 'Terapeuta ocupacional', 'Profissional de Educação Física', 'Instrutor(a) de Pilates',
      'Instrutor(a) de yoga', 'Massoterapeuta', 'Quiropraxista', 'Osteopata', 'Médico(a) do esporte'],
    publish_scope: 'da área do movimento, da reabilitação e da saúde',
  },
};
const ALL_PROFESSIONS = KEYS.flatMap((k) => PORTALS[k].professions);

// Colunas novas (só acrescenta). Tudo o que já existe fica no Psi.
for (const [table, col] of [['professionals', 'portal'], ['clinics', 'portal']]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT NOT NULL DEFAULT 'psi'`); } catch { /* já existe */ }
}
try { db.exec("ALTER TABLE patients ADD COLUMN last_portal TEXT NOT NULL DEFAULT ''"); } catch { /* já existe */ }
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

const valid = (k) => KEYS.includes(k);
const normalize = (k) => (valid(String(k || '').toLowerCase()) ? String(k).toLowerCase() : 'psi');

function enabled() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'portals_enabled'").get();
  return !row || row.value !== '0'; // ligado por padrão
}
function setEnabled(on) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('portals_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(on ? '1' : '0');
}

const COOKIE = 'acolia_portal';
function cookiePortal(header) {
  const m = String(header || '').match(/(?:^|;\s*)acolia_portal=([a-z]+)/);
  return m ? m[1] : '';
}

// Portal de quem está pedindo: profissional e clínica → o da conta; paciente e visitante → o escolhido
// (parâmetro ?portal=, cabeçalho X-Acolia-Portal ou o cookie acolia_portal). Desligado → sempre Psi.
function fromReq(req) {
  if (!enabled()) return 'psi';
  const role = req.auth?.role;
  if ((role === 'professional' || role === 'clinic') && req.auth.user?.portal) return normalize(req.auth.user.portal);
  const asked = req.query?.portal || req.get?.('x-acolia-portal') || cookiePortal(req.headers?.cookie);
  return normalize(asked);
}

// Admin: o portal que ele está administrando (escolhido ao entrar; cookie acolia_admin_portal).
// Com os portais desligados, ou sem escolha, é o Psi.
function adminPortal(req) {
  if (!enabled()) return 'psi';
  const m = String(req.headers?.cookie || '').match(/(?:^|;\s*)acolia_admin_portal=([a-z]+)/);
  return normalize(m ? m[1] : 'psi');
}

function portalOfProfession(profession) {
  return KEYS.find((k) => PORTALS[k].professions.includes(profession)) || null;
}

// E-mail do profissional/clínica por portal: a mesma pessoa pode usar o mesmo e-mail em contas de portais
// diferentes. No banco (que exige e-mail único) o do Psi fica como está e o dos outros portais leva
// "#portal" no fim (ex.: ana@x.com#nutri). Para mostrar, usar plainEmail().
const emailKey = (email, portal) => (normalize(portal) === 'psi' ? email : `${email}#${normalize(portal)}`);
const plainEmail = (stored) => String(stored || '').replace(/#[a-z]+$/, '');

function publicList() {
  return KEYS.map((k) => {
    const p = PORTALS[k];
    return { key: k, name: p.name, short: p.short, area: p.area, who: p.who, tagline: p.tagline, logo: p.logo, symbol: p.symbol, professions: p.professions };
  });
}

module.exports = { KEYS, PORTALS, ALL_PROFESSIONS, COOKIE, valid, normalize, enabled, setEnabled, fromReq, adminPortal, portalOfProfession, emailKey, plainEmail, publicList };
