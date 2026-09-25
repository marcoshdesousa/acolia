'use strict';
// Rotas da agenda e das consultas (ver server/agenda.js para as regras)
const express = require('express');
const { db, tx } = require('../db');
const U = require('../util');
const A = require('../auth');
const G = require('../agenda');
const { VISIBLE_SQL } = require('../serialize');

const router = express.Router();
const MIN = 60e3;

const visiblePro = (id) => db.prepare(`SELECT * FROM professionals p WHERE id = ? AND ${VISIBLE_SQL}`).get(Number(id));
const isPatient = (req) => req.auth?.role === 'patient';
const isPro = (req) => req.auth?.role === 'professional';

// ---------- Público: próximo dia disponível (aparece até para quem não tem conta) ----------
router.get('/pro/:id/next', (req, res) => {
  const pro = visiblePro(req.params.id);
  if (!pro) throw new U.HttpError(404, 'Profissional não encontrado.');
  res.json({ next: G.nextAvailable(pro) });
});

router.use(A.requireRole('patient', 'professional'));

// ---------- Calendário (paciente escolhe; profissional usa para propor no chat) ----------
function bookablePro(req, id) {
  const pro = isPro(req) && Number(id) === req.auth.user.id ? req.auth.user : visiblePro(id);
  if (!pro) throw new U.HttpError(404, 'Profissional não encontrado.');
  return pro;
}

router.get('/pro/:id/month', (req, res) => {
  const pro = bookablePro(req, req.params.id);
  const ym = /^\d{4}-\d{2}$/.test(req.query.ym || '') ? req.query.ym : G.localDate(G.now()).slice(0, 7);
  const ready = G.readiness(pro);
  const patientId = isPatient(req) ? req.auth.user.id : (req.query.patient_id ? Number(req.query.patient_id) : null);
  res.json({
    ym, today: G.localDate(G.now()), max_date: G.addDays(G.localDate(G.now()), G.RULES.HORIZON_DAYS),
    ready: ready.ok, mode: ready.mode, price_cents: pro.price_cents, minutes: G.duration(pro),
    days: ready.ok ? G.monthDays(pro, ym, { patientId }) : [],
  });
});

router.get('/pro/:id/day', (req, res) => {
  const pro = bookablePro(req, req.params.id);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  if (!date) throw new U.HttpError(400, 'Escolha um dia.');
  const patientId = isPatient(req) ? req.auth.user.id : (req.query.patient_id ? Number(req.query.patient_id) : null);
  const exclude = Number(req.query.exclude) || 0;
  res.json({ date, label: G.dayLabel(date), slots: G.readiness(pro).ok ? G.slotsForDay(pro, date, { patientId, exclude }) : [] });
});

// ---------- Paciente marca ----------
router.post('/book', async (req, res) => {
  if (!isPatient(req)) throw new U.HttpError(403, 'Só pacientes marcam consultas por aqui.');
  if (!req.body.accept) throw new U.HttpError(400, 'Leia e aceite a política de agendamento para continuar.');
  const pro = visiblePro(req.body.professional_id);
  if (!pro) throw new U.HttpError(404, 'Profissional não encontrado.');
  const ready = G.readiness(pro);
  if (!ready.ok) throw new U.HttpError(409, 'Este profissional ainda não abriu a agenda.');
  const me = req.auth.user;
  const a = tx(() => {
    const slot = G.assertFree(pro, req.body.start, { patientId: me.id });
    const c = G.ensureConversation(me.id, pro.id);
    const t = G.now();
    const auto = ready.mode === 'auto';
    const info = db.prepare(`INSERT INTO appointments (professional_id, patient_id, conversation_id, start_at, end_at, price_cents, mode, origin, status, hold_until, accepted_policy_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'paciente', ?, ?, ?)`).run(pro.id, me.id, c.id, G.iso(slot.start), G.iso(slot.end), pro.price_cents, ready.mode,
      auto ? 'aguardando_pagamento' : 'aguardando_pix', G.iso(t + (auto ? G.RULES.PAY_MIN : G.RULES.PRO_PIX_MIN) * MIN), G.iso(t));
    return G.getAppt(Number(info.lastInsertRowid));
  });
  let out = a;
  if (a.mode === 'auto') {
    try { out = await G.createCharge(a); } catch (e) {
      G.setStatus(a.id, { status: 'cancelada', hold_until: null });
      G.touch();
      throw e;
    }
  } else {
    G.post(a, 'patient', 'pedido');
  }
  G.notifyBoth(out);
  res.status(201).json(G.view(out, 'patient'));
});

