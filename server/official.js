'use strict';
// Perfil oficial "Acolia Brasil": quem publica é o administrador (pelo painel /admin).
// - Todo mundo com conta segue automaticamente e não consegue deixar de seguir.
// - Ele também "segue" todo mundo: cada profissional já começa com 1 seguidor (a Acolia).
// - Não aparece na vitrine, não recebe mensagem nem atendimento e ninguém entra nele.
// Fica guardado como uma linha especial em professionals (status 'oficial'), assim as
// publicações, curtidas e comentários usam o mesmo caminho das publicações dos profissionais.
const crypto = require('node:crypto');
const { db } = require('./db');
const U = require('./util');

const NAME = 'Acolia Brasil';
const SLUG = 'acolia'; // site.com/acolia (nome reservado: nenhum profissional consegue usar)
const PHOTO = '/img/logo-simbolo.png';

function ensureOfficial() {
  let row = db.prepare("SELECT id FROM professionals WHERE status = 'oficial'").get();
  if (!row) {
    const code = `OFICIAL${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    db.prepare(`INSERT INTO professionals (code, name, legal_name, profession, registry, email, phone, password_hash, status, slug)
      VALUES (?, ?, ?, 'Perfil oficial', '', ?, '', ?, 'oficial', ?)`)
      .run(code, NAME, NAME, `oficial-${code.toLowerCase()}@acolia.invalid`, U.hashPassword(crypto.randomBytes(24).toString('hex')), SLUG);
    row = db.prepare("SELECT id FROM professionals WHERE status = 'oficial'").get();
  }
  return row.id;
}

let cachedId = null;
function officialId() {
  if (cachedId == null) cachedId = ensureOfficial();
  return cachedId;
}
const isOfficial = (id) => Number(id) === officialId();
const officialRow = () => db.prepare('SELECT * FROM professionals WHERE id = ?').get(officialId());

// Seguidores: pacientes com a conta ativa e profissionais com a licença em dia
// (quem é bloqueado, exclui a conta ou deixa a mensalidade vencer some da contagem).
// Contas de teste não entram.
function followerCounts() {
  const patients = db.prepare("SELECT COUNT(*) n FROM patients WHERE status = 'ativo' AND is_test = 0").get().n;
  const professionals = db.prepare(`SELECT COUNT(*) n FROM professionals p WHERE is_test = 0 AND
    p.status = 'aprovado' AND p.subscription_until IS NOT NULL AND p.subscription_until >= date('now', '-1 day')`).get().n;
  return { patients, professionals };
}

function publicOfficial({ loggedIn = false } = {}) {
  const p = officialRow();
  const total = db.prepare('SELECT COUNT(*) n FROM posts WHERE professional_id = ?').get(p.id).n;
  const counts = followerCounts();
  return {
    id: p.id, official: true, slug: p.slug, name: NAME, photo: PHOTO, instagram: p.instagram || '',
    social: require('./social').list(p), social_values: require('./social').values(p),
    posts_count: total,
    followers_patients: counts.patients,
    followers_professionals: counts.professionals,
    followers_count: counts.patients + counts.professionals,
    following: loggedIn, // todo mundo com conta segue (e não dá para deixar de seguir)
    locked: !loggedIn,
  };
}

module.exports = { NAME, SLUG, PHOTO, officialId, isOfficial, officialRow, followerCounts, publicOfficial };
