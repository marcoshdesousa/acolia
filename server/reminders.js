'use strict';
// Lembretes de consulta (paciente e profissional), pelo WhatsApp da Acolia e pela notificação do app:
// - 1 dia antes: só se a consulta foi marcada com mais de 1 dia de antecedência;
// - 1 hora antes: só se foi marcada com mais de 1 hora de antecedência (marcou em cima da hora → sem lembrete).
// Cada lembrete sai uma vez só (por consulta, tipo e horário: se remarcar, os lembretes valem de novo).
// Só consultas confirmadas (pagas ou pelo convênio).
const { db } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS reminder_log (
  appointment_id INTEGER NOT NULL,
  kind TEXT NOT NULL,          -- 1d | 1h
  start_at TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  wa_patient TEXT,             -- ok | motivo de não ter ido pelo WhatsApp
  wa_pro TEXT,
  PRIMARY KEY (appointment_id, kind, start_at)
)`);

const MIN = 60e3;
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';

function texts(G, a, kind, pro, pat) {
  const t = G.ms(a.start_at);
  const date = G.localDate(t);
  const [y, m, d] = date.split('-');
  const time = G.hhmm(G.localMin(t));
  const tipo = a.modality === 'presencial' ? 'presencial' : 'online';
  const when = kind === '1d' ? `amanhã, ${d}/${m}/${y}, às ${time}` : `daqui a 1 hora, hoje às ${time}`;
  const place = a.modality === 'presencial' && pro.clinic_address ? ` Local: ${pro.clinic_name ? `${pro.clinic_name}, ` : ''}${pro.clinic_address}.` : '';
  const forPatient = kind === '1d'
    ? `você tem uma consulta ${tipo} com ${pro.name} ${when}.${place}`
    : `sua consulta ${tipo} com ${pro.name} é ${when}.${place}`;
  const forPro = kind === '1d'
    ? `você tem uma consulta ${tipo} com o(a) paciente ${pat.name} ${when}.`
    : `sua consulta ${tipo} com o(a) paciente ${pat.name} é ${when}.`;
  return { forPatient, forPro };
}

async function run(G) {
  const t = G.now();
  const site = require('./whatsapp').siteUrl();
  const rows = db.prepare("SELECT * FROM appointments WHERE status = 'confirmada' AND start_at > ? AND start_at <= ?").all(G.iso(t), G.iso(t + 24 * 60 * MIN));
  for (const a of rows) {
    const start = G.ms(a.start_at);
    const ref = G.ms(a.scheduled_at || a.paid_at || a.created_at);
    const left = start - t;
    let kind = null;
    if (left <= 60 * MIN) kind = start - ref > 60 * MIN ? '1h' : null;
    else if (start - ref >= 24 * 60 * MIN) kind = '1d';
    if (!kind) continue;
    const ins = db.prepare('INSERT OR IGNORE INTO reminder_log (appointment_id, kind, start_at, sent_at) VALUES (?, ?, ?, ?)').run(a.id, kind, a.start_at, G.iso(t));
    if (!ins.changes) continue; // já foi
    const pro = db.prepare('SELECT * FROM professionals WHERE id = ?').get(a.professional_id);
    const pat = db.prepare('SELECT * FROM patients WHERE id = ?').get(a.patient_id);
    if (!pro || !pat) continue;
    const { forPatient, forPro } = texts(G, a, kind, pro, pat);
    // No app (notificação no celular / computador)
    const title = kind === '1d' ? 'Lembrete: sua consulta é amanhã' : 'Lembrete: sua consulta é daqui a 1 hora';
    const push = require('./push');
    push.notify('patient', pat.id, { title, body: forPatient.charAt(0).toUpperCase() + forPatient.slice(1), url: `/app#chat/${a.conversation_id || ''}` });
    push.notify('professional', pro.id, { title, body: forPro.charAt(0).toUpperCase() + forPro.slice(1), url: '/painel#consultas' });
    // WhatsApp (não segura a varredura: manda e anota o resultado)
    const wa = require('./whatsapp');
    const [rp, rr] = await Promise.all([
      pat.phone ? wa.send(pat.phone, { name: firstName(pat.name), detail: forPatient, site }) : { ok: false, error: 'sem número' },
      pro.phone ? wa.send(pro.phone, { name: firstName(pro.name), detail: forPro, site }) : { ok: false, error: 'sem número' },
    ]);
    db.prepare('UPDATE reminder_log SET wa_patient = ?, wa_pro = ? WHERE appointment_id = ? AND kind = ? AND start_at = ?')
      .run(rp.ok ? 'ok' : rp.error, rr.ok ? 'ok' : rr.error, a.id, kind, a.start_at);
  }
}

// Para o admin: textos de exemplo (com os campos entre chaves)
const SAMPLES = {
  patient_1d: 'Olá, {nome}! Lembrete da Acolia: você tem uma consulta {online/presencial} com {profissional} amanhã, {data}, às {hora}.\nAcesse pelo link ou pelo app: {site}',
  patient_1h: 'Olá, {nome}! Lembrete da Acolia: sua consulta {online/presencial} com {profissional} é daqui a 1 hora, hoje às {hora}.\nAcesse pelo link ou pelo app: {site}',
  pro_1d: 'Olá, {nome}! Lembrete da Acolia: você tem uma consulta {online/presencial} com o(a) paciente {paciente} amanhã, {data}, às {hora}.\nAcesse pelo link ou pelo app: {site}',
  pro_1h: 'Olá, {nome}! Lembrete da Acolia: sua consulta {online/presencial} com o(a) paciente {paciente} é daqui a 1 hora, hoje às {hora}.\nAcesse pelo link ou pelo app: {site}',
};

module.exports = { run, texts, SAMPLES };
