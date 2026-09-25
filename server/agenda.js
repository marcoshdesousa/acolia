'use strict';
// Agenda e consultas: horários livres, marcar, pagar com Pix (automático pelo Asaas do profissional
// ou manual pela chave Pix no chat), remarcar, cancelar, reembolso e a chamada criada sozinha.
// O dinheiro vai sempre direto para a conta do profissional — nada passa pela Acolia.
//
// Regras da plataforma:
// - Pagamento só por Pix. Automático: 10 minutos para pagar. Manual: o profissional tem 5 minutos para
//   mandar a chave Pix e o paciente tem 10 minutos para pagar depois que ela chega.
// - Paciente remarca 1 vez e cancela (com motivo e reembolso) até 30 minutos antes. Com 30 minutos ou
//   menos, não remarca nem pede reembolso; se não comparecer, o valor não volta.
// - Profissional não remarca sozinho: até 24 horas antes ele avisa que não pode atender e o paciente
//   escolhe entre o reembolso e remarcar (essa remarcação não conta).
// - Profissional que não entra na chamada até 3 minutos depois do horário: reembolso de 100% e a
//   chamada é fechada.
const { db, tx } = require('./db');
const U = require('./util');
const rt = require('./realtime');

const MIN = 60e3;
const RULES = {
  PAY_MIN: 10,            // minutos para pagar o Pix
  PRO_PIX_MIN: 5,         // manual: minutos para o profissional mandar a chave Pix
  ANSWER_MIN: 5,          // manual: minutos para o paciente responder "quer tentar de novo?"
  CUTOFF_MIN: 30,         // paciente remarca/cancela só com MAIS de 30 minutos de antecedência
  MIN_ADVANCE_MIN: 30,    // horário marcado precisa começar daqui a pelo menos 30 minutos
  PRO_CANCEL_H: 24,       // profissional avisa que não pode atender até 24 horas antes
  PRO_GRACE_MIN: 3,       // profissional tem até 3 minutos depois do horário para entrar
  CALL_BEFORE_MIN: 5,     // a chamada é aberta (e o paciente avisado) 5 minutos antes
  DONE_AFTER_MIN: 30,     // 30 minutos depois do fim, a consulta vira "concluída"
  MAX_RESCHEDULES: 1,
  HORIZON_DAYS: 90,       // dá para marcar até 90 dias à frente
  DEFAULT_MINUTES: 50,
};
const CANCEL_REASONS = {
  nao_preciso: 'Não preciso mais',
  horario: 'Problema com o horário',
  financeiro: 'Problema financeiro',
  saude: 'Problema de saúde',
  outro_profissional: 'Vou fazer com outro profissional',
  outros: 'Outros motivos',
};

// Relógio (os testes avançam o tempo)
let nowFn = Date.now;
const now = () => nowFn();
const iso = (ms) => new Date(ms).toISOString();
const ms = (s) => Date.parse(s);

// ---------- Horário de Brasília (UTC-3, sem horário de verão) ----------
const BR = 3 * 60 * MIN;
const localDate = (t) => new Date(t - BR).toISOString().slice(0, 10);
const localMin = (t) => { const d = new Date(t - BR); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const fromLocal = (date, min) => { const [y, m, d] = date.split('-').map(Number); return Date.UTC(y, m - 1, d, 0, min) + BR; };
const dowOf = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const parseHHMM = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim()); if (!m) return null; const v = Number(m[1]) * 60 + Number(m[2]); return v >= 0 && v <= 1440 ? v : null; };
const addDays = (date, n) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
function fmtWhen(t) {
  const date = localDate(t);
  const [y, m, d] = date.split('-');
  return `${WEEKDAYS[dowOf(date)]}, ${d}/${m}/${y} às ${hhmm(localMin(t))}`;
}
function dayLabel(date) {
  const today = localDate(now());
  if (date === today) return 'Hoje';
  if (date === addDays(today, 1)) return 'Amanhã';
  const [, m, d] = date.split('-');
  return `${WEEKDAYS[dowOf(date)].replace('-feira', '')}, ${d}/${m}`;
}

// ---------- Situação da consulta ----------
const HOLDING = ['aguardando_pagamento', 'aguardando_pix', 'pagamento_recusado'];
const OCCUPY_SQL = `(status IN ('confirmada', 'aguardando_paciente') OR (status IN ('aguardando_pagamento', 'aguardando_pix', 'pagamento_recusado') AND hold_until > ?))`;
const ACTIVE = ['aguardando_pagamento', 'aguardando_pix', 'pagamento_recusado', 'confirmada', 'aguardando_paciente', 'reembolso_pendente'];

