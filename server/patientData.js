'use strict';
// "Ver dados do paciente" (profissional): nome completo, @, CPF, data de nascimento e cidade dos pacientes DELE
// — quem veio pelo link dele, conversou com ele ou marcou consulta com ele. Nunca de outros pacientes.
// Antes de ver pela primeira vez, o profissional aceita o Termo de Responsabilidade e Sigilo dos Dados.
// WhatsApp, e-mail e senha do paciente nunca aparecem (a conversa é dentro da Acolia).
// Cada vez que os dados são abertos fica registrado (quem, de quem e quando).
const { db } = require('./db');
const U = require('./util');
require('./terms'); // cria a tabela terms_acceptances (usada aqui também)

const VERSION = 'dados-pacientes-v1-2026-10';
const ROLE = 'dados_pacientes'; // na tabela terms_acceptances (a mesma do Termo de Adesão)
const TITLE = 'Termo de Responsabilidade e Sigilo dos Dados dos Pacientes';
const SECTIONS = [
  ['Para que servem os dados', 'Os dados do paciente (nome completo, CPF, data de nascimento e cidade) ficam disponíveis apenas para o atendimento: identificar o paciente, emitir atestados, receitas, encaminhamentos, declarações e recibos, e cumprir as obrigações do profissional (por exemplo, o Imposto de Renda).'],
  ['O que eu me comprometo a fazer', 'Usar os dados somente para o atendimento deste paciente; guardar sigilo; não copiar, imprimir ou guardar além do necessário; e manter protegido o aparelho em que acesso a Acolia (com senha e sem deixar a conta aberta para outras pessoas).'],
  ['O que é proibido', 'Vender, ceder, emprestar, divulgar ou compartilhar os dados com qualquer pessoa ou empresa; usar os dados para propaganda, cobrança indevida, cadastro em outros serviços, golpes, perseguição, discriminação ou qualquer finalidade que não seja o atendimento; e procurar dados de pacientes que não são meus.'],
  ['Lei Geral de Proteção de Dados (Lei 13.709/2018)', 'Dados de saúde são dados pessoais sensíveis. Quem causa dano por tratar dados em desacordo com a LGPD é obrigado a reparar o dano (art. 42) e está sujeito às sanções da Autoridade Nacional de Proteção de Dados (art. 52), como advertência, bloqueio e eliminação dos dados e multa de até 2% do faturamento, limitada a R$ 50 milhões por infração.'],
  ['Violação de segredo profissional (Código Penal, art. 154)', 'Revelar, sem justa causa, segredo de que tem conhecimento em razão da profissão, podendo causar dano a outra pessoa, é crime: pena de detenção de 3 meses a 1 ano, ou multa.'],
  ['Fraude com os dados (Código Penal, art. 171)', 'Usar os dados do paciente para enganar alguém e obter vantagem é estelionato. Quando a fraude é feita com informações obtidas por meios eletrônicos (como uma plataforma digital), a pena é de reclusão de 4 a 8 anos e multa (art. 171, § 2º-A).'],
  ['Responsabilidade civil (Código Civil, arts. 186 e 927)', 'Quem causa dano a outra pessoa, mesmo que apenas moral, é obrigado a indenizar.'],
  ['Código de Ética da profissão', 'O sigilo também é dever ético: Código de Ética Profissional do Psicólogo (Resolução CFP nº 10/2005) e Código de Ética Médica (Resolução CFM nº 2.217/2018), entre outros. O descumprimento pode levar a processo no conselho profissional.'],
  ['Registro de acesso e consequências na Acolia', 'Cada vez que eu abro os dados de um paciente, a Acolia registra quem abriu, de qual paciente e quando. Em caso de uso indevido, a Acolia pode suspender ou encerrar a minha conta e fornecer esses registros às autoridades.'],
  ['Declaração', 'Declaro que li este termo, entendi as minhas responsabilidades e me comprometo a proteger os dados dos meus pacientes.'],
];