// ---------- Profissional propõe uma consulta pelo chat ----------
router.post('/propose', async (req, res) => {
  if (!isPro(req)) throw new U.HttpError(403, 'Só o profissional propõe consultas.');
  const pro = req.auth.user;
  const c = require('./chat').loadConversation(req, req.body.conversation_id);
  require('./chat').assertCanSend('professional', c);
  if (G.refundLock(c.id)) throw new U.HttpError(403, 'Faça o reembolso pendente deste paciente antes de marcar outra consulta.');
  const pat = db.prepare("SELECT * FROM patients WHERE id = ? AND status = 'ativo'").get(c.patient_id);
  if (!pat) throw new U.HttpError(403, 'Esta conta não está mais ativa na plataforma.');
  const ready = G.readiness(pro);
  if (!ready.ok) throw new U.HttpError(409, 'Abra a sua agenda primeiro (horários, valor da consulta e forma de receber).');
  const a = tx(() => {
    const slot = G.assertFree(pro, req.body.start, { patientId: pat.id });
    const t = G.now();
    const info = db.prepare(`INSERT INTO appointments (professional_id, patient_id, conversation_id, start_at, end_at, price_cents, mode, origin, status, hold_until, pix_payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'profissional', 'aguardando_pagamento', ?, ?)`).run(pro.id, pat.id, c.id, G.iso(slot.start), G.iso(slot.end), pro.price_cents,
      ready.mode, G.iso(t + G.RULES.PAY_MIN * MIN), ready.mode === 'manual' ? pro.pix_key : null);
    return G.getAppt(Number(info.lastInsertRowid));
  });
  let out = a;
  if (a.mode === 'auto') {
    try { out = await G.createCharge(a); } catch (e) {
      G.setStatus(a.id, { status: 'cancelada', hold_until: null });
      G.touch();
      throw e;
    }
  }
  G.post(out, 'professional', 'proposta');
  G.notifyBoth(out);
  res.status(201).json(G.view(out, 'professional'));
});

// ---------- Consultas ----------
function loadMine(req, id) {
  const a = G.getAppt(id);
  const mine = a && (isPatient(req) ? a.patient_id === req.auth.user.id : a.professional_id === req.auth.user.id);
  if (!mine) throw new U.HttpError(404, 'Consulta não encontrada.');
  return a;
}
const role = (req) => req.auth.role;

router.get('/appointments', (req, res) => {
  const col = isPatient(req) ? 'patient_id' : 'professional_id';
  const scope = req.query.scope || 'upcoming';
  let rows;
  if (scope === 'all') {
    rows = db.prepare(`SELECT * FROM appointments WHERE ${col} = ? AND status NOT IN ('expirada', 'cancelada') ORDER BY start_at DESC LIMIT 200`).all(req.auth.user.id);
  } else {
    // Próximas: as que ainda valem (e a que está acontecendo agora)
    rows = db.prepare(`SELECT * FROM appointments WHERE ${col} = ? AND status IN (${G.ACTIVE.map(() => '?').join(', ')}) AND end_at > ? ORDER BY start_at`)
      .all(req.auth.user.id, ...G.ACTIVE, G.iso(G.now() - 30 * MIN));
    // Reembolso pendente fica aparecendo mesmo depois do horário
    const pend = db.prepare(`SELECT * FROM appointments WHERE ${col} = ? AND status = 'reembolso_pendente' AND end_at <= ?`).all(req.auth.user.id, G.iso(G.now() - 30 * MIN));
    rows = [...rows, ...pend];
  }
  res.json({ items: rows.map((a) => G.view(a, role(req))), rules: G.RULES, reasons: G.CANCEL_REASONS });
});

router.get('/appointments/:id', async (req, res) => {
  let a = loadMine(req, req.params.id);
  if (isPatient(req)) a = await G.checkPayment(a); // na tela do Pix: confere se já caiu
  res.json(G.view(a, role(req)));
});

