'use strict';
// Mensalidade da plataforma paga pelo Pix, na conta da Acolia (dono), pela SyncPay.
// (O dinheiro das CONSULTAS continua indo direto para o Asaas de cada profissional — nada muda nisso.)
//
// Como funciona:
//   1. O site gera um Pix na SyncPay (POST /api/partner/v1/cash-in) e mostra o QR Code e o "copia e cola".
//   2. Para saber se foi pago, o site PERGUNTA para a SyncPay (GET /api/partner/v2/transactions/{id}).
//      O aviso deles (webhook) só serve de "cutucada" para conferir na hora: o conteúdo do aviso nunca
//      é usado como prova de pagamento.
//   3. Pago: cadastro novo → conta liberada na hora com a senha de acesso único; renovação → +30 dias.
//
// Configuração (Render → Environment): SYNCPAY_CLIENT_ID e SYNCPAY_CLIENT_SECRET.
// Sem elas, o cadastro continua como antes (Finalizar cadastro no WhatsApp + aprovação no admin).
// SYNCPAY_FAKE=1: pagamento simulado (só para os testes automáticos; nunca em produção).
const crypto = require('node:crypto');
const { db } = require('./db');
const U = require('./util');

const BASE = (process.env.SYNCPAY_BASE_URL || 'https://api.syncpayments.com.br').replace(/\/+$/, '');
const fake = () => process.env.SYNCPAY_FAKE === '1';
const configured = () => fake() || (!!process.env.SYNCPAY_CLIENT_ID && !!process.env.SYNCPAY_CLIENT_SECRET);

// Valor de cada plano (em centavos) e quantos dias cada pagamento libera
const PRICES = { 'mensal-30': 3000, 'clinica-4990': 4990 };
const DAYS = 30;

db.exec(`CREATE TABLE IF NOT EXISTS platform_payments (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL,                  -- professional | clinic
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                  -- cadastro | renovacao
  plan TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  identifier TEXT UNIQUE,              -- id da cobrança na SyncPay
  pix_code TEXT,
  token_hash TEXT,                     -- cadastro: só quem fez o cadastro acompanha o pagamento (sem login ainda)
  status TEXT NOT NULL DEFAULT 'pendente', -- pendente | pago | reembolsado | cancelado
  reveal TEXT,                         -- cadastro pago: senha de acesso único (criptografada) mostrada UMA vez
  checked_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_pp_user ON platform_payments(role, user_id, id)');
try { db.exec('ALTER TABLE professionals ADD COLUMN review_pending INTEGER NOT NULL DEFAULT 0'); } catch { /* já existe */ }

// ---------- SyncPay ----------
let tok = null; // { value, until } — o token vale 1 hora: só pede outro quando vencer
async function token() {
  if (tok && tok.until > Date.now() + 60e3) return tok.value;
  const r = await fetch(`${BASE}/api/partner/v1/auth-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: process.env.SYNCPAY_CLIENT_ID, client_secret: process.env.SYNCPAY_CLIENT_SECRET }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new U.HttpError(502, 'Não foi possível gerar o Pix agora. Tente de novo em alguns minutos.');
  tok = { value: d.access_token, until: Date.parse(d.expires_at) || Date.now() + (Number(d.expires_in) || 3600) * 1000 };
  return tok.value;
}
async function call(method, path, body) {
  const t = await token();
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) tok = null; // token recusado: na próxima pede outro
  const d = await r.json().catch(() => ({}));
  return { status: r.status, data: d };
}

// Simulado (testes): guarda as cobranças na memória
const FAKE = new Map();
function fakeCreate() {
  const identifier = crypto.randomUUID();
  FAKE.set(identifier, { status: 'pending' });
  return { identifier, pix_code: `00020126FAKEPIX${identifier.replace(/-/g, '').slice(0, 20)}` };
}

