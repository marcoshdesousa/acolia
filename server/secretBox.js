'use strict';
// Guarda a chave de pagamento (Asaas) de cada profissional criptografada (AES-256-GCM).
// A senha da criptografia é a senha do administrador que já está no Render (ADMIN_PASSWORD);
// se um dia quiser uma senha separada, é só criar PAYMENT_SECRET. Sem nenhuma das duas (ex.: no
// computador), usa uma senha gerada e guardada na pasta de dados.
// Atenção: se ADMIN_PASSWORD (ou PAYMENT_SECRET) mudar no Render, as chaves guardadas deixam de
// abrir e cada profissional precisa conectar o Asaas de novo.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

let key = null;
function getKey() {
  if (key) return key;
  let secret = process.env.PAYMENT_SECRET || process.env.ADMIN_PASSWORD;
  if (!secret) {
    const { DATA_DIR } = require('./db');
    const file = path.join(DATA_DIR, '.payment-secret');
    try { secret = fs.readFileSync(file, 'utf8').trim(); } catch { /* ainda não existe */ }
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(file, secret, { mode: 0o600 });
    }
  }
  key = crypto.scryptSync(secret, 'acolia-pagamentos-v1', 32);
  return key;
}

function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

// Devolve null se não conseguir abrir (senha trocada ou dado corrompido)
function open(sealed) {
  try {
    const [v, iv, tag, enc] = String(sealed).split('.');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}

module.exports = { seal, open };