// Paciente aceita a política (consulta proposta pelo profissional) e vê o Pix
router.post('/appointments/:id/accept', (req, res) => {
  if (!isPatient(req)) throw new U.HttpError(403, 'Só o paciente aceita.');
  let a = loadMine(req, req.params.id);
  if (a.status !== 'aguardando_pagamento') throw new U.HttpError(409, 'Esta proposta não está mais valendo.');
  a = G.setStatus(a.id, { accepted_policy_at: G.iso(G.now()) });
  G.notifyBoth(a);
  res.json(G.view(a, 'patient'));
});

// Paciente remarca (1 vez, até 30 minutos antes) — ou escolhe remarcar quando o profissional não pode
router.post('/appointments/:id/reschedule', (req, res) => {
  if (!isPatient(req)) throw new U.HttpError(403, 'Só o paciente remarca. Se você não puder atender, use "Não vou poder atender".');
  const a = loadMine(req, req.params.id);
  const byPro = a.status === 'aguardando_paciente';
  const c = G.canDo(a, 'patient');
  if (!byPro && !c.reschedule) {
    if (a.status === 'confirmada' && a.reschedules >= G.RULES.MAX_RESCHEDULES) throw new U.HttpError(403, 'Você já remarcou esta consulta uma vez. Não dá para remarcar de novo.');
    throw new U.HttpError(403, `Só dá para remarcar até ${G.RULES.CUTOFF_MIN} minutos antes da consulta.`);
  }
  if (byPro && !c.choose) throw new U.HttpError(403, 'O horário desta consulta já passou.');
  const pro = G.getPro(a.professional_id);
  const old = a.start_at;
  const upd = tx(() => {
    const slot = G.assertFree(pro, req.body.start, { patientId: a.patient_id, exclude: a.id });
    return G.setStatus(a.id, {
      start_at: G.iso(slot.start), end_at: G.iso(slot.end), status: 'confirmada',
      reschedules: byPro ? a.reschedules : a.reschedules + 1, call_id: null,
    });
  });
  G.post(upd, 'patient', 'remarcada', old);
  G.notifyBoth(upd);
  res.json(G.view(upd, 'patient'));
});

// Paciente cancela: com motivo; paga → reembolso. Antes de pagar → só desiste.
router.post('/appointments/:id/cancel', async (req, res) => {
  if (!isPatient(req)) throw new U.HttpError(403, 'Só o paciente cancela por aqui.');
  const a = loadMine(req, req.params.id);
  const c = G.canDo(a, 'patient');
  if (c.give_up) {
    if (a.mode === 'auto' && a.pay_id) {
      const pay = G.autoPayment(a.professional_id);
      // Se o Pix já caiu, confirma em vez de desistir (e aí dá para cancelar com reembolso)
      const cur = await G.checkPayment(a, { force: true });
      if (cur.status === 'confirmada') throw new U.HttpError(409, 'O seu Pix já foi recebido e a consulta está marcada. Para desmarcar, use "Cancelar consulta".');
      if (pay) require('../asaas').cancel(pay.env, pay.key, a.pay_id);
    }
    const upd = G.setStatus(a.id, { status: 'cancelada', hold_until: null, cancel_reason: 'desistiu' });
    G.post(upd, 'patient', 'cancelada', 'antes_pagar');
    G.notifyBoth(upd);
    return res.json(G.view(upd, 'patient'));
  }
  const choosing = a.status === 'aguardando_paciente';
  if (!c.cancel && !(choosing && c.choose)) {
    throw new U.HttpError(403, `Só dá para cancelar com reembolso até ${G.RULES.CUTOFF_MIN} minutos antes da consulta.`);
  }
  const reason = choosing ? 'profissional_cancelou' : String(req.body.reason || '');
  const detail = U.cleanText(req.body.detail, 500);
  if (!choosing) {
    if (!G.CANCEL_REASONS[reason]) throw new U.HttpError(400, 'Escolha o motivo do cancelamento.');
    if (reason === 'outros' && detail.length < 3) throw new U.HttpError(400, 'Conte rapidinho o motivo do cancelamento.');
  }
  G.closeCall(a);
  G.post(a, 'patient', 'reembolso_pedido', reason);
  const upd = await G.refund(a, reason, detail);
  res.json(G.view(G.getAppt(upd.id), 'patient'));
});

