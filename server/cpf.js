'use strict';
// Verificação de CPF.
//
// 1) Os dígitos verificadores são sempre validados localmente (bloqueia CPF inventado/fictício).
// 2) Conferir se o NOME pertence ao CPF só é possível consultando a base da Receita Federal,
//    o que exige um serviço pago e contratado (ex.: SERPRO "Consulta CPF", ou birôs como
//    BigDataCorp, Serasa etc.). Configure as variáveis abaixo para ativar:
//
//    CPF_API_URL    URL com {cpf} no lugar do número. Ex. SERPRO:
//                   https://gateway.apiserpro.serpro.gov.br/consulta-cpf-df/v2/cpf/{cpf}
//    CPF_API_TOKEN  Token "Bearer" de acesso ao serviço
//    CPF_API_NAME_FIELD  Campo do JSON de resposta que contém o nome (padrão: "nome")
//
//    Com a API configurada, o cadastro só é aceito se o nome digitado bater com o do CPF.
const { norm, onlyDigits } = require('./util');

function isConfigured() {
  return Boolean(process.env.CPF_API_URL && process.env.CPF_API_TOKEN);
}

function namesMatch(typed, official) {
  const a = norm(typed).split(' ').filter((w) => !['da', 'de', 'do', 'das', 'dos', 'e'].includes(w));
  const b = norm(official).split(' ').filter((w) => !['da', 'de', 'do', 'das', 'dos', 'e'].includes(w));
  if (!a.length || !b.length) return false;
  return a.join(' ') === b.join(' ');
}

// Retorna { checked: boolean, match: boolean, message?: string }
async function verifyCpfName(cpf, name) {
  if (!isConfigured()) return { checked: false, match: false };
  const url = process.env.CPF_API_URL.replace('{cpf}', onlyDigits(cpf));
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.CPF_API_TOKEN}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404) return { checked: true, match: false, message: 'CPF não encontrado na Receita Federal.' };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const official = data[process.env.CPF_API_NAME_FIELD || 'nome'];
    if (!official) throw new Error('resposta sem nome');
    const match = namesMatch(name, official);
    return { checked: true, match, message: match ? undefined : 'O nome informado não confere com o CPF.' };
  } catch (e) {
    console.error('[cpf] falha na consulta:', e.message);
    return { checked: false, match: false, error: true };
  }
}

module.exports = { verifyCpfName, isConfigured, namesMatch };