const getPro = (id) => db.prepare('SELECT * FROM professionals WHERE id = ?').get(Number(id));
const getAppt = (id) => db.prepare('SELECT * FROM appointments WHERE id = ?').get(Number(id));
const duration = (pro) => pro.session_minutes || RULES.DEFAULT_MINUTES;

// Pagamento automático (Asaas) do profissional, com a chave já aberta; null = manual
function autoPayment(proId) {
  const row = db.prepare('SELECT * FROM pro_payment WHERE professional_id = ? AND enabled = 1').get(proId);
  if (!row) return null;
  // Chave de teste (Sandbox) ou Asaas simulado: só vale para o Profissional Teste (não recebe dinheiro)
  if (row.env !== 'producao' && process.env.ALLOW_ASAAS_SANDBOX !== '1' && !(row.env === 'simulado' && getPro(proId)?.is_test)) return null;
  const key = require('./secretBox').open(row.key_enc);
  return key ? { env: row.env, key, name: row.account_name } : null;
}

// Consultório (consulta presencial): só quem marcou "Atende presencialmente" e cadastrou o endereço
function clinicOf(pro) {
  if (!pro || !pro.has_clinic || !String(pro.clinic_address || '').trim()) return null;
  const m = require('./serialize').clinicMap(pro);
  return { name: pro.clinic_name || '', address: pro.clinic_address, city: pro.city || '', state: pro.state || '',
    place: [pro.city, pro.state].filter(Boolean).join(' - '), maps_url: m.maps_url, map_embed: m.map_embed };
}
// Valor da consulta conforme a modalidade (presencial pode ter valor diferente)
function priceFor(pro, modality) {
  return modality === 'presencial' && pro.price_presencial_cents != null ? pro.price_presencial_cents : pro.price_cents;
}
// Mensagem automática com o local da consulta (nome, endereço e mapa)
function sendLocation(c, pro) {
  const loc = clinicOf(pro);
  if (!c || !loc) return null;
  return require('./routes/chat').sendMessage(c, 'professional', pro.name, 'location', JSON.stringify(loc));
}

// Pode receber marcações? (horários cadastrados, valor da consulta e uma forma de receber o Pix)
function readiness(pro) {
  const missing = [];
  if (!pro.agenda_on) missing.push('online');
  if (!db.prepare('SELECT 1 FROM agenda_hours WHERE professional_id = ?').get(pro.id)) missing.push('horarios');
  if (!(pro.price_cents > 0)) missing.push('valor');
  const auto = !!autoPayment(pro.id);
  if (!auto && !String(pro.pix_key || '').trim()) missing.push('pix');
  return { ok: missing.length === 0, missing, mode: auto ? 'auto' : 'manual' };
}

// ---------- Horários livres ----------
function loadBusy(proId, fromMs, toMs, { patientId = null, exclude = 0 } = {}) {
  const t = iso(now());
  const busy = db.prepare(`SELECT start_at, end_at FROM appointments WHERE professional_id = ? AND id <> ? AND ${OCCUPY_SQL}
    AND end_at > ? AND start_at < ?`).all(proId, exclude, t, iso(fromMs), iso(toMs));
  const blocks = db.prepare('SELECT start_at, end_at FROM agenda_blocks WHERE professional_id = ? AND end_at > ? AND start_at < ?').all(proId, iso(fromMs), iso(toMs));
  const mine = patientId ? db.prepare(`SELECT start_at, end_at FROM appointments WHERE patient_id = ? AND id <> ? AND ${OCCUPY_SQL}
    AND end_at > ? AND start_at < ?`).all(patientId, exclude, t, iso(fromMs), iso(toMs)) : [];
  return [...busy, ...blocks, ...mine].map((r) => [ms(r.start_at), ms(r.end_at)]);
}

// Regra: cada paciente marca UMA consulta por dia (com qualquer profissional). Devolve a consulta que
// já ocupa aquele dia (data de Brasília), se houver.
function patientDayTaken(patientId, date, exclude = 0) {
  if (!patientId) return null;
  const from = fromLocal(date, 0);
  return db.prepare(`SELECT a.*, p.name AS pro_name FROM appointments a JOIN professionals p ON p.id = a.professional_id
    WHERE a.patient_id = ? AND a.id <> ? AND ${OCCUPY_SQL.replace(/status|hold_until/g, (w) => `a.${w}`)} AND a.start_at >= ? AND a.start_at < ? ORDER BY a.start_at LIMIT 1`)
    .get(patientId, exclude, iso(now()), iso(from), iso(from + 1440 * MIN)) || null;
}
const takenText = (a, who = 'patient') => `${who === 'patient' ? 'Você já tem' : 'Este paciente já tem'} uma consulta marcada para ${fmtWhen(ms(a.start_at))}. Cada paciente marca uma consulta por dia: escolha outro dia.`;

