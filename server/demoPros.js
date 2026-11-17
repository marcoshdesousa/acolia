'use strict';
// Pedido do dono: 24 profissionais de demonstração (8 do Psi, 8 do Nutri, 8 do Fisio) para testar a
// vitrine e os perfis. São contas de TESTE (is_test = 1): verificadas, com foto ilustrada (não são fotos
// de pessoas reais), especialidades, valores e agenda. Recebem mensagens; só respondem se o dono entrar
// na conta (código PSI01…FIS08, a mesma senha para todas). A agenda e o pagamento simulado só valem para
// o Paciente Teste. Criadas UMA vez (chave em settings); o admin pode apagar (são contas de teste).
const { db } = require('./db');
const U = require('./util');

const KEY = 'demo_pros_v1';
const PASSWORD = 'acolia2026';
const H = (h, m = 0) => h * 60 + m;

// [código, nome, profissão, registro, especialidades (as 2 primeiras são as principais), online, presencial (ou null), cidade/UF, dias, das, até]
const LIST = [
  ['PSI01', 'Helena Duarte Campos', 'Psicólogo(a)', 'CRP 06/190101', ['Ansiedade', 'Depressão', 'Adultos', 'Autoestima'], 150, 180, 'São Paulo', 'SP', [1, 2, 3, 4, 5], H(8), H(18)],
  ['PSI02', 'Gustavo Ramos Teixeira', 'Psicólogo(a)', 'CRP 05/190102', ['Burnout', 'Estresse', 'Executivos e líderes'], 130, null, 'Rio de Janeiro', 'RJ', [1, 3, 5], H(9), H(20)],
  ['PSI03', 'Larissa Monteiro Alves', 'Neuropsicólogo(a)', 'CRP 04/190103', ['TDAH', 'TEA (transtorno do espectro autista)', 'Crianças', 'Adolescentes'], 220, 250, 'Belo Horizonte', 'MG', [2, 4], H(8), H(17)],
  ['PSI04', 'Eduardo Farias Lins', 'Psicanalista', '', ['Luto', 'Relacionamentos', 'Autoconhecimento'], 120, null, 'Recife', 'PE', [0, 1, 2, 3, 4, 5, 6], H(7), H(22)],
  ['PSI05', 'Patrícia Nogueira Sales', 'Psiquiatra', 'CRM-SP 190105', ['Transtorno bipolar', 'Síndrome do pânico', 'Adultos'], 380, 420, 'Campinas', 'SP', [1, 2, 3, 4], H(10), H(18)],
  ['PSI06', 'Thiago Barreto Moura', 'Psicoterapeuta', '', ['Dependência emocional', 'Casais', 'Conflitos conjugais'], 110, null, 'Curitiba', 'PR', [3, 4, 5, 6], H(14), H(21)],
  ['PSI07', 'Renata Cordeiro Paiva', 'Psicólogo(a)', 'CRP 07/190107', ['Gestantes e puérperas', 'Ansiedade', 'Mulheres'], 160, 160, 'Porto Alegre', 'RS', [1, 2, 3, 4, 5, 6], H(8), H(19)],
  ['PSI08', 'André Vasconcelos Rey', 'Terapeuta', '', ['Estresse', 'Autoconhecimento', 'Jovens adultos'], 90, null, 'Salvador', 'BA', [5, 6], H(9), H(18)],
  ['NUT01', 'Felipe Antunes Rocha', 'Nutricionista', 'CRN-3 290101', ['Emagrecimento', 'Nutrição esportiva', 'Ganho de massa muscular'], 140, 170, 'São Paulo', 'SP', [1, 2, 3, 4, 5], H(7), H(19)],
  ['NUT02', 'Mariana Leite Bastos', 'Nutricionista', 'CRN-4 290102', ['Nutrição comportamental', 'Comer intuitivo', 'Compulsão alimentar'], 160, null, 'Rio de Janeiro', 'RJ', [0, 1, 2, 3, 4, 5, 6], H(8), H(21)],
  ['NUT03', 'Lucas Brandão Freire', 'Nutrólogo(a)', 'CRM-MG 290103', ['Nutrologia', 'Diabetes', 'Colesterol e triglicerídeos'], 350, 400, 'Belo Horizonte', 'MG', [2, 3, 4], H(9), H(17)],
  ['NUT04', 'Carolina Siqueira Melo', 'Nutricionista', 'CRN-6 290104', ['Nutrição materno-infantil', 'Bebês e introdução alimentar', 'Gestantes'], 150, 150, 'Recife', 'PE', [1, 3, 5], H(8), H(18)],
  ['NUT05', 'Beatriz Fontes Carvalho', 'Educador(a) de hábitos alimentares', '', ['Reeducação alimentar', 'Hábitos saudáveis', 'Famílias'], 90, null, 'Florianópolis', 'SC', [1, 2, 3, 4, 5], H(10), H(20)],
  ['NUT06', 'Rodrigo Pacheco Neves', 'Nutricionista', 'CRN-8 290106', ['Esporte e performance', 'Atletas', 'Low carb'], 180, 200, 'Curitiba', 'PR', [4, 5, 6], H(6), H(14)],
  ['NUT07', 'Vanessa Queiroz Lima', 'Chef de alimentação saudável', '', ['Marmitas saudáveis', 'Cozinha vegana', 'Cardápio da semana'], 100, null, 'Brasília', 'DF', [0, 6], H(9), H(17)],
  ['NUT08', 'Daniel Moreira Guedes', 'Técnico(a) em Nutrição', '', ['Saúde intestinal', 'Imunidade', 'Adultos'], 80, null, 'Fortaleza', 'CE', [1, 2, 3, 4, 5, 6], H(8), H(18)],
  ['FIS01', 'Aline Castro Ribeiro', 'Fisioterapeuta', 'CREFITO-3/390101-F', ['Dor lombar', 'Hérnia de disco', 'RPG', 'Postura'], 140, 160, 'São Paulo', 'SP', [1, 2, 3, 4, 5], H(7), H(20)],
  ['FIS02', 'Henrique Matos Pires', 'Fisioterapeuta', 'CREFITO-2/390102-F', ['Fisioterapia esportiva', 'Lesão esportiva', 'Joelho'], 160, 190, 'Rio de Janeiro', 'RJ', [0, 1, 2, 3, 4, 5, 6], H(6), H(21)],
  ['FIS03', 'Igor Saldanha Costa', 'Profissional de Educação Física', 'CREF 390103-G/SP', ['Treinamento funcional', 'Emagrecimento', 'Condicionamento físico'], 100, 120, 'Santos', 'SP', [1, 2, 3, 4, 5, 6], H(6), H(12)],
  ['FIS04', 'Fernanda Lopes Araújo', 'Instrutor(a) de Pilates', '', ['Pilates em aparelhos', 'Pilates solo', 'Gestantes'], 120, 120, 'Belo Horizonte', 'MG', [1, 3, 5], H(7), H(19)],
  ['FIS05', 'Gabriela Torres Mendes', 'Instrutor(a) de yoga', '', ['Hatha yoga', 'Meditação', 'Estresse e respiração'], 80, null, 'Florianópolis', 'SC', [0, 2, 4, 6], H(7), H(11)],
  ['FIS06', 'Paulo Sérgio Cunha', 'Osteopata', '', ['Osteopatia', 'Dor no pescoço', 'Terapia manual'], 200, 230, 'Goiânia', 'GO', [2, 3, 4], H(9), H(18)],
  ['FIS07', 'Débora Prates Nunes', 'Terapeuta ocupacional', 'CREFITO-5/390107-TO', ['Crianças', 'Pessoas com deficiência', 'AVC'], 150, null, 'Porto Alegre', 'RS', [1, 2, 4], H(8), H(17)],
  ['FIS08', 'Vinícius Rezende Baptista', 'Quiropraxista', '', ['Quiropraxia', 'Escoliose', 'Dor lombar'], 170, 190, 'Salvador', 'BA', [1, 2, 3, 4, 5], H(10), H(19)],
];
const PORTAL = { PSI: 'psi', NUT: 'nutri', FIS: 'fisio' };
const PHOTO = (code) => `/img/demo/${PORTAL[code.slice(0, 3)]}${code.slice(3)}.jpg`;