// Paciente responde "quer tentar pagar de novo?" (manual, depois de "pagamento não aprovado")
router.post('/appointments/:id/retry', (req, res) => {
  if (!isPatient(req)) throw new U.HttpError(403, 'Só o paciente responde.');
  const a = loadMine(req, req.params.id);
  if (!G.canDo(a, 'patient').retry) throw new U.HttpError(409, 'Esta consulta não está mais esperando resposta.');
  let upd;
  if (req.body.yes) {
    upd = G.setStatus(a.id, { status: 'aguardando_pix', hold_until: G.iso(G.now() + G.RULES.PRO_PIX_MIN * MIN), pix_payload: null });
    G.post(upd, 'patient', 'tentar');
  } else {
    upd = G.setStatus(a.id, { status: 'cancelada', hold_until: null, cancel_reason: 'desistiu' });
    G.post(upd, 'patient', 'cancelada', 'antes_pagar');
  }
  G.notifyBoth(upd);
  res.json(G.view(upd, 'patient'));
});

// Paciente confirma se recebeu o reembolso manual
router.post('/appointments/:id/refund-received', (req, res) => {
  if (!isPatient(req)) throw new U.HttpError(403, 'Só o paciente confirma.');
  const a = loadMine(req, req.params.id);
  if (!G.canDo(a, 'patient').refund_received) throw new U.HttpError(409, 'Não há reembolso esperando confirmação.');
  let upd;
  if (req.body.yes) {
    upd = G.setStatus(a.id, { status: 'reembolsada', refund_status: 'confirmado' });
    G.post(upd, 'patient', 'reembolsada', 'manual');
  } else {
    upd = G.setStatus(a.id, { refund_status: 'pedido' });
    G.post(upd, 'patient', 'reembolso_nao');
  }
  G.notifyBoth(upd);
  res.json(G.view(upd, 'patient'));
});

// ---------- Profissional ----------
router.post('/appointments/:id/send-pix', (req, res) => {
  if (!isPro(req)) throw new U.HttpError(403, 'Só o profissional envia a chave Pix.');
  const a = loadMine(req, req.params.id);
  if (!G.canDo(a, 'professional').send_pix) throw new U.HttpError(409, 'Este pedido não está mais esperando a chave Pix.');
  const key = String(req.auth.user.pix_key || '').trim();
  if (!key) throw new U.HttpError(400, 'Cadastre a sua chave Pix em Meu perfil primeiro.');
  const upd = G.setStatus(a.id, { status: 'aguardando_pagamento', hold_until: G.iso(G.now() + G.RULES.PAY_MIN * MIN), pix_payload: key });
  const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(a.conversation_id);
  require('./chat').sendMessage(c, 'professional', req.auth.user.name, 'pix', key);
  G.notifyBoth(upd);
  res.json(G.view(upd, 'professional'));
});

router.post('/appointments/:id/manual-result', (req, res) => {
  if (!isPro(req)) throw new U.HttpError(403, 'Só o profissional confirma o pagamento.');
  const a = loadMine(req, req.params.id);
  if (!G.canDo(a, 'professional').approve) throw new U.HttpError(409, 'Esta consulta não está esperando a confirmação do pagamento.');
  if (req.body.approved) {
    const upd = G.confirmPaid(a);
    if (upd.status !== 'confirmada') throw new U.HttpError(409, 'Esse horário já foi ocupado por outra pessoa. Devolva o Pix ao paciente e combine outro horário pelo chat.');
    return res.json(G.view(upd, 'professional'));
  }
  const upd = G.setStatus(a.id, { status: 'pagamento_recusado', hold_until: G.iso(G.now() + G.RULES.ANSWER_MIN * MIN) });
  G.post(upd, 'professional', 'recusado');
  G.notifyBoth(upd);
  res.json(G.view(upd, 'professional'));
});