// Horários livres de um dia (data de Brasília)
function slotsForDay(pro, date, opts = {}) {
  if (opts.patientId && patientDayTaken(opts.patientId, date, opts.exclude || 0)) return []; // já tem consulta neste dia
  const dur = duration(pro);
  const step = dur + (pro.break_minutes || 0); // consulta + descanso até a próxima
  const ranges = db.prepare('SELECT start_min, end_min, single FROM agenda_hours WHERE professional_id = ? AND dow = ? ORDER BY start_min').all(pro.id, dowOf(date));
  if (!ranges.length) return [];
  const t0 = now();
  // Conta de teste: dá para marcar até em cima da hora (para o dono testar na hora)
  const earliest = t0 + (pro.is_test ? 1 : RULES.MIN_ADVANCE_MIN) * MIN;
  const latest = fromLocal(localDate(t0), 0) + (RULES.HORIZON_DAYS + 1) * 1440 * MIN;
  const dayStart = fromLocal(date, 0);
  const busy = opts.busy || loadBusy(pro.id, dayStart, dayStart + 1440 * MIN, opts);
  const out = [];
  const seen = new Set();
  for (const r of ranges) {
    // single: a linha é o início de UMA consulta; senão é uma faixa (formato antigo) dividida em consultas
    const last = r.single ? Math.min(r.start_min, 1440 - dur) : r.end_min - dur;
    for (let m = r.start_min; m <= last; m += step) {
      const s = fromLocal(date, m);
      const e = s + dur * MIN;
      if (s < earliest || s > latest || seen.has(s)) continue;
      if (busy.some(([bs, be]) => s < be && e > bs)) continue;
      seen.add(s);
      out.push({ start: iso(s), label: hhmm(m) });
    }
  }
  return out.sort((a, b) => ms(a.start) - ms(b.start));
}

// Inícios das consultas de cada dia da semana, como a tela mostra ({ 1: ['08:00', '09:00'], ... })
function weekStarts(pro) {
  const dur = duration(pro);
  const step = dur + (pro.break_minutes || 0);
  const out = {};
  for (const r of db.prepare('SELECT dow, start_min, end_min, single FROM agenda_hours WHERE professional_id = ? ORDER BY dow, start_min').all(pro.id)) {
    const list = (out[r.dow] ||= []);
    if (r.single) list.push(r.start_min);
    else for (let m = r.start_min; m + dur <= r.end_min; m += step) list.push(m);
  }
  for (const d of Object.keys(out)) out[d] = [...new Set(out[d])].sort((a, b) => a - b).map(hhmm);
  return out;
}

// Dias de um mês ("2026-10") com quantos horários livres cada um tem
function monthDays(pro, ym, opts = {}) {
  const [y, m] = ym.split('-').map(Number);
  const first = `${ym}-01`;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const from = fromLocal(first, 0);
  const busy = loadBusy(pro.id, from, from + (days + 1) * 1440 * MIN, opts);
  const out = [];
  for (let d = 1; d <= days; d++) {
    const date = `${ym}-${String(d).padStart(2, '0')}`;
    const taken = patientDayTaken(opts.patientId, date, opts.exclude || 0);
    out.push({ date, free: taken ? 0 : slotsForDay(pro, date, { ...opts, busy }).length, ...(taken ? { taken: { when: fmtWhen(ms(taken.start_at)), time: hhmm(localMin(ms(taken.start_at))), with: taken.pro_name } } : {}) });
  }
  return out;
}

// Próximo dia com horário livre (aparece para todos, até sem conta). Guarda por 30 segundos.
const nextCache = new Map();
let version = 0;
const touch = () => { version++; };
function nextAvailable(pro) {
  const hit = nextCache.get(pro.id);
  if (hit && hit.v === version && now() - hit.at < 30e3) return hit.value;
  let value = null;
  if (readiness(pro).ok) {
    const today = localDate(now());
    const busy = loadBusy(pro.id, fromLocal(today, 0), fromLocal(today, 0) + 62 * 1440 * MIN);
    for (let i = 0; i <= 60 && !value; i++) {
      const date = addDays(today, i);
      const s = slotsForDay(pro, date, { busy });
      if (s.length) value = { date, label: dayLabel(date), first: s[0].label };
    }
  }
  nextCache.set(pro.id, { v: version, at: now(), value });
  return value;
}
// Para um paciente logado: pula os dias em que ele já tem consulta (uma por dia)
function nextAvailableFor(pro, patientId) {
  const base = nextAvailable(pro);
  if (!base || !patientId || !patientDayTaken(patientId, base.date)) return base;
  const today = localDate(now());
  for (let i = 0; i <= 60; i++) {
    const date = addDays(today, i);
    const s = slotsForDay(pro, date, { patientId });
    if (s.length) return { date, label: dayLabel(date), first: s[0].label };
  }
  return null;
}

