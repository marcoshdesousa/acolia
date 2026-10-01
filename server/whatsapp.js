'use strict';
// Envio de mensagens pelo WhatsApp da Acolia (lembretes de consulta).
// O número que envia é o que o administrador cadastra no painel (Conta → Lembretes pelo WhatsApp).
// Para mandar mensagem automática é preciso um serviço conectado a esse número:
//   - "meta": WhatsApp Cloud API oficial (Meta). Mensagem iniciada pela empresa só sai com um modelo
//     (template) aprovado pela Meta — o painel mostra o texto do modelo para cadastrar.
//   - "zapi": Z-API (o número é conectado lendo um QR Code, como no WhatsApp Web) — manda o texto direto.
// Trocar o número: basta conectar o número novo no serviço e atualizar no painel.
// As chaves ficam guardadas criptografadas (secretBox, com ADMIN_PASSWORD).
const { db } = require('./db');
const box = require('./secretBox');

const KEY = 'whatsapp_config';
const DEFAULT_SITE = process.env.SITE_URL || 'https://acolia.onrender.com';
const SECRET_FIELDS = ['zapi_token', 'zapi_client_token', 'meta_token'];

function rawConfig() {
  try { return JSON.parse(db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY)?.value || '{}'); } catch { return {}; }
}
// Para a tela do admin: as chaves nunca voltam (só se estão preenchidas)
function publicConfig() {
  const c = rawConfig();
  const out = { enabled: !!c.enabled, number: c.number || '', provider: c.provider || 'zapi', site: c.site || DEFAULT_SITE,
    zapi_instance: c.zapi_instance || '', meta_phone_id: c.meta_phone_id || '', meta_template: c.meta_template || 'lembrete_consulta', meta_lang: c.meta_lang || 'pt_BR' };
  for (const f of SECRET_FIELDS) out[`has_${f}`] = !!c[f];
  return out;
}
function saveConfig(b) {
  const c = rawConfig();
  const clean = (v, n = 200) => String(v ?? '').trim().slice(0, n);
  c.enabled = !!b.enabled;
  c.number = String(b.number || '').replace(/\D/g, '').slice(0, 15);
  c.provider = b.provider === 'meta' ? 'meta' : 'zapi';
  c.site = /^https?:\/\/\S+$/.test(clean(b.site)) ? clean(b.site) : DEFAULT_SITE;
  c.zapi_instance = clean(b.zapi_instance);
  c.meta_phone_id = clean(b.meta_phone_id);
  c.meta_template = clean(b.meta_template, 80) || 'lembrete_consulta';
  c.meta_lang = clean(b.meta_lang, 10) || 'pt_BR';
  // Chave em branco = mantém a que já estava
  for (const f of SECRET_FIELDS) if (clean(b[f])) c[f] = box.seal(clean(b[f], 500));
  if (c.enabled && c.number.length < 10) throw Object.assign(new Error('Informe o número de WhatsApp que envia os lembretes (com DDD).'), { status: 400 });
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(c));
  return publicConfig();
}
const siteUrl = () => rawConfig().site || DEFAULT_SITE;

// Número no formato internacional (Brasil): 55 + DDD + número
function toE164(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) return '55' + d;
  return d.length >= 12 ? d : '';
}

// Testes: guarda as mensagens em vez de mandar
const sent = [];

// parts = { name, detail, site } → texto: "Olá, {name}! Lembrete da Acolia: {detail}\nAcesse pelo link ou pelo app: {site}"
const textOf = (p) => `Olá, ${p.name}! Lembrete da Acolia: ${p.detail}\nAcesse pelo link ou pelo app: ${p.site}`;

async function send(phone, parts) {
  const to = toE164(phone);
  if (!to) return { ok: false, error: 'sem número' };
  if (process.env.WHATSAPP_FAKE === '1') { sent.push({ to, text: textOf(parts) }); return { ok: true }; }
  const c = rawConfig();
  if (!c.enabled) return { ok: false, error: 'desligado' };
  try {
    let r;
    if (c.provider === 'meta') {
      const token = box.open(c.meta_token);
      if (!token || !c.meta_phone_id) return { ok: false, error: 'configuração incompleta' };
      r = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(c.meta_phone_id)}/messages`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: {
          name: c.meta_template || 'lembrete_consulta', language: { code: c.meta_lang || 'pt_BR' },
          components: [{ type: 'body', parameters: [parts.name, parts.detail, parts.site].map((text) => ({ type: 'text', text })) }] } }),
        signal: AbortSignal.timeout(15000),
      });
    } else {
      const token = box.open(c.zapi_token);
      if (!token || !c.zapi_instance) return { ok: false, error: 'configuração incompleta' };
      const headers = { 'Content-Type': 'application/json' };
      const ct = box.open(c.zapi_client_token);
      if (ct) headers['Client-Token'] = ct;
      r = await fetch(`https://api.z-api.io/instances/${encodeURIComponent(c.zapi_instance)}/token/${encodeURIComponent(token)}/send-text`, {
        method: 'POST', headers, body: JSON.stringify({ phone: to, message: textOf(parts) }), signal: AbortSignal.timeout(15000),
      });
    }
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { publicConfig, saveConfig, send, textOf, siteUrl, toE164, sent };
