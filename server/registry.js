'use strict';
// Validação do registro profissional (carteirinha) no autocadastro.
//
// 1) Sempre: confere o formato e se o conselho regional bate com o estado informado
//    (CRP para psicólogos e neuropsicólogos, CRM para psiquiatras).
// 2) Opcional: consulta automática ao conselho para confirmar que o registro existe,
//    está ativo e pertence a esse nome. Os conselhos não oferecem consulta pública
//    gratuita por API; é preciso contratar um serviço. Configure:
//      REGISTRY_API_URL    URL com {tipo} (CRP|CRM), {uf} e {numero}
//      REGISTRY_API_TOKEN  Token "Bearer"
//      REGISTRY_API_NAME_FIELD    campo do nome no JSON (padrão "nome")
//      REGISTRY_API_ACTIVE_FIELD  campo booleano/situação (opcional, padrão "ativo")
// 3) Sempre: a foto da carteirinha é enviada no cadastro e a administração confere
//    nome e endereço antes de aprovar.
const U = require('./util');
const { namesMatch } = require('./cpf');

// Conselhos Regionais de Psicologia → estados atendidos
const CRP_REGIONS = {
  '01': ['DF'], '02': ['PE'], '03': ['BA'], '04': ['MG'], '05': ['RJ'], '06': ['SP'], '07': ['RS'], '08': ['PR'],
  '09': ['GO'], '10': ['PA', 'AP'], '11': ['CE'], '12': ['SC'], '13': ['PB'], '14': ['MS'], '15': ['AL'], '16': ['ES'],
  '17': ['RN'], '18': ['MT'], '19': ['SE'], '20': ['AM', 'RR'], '21': ['PI'], '22': ['MA'], '23': ['TO'], '24': ['RO', 'AC'],
};

const COUNCIL_BY_PROFESSION = {
  'Psicólogo(a)': 'CRP',
  'Neuropsicólogo(a)': 'CRP',
  Psiquiatra: 'CRM',
};

function councilFor(profession) {
  return COUNCIL_BY_PROFESSION[profession] || null;
}

// Retorna { registry (normalizado), council, uf, number } ou lança HttpError
function validateRegistry(profession, raw, state) {
  const text = U.cleanText(raw, 40).toUpperCase();
  const council = councilFor(profession);
  if (council === 'CRP') {
    const m = text.match(/(\d{1,2})\s*[/\-.\s]\s*(\d{3,6})/);
    if (!m) throw new U.HttpError(400, 'Informe o CRP no formato região/número. Ex.: CRP 10/12345.');
    const region = m[1].padStart(2, '0');
    const ufs = CRP_REGIONS[region];
    if (!ufs) throw new U.HttpError(400, `A região ${region} do CRP não existe. Confira o número da sua carteirinha.`);
    if (!ufs.includes(state)) {
      throw new U.HttpError(400, `O CRP ${region} é do(s) estado(s) ${ufs.join('/')}, mas você informou ${state}. O estado precisa ser o mesmo da sua carteirinha.`);
    }
    const number = m[2].padStart(5, '0');
    return { registry: `CRP ${region}/${number}`, council, uf: state, number };
  }
  if (council === 'CRM') {
    const num = text.match(/(\d{3,7})/);
    if (!num) throw new U.HttpError(400, 'Informe o número do CRM. Ex.: CRM-PA 12345.');
    const ufInText = (text.replace(/CRM/, '').match(/\b([A-Z]{2})\b/) || [])[1];
    if (ufInText && U.isUf(ufInText) && ufInText !== state) {
      throw new U.HttpError(400, `Seu CRM é do estado ${ufInText}, mas você informou ${state}. O estado precisa ser o mesmo da sua carteirinha.`);
    }
    return { registry: `CRM-${state} ${num[1]}`, council, uf: state, number: num[1] };
  }
  // Profissões sem conselho federal (psicanalista, terapeuta…): registro da entidade/associação
  // Não é obrigatório: só CRP e CRM exigem carteirinha. Se informar, fica no perfil.
  return { registry: U.cleanText(raw, 40), council: null, uf: state, number: text };
}

function isApiConfigured() {
  return Boolean(process.env.REGISTRY_API_URL && process.env.REGISTRY_API_TOKEN);
}

// Retorna { checked, match, message? }
async function verifyRegistry({ council, uf, number }, name) {
  if (!council || !isApiConfigured()) return { checked: false, match: false };
  const url = process.env.REGISTRY_API_URL.replace('{tipo}', council).replace('{uf}', uf).replace('{numero}', number);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.REGISTRY_API_TOKEN}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404) return { checked: true, match: false, message: `${council} não encontrado no conselho. Confira o número.` };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const activeField = process.env.REGISTRY_API_ACTIVE_FIELD || 'ativo';
    if (data[activeField] === false || /inativ|cancel|suspens/i.test(String(data[activeField] ?? ''))) {
      return { checked: true, match: false, message: `Este ${council} não está ativo no conselho.` };
    }
    const official = data[process.env.REGISTRY_API_NAME_FIELD || 'nome'];
    if (!official) throw new Error('resposta sem nome');
    const match = namesMatch(name, official);
    return { checked: true, match, message: match ? undefined : `O nome informado não confere com o do ${council}. Use o nome completo como está na carteirinha.` };
  } catch (e) {
    console.error('[registro] falha na consulta:', e.message);
    return { checked: false, match: false, error: true };
  }
}

module.exports = { validateRegistry, verifyRegistry, councilFor, isApiConfigured, CRP_REGIONS };