function assertFree(pro, startIso, { patientId, exclude = 0, who = 'patient' } = {}) {
  const t = ms(startIso);
  if (!Number.isFinite(t)) throw new U.HttpError(400, 'Escolha um horário.');
  const date = localDate(t);
  const taken = patientDayTaken(patientId, date, exclude);
  if (taken) throw new U.HttpError(409, takenText(taken, who));
  const ok = slotsForDay(pro, date, { patientId, exclude }).some((s) => ms(s.start) === t);
  if (!ok) {
    // Diz o motivo certo quando é choque com outra consulta do próprio paciente
    if (patientId && slotsForDay(pro, date, { exclude }).some((s) => ms(s.start) === t)) {
      throw new U.HttpError(409, 'Você já tem outra consulta nesse horário. Escolha um horário que não bata com ela.');
    }
    throw new U.HttpError(409, 'Esse horário não está mais disponível. Escolha outro.');
  }
  return { start: t, end: t + duration(pro) * MIN };
}

// ---------- Conversa e mensagens automáticas ----------
function ensureConversation(patientId, proId) {
  let c = db.prepare('SELECT * FROM conversations WHERE patient_id = ? AND professional_id = ?').get(patientId, proId);
  if (!c) {
    const info = db.prepare('INSERT INTO conversations (patient_id, professional_id) VALUES (?, ?)').run(patientId, proId);
    c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(info.lastInsertRowid));
  }
  // A consulta faz a conversa aparecer para os dois (e sai do arquivo)
  db.prepare('UPDATE conversations SET patient_wrote = 1, archived_by_patient = 0, archived_by_professional = 0 WHERE id = ?').run(c.id);
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(c.id);
}

// Cartão da consulta no chat: body = "id|evento|extra"
function post(a, role, event, extra = '') {
  if (!a.conversation_id) return;
  const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(a.conversation_id);
  if (!c) return;
  const pro = getPro(a.professional_id);
  const pat = db.prepare('SELECT name FROM patients WHERE id = ?').get(a.patient_id);
  const from = role === 'patient' ? pat.name : pro.name;
  require('./routes/chat').sendMessage(c, role, from, 'booking', `${a.id}|${event}|${extra}`);
}

const PUSH = {
  pedido: 'Quer marcar uma consulta e fazer o pagamento',
  proposta: '📅 Sua consulta está quase pronta: faça o pagamento',
  agendada: '✅ Consulta agendada',
  remarcada: '🔁 Consulta remarcada',
  cancelada: 'Consulta cancelada',
  reembolso_pedido: 'Pediu o reembolso da consulta',
  reembolso_feito: 'Informou que fez o reembolso',
  reembolso_nao: 'Ainda não recebeu o reembolso',
  reembolsada: 'Reembolso confirmado',
  recusado: 'Pagamento não aprovado',
  tentar: 'Quer tentar pagar de novo',
  pro_cancelou: 'O profissional não poderá atender. Escolha: reembolso ou remarcar',
  ausente: 'O profissional não compareceu. Seu dinheiro será reembolsado',
  paciente_ausente: 'Você não entrou na chamada a tempo. A consulta foi encerrada, sem reembolso',
  chamada: '🎥 Sua consulta vai começar: toque para entrar',
  finalizada: '✅ Chamada finalizada',
  expirada: 'O tempo para pagar acabou',
  sem_resposta: 'O profissional não mandou a chave Pix a tempo',
};
function pushText(body) {
  const [id, event] = String(body).split('|');
  if (event === 'agendada') {
    const a = getAppt(id);
    if (a?.modality === 'presencial') return `📍 Consulta presencial agendada: ${fmtWhen(ms(a.start_at))}`;
    if (a?.billing === 'convenio') return `✅ Consulta agendada pelo convênio: ${fmtWhen(ms(a.start_at))}`;
  }
  return PUSH[event] || 'Consulta';
}
// Consulta confirmada: o cartão "agendada" e, se for presencial, a localização logo em seguida
function announceConfirmed(a) {
  post(a, 'patient', 'agendada', a.billing === 'convenio' ? 'convenio' : '');
  if (a.modality === 'presencial' && a.conversation_id) {
    sendLocation(db.prepare('SELECT * FROM conversations WHERE id = ?').get(a.conversation_id), getPro(a.professional_id));
  }
}