// Não vou poder atender (até 24 horas antes): o paciente escolhe entre reembolso e remarcar
router.post('/appointments/:id/pro-cancel', (req, res) => {
  if (!isPro(req)) throw new U.HttpError(403, 'Só o profissional usa esta opção.');
  const a = loadMine(req, req.params.id);
  if (!G.canDo(a, 'professional').pro_cancel) throw new U.HttpError(403, `Só dá para avisar que não vai atender até ${G.RULES.PRO_CANCEL_H} horas antes da consulta.`);
  const upd = G.setStatus(a.id, { status: 'aguardando_paciente', cancel_detail: U.cleanText(req.body.detail, 500) || null });
  G.post(upd, 'professional', 'pro_cancelou');
  G.notifyBoth(upd);
  res.json(G.view(upd, 'professional'));
});

router.post('/appointments/:id/refund-done', (req, res) => {
  if (!isPro(req)) throw new U.HttpError(403, 'Só o profissional informa o reembolso.');
  const a = loadMine(req, req.params.id);
  if (!G.canDo(a, 'professional').refund_done) throw new U.HttpError(409, 'Não há reembolso pendente nesta consulta.');
  const upd = G.setStatus(a.id, { refund_status: 'feito' });
  G.post(upd, 'professional', 'reembolso_feito');
  G.notifyBoth(upd);
  res.json(G.view(upd, 'professional'));
});

// ---------- Configurações da agenda (profissional) ----------
function settingsOf(pro) {
  const pay = db.prepare('SELECT env, account_name, enabled, connected_at, key_enc FROM pro_payment WHERE professional_id = ?').get(pro.id);
  const ready = G.readiness(pro);
  return {
    hours: db.prepare('SELECT dow, start_min, end_min FROM agenda_hours WHERE professional_id = ? ORDER BY dow, start_min').all(pro.id)
      .map((h) => ({ dow: h.dow, start: G.hhmm(h.start_min), end: G.hhmm(h.end_min) })),
    blocks: db.prepare('SELECT id, start_at, end_at, note FROM agenda_blocks WHERE professional_id = ? AND end_at > ? ORDER BY start_at').all(pro.id, G.iso(G.now()))
      .map((b) => ({ ...b, date: G.localDate(G.ms(b.start_at)), from: G.hhmm(G.localMin(G.ms(b.start_at))), to: G.hhmm(G.localMin(G.ms(b.end_at))) || '24:00' })),
    session_minutes: G.duration(pro),
    price_cents: pro.price_cents,
    has_pix_key: !!String(pro.pix_key || '').trim(),
    payment: pay ? { connected: true, env: pay.env, account_name: pay.account_name, enabled: !!pay.enabled, connected_at: pay.connected_at, key_ok: !!require('../secretBox').open(pay.key_enc) } : { connected: false },
    ready: ready.ok, missing: ready.missing, mode: ready.mode,
    next: G.nextAvailable(pro),
    rules: G.RULES,
  };
}

router.get('/settings', (req, res) => {
  if (!isPro(req)) throw new U.HttpError(403, 'Só para profissionais.');
  res.json(settingsOf(req.auth.user));
});

router.put('/settings', (req, res) => {
  if (!isPro(req)) throw new U.HttpError(403, 'Só para profissionais.');
  const pro = req.auth.user;
  const hours = (Array.isArray(req.body.hours) ? req.body.hours : []).slice(0, 70).map((h) => {
    const dow = Number(h.dow);
    const s = G.parseHHMM(h.start);
    const e = G.parseHHMM(h.end);
    if (!(dow >= 0 && dow <= 6) || s === null || e === null) throw new U.HttpError(400, 'Confira os horários (formato 08:00).');
    if (e <= s) throw new U.HttpError(400, `Em ${['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][dow]}, o horário final precisa ser depois do inicial.`);
    return { dow, s, e };
  });
  for (const d of [0, 1, 2, 3, 4, 5, 6]) {
    const list = hours.filter((h) => h.dow === d).sort((a, b) => a.s - b.s);
    for (let i = 1; i < list.length; i++) if (list[i].s < list[i - 1].e) throw new U.HttpError(400, 'Há horários que se sobrepõem no mesmo dia.');
  }
  const minutes = req.body.session_minutes ? Number(req.body.session_minutes) : null;
  if (minutes !== null && ![30, 40, 45, 50, 60, 90, 120].includes(minutes)) throw new U.HttpError(400, 'Escolha a duração da sessão.');
  tx(() => {
    db.prepare('DELETE FROM agenda_hours WHERE professional_id = ?').run(pro.id);
    const ins = db.prepare('INSERT INTO agenda_hours (professional_id, dow, start_min, end_min) VALUES (?, ?, ?, ?)');
    for (const h of hours) ins.run(pro.id, h.dow, h.s, h.e);
    if (minutes) db.prepare('UPDATE professionals SET session_minutes = ? WHERE id = ?').run(minutes, pro.id);
  });
  G.touch();
  res.json(settingsOf(G.getPro(pro.id)));
});

