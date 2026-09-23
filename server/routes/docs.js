'use strict';
// Documentos emitidos pelo profissional no chat: atestado, receita e encaminhamento.
//
// Quem pode emitir o quê (regras brasileiras):
// - Receita (medicamentos): só médico → Psiquiatra (CRM). Psicólogo não prescreve remédio.
// - Atestado: médico (Psiquiatra, CRM — "atestado médico", CFM Res. 1.658/2002) e psicólogo
//   (Psicólogo(a) / Neuropsicólogo(a), CRP — "atestado psicológico", CFP Res. 06/2019).
//   Psicanalista, psicoterapeuta e terapeuta não têm conselho que permita atestado.
// - Encaminhamento para outro profissional: todos.
// - Laudo: não é feito pela plataforma (só presencialmente, em clínica).
//
// Cada documento tem um código único e um QR Code que abre a página pública de verificação
// (site.com/v/CÓDIGO): qualquer pessoa confere que ele foi emitido por aquele profissional
// (nome e registro), quando, e se não foi cancelado. A responsabilidade pelo conteúdo é do
// profissional que emitiu.
const express = require('express');
const crypto = require('node:crypto');
const { db } = require('../db');
const U = require('../util');
const A = require('../auth');

const router = express.Router();

db.exec(`CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  conversation_id INTEGER NOT NULL,
  professional_id INTEGER NOT NULL,
  patient_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                      -- atestado | receita | encaminhamento
  data TEXT NOT NULL,                      -- JSON com os dados do documento
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  revoked_at TEXT
)`);

// Assinatura feita com o dedo na hora de emitir (imagem PNG que vai na folha, acima da linha)
try { db.exec('ALTER TABLE documents ADD COLUMN signature TEXT'); } catch { /* já existe */ }
const SIGNATURE_MAX = 250 * 1024;

const MEDICO = ['Psiquiatra'];
const PSICO = ['Psicólogo(a)', 'Neuropsicólogo(a)'];
function allowedKinds(profession) {
  const kinds = [];
  if (MEDICO.includes(profession) || PSICO.includes(profession)) kinds.push('atestado');
  if (MEDICO.includes(profession)) kinds.push('receita');
  kinds.push('encaminhamento');
  return kinds;
}
const TITLES = { receita: 'Receita', encaminhamento: 'Encaminhamento' };
const titleOf = (kind, profession) => (kind === 'atestado' ? (MEDICO.includes(profession) ? 'Atestado médico' : 'Atestado psicológico') : TITLES[kind]);

// Código fácil de ler e digitar (sem 0/O, 1/I)
function newCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const bytes = crypto.randomBytes(8);
    const code = `AC-${[...bytes].map((b) => abc[b % abc.length]).join('')}`;
    if (!db.prepare('SELECT 1 FROM documents WHERE code = ?').get(code)) return code;
  }
}