function notifyBoth(a) {
  touch();
  rt.emit(`patient:${a.patient_id}`, 'agenda:update', { id: a.id });
  rt.emit(`professional:${a.professional_id}`, 'agenda:update', { id: a.id });
  require('./cloud').scheduleBackup();
}

function setStatus(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE appointments SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), iso(now()), id);
  return getAppt(id);
}

// ---------- Pagamento ----------
async function createCharge(a) {
  const pay = autoPayment(a.professional_id);
  if (!pay) throw new U.HttpError(409, 'O pagamento automático deste profissional não está disponível agora.');
  const asaas = require('./asaas');
  const pat = db.prepare('SELECT id, name, cpf FROM patients WHERE id = ?').get(a.patient_id);
  let cust = db.prepare('SELECT customer_id FROM asaas_customers WHERE professional_id = ? AND patient_id = ?').get(a.professional_id, a.patient_id)?.customer_id;
  if (!cust) {
    cust = await asaas.ensureCustomer(pay.env, pay.key, pat);
    db.prepare('INSERT OR REPLACE INTO asaas_customers (professional_id, patient_id, customer_id) VALUES (?, ?, ?)').run(a.professional_id, a.patient_id, cust);
  }
  const pro = getPro(a.professional_id);
  const pix = await asaas.createPix(pay.env, pay.key, {
    customer: cust, cents: a.price_cents, description: `Consulta ${a.modality === 'presencial' ? 'presencial' : 'online'} com ${pro.name} — ${fmtWhen(ms(a.start_at))} (Acolia)`, ref: `acolia-consulta-${a.id}`,
  });
  return setStatus(a.id, { pay_id: pix.id, pix_payload: pix.payload, pix_image: pix.image });
}

// Pago: confirma a consulta (se o horário ainda estiver livre; senão, devolve o dinheiro)
function confirmPaid(a) {
  const r = tx(() => {
    const cur = getAppt(a.id);
    if (cur.status === 'confirmada') return { a: cur, already: true };
    const pro = getPro(cur.professional_id);
    const clash = db.prepare(`SELECT 1 FROM appointments WHERE professional_id = ? AND id <> ? AND ${OCCUPY_SQL} AND start_at < ? AND end_at > ?`)
      .get(cur.professional_id, cur.id, iso(now()), cur.end_at, cur.start_at);
    if (clash || !pro) return { a: cur, clash: true };
    return { a: setStatus(cur.id, { status: 'confirmada', paid_at: iso(now()), hold_until: null }) };
  });
  if (r.already) return r.a;
  if (r.clash) {
    // Pagou depois do prazo e o horário já foi ocupado por outra pessoa: devolve
    refund(r.a, 'horario_ocupado');
    return getAppt(a.id);
  }
  announceConfirmed(r.a);
  notifyBoth(r.a);
  return r.a;
}

// Consulta o Asaas (quando o paciente está na tela do Pix e na varredura periódica)
const lastCheck = new Map();
async function checkPayment(a, { force = false } = {}) {
  if (a.mode !== 'auto' || !a.pay_id || !['aguardando_pagamento', 'expirada'].includes(a.status)) return a;
  if (!force && now() - (lastCheck.get(a.id) || 0) < 3000) return a;
  lastCheck.set(a.id, now());
  const pay = autoPayment(a.professional_id);
  if (!pay) return a;
  try {
    const st = await require('./asaas').status(pay.env, pay.key, a.pay_id);
    if (st.paid) return confirmPaid(a);
  } catch (e) { console.error('[agenda] consulta de pagamento', a.id, e.message); }
  return getAppt(a.id);
}

// Reembolso: automático (Asaas) ou pedido ao profissional (manual — ele devolve, toca em "Fiz o reembolso"
// e manda a foto do comprovante na conversa)
function refund(a, reason, detail = '') {
  const fields = { cancel_reason: reason, cancel_detail: detail || null };
  if (a.billing === 'convenio') {
    // Pelo convênio não houve pagamento pela Acolia: só cancela
    const upd = setStatus(a.id, { ...fields, status: 'cancelada', hold_until: null });
    post(upd, 'patient', 'cancelada', 'convenio');
    notifyBoth(upd);
    return upd;
  }
  if (a.mode === 'auto' && a.pay_id) {
    const pay = autoPayment(a.professional_id);
    setStatus(a.id, { ...fields, status: 'reembolso_pendente', refund_status: 'processando' });
    const done = (ok, err) => {
      const cur = getAppt(a.id);
      if (ok) {
        const upd = setStatus(a.id, { status: 'reembolsada', refund_status: 'feito' });
        post(upd, 'professional', 'reembolsada', 'auto');
        notifyBoth(upd);
      } else {
        // Não deu no automático (ex.: sem saldo): o profissional devolve pelo Pix, como no manual
        console.error('[agenda] estorno automático falhou', a.id, err);
        const upd = setStatus(cur.id, { status: 'reembolso_pendente', refund_status: 'pedido' });
        post(upd, 'patient', 'reembolso_pedido', 'erro_auto');
        notifyBoth(upd);
      }
    };
    if (!pay) { done(false, 'sem chave'); return getAppt(a.id); }
    return require('./asaas').refund(pay.env, pay.key, a.pay_id, 'Reembolso da consulta (Acolia)')
      .then(() => done(true)).catch((e) => done(false, e.message)).then(() => getAppt(a.id));
  }
  const upd = setStatus(a.id, { ...fields, status: 'reembolso_pendente', refund_status: 'pedido' });
  notifyBoth(upd);
  return upd;
}

