'use strict';
// Pacote mensal (qualquer profissional, de qualquer portal, se ele quiser).
// O profissional cria os pacotes: quantas sessões por semana (1 a 7) e o valor do mês. O paciente compra
// (Pix automático pelo Asaas do profissional ou Pix manual pela chave dele, com o profissional confirmando
// que recebeu) e, enquanto o pacote vale (um mês), marca as sessões sem pagar cada uma, até o limite da
// semana (segunda a domingo). Sessão cancelada a tempo volta para o pacote. O dinheiro vai direto para o
// profissional, como nas consultas.
const { db } = require('./db');
const U = require('./util');
const G = require('./agenda');

const MIN = 60e3;
const money = (c) => `R$ ${(c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const PAY_AUTO_MIN = 30;          // Pix automático: 30 minutos para pagar
const PAY_MANUAL_HOURS = 72;      // Pix manual: o profissional tem até 3 dias para confirmar que recebeu
const USED = ['confirmada', 'concluida', 'paciente_ausente', 'aguardando_paciente']; // contam como sessão usada

db.exec(`CREATE TABLE IF NOT EXISTS pro_packages (
  id INTEGER PRIMARY KEY,
  professional_id INTEGER NOT NULL,
  per_week INTEGER NOT NULL,        -- sessões por semana
  price_cents INTEGER NOT NULL,     -- valor do mês
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_pro_packages_pro ON pro_packages(professional_id)');
db.exec(`CREATE TABLE IF NOT EXISTS patient_packages (
  id INTEGER PRIMARY KEY,
  package_id INTEGER NOT NULL,
  professional_id INTEGER NOT NULL,
  patient_id INTEGER NOT NULL,
  conversation_id INTEGER,
  per_week INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  mode TEXT NOT NULL,               -- auto (Asaas) | manual (chave Pix do profissional)
  status TEXT NOT NULL,             -- aguardando_pagamento | ativo | cancelado | expirado
  pay_id TEXT,
  pix_payload TEXT,
  pix_image TEXT,
  hold_until TEXT,
  starts_on TEXT,                   -- AAAA-MM-DD (horário de Brasília)
  ends_on TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_patient_packages ON patient_packages(patient_id, professional_id)');
try { db.exec('ALTER TABLE appointments ADD COLUMN package_id INTEGER'); } catch { /* já existe */ }

const allowed = (pro) => !!pro; // todos podem; só aparece para o paciente quem criou algum pacote
const label = (n) => `${n} ${n === 1 ? 'vez' : 'vezes'} por semana`;
const brDate = (d) => (d ? d.split('-').reverse().join('/') : '');
const addMonthDay = (date) => { // mesmo dia do mês seguinte, menos 1 (01/03 → 31/03; 15/03 → 14/04)
  const [y, m, d] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return G.addDays(new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10), -1);
};
// Segunda-feira da semana de uma data
const monday = (date) => G.addDays(date, -((G.dowOf(date) + 6) % 7));

function offers(proId) {
  return db.prepare('SELECT id, per_week, price_cents FROM pro_packages WHERE professional_id = ? AND active = 1 ORDER BY per_week, price_cents').all(proId)
    .map((p) => ({ ...p, label: label(p.per_week) }));
}
const get = (id) => db.prepare('SELECT * FROM patient_packages WHERE id = ?').get(Number(id));

// Sessões do pacote já usadas na semana de uma data (sem contar uma consulta, ao remarcar)
function usedInWeek(pp, date, exclude = 0) {
  const mon = monday(date);
  const from = G.iso(G.fromLocal(mon, 0));
  const to = G.iso(G.fromLocal(G.addDays(mon, 7), 0));
  return db.prepare(`SELECT COUNT(*) AS n FROM appointments WHERE package_id = ? AND id <> ? AND start_at >= ? AND start_at < ?
    AND status IN (${USED.map(() => '?').join(', ')})`).get(pp.id, exclude, from, to, ...USED).n;
}

// Pacote do paciente com este profissional que vale numa data (ou hoje)
function activeFor(patientId, proId, date = G.localDate(G.now())) {
  return db.prepare(`SELECT * FROM patient_packages WHERE patient_id = ? AND professional_id = ? AND status = 'ativo'
    AND starts_on <= ? AND ends_on >= ? ORDER BY ends_on DESC LIMIT 1`).get(patientId, proId, date, date) || null;
}
// Pacotes ainda valendo (hoje ou começando depois): o paciente usa nas datas de cada um
function current(patientId, proId) {
  return db.prepare(`SELECT * FROM patient_packages WHERE patient_id = ? AND professional_id = ? AND status = 'ativo' AND ends_on >= ? ORDER BY starts_on`)
    .all(patientId, proId, G.localDate(G.now()));
}

function view(pp, role = 'patient') {
  const today = G.localDate(G.now());
  const pat = db.prepare('SELECT id, name, photo FROM patients WHERE id = ?').get(pp.patient_id);
  const pro = db.prepare('SELECT id, name, photo, profession, pix_key FROM professionals WHERE id = ?').get(pp.professional_id);
  return {
    id: pp.id, status: pp.status, mode: pp.mode, per_week: pp.per_week, label: label(pp.per_week), price_cents: pp.price_cents,
    starts_on: pp.starts_on, ends_on: pp.ends_on, period: pp.starts_on ? `${brDate(pp.starts_on)} a ${brDate(pp.ends_on)}` : '',
    used_this_week: pp.status === 'ativo' && pp.starts_on <= today && pp.ends_on >= today ? usedInWeek(pp, today) : 0,
    hold_until: pp.hold_until, conversation_id: pp.conversation_id,
    pix_payload: pp.status === 'aguardando_pagamento' ? (pp.mode === 'manual' ? pro.pix_key : pp.pix_payload) : null,
    pix_image: role === 'patient' && pp.status === 'aguardando_pagamento' && pp.mode === 'auto' ? pp.pix_image : null,
    patient: { id: pat.id, name: pat.name, photo: pat.photo },
    professional: { id: pro.id, name: pro.name, photo: pro.photo, profession: pro.profession },
  };
}

// Comprar (paciente)
async function buy(patient, offerId) {
  const offer = db.prepare('SELECT * FROM pro_packages WHERE id = ? AND active = 1').get(Number(offerId));
  if (!offer) throw new U.HttpError(404, 'Este pacote não está mais disponível.');
  const pro = G.getPro(offer.professional_id);
  if (!allowed(pro)) throw new U.HttpError(400, 'Este profissional não oferece pacotes.');
  if (pro.accepts_messages === 0) throw new U.HttpError(409, 'Este profissional não está fazendo agendamentos no momento.');
  if (!!pro.is_test !== !!patient.is_test) throw new U.HttpError(403, 'Conta de teste: os pacotes de teste são só entre o Profissional Teste e o Paciente Teste.');
  const t = G.now();
  if (db.prepare("SELECT 1 FROM patient_packages WHERE patient_id = ? AND professional_id = ? AND status = 'aguardando_pagamento' AND hold_until > ?").get(patient.id, pro.id, G.iso(t))) {
    throw new U.HttpError(409, 'Você já tem um pacote esperando o pagamento com este profissional.');
  }
  // Já tem pacote valendo: o novo só pode ser comprado nos últimos 7 dias (começa quando o atual acabar)
  const cur = current(patient.id, pro.id).pop();
  if (cur && cur.ends_on > G.addDays(G.localDate(t), 7)) throw new U.HttpError(409, `Você já tem um pacote valendo até ${brDate(cur.ends_on)}. A renovação abre 7 dias antes de ele acabar.`);
  const pay = G.autoPayment(pro.id);
  const manualKey = String(pro.pix_key || '').trim();
  if (!pay && !manualKey) throw new U.HttpError(409, 'Este profissional ainda não configurou a forma de receber.');
  const c = G.ensureConversation(patient.id, pro.id);
  const mode = pay ? 'auto' : 'manual';
  const info = db.prepare(`INSERT INTO patient_packages (package_id, professional_id, patient_id, conversation_id, per_week, price_cents, mode, status, hold_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'aguardando_pagamento', ?)`).run(offer.id, pro.id, patient.id, c.id, offer.per_week, offer.price_cents, mode,
    G.iso(t + (pay ? PAY_AUTO_MIN * MIN : PAY_MANUAL_HOURS * 60 * MIN)));
  let pp = get(Number(info.lastInsertRowid));
  if (pay) {
    try {
      const asaas = require('./asaas');
      let cust = db.prepare('SELECT customer_id FROM asaas_customers WHERE professional_id = ? AND patient_id = ?').get(pro.id, patient.id)?.customer_id;
      if (!cust) {
        cust = await asaas.ensureCustomer(pay.env, pay.key, db.prepare('SELECT id, name, cpf FROM patients WHERE id = ?').get(patient.id));
        db.prepare('INSERT OR REPLACE INTO asaas_customers (professional_id, patient_id, customer_id) VALUES (?, ?, ?)').run(pro.id, patient.id, cust);
      }
      const pix = await asaas.createPix(pay.env, pay.key, { customer: cust, cents: offer.price_cents, description: `Pacote mensal (${label(offer.per_week)}) com ${pro.name} (Acolia)`, ref: `acolia-pacote-${pp.id}` });
      db.prepare('UPDATE patient_packages SET pay_id = ?, pix_payload = ?, pix_image = ? WHERE id = ?').run(pix.id, pix.payload, pix.image, pp.id);
    } catch (e) {
      db.prepare("UPDATE patient_packages SET status = 'cancelado' WHERE id = ?").run(pp.id);
      throw e;
    }
  }
  pp = get(pp.id);
  // Aviso na conversa (o profissional fica sabendo; no manual, ele confirma quando o Pix cair)
  require('./routes/chat').sendMessage(c, 'patient', patient.name, 'text',
    `Comprei o pacote mensal: ${label(offer.per_week)}, ${money(offer.price_cents)} por mês.${mode === 'manual' ? ' Vou pagar pelo Pix da sua chave.' : ''}`);
  return pp;
}

// Pago (Asaas confirmou ou o profissional confirmou que recebeu): o pacote começa hoje ou, se já houver um
// valendo, no dia seguinte ao fim dele
function activate(pp) {
  if (pp.status !== 'aguardando_pagamento') return pp;
  const today = G.localDate(G.now());
  const cur = current(pp.patient_id, pp.professional_id).pop();
  const start = cur && cur.ends_on >= today ? G.addDays(cur.ends_on, 1) : today;
  db.prepare("UPDATE patient_packages SET status = 'ativo', paid_at = ?, starts_on = ?, ends_on = ?, hold_until = NULL WHERE id = ? AND status = 'aguardando_pagamento'")
    .run(G.iso(G.now()), start, addMonthDay(start), pp.id);
  const upd = get(pp.id);
  const c = upd.conversation_id && db.prepare('SELECT * FROM conversations WHERE id = ?').get(upd.conversation_id);
  const pro = G.getPro(upd.professional_id);
  if (c) require('./routes/chat').sendMessage(c, 'professional', pro.name, 'text', `Pacote confirmado: ${label(upd.per_week)}, de ${brDate(upd.starts_on)} a ${brDate(upd.ends_on)}. Agora é só marcar as sessões pela agenda, sem pagar cada uma.`);
  G.touch();
  return upd;
}

async function check(pp) {
  if (pp.status !== 'aguardando_pagamento' || pp.mode !== 'auto' || !pp.pay_id) return pp;
  const pay = G.autoPayment(pp.professional_id);
  if (!pay) return pp;
  try {
    const st = await require('./asaas').status(pay.env, pay.key, pp.pay_id);
    if (st.paid) return activate(pp);
  } catch (e) { console.error('[pacote] consulta de pagamento', pp.id, e.message); }
  return get(pp.id);
}

// Prazo de pagamento vencido: cancela (roda na varredura da agenda)
async function sweep() {
  for (const pp of db.prepare("SELECT * FROM patient_packages WHERE status = 'aguardando_pagamento' AND hold_until <= ?").all(G.iso(G.now()))) {
    const cur = await check(pp);
    if (cur.status !== 'aguardando_pagamento') continue;
    db.prepare("UPDATE patient_packages SET status = 'expirado' WHERE id = ? AND status = 'aguardando_pagamento'").run(pp.id);
  }
}

// Marcar com o pacote: o pacote precisa valer no dia e ter sessão livre naquela semana
function assertUsable(patientId, pro, startMs, exclude = 0) {
  const date = G.localDate(startMs);
  const pp = activeFor(patientId, pro.id, date);
  if (!pp) {
    const any = current(patientId, pro.id)[0];
    throw new U.HttpError(409, any ? `O seu pacote vale de ${brDate(any.starts_on)} a ${brDate(any.ends_on)}. Escolha um dia dentro desse período.` : 'Você não tem pacote valendo com este profissional.');
  }
  if (usedInWeek(pp, date, exclude) >= pp.per_week) {
    throw new U.HttpError(409, `O seu pacote é de ${label(pp.per_week)} e você já marcou ${pp.per_week === 1 ? 'a sessão' : `as ${pp.per_week} sessões`} desta semana. Escolha um dia de outra semana.`);
  }
  return pp;
}

// Para o calendário do paciente: os pacotes valendo e quantas sessões já usou em cada semana
function forCalendar(patientId, proId) {
  return current(patientId, proId).map((pp) => {
    const weeks = {};
    for (const a of db.prepare(`SELECT start_at FROM appointments WHERE package_id = ? AND status IN (${USED.map(() => '?').join(', ')})`).all(pp.id, ...USED)) {
      const w = monday(G.localDate(G.ms(a.start_at)));
      weeks[w] = (weeks[w] || 0) + 1;
    }
    return { id: pp.id, per_week: pp.per_week, label: label(pp.per_week), starts_on: pp.starts_on, ends_on: pp.ends_on, weeks };
  });
}

module.exports = { allowed, offers, get, view, buy, activate, check, sweep, assertUsable, forCalendar, current, label, monday, brDate, USED };
