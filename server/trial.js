'use strict';
// 7 dias grátis (só para profissionais novos) e o selo azul de verificado.
//
// 7 dias grátis: no cadastro não tem plano nem pagamento. A conta já nasce liberada (aparece na vitrine e
// usa tudo) por 7 dias. Cada CPF de profissional ganha os 7 dias UMA vez só (mesmo apagando a conta e
// criando de novo): quem já usou paga pelo Pix no cadastro. Acabou o período: some da vitrine e só volta
// a usar depois de pagar (Pix pela própria plataforma). Dá para pagar antes de acabar (soma 30 dias no fim).
//
// Verificado (selo azul ao lado do nome): a equipe confere os dados no admin e dá o selo. Sem o selo o
// profissional usa tudo normalmente. (O selo da Acolia Brasil é dourado.)
const { db } = require('./db');
const U = require('./util');

const TRIAL_DAYS = 7;
const on = () => process.env.FREE_TRIAL !== 'off'; // FREE_TRIAL=off desliga (testes automáticos antigos)

for (const [col, def] of [['review_pending', 'INTEGER NOT NULL DEFAULT 0'], ['trial', 'INTEGER NOT NULL DEFAULT 0'], ['verified', 'INTEGER NOT NULL DEFAULT 0'], ['verified_seen', 'INTEGER NOT NULL DEFAULT 1']]) {
  try { db.exec(`ALTER TABLE professionals ADD COLUMN ${col} ${def}`); } catch { /* já existe */ }
}
db.exec(`CREATE TABLE IF NOT EXISTS free_trials (
  cpf TEXT PRIMARY KEY,                 -- CPF do profissional que já ganhou os 7 dias
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

// Uma vez: quem já tinha conta de profissional não ganha os 7 dias (é só para os novos);
// e quem já foi aprovado pela equipe (e não está esperando conferência) já recebe o selo
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'trial_verified_v1'").get()) {
  db.prepare("INSERT OR IGNORE INTO free_trials (cpf) SELECT cpf FROM professionals WHERE cpf IS NOT NULL AND cpf <> ''").run();
  db.prepare(`UPDATE professionals SET verified = 1 WHERE status IN ('aprovado', 'restrito', 'bloqueado') AND is_test = 0
    AND COALESCE(review_pending, 0) = 0`).run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('trial_verified_v1', datetime('now'))").run();
}

const eligible = (cpf) => on() && !!cpf && !db.prepare('SELECT 1 FROM free_trials WHERE cpf = ?').get(U.onlyDigits(cpf));
const markUsed = (cpf) => { if (cpf) db.prepare('INSERT OR IGNORE INTO free_trials (cpf) VALUES (?)').run(U.onlyDigits(cpf)); };

// Dar ou tirar o selo. Ao dar, o profissional vê "Você é verificado!" no próximo acesso e recebe a notificação.
function setVerified(proId, on) {
  db.prepare('UPDATE professionals SET verified = ?, verified_seen = ?, review_pending = 0 WHERE id = ?').run(on ? 1 : 0, on ? 0 : 1, proId);
  if (on) {
    require('./push').notify('professional', proId, {
      title: 'Você é verificado!', body: 'A equipe Acolia conferiu os seus dados. O selo azul de verificado já aparece ao lado do seu nome.', url: '/painel', tag: 'verificado',
    });
  }
}

module.exports = { TRIAL_DAYS, eligible, markUsed, setVerified };