// Reembolso manual pedido e ainda não feito: o profissional não marca outra consulta com esse paciente
// até tocar em "Fiz o reembolso" (o chat NÃO fica travado: os dois continuam conversando e mandando fotos)
function refundLock(conversationId) {
  return !!db.prepare("SELECT 1 FROM appointments WHERE conversation_id = ? AND status = 'reembolso_pendente' AND refund_status = 'pedido'").get(conversationId);
}
// Antes, o reembolso manual esperava o paciente confirmar ("Você recebeu?"). Agora o profissional
// informa e manda o comprovante em foto: as consultas que estavam esperando essa confirmação terminam.
db.prepare("UPDATE appointments SET status = 'reembolsada' WHERE status = 'reembolso_pendente' AND refund_status = 'feito'").run();

// ---------- Chamada automática ----------
function openCall(a) {
  const cur = getAppt(a.id);
  if (cur.call_id) return cur;
  const pro = getPro(cur.professional_id);
  const pat = db.prepare('SELECT name FROM patients WHERE id = ?').get(cur.patient_id);
  const { newPatientCode } = require('./routes/calls');
  const code = newPatientCode(pro.code);
  const info = db.prepare('INSERT INTO calls (professional_id, patient_label, patient_code, conversation_id, appointment_id) VALUES (?, ?, ?, ?, ?)')
    .run(pro.id, pat?.name || 'Paciente', code, cur.conversation_id, cur.id);
  const upd = setStatus(cur.id, { call_id: Number(info.lastInsertRowid) });
  post(upd, 'professional', 'chamada');
  notifyBoth(upd);
  return upd;
}

function closeCall(a) {
  if (!a.call_id) return;
  const call = db.prepare("SELECT * FROM calls WHERE id = ? AND status = 'ativo'").get(a.call_id);
  if (call) require('./routes/calls').endCall(call);
}

// O profissional finalizou a chamada da consulta: a consulta está concluída. Sai o aviso fixo
// (se não houver outra consulta) e todos na conversa veem "Chamada finalizada".
// Se o paciente ainda não entrou, a chamada NÃO fecha (ele tem até 3 minutos depois do horário):
// devolve false para quem chamou não encerrar.
function canEndCall(call) {
  if (!call?.appointment_id || call.guest_joined_at) return true;
  const a = getAppt(call.appointment_id);
  return !(a && a.status === 'confirmada');
}
function finishFromCall(call) {
  if (!call?.appointment_id) return;
  const a = getAppt(call.appointment_id);
  if (!a || a.status !== 'confirmada') return;
  const upd = setStatus(a.id, { status: 'concluida' });
  post(upd, 'professional', 'finalizada');
  notifyBoth(upd);
}

