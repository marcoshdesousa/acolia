'use strict';
// Termo de Adesão e Responsabilidade do Profissional: o profissional assina no cadastro (marca "Li e concordo"
// e digita o nome completo). Fica guardado quem assinou, quando, de onde (IP e aparelho) e qual versão.
// Mudou o texto? Troque a VERSION: assim fica claro qual versão cada pessoa assinou.
const { db } = require('./db');
const U = require('./util');

const VERSION = 'profissional-v1-2026-10';
const TITLE = 'Termo de Adesão e Responsabilidade do Profissional';
const SECTIONS = [
  ['O que é a Acolia', 'A Acolia é uma plataforma digital de organização e rede social para profissionais da área da mente (agenda, mensagens, videochamada, publicações, documentos e controle financeiro). A Acolia não presta serviços de saúde, não é clínica, não indica tratamentos e não participa dos atendimentos.'],
  ['Responsabilidade pelo atendimento', 'O profissional é o único responsável pelos atendimentos que realiza, por tudo o que fala, orienta ou prescreve aos pacientes e pelos documentos que emite (atestados, receitas, encaminhamentos e declarações), assim como pelo sigilo e pelo cumprimento do código de ética e das normas do seu conselho (CRP, CRM ou outro).'],
  ['Dados verdadeiros', 'O profissional declara que todos os dados informados são verdadeiros, incluindo nome, CPF, data de nascimento, profissão e registro no conselho, e que o registro está ativo. A Acolia pode conferir essas informações a qualquer momento.'],
  ['Relação com os pacientes e pagamentos das consultas', 'Valores, combinados, remarcações, faltas e reembolsos das consultas são acertados diretamente entre o profissional e o paciente. O pagamento das consultas vai direto para a conta do profissional; a Acolia não recebe, não repassa e não se responsabiliza por esses valores.'],
  ['Publicações e conteúdo', 'O profissional se compromete a publicar apenas conteúdo da área da mente e da saúde mental, sem propaganda de outros produtos ou serviços, sem promessas de cura e respeitando as regras de publicidade do seu conselho. O profissional responde pelo que publica e escreve, e a Acolia pode remover conteúdo fora dessas regras.'],
  ['Videochamadas', 'A Acolia oferece a ferramenta de videochamada. A qualidade depende da internet de cada um. Cabe ao profissional garantir um ambiente adequado e sigiloso para o atendimento.'],
  ['Dados pessoais (LGPD)', 'O profissional é responsável pelos dados dos pacientes que coleta e usa nos atendimentos. A Acolia trata os dados apenas para o funcionamento da plataforma e não os vende.'],
  ['Plano e mensalidade', 'O uso da plataforma depende do pagamento da mensalidade do plano escolhido, a cada 30 dias. A equipe Acolia analisa os dados enviados; se estiverem errados ou não puderem ser confirmados, o acesso é encerrado e o valor pago é devolvido integralmente. Sem a renovação, a conta é bloqueada até o novo pagamento.'],
  ['Suspensão e cancelamento', 'A Acolia pode suspender ou encerrar a conta em caso de dados falsos, descumprimento deste termo ou conduta inadequada. O profissional pode excluir a própria conta quando quiser.'],
  ['Limite de responsabilidade', 'A Acolia não se responsabiliza por danos decorrentes dos atendimentos, orientações, condutas, documentos ou conteúdos do profissional.'],
  ['Alterações', 'Este termo pode ser atualizado. A versão nova será apresentada para um novo aceite.'],
];

db.exec(`CREATE TABLE IF NOT EXISTS terms_acceptances (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL,              -- professional
  user_id INTEGER NOT NULL,
  version TEXT NOT NULL,
  signed_name TEXT NOT NULL,       -- nome completo digitado como assinatura
  ip TEXT,
  user_agent TEXT,
  accepted_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const publicTerms = () => ({ version: VERSION, title: TITLE, sections: SECTIONS.map(([title, text]) => ({ title, text })) });

// Confere a assinatura do cadastro (antes de criar a conta): marcou "Li e concordo", a versão é a atual e o
// nome digitado é o mesmo nome completo do cadastro
function checkSignature(body, fullName) {
  if (!(body.terms_accept === '1' || body.terms_accept === true || body.terms_accept === 'true')) throw new U.HttpError(400, 'Leia e aceite o Termo de Adesão e Responsabilidade para continuar.');
  if (body.terms_version !== VERSION) throw new U.HttpError(409, 'O termo foi atualizado. Recarregue a página e assine a versão nova.');
  const signed = U.cleanText(body.terms_name, 120);
  if (U.norm(signed) !== U.norm(fullName)) throw new U.HttpError(400, 'Para assinar, digite o seu nome completo igual ao do cadastro.');
  return signed;
}
function record(role, userId, signedName, req) {
  db.prepare('INSERT INTO terms_acceptances (role, user_id, version, signed_name, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
    .run(role, userId, VERSION, signedName, req.ip || '', String(req.headers['user-agent'] || '').slice(0, 300));
}
const lastAcceptance = (role, userId) => db.prepare('SELECT version, signed_name, ip, accepted_at FROM terms_acceptances WHERE role = ? AND user_id = ? ORDER BY id DESC LIMIT 1').get(role, userId) || null;

module.exports = { VERSION, publicTerms, checkSignature, record, lastAcceptance };