async function providerCreate({ amountCents, description, payer, webhookUrl }) {
  if (fake()) return fakeCreate();
  const phone = U.onlyDigits(payer.phone).replace(/^55(?=\d{10,11}$)/, '');
  const body = {
    amount: Math.round(amountCents) / 100,
    description,
    client: { name: payer.name, cpf: U.onlyDigits(payer.cpf), email: payer.email, phone },
  };
  if (webhookUrl) body.webhook_url = webhookUrl;
  const r = await call('POST', '/api/partner/v1/cash-in', body);
  if (r.status >= 300 || !r.data.pix_code || !r.data.identifier) {
    console.warn('[syncpay] cash-in recusado', r.status, r.data?.message);
    throw new U.HttpError(502, 'Não foi possível gerar o Pix agora. Tente de novo em alguns minutos.');
  }
  return { identifier: String(r.data.identifier), pix_code: String(r.data.pix_code) };
}
// Situação da cobrança na SyncPay → pago | reembolsado | pendente | recusado
async function providerStatus(identifier) {
  if (fake()) return FAKE.get(identifier)?.status === 'completed' ? 'pago' : FAKE.get(identifier)?.status === 'refunded' ? 'reembolsado' : 'pendente';
  const r = await call('GET', `/api/partner/v2/transactions/${encodeURIComponent(identifier)}`);
  if (r.status !== 200) return 'pendente';
  const t = r.data?.data?.transaction || {};
  const s = String(t.status || '').toLowerCase();
  if (t.refunded_at || s === 'refunded') return 'reembolsado';
  if (t.paid_at || ['completed', 'paid', 'approved'].includes(s)) return 'pago';
  if (['refused', 'canceled', 'cancelled', 'expired', 'failed'].includes(s)) return 'recusado';
  return 'pendente';
}

// ---------- Cobranças ----------
const siteUrl = () => (process.env.SITE_URL || 'https://acolia.onrender.com').replace(/\/+$/, '');
const QR = (code) => require('qrcode').toDataURL(code, { margin: 1, width: 360 });

async function create({ role, userId, kind, plan, payer, withToken = false }) {
  if (!configured()) throw new U.HttpError(503, 'O pagamento pelo Pix ainda não está disponível.');
  const amountCents = PRICES[plan];
  if (!amountCents) throw new U.HttpError(400, 'Plano inválido.');
  // Já tem um Pix esperando (de menos de 12 h)? Reaproveita, em vez de gerar outro
  const open = db.prepare("SELECT * FROM platform_payments WHERE role = ? AND user_id = ? AND kind = ? AND status = 'pendente' AND created_at >= datetime('now', '-12 hours') ORDER BY id DESC LIMIT 1").get(role, userId, kind);
  let p = open;
  let secret = null;
  if (!p) {
    const description = `Acolia - ${kind === 'cadastro' ? 'Cadastro' : 'Mensalidade'} ${role === 'clinic' ? 'da clínica' : 'do profissional'} (${DAYS} dias)`;
    const c = await providerCreate({ amountCents, description, payer, webhookUrl: fake() ? null : `${siteUrl()}/api/plataforma/pagamento/webhook` });
    const info = db.prepare('INSERT INTO platform_payments (role, user_id, kind, plan, amount_cents, identifier, pix_code) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(role, userId, kind, plan, amountCents, c.identifier, c.pix_code);
    p = db.prepare('SELECT * FROM platform_payments WHERE id = ?').get(Number(info.lastInsertRowid));
  }
  if (withToken) {
    secret = crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE platform_payments SET token_hash = ? WHERE id = ?').run(U.hashPassword(secret), p.id);
  }
  return { ...(await out(p)), token: secret || undefined };
}
async function out(p) {
  return { id: p.id, status: p.status, kind: p.kind, amount_cents: p.amount_cents, pix_code: p.pix_code, qr: p.pix_code ? await QR(p.pix_code) : null, days: DAYS };
}

// Pago: libera. Cadastro → conta aprovada na hora (aparece na vitrine) + senha de acesso único; renovação → +30 dias
function apply(p) {
  const today = U.todayISO();
  const table = p.role === 'clinic' ? 'clinics' : 'professionals';
  const u = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(p.user_id);
  if (!u) return;
  const from = u.subscription_until && u.subscription_until > today ? u.subscription_until : today;
  const until = U.addDaysISO(from, DAYS);
  if (p.kind === 'cadastro' && u.status === 'pendente') {
    const password = U.randomPassword();
    const extra = table === 'professionals' ? ', review_pending = 1' : '';
    db.prepare(`UPDATE ${table} SET status = 'aprovado', subscription_until = ?, password_hash = ?, must_change_password = 1${extra} WHERE id = ?`)
      .run(until, U.hashPassword(password), u.id);
    db.prepare('UPDATE platform_payments SET reveal = ? WHERE id = ?').run(require('./secretBox').seal(password), p.id);
  } else {
    db.prepare(`UPDATE ${table} SET subscription_until = ? WHERE id = ?`).run(until, u.id);
  }
}

// Confere na SyncPay (no máximo a cada 5 s por cobrança) e, se foi pago, libera (uma vez só)
async function check(p, { force = false } = {}) {
  if (!p || p.status !== 'pendente') return p;
  if (!force && p.checked_at && Date.now() - p.checked_at < 5000) return p;
  db.prepare('UPDATE platform_payments SET checked_at = ? WHERE id = ?').run(Date.now(), p.id);
  let st;
  try { st = await providerStatus(p.identifier); } catch (e) { console.warn('[syncpay] consulta falhou:', e.message); return p; }
  if (st === 'pago') {
    const changed = db.prepare("UPDATE platform_payments SET status = 'pago', paid_at = datetime('now') WHERE id = ? AND status = 'pendente'").run(p.id).changes;
    if (changed) apply(p);
  } else if (st === 'reembolsado' || st === 'recusado') {
    db.prepare("UPDATE platform_payments SET status = ? WHERE id = ? AND status = 'pendente'").run(st === 'reembolsado' ? 'reembolsado' : 'cancelado', p.id);
  }
  return db.prepare('SELECT * FROM platform_payments WHERE id = ?').get(p.id);
}
// Varredura (a cada 2 min): Pix esperando há menos de 2 dias
async function sweep() {
  if (!configured()) return;
  for (const p of db.prepare("SELECT * FROM platform_payments WHERE status = 'pendente' AND created_at >= datetime('now', '-2 days')").all()) await check(p);
}
// Aviso da SyncPay: só serve para conferir na hora as cobranças que ele cita (pelo identificador)
async function onWebhook(body) {
  const ids = new Set();
  const walk = (v, depth = 0) => {
    if (depth > 5 || v == null) return;
    if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) ids.add(v.toLowerCase());
    else if (typeof v === 'object') Object.values(v).slice(0, 50).forEach((x) => walk(x, depth + 1));
  };
  walk(body);
  for (const id of [...ids].slice(0, 10)) {
    const p = db.prepare('SELECT * FROM platform_payments WHERE lower(identifier) = ?').get(id);
    if (p) await check(p, { force: true });
  }
}