// ---------- Varredura (a cada 20 segundos) ----------
let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const t = now();
    const T = iso(t);
    // Prazos de pagamento vencidos
    for (const a of db.prepare("SELECT * FROM appointments WHERE status IN ('aguardando_pagamento', 'aguardando_pix', 'pagamento_recusado') AND hold_until <= ?").all(T)) {
      if (a.mode === 'auto') {
        const cur = await checkPayment(a, { force: true });
        if (cur.status !== 'aguardando_pagamento') continue;
        const pay = autoPayment(a.professional_id);
        if (pay && a.pay_id) require('./asaas').cancel(pay.env, pay.key, a.pay_id);
      }
      const upd = setStatus(a.id, { status: 'expirada', hold_until: null });
      post(upd, a.status === 'aguardando_pix' ? 'professional' : 'patient', a.status === 'aguardando_pix' ? 'sem_resposta' : 'expirada');
      notifyBoth(upd);
    }
    // Pix automático pago logo depois de vencer (até 1 hora): confirma ou devolve
    for (const a of db.prepare("SELECT * FROM appointments WHERE mode = 'auto' AND status = 'expirada' AND pay_id IS NOT NULL AND updated_at > ?").all(iso(t - 60 * MIN))) {
      await checkPayment(a, { force: false });
    }
    // Automático aguardando: confere de vez em quando mesmo se o paciente fechou a tela
    for (const a of db.prepare("SELECT * FROM appointments WHERE mode = 'auto' AND status = 'aguardando_pagamento'").all()) {
      await checkPayment(a);
    }
    // Chamada: abre 5 minutos antes (manda o aviso na conversa)
    for (const a of db.prepare("SELECT * FROM appointments WHERE status = 'confirmada' AND modality = 'online' AND call_id IS NULL AND start_at <= ?").all(iso(t + RULES.CALL_BEFORE_MIN * MIN))) {
      openCall(a);
    }
    // Regra dos 3 minutos (vale para os dois), contada a partir do horário da consulta:
    // - profissional não entrou → reembolso de 100% e fecha a chamada (vale mesmo se o paciente também faltou)
    // - paciente não entrou → a chamada acaba e o valor NÃO é devolvido
    for (const a of db.prepare("SELECT * FROM appointments WHERE status = 'confirmada' AND modality = 'online' AND start_at <= ?").all(iso(t - RULES.PRO_GRACE_MIN * MIN))) {
      const call = a.call_id ? db.prepare('SELECT host_joined_at, guest_joined_at FROM calls WHERE id = ?').get(a.call_id) : null;
      if (!call?.host_joined_at) {
        closeCall(a);
        post(a, 'professional', 'ausente');
        await refund(getAppt(a.id), 'profissional_ausente');
        continue;
      }
      if (call.guest_joined_at) continue;
      closeCall(a);
      const upd = setStatus(a.id, { status: 'paciente_ausente' });
      post(upd, 'professional', 'paciente_ausente'); // aviso vai para o paciente (e aparece para o profissional)
      notifyBoth(upd);
    }
    // Profissional pediu para cancelar e o paciente não escolheu até o horário: reembolso
    for (const a of db.prepare("SELECT * FROM appointments WHERE status = 'aguardando_paciente' AND start_at <= ?").all(T)) {
      await refund(a, 'profissional_cancelou');
    }
    // Fim: 30 minutos depois do horário de término, a consulta está concluída
    // (presencial não: o profissional confirma se a consulta aconteceu — "Sim" vai para Meus pacientes, "Não" some)
    for (const a of db.prepare("SELECT * FROM appointments WHERE status = 'confirmada' AND modality = 'online' AND end_at <= ?").all(iso(t - RULES.DONE_AFTER_MIN * MIN))) {
      closeCall(a);
      const upd = setStatus(a.id, { status: 'concluida' });
      post(upd, 'professional', a.modality === 'presencial' ? 'concluida' : 'finalizada');
      notifyBoth(upd);
    }
  } catch (e) {
    console.error('[agenda] varredura', e);
  } finally {
    sweeping = false;
  }
}

// Conta apagada: consultas que ainda iam acontecer são canceladas (paga pelo Asaas → estorno automático)
function onAccountGone(role, id) {
  const col = role === 'patient' ? 'patient_id' : 'professional_id';
  for (const a of db.prepare(`SELECT * FROM appointments WHERE ${col} = ? AND status IN (${ACTIVE.map(() => '?').join(', ')})`).all(id, ...ACTIVE)) {
    closeCall(a);
    if (['confirmada', 'aguardando_paciente'].includes(a.status) && a.mode === 'auto' && a.pay_id) {
      const pay = autoPayment(a.professional_id);
      if (pay) require('./asaas').refund(pay.env, pay.key, a.pay_id, 'Conta apagada (Acolia)').catch((e) => console.error('[agenda] estorno', a.id, e.message));
    }
    setStatus(a.id, { status: 'cancelada', hold_until: null, cancel_reason: 'conta_apagada', conversation_id: null });
  }
  touch();
}

