'use strict';
// Especialidades que o profissional escolhe (no cadastro e depois no perfil): no mínimo uma, sem máximo.
// Lista única para todas as profissões, separada em grupos só para facilitar achar. Os nomes não
// podem ter vírgula (no banco elas ficam guardadas como texto separado por ", ", na ordem escolhida).
const U = require('./util');

const GROUPS = [
  {
    name: 'Público atendido',
    items: [
      'Bebês', 'Crianças', 'Adolescentes', 'Jovens adultos', 'Adultos', 'Idosos', 'Casais', 'Famílias', 'Mulheres', 'Homens',
      'Gestantes e puérperas', 'Pais e mães', 'Cuidadores', 'LGBTQIAPN+', 'Pessoas trans e não binárias', 'Pessoas com deficiência',
      'Pessoas neurodivergentes', 'Pessoas negras', 'Povos indígenas', 'Migrantes e refugiados', 'Estudantes', 'Universitários',
      'Profissionais da saúde', 'Executivos e líderes', 'Empreendedores', 'Atletas', 'Artistas', 'Militares e forças de segurança',
      'Grupos', 'Empresas e equipes', 'Atendimento em Libras', 'Atendimento em inglês', 'Atendimento em espanhol',
    ],
  },
  {
    name: 'Temas e demandas',
    items: [
      'Ansiedade', 'Depressão', 'Síndrome do pânico', 'Fobias', 'Fobia social', 'TOC (transtorno obsessivo-compulsivo)', 'Estresse', 'Burnout',
      'Estresse pós-traumático (TEPT)', 'Traumas', 'Luto', 'Luto gestacional e perinatal', 'Autoestima', 'Autoconhecimento', 'Relacionamentos',
      'Conflitos conjugais', 'Conflitos familiares', 'Separação e divórcio', 'Dependência emocional', 'Relacionamentos abusivos', 'Ciúmes',
      'Traição', 'Violência doméstica', 'Violência contra a mulher', 'Abuso sexual', 'Violência e abuso na infância', 'Assédio moral',
      'Bullying', 'TEA (transtorno do espectro autista)', 'TDAH', 'Dificuldades de aprendizagem', 'Dislexia', 'Discalculia', 'Disgrafia',
      'Altas habilidades e superdotação', 'Deficiência intelectual', 'Síndrome de Down', 'Atrasos no desenvolvimento', 'Atraso de fala e linguagem',
      'Seletividade alimentar', 'Desfralde e enurese', 'Birras e comportamento infantil', 'TOD (transtorno opositor desafiador)',
      'Transtornos de conduta', 'Transtorno bipolar', 'Esquizofrenia', 'Psicoses', 'Transtornos de personalidade', 'Transtorno de personalidade borderline',
      'Transtorno de personalidade narcisista', 'Transtornos alimentares', 'Anorexia', 'Bulimia', 'Compulsão alimentar', 'Obesidade',
      'Imagem corporal', 'Cirurgia bariátrica', 'Dependência química', 'Alcoolismo', 'Tabagismo', 'Jogos e apostas (bets)',
      'Uso excessivo de internet e celular', 'Autolesão', 'Prevenção do suicídio', 'Insônia e sono', 'Sexualidade', 'Disfunções sexuais',
      'Identidade de gênero', 'Orientação sexual', 'Questões raciais', 'Maternidade e paternidade', 'Depressão pós-parto', 'Infertilidade',
      'Reprodução assistida', 'Adoção', 'Orientação de pais', 'Orientação profissional e vocacional', 'Carreira e transição de carreira',
      'Aposentadoria', 'Desemprego', 'Saúde mental no trabalho', 'Liderança', 'Procrastinação', 'Foco e concentração', 'Ansiedade de desempenho',
      'Vestibular e concursos', 'Timidez', 'Habilidades sociais', 'Controle da raiva', 'Impulsividade', 'Solidão', 'Crises existenciais',
      'Espiritualidade', 'Mudanças e adaptação', 'Imigração', 'Envelhecimento', 'Menopausa', 'TPM e TDPM', 'Doenças crônicas', 'Dor crônica',
      'Fibromialgia', 'Câncer', 'Cuidados paliativos', 'HIV e ISTs', 'Doenças neurológicas', 'Demências e Alzheimer', 'Parkinson', 'AVC',
      'Epilepsia', 'Lesões cerebrais', 'Deficiência física', 'Psicossomática', 'Hipocondria (ansiedade de saúde)', 'Tricotilomania',
      'Tiques e síndrome de Tourette', 'Gagueira', 'Esporte e desempenho',
    ],
  },
  {
    name: 'Abordagens e métodos',
    items: [
      'Terapia cognitivo-comportamental (TCC)', 'Terapia do esquema', 'Terapia comportamental dialética (DBT)',
      'Terapia de aceitação e compromisso (ACT)', 'Análise do comportamento (ABA)', 'Terapia analítico-comportamental',
      'Terapia focada na compaixão', 'Terapia focada nas emoções', 'Terapia interpessoal', 'Terapia breve', 'Terapia narrativa',
      'Terapia sistêmica', 'Terapia familiar sistêmica', 'Terapia de casal', 'Terapia de grupo', 'Psicanálise', 'Psicanálise freudiana',
      'Psicanálise lacaniana', 'Psicanálise winnicottiana', 'Psicanálise kleiniana', 'Psicoterapia psicodinâmica',
      'Psicologia analítica (junguiana)', 'Gestalt-terapia', 'Abordagem centrada na pessoa', 'Psicologia humanista',
      'Fenomenologia e existencialismo', 'Logoterapia', 'Psicodrama', 'Análise bioenergética', 'Terapia reichiana', 'Mindfulness',
      'EMDR', 'Brainspotting', 'Somatic Experiencing', 'Hipnose clínica', 'Psicologia positiva', 'Ludoterapia', 'Arteterapia',
      'Musicoterapia', 'Treino de pais', 'Modelo Denver (ESDM)', 'TEACCH', 'PECS', 'Reabilitação neuropsicológica',
      'Estimulação cognitiva', 'Neurofeedback', 'Psicoeducação', 'Psicofarmacologia', 'Estimulação magnética transcraniana (EMT)',
      'Tratamento com escetamina', 'Mediação de conflitos',
    ],
  },
  {
    name: 'Áreas e especialidades',
    items: [
      'Psicologia clínica', 'Psicologia da saúde', 'Psicologia hospitalar', 'Psicologia escolar e educacional', 'Psicologia organizacional e do trabalho',
      'Psicologia jurídica', 'Psicologia do trânsito', 'Psicologia do esporte', 'Psicologia social e comunitária', 'Psicologia perinatal',
      'Psicologia do luto', 'Psico-oncologia', 'Psicogerontologia', 'Psicopedagogia', 'Psicomotricidade', 'Neuropsicologia',
      'Avaliação psicológica', 'Avaliação neuropsicológica', 'Psicodiagnóstico', 'Laudos e relatórios', 'Perícia psicológica',
      'Avaliação para cirurgia bariátrica', 'Avaliação para porte de arma', 'Avaliação para CNH', 'Emergências e desastres',
      'Sexologia', 'Terapia sexual', 'Psiquiatria geral', 'Psiquiatria da infância e adolescência', 'Psicogeriatria', 'Psiquiatria forense',
      'Psiquiatria perinatal', 'Psiquiatria das adições', 'Medicina do sono', 'Interconsulta psiquiátrica',
    ],
  },
];

const ALL = GROUPS.flatMap((g) => g.items);
const BY_NORM = new Map(ALL.map((s) => [U.norm(s), s]));

// Texto guardado -> lista (aceita o formato antigo, que era texto livre separado por vírgula)
function toList(text) {
  return String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// O que veio do formulário (lista, JSON ou texto com vírgula) -> lista válida, sem repetir, na ordem.
// Vale item da lista oficial ou algo que o profissional já tinha salvo antes (texto livre antigo).
function parse(input, previous = '') {
  let arr = input;
  if (typeof arr === 'string') {
    try { arr = arr.trim().startsWith('[') ? JSON.parse(arr) : toList(arr); } catch { arr = toList(arr); }
  }
  if (!Array.isArray(arr)) arr = [];
  const old = new Map(toList(previous).map((s) => [U.norm(s), s]));
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const k = U.norm(String(raw || ''));
    const name = BY_NORM.get(k) || old.get(k);
    if (!name || seen.has(k)) continue;
    seen.add(k);
    out.push(name);
  }
  if (!out.length) throw new U.HttpError(400, 'Escolha pelo menos uma especialidade.');
  return out;
}

module.exports = { GROUPS, ALL, toList, parse, store: (list) => list.join(', ') };