// Fechar um horário (ex.: consulta presencial). Consulta já paga continua valendo.
router.post('/blocks', (req, res) => {
  if (!isPro(req)) throw new U.HttpError(403, 'Só para profissionais.');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : null;
  if (!date) throw new U.HttpError(400, 'Escolha o dia.');
  const s = req.body.all_day ? 0 : G.parseHHMM(req.body.from);
  const e = req.body.all_day ? 1440 : G.parseHHMM(req.body.to);
  if (s === null || e === null || e <= s) throw new U.HttpError(400, 'Confira o horário (o final precisa ser depois do inicial).');
  if (G.fromLocal(date, e) <= G.now()) throw new U.HttpError(400, 'Esse horário já passou.');
  const pro = req.auth.user;
  db.prepare('INSERT INTO agenda_blocks (professional_id, start_at, end_at, note) VALUES (?, ?, ?, ?)')
    .run(pro.id, G.iso(G.fromLocal(date, s)), G.iso(G.fromLocal(date, e)), U.cleanText(req.body.note, 120));
  G.touch();
  const clash = db.prepare(`SELECT COUNT(*) n FROM appointments WHERE professional_id = ? AND status IN ('confirmada', 'aguardando_paciente') AND start_at < ? AND end_at > ?`)
    .get(pro.id, G.iso(G.fromLocal(date, e)), G.iso(G.fromLocal(date, s))).n;
  res.status(201).json({ ...settingsOf(pro), clash });
});

router.delete('/blocks/:id', (req, res) => {
  if (!isPro(req)) throw new U.HttpError(403, 'Só para profissionais.');
  db.prepare('DELETE FROM agenda_blocks WHERE id = ? AND professional_id = ?').run(Number(req.params.id), req.auth.user.id);
  G.touch();
  res.json(settingsOf(req.auth.user));
});

// ---------- Pagamento automático (Asaas) ----------
router.post('/asaas', async (req, res) => {
  if (!isPro(req)) throw new U.HttpError(403, 'Só para profissionais.');
  const r = await require('../asaas').check(req.body.key);
  db.prepare(`INSERT INTO pro_payment (professional_id, provider, key_enc, env, account_name, enabled, connected_at) VALUES (?, 'asaas', ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(professional_id) DO UPDATE SET key_enc = excluded.key_enc, env = excluded.env, account_name = excluded.account_name, enabled = 1, connected_at = excluded.connected_at`)
    .run(req.auth.user.id, require('../secretBox').seal(r.key), r.env, U.cleanText(r.name, 120));
  G.touch();
  require('../cloud').scheduleBackup();
  res.json(settingsOf(req.auth.user));
});

router.put('/asaas', (req, res) => {
  if (!isPro(req)) throw new U.HttpError(403, 'Só para profissionais.');
  db.prepare('UPDATE pro_payment SET enabled = ? WHERE professional_id = ?').run(req.body.enabled ? 1 : 0, req.auth.user.id);
  G.touch();
  res.json(settingsOf(req.auth.user));
});

router.delete('/asaas', (req, res) => {
  if (!isPro(req)) throw new U.HttpError(403, 'Só para profissionais.');
  const pending = db.prepare("SELECT COUNT(*) n FROM appointments WHERE professional_id = ? AND mode = 'auto' AND status IN ('aguardando_pagamento', 'confirmada', 'aguardando_paciente', 'reembolso_pendente')").get(req.auth.user.id).n;
  if (pending) throw new U.HttpError(409, `Você tem ${pending} consulta(s) paga(s) pelo Asaas em andamento. Desligue o pagamento automático (as novas vão pelo Pix manual) e desconecte depois que elas terminarem.`);
  db.prepare('DELETE FROM pro_payment WHERE professional_id = ?').run(req.auth.user.id);
  G.touch();
  res.json(settingsOf(req.auth.user));
});

module.exports = { router };