// ---------- O que cada um pode fazer agora ----------
function canDo(a, role) {
  const t = now();
  const start = ms(a.start_at);
  const beforeCutoff = t < start - RULES.CUTOFF_MIN * MIN;
  const c = {};
  if (role === 'patient') {
    c.pay = a.status === 'aguardando_pagamento' && a.mode === 'auto' && ms(a.hold_until) > t;
    c.accept = a.origin === 'profissional' && !a.accepted_policy_at && a.status === 'aguardando_pagamento' && ms(a.hold_until) > t;
    c.reschedule = a.status === 'confirmada' && beforeCutoff && a.reschedules < RULES.MAX_RESCHEDULES;
    c.cancel = a.status === 'confirmada' && beforeCutoff;
    c.give_up = HOLDING.includes(a.status);
    // Pix manual: a chave e o valor já vêm no cartão ("Copiar Pix")
    c.copy_pix = a.mode === 'manual' && a.status === 'aguardando_pagamento' && !!a.pix_payload && ms(a.hold_until) > t;
    c.choose = a.status === 'aguardando_paciente' && t < start;
    c.retry = a.status === 'pagamento_recusado' && ms(a.hold_until) > t;
    c.refund_received = false; // o paciente não precisa mais confirmar (o comprovante vai em foto)
  } else {
    c.send_pix = a.mode === 'manual' && a.status === 'aguardando_pix' && ms(a.hold_until) > t;
    c.approve = a.mode === 'manual' && !!a.pix_payload && (a.status === 'aguardando_pagamento' || (a.status === 'expirada' && ms(a.start_at) > t));
    c.pro_cancel = a.status === 'confirmada' && t < start - RULES.PRO_CANCEL_H * 60 * MIN;
    c.refund_done = a.status === 'reembolso_pendente' && a.refund_status === 'pedido';
    // "Cancelar agendamento" antes do pagamento (profissional ou secretária)
    c.withdraw = HOLDING.includes(a.status);
    // Presencial: a partir do horário, o profissional (ou a secretária) diz se aconteceu
    c.presence_check = a.modality === 'presencial' && a.status === 'confirmada' && t >= start;
  }
  c.enter_call = a.status === 'confirmada' && !!a.call_id && a.modality !== 'presencial';
  return c;
}

// role 'secretary' (versão 1.1.3): vê como o profissional, mas sem entrar na chamada
function view(a, role) {
  if (role === 'secretary') {
    const v = view(a, 'professional');
    return { ...v, call_code: null, can: { ...v.can, enter_call: false }, secretary: true };
  }
  const pro = getPro(a.professional_id);
  const pat = db.prepare('SELECT id, name, handle, photo FROM patients WHERE id = ?').get(a.patient_id);
  const call = a.call_id ? db.prepare('SELECT patient_code, status FROM calls WHERE id = ?').get(a.call_id) : null;
  const t0 = ms(a.start_at);
  return {
    id: a.id,
    professional: { id: pro.id, name: pro.name, photo: pro.photo, profession: pro.profession },
    patient: { id: pat.id, name: pat.name, handle: pat.handle || '', photo: pat.photo },
    conversation_id: a.conversation_id,
    start_at: a.start_at,
    end_at: a.end_at,
    when: fmtWhen(t0),
    date: localDate(t0),
    time: hhmm(localMin(t0)),
    minutes: Math.round((ms(a.end_at) - t0) / MIN),
    price_cents: a.price_cents,
    mode: a.mode,
    modality: a.modality || 'online',
    billing: a.billing || 'pix',
    location: a.modality === 'presencial' ? clinicOf(pro) : null,
    origin: a.origin,
    status: a.status,
    hold_until: a.hold_until,
    reschedules: a.reschedules,
    max_reschedules: RULES.MAX_RESCHEDULES,
    refund_status: a.refund_status,
    cancel_reason: a.cancel_reason,
    cancel_reason_label: CANCEL_REASONS[a.cancel_reason] || null,
    cancel_detail: a.cancel_detail,
    pix_payload: role === 'patient' || a.mode === 'manual' ? a.pix_payload : null,
    pix_image: role === 'patient' && a.mode === 'auto' && a.status === 'aguardando_pagamento' ? a.pix_image : null,
    call_code: call && call.status === 'ativo' ? call.patient_code : null,
    // Conta de teste com o Asaas simulado: o paciente de teste vê o botão "Simular pagamento"
    simulated: role === 'patient' && a.mode === 'auto' && db.prepare('SELECT env FROM pro_payment WHERE professional_id = ?').get(a.professional_id)?.env === 'simulado',
    can: canDo(a, role),
    now: iso(now()),
  };
}

module.exports = {
  RULES, CANCEL_REASONS, HOLDING, ACTIVE, OCCUPY_SQL,
  now, iso, ms, localDate, localMin, fromLocal, hhmm, parseHHMM, addDays, fmtWhen, dayLabel, dowOf,
  getPro, getAppt, duration, readiness, clinicOf, priceFor, sendLocation, announceConfirmed, weekStarts, autoPayment, slotsForDay, monthDays, nextAvailable, nextAvailableFor, patientDayTaken, assertFree, touch,
  ensureConversation, post, pushText, notifyBoth, setStatus, createCharge, confirmPaid, checkPayment, refund, refundLock,
  openCall, closeCall, canEndCall, finishFromCall, sweep, canDo, view, onAccountGone,
  _setNow(fn) { nowFn = fn || Date.now; touch(); },
};