// Horário do último atendimento (chamada) com este paciente
function lastAttendance(c) {
  const byConv = db.prepare('SELECT started_at, created_at FROM calls WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(c.id);
  if (byConv) return byConv.started_at || byConv.created_at;
  const byCode = db.prepare(`SELECT ca.started_at, ca.created_at FROM messages m JOIN calls ca ON ca.patient_code = m.body
    WHERE m.conversation_id = ? AND m.kind = 'call' ORDER BY ca.id DESC LIMIT 1`).get(c.id);
  return byCode ? byCode.started_at || byCode.created_at : null;
}

function proInfo(p) {
  return { name: p.legal_name || p.name, profession: p.profession, registry: p.registry, city: p.city, state: p.state };
}

function docOut(d, { masked = false } = {}) {
  const data = JSON.parse(d.data);
  if (masked) {
    data.cpf = data.cpf ? `***.${data.cpf.slice(4, 7)}.${data.cpf.slice(8, 11)}-**` : '';
    data.birth_date = '';
  }
  return { code: d.code, kind: d.kind, title: data.title, created_at: d.created_at, revoked: !!d.revoked_at, revoked_at: d.revoked_at, data, masked, signature: d.signature || null };
}

async function qrSvg(code, req) {
  const origin = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
  return require('qrcode').toString(`${origin}/v/${code}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
}

// Verificação pública (qualquer pessoa com o código): CPF mascarado, sem data de nascimento.
// Quem participa da conversa vê o documento completo.
router.get('/:code', async (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE code = ?').get(String(req.params.code).toUpperCase());
  if (!d) throw new U.HttpError(404, 'Documento não encontrado. Confira o código.');
  const me = req.auth;
  const participant = me && ((me.role === 'professional' && me.user.id === d.professional_id) || (me.role === 'patient' && me.user.id === d.patient_id));
  res.json({ ...docOut(d, { masked: !participant }), qr: await qrSvg(d.code, req) });
});

router.use(A.requireRole('professional'));

// O que este profissional pode emitir para este paciente + dados já preenchidos
router.get('/options/:conversationId', (req, res) => {
  const c = require('./chat').loadConversation(req, req.params.conversationId);
  const pat = db.prepare('SELECT name, cpf FROM patients WHERE id = ?').get(c.patient_id);
  res.json({
    kinds: allowedKinds(req.auth.user.profession).map((k) => ({ kind: k, title: titleOf(k, req.auth.user.profession) })),
    patient: { name: pat.name, cpf: U.formatCpf(pat.cpf) },
    attended_at: lastAttendance(c),
    professional: proInfo(req.auth.user),
  });
});

router.post('/', (req, res) => {
  const pro = req.auth.user;
  const chat = require('./chat');
  const c = chat.loadConversation(req, req.body.conversation_id);
  const kind = String(req.body.kind || '');
  if (!['atestado', 'receita', 'encaminhamento'].includes(kind)) throw new U.HttpError(400, 'Tipo de documento inválido.');
  if (!allowedKinds(pro.profession).includes(kind)) {
    throw new U.HttpError(403, kind === 'receita'
      ? 'Só médico (psiquiatra, com CRM) pode emitir receita de medicamentos.'
      : 'Sua profissão não permite emitir atestado. Você pode fazer um encaminhamento.');
  }
  chat.assertCanSend('professional', c);
  // Assinatura obrigatória: feita com o dedo agora, só vale para este documento
  const signature = String(req.body.signature || '');
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature)) throw new U.HttpError(400, 'Assine o documento antes de enviar.');
  if (signature.length > SIGNATURE_MAX) throw new U.HttpError(400, 'Assinatura muito grande. Assine de novo.');
  const name = U.cleanText(req.body.patient_name, 120);
  if (name.split(/\s+/).length < 2) throw new U.HttpError(400, 'Informe o nome completo do paciente.');
  const cpf = U.onlyDigits(req.body.cpf);
  if (!U.isValidCpf(cpf)) throw new U.HttpError(400, 'CPF do paciente inválido.');
  const birth = String(req.body.birth_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth) || birth >= U.todayISO() || birth < '1900-01-01') throw new U.HttpError(400, 'Informe a data de nascimento do paciente.');
  const attended = String(req.body.attended_at || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(attended)) throw new U.HttpError(400, 'Informe a data e o horário do atendimento.');

  const data = {
    title: titleOf(kind, pro.profession),
    professional: proInfo(pro),
    patient_name: name,
    cpf: U.formatCpf(cpf),
    birth_date: birth,
    attended_at: attended.slice(0, 16), // horário local de quem emitiu (AAAA-MM-DDTHH:MM)
  };
  if (kind === 'atestado') {
    data.days = 1; // um atendimento = um dia
    const cid = U.cleanText(req.body.cid, 20).toUpperCase();
    if (cid) {
      if (!req.body.cid_authorized) throw new U.HttpError(400, 'O CID só pode constar no atestado com a autorização do paciente.');
      if (!/^[A-Z]\d{2}(\.\d{1,2})?$/.test(cid)) throw new U.HttpError(400, 'CID inválido (ex.: F41.1).');
      data.cid = cid;
    }
  } else if (kind === 'receita') {
    const items = (Array.isArray(req.body.items) ? req.body.items : []).slice(0, 10).map((it) => ({
      name: U.cleanText(it.name, 120), dose: U.cleanText(it.dose, 60), qty: U.cleanText(it.qty, 60), instructions: U.cleanText(it.instructions, 300),
    })).filter((it) => it.name);
    if (!items.length) throw new U.HttpError(400, 'Adicione pelo menos um medicamento.');
    if (items.some((it) => !it.instructions)) throw new U.HttpError(400, 'Informe como tomar cada medicamento.');
    data.items = items;
  } else {
    data.specialty = U.cleanText(req.body.specialty, 120);
    if (!data.specialty) throw new U.HttpError(400, 'Informe para qual profissional/especialidade é o encaminhamento.');
    data.modality = req.body.modality === 'online' ? 'online' : 'presencial';
    data.reason = U.cleanText(req.body.reason, 800);
  }
  const code = newCode();
  db.prepare('INSERT INTO documents (code, conversation_id, professional_id, patient_id, kind, data, signature) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(code, c.id, pro.id, c.patient_id, kind, JSON.stringify(data), signature);
  const msg = chat.postMessage(req, c, 'doc', `${code}|${data.title}`);
  res.status(201).json({ code, message: msg });
});

module.exports = { router, allowedKinds };