function bioFor(name, profession, sp, city) {
  const first = name.split(' ')[0];
  return `Olá, eu sou ${first}. Atuo como ${profession.replace('(a)', '').replace('(a) ', ' ').toLowerCase()} há alguns anos, com foco em ${sp.slice(0, 2).join(' e ').toLowerCase()}.\n\n`
    + `Meu atendimento é acolhedor, sem julgamentos e com um plano feito para você. Atendo online para todo o Brasil${city ? ` e presencialmente em ${city}` : ''}.\n\n`
    + 'Perfil de demonstração da Acolia.';
}

function createOnce() {
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(KEY)) return 0;
  const hash = U.hashPassword(PASSWORD);
  const until = U.addDaysISO(U.todayISO(), 3650);
  let n = 0;
  for (const [code, name, profession, registry, sp, online, pres, city, uf, days, from, to] of LIST) {
    if (db.prepare('SELECT 1 FROM professionals WHERE code = ?').get(code)) continue;
    const portal = PORTAL[code.slice(0, 3)];
    const clinic = pres != null;
    const r = db.prepare(`INSERT INTO professionals
      (code, name, legal_name, profession, registry, email, phone, password_hash, status, bio, specialties, photo,
       price_cents, price_presencial_cents, state, city, city_norm, has_clinic, clinic_name, clinic_address, presencial_on,
       subscription_until, slug, is_test, must_change_password, session_minutes, break_minutes, agenda_on, portal)
      VALUES (?, ?, ?, ?, ?, ?, '11900000000', ?, 'aprovado', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 50, 10, 1, ?)`)
      .run(code, name, name, profession, registry, `${code.toLowerCase()}@demo.acolia`, hash, bioFor(name, profession, sp, clinic ? city : ''),
        sp.join(', '), PHOTO(code), online * 100, clinic && pres !== online ? pres * 100 : null, uf, city, U.norm(city),
        clinic ? 1 : 0, clinic ? `Consultório ${name.split(' ')[0]}` : '', clinic ? `Endereço de demonstração, ${city} - ${uf}` : '', clinic ? 1 : 0,
        until, require('./slug').uniqueSlug(db, name), portal);
    const id = Number(r.lastInsertRowid);
    try { db.prepare('UPDATE professionals SET verified = 1, verified_seen = 1, registry_verified = 1 WHERE id = ?').run(id); } catch { /* colunas antigas */ }
    const ins = db.prepare('INSERT INTO agenda_hours (professional_id, dow, start_min, end_min) VALUES (?, ?, ?, ?)');
    for (const d of days) ins.run(id, d, from, to);
    // Pagamento simulado (só o Paciente Teste marca e paga, sem dinheiro de verdade)
    try {
      db.prepare(`INSERT INTO pro_payment (professional_id, provider, key_enc, env, account_name, enabled) VALUES (?, 'asaas', ?, 'simulado', 'Asaas simulado (teste)', 1)
        ON CONFLICT(professional_id) DO NOTHING`).run(id, require('./secretBox').seal('SIMULADO'));
    } catch { /* sem a tabela de pagamento */ }
    n++;
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(KEY, new Date().toISOString());
  try { require('./agenda').touch(); } catch { /* ignora */ }
  if (n) console.log(`[demo] ${n} profissionais de demonstração criados (códigos PSI01…FIS08)`);
  return n;
}

module.exports = { createOnce, LIST, PASSWORD, KEY };