// ---------- Teste pelo admin (botão "Testar SyncPay") ----------
// 1) confere as chaves pedindo um token; 2) gera um Pix de R$ 1,00 com os dados do dono, para pagar e ver chegar.
// Nada disso mexe em contas: o Pix de teste não fica na tabela de mensalidades.
async function testKeys() {
  if (fake()) return { ok: true, fake: true };
  if (!configured()) return { ok: false, message: 'As chaves SYNCPAY_CLIENT_ID e SYNCPAY_CLIENT_SECRET não estão no Render (Environment).' };
  tok = null;
  let r;
  try {
    r = await fetch(`${BASE}/api/partner/v1/auth-token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: process.env.SYNCPAY_CLIENT_ID, client_secret: process.env.SYNCPAY_CLIENT_SECRET }),
    });
  } catch (e) { return { ok: false, message: `Não deu para falar com a SyncPay (${e.message}).` }; }
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) return { ok: false, message: `A SyncPay recusou as chaves (erro ${r.status}${d.message ? `: ${d.message}` : ''}). Confira o Client ID e o Client Secret no Render.` };
  tok = { value: d.access_token, until: Date.parse(d.expires_at) || Date.now() + 3600e3 };
  return { ok: true };
}
async function testCharge(payer) {
  if (fake()) { const c = fakeCreate(); return { ok: true, identifier: c.identifier, pix_code: c.pix_code, qr: await QR(c.pix_code) }; }
  const keys = await testKeys();
  if (!keys.ok) return keys;
  const phone = U.onlyDigits(payer.phone).replace(/^55(?=\d{10,11}$)/, '');
  const r = await call('POST', '/api/partner/v1/cash-in', {
    amount: 1, description: 'Acolia - teste da integração',
    client: { name: payer.name, cpf: U.onlyDigits(payer.cpf), email: payer.email, phone },
  });
  if (r.status >= 300 || !r.data.pix_code) {
    const msg = r.data?.message || (r.data?.errors ? JSON.stringify(r.data.errors) : '');
    return { ok: false, message: `As chaves estão certas, mas a SyncPay não gerou o Pix (erro ${r.status}${msg ? `: ${msg}` : ''}).${r.status === 403 ? ' Pode ser o IP: autorize os IPs do Render no painel da SyncPay.' : ''}${r.status === 422 ? ' Pode ser a conta da SyncPay ainda não aprovada, ou algum dado do pagador.' : ''}` };
  }
  return { ok: true, identifier: String(r.data.identifier), pix_code: String(r.data.pix_code), qr: await QR(String(r.data.pix_code)) };
}
const testStatus = (identifier) => providerStatus(String(identifier));

const _fakePay = (identifier, status = 'completed') => { if (FAKE.has(identifier)) FAKE.get(identifier).status = status; };

module.exports = { configured, PRICES, DAYS, create, out, check, sweep, onWebhook, testKeys, testCharge, testStatus, _fakePay };