db.exec(`CREATE TABLE IF NOT EXISTS patient_data_access (
  id INTEGER PRIMARY KEY,
  professional_id INTEGER NOT NULL,
  patient_id INTEGER NOT NULL,
  ip TEXT,
  accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_pda_pro ON patient_data_access(professional_id, id)');

const publicTerms = () => ({ version: VERSION, title: TITLE, sections: SECTIONS.map(([title, text]) => ({ title, text })) });
const accepted = (proId) => db.prepare('SELECT version, signed_name, ip, accepted_at FROM terms_acceptances WHERE role = ? AND user_id = ? AND version = ? ORDER BY id DESC LIMIT 1').get(ROLE, proId, VERSION) || null;
function accept(pro, body, req) {
  if (!(body.accept === true || body.accept === '1' || body.accept === 'true')) throw new U.HttpError(400, 'Marque "Li e aceito" para continuar.');
  if (body.version !== VERSION) throw new U.HttpError(409, 'O termo foi atualizado. Abra de novo e aceite a versão nova.');
  const full = pro.legal_name || pro.name;
  if (U.norm(U.cleanText(body.name, 120)) !== U.norm(full)) throw new U.HttpError(400, 'Para assinar, digite o seu nome completo igual ao do cadastro.');
  db.prepare('INSERT INTO terms_acceptances (role, user_id, version, signed_name, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ROLE, pro.id, VERSION, full, req.ip || '', String(req.headers['user-agent'] || '').slice(0, 300));
  return accepted(pro.id);
}

// O paciente é deste profissional? Veio pelo link dele, conversou com ele ou marcou consulta com ele.
function isMine(proId, patientId) {
  return !!db.prepare(`SELECT 1 FROM patients pt WHERE pt.id = ? AND (
      pt.ref_professional_id = ?
      OR EXISTS (SELECT 1 FROM conversations c WHERE c.patient_id = pt.id AND c.professional_id = ? AND c.patient_wrote = 1)
      OR EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = pt.id AND a.professional_id = ?))`).get(patientId, proId, proId, proId);
}

function dataFor(pro, patientId, req) {
  if (!accepted(pro.id)) throw Object.assign(new U.HttpError(428, 'Aceite o termo de sigilo para ver os dados.'), { extra: { needs_terms: true } });
  const pt = db.prepare("SELECT * FROM patients WHERE id = ? AND status <> 'excluido'").get(Number(patientId));
  if (!pt || !isMine(pro.id, pt.id)) throw new U.HttpError(404, 'Você só vê os dados dos seus pacientes: quem veio pelo seu link, conversou ou marcou consulta com você.');
  db.prepare('INSERT INTO patient_data_access (professional_id, patient_id, ip) VALUES (?, ?, ?)').run(pro.id, pt.id, req.ip || '');
  const birth = pt.birth_date || '';
  let age = null;
  if (birth) {
    const [y, m, d] = birth.split('-').map(Number);
    const t = U.todayISO().split('-').map(Number);
    age = t[0] - y - (t[1] < m || (t[1] === m && t[2] < d) ? 1 : 0);
  }
  const via = [];
  if (pt.ref_professional_id === pro.id) via.push('Criou a conta pelo seu link');
  const n = db.prepare("SELECT COUNT(*) n FROM appointments WHERE patient_id = ? AND professional_id = ? AND status IN ('confirmada', 'concluida')").get(pt.id, pro.id).n;
  if (n) via.push(`${n} consulta${n > 1 ? 's' : ''} marcada${n > 1 ? 's' : ''} com você`);
  return {
    id: pt.id, name: pt.name, handle: pt.handle || '', cpf: U.formatCpf(pt.cpf), birth_date: birth, age,
    city: pt.city, state: pt.state, since: String(pt.created_at || '').slice(0, 10), via,
  };
}

module.exports = { VERSION, publicTerms, accepted, accept, isMine, dataFor };
