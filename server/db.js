'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'acolia.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS professionals (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,              -- código único (login e sala de atendimento)
  name TEXT NOT NULL,
  profession TEXT NOT NULL,
  registry TEXT NOT NULL,                 -- CRP / CRM / registro profissional
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,                    -- WhatsApp
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente',-- pendente | aprovado | recusado | restrito | bloqueado
  bio TEXT NOT NULL DEFAULT '',
  specialties TEXT NOT NULL DEFAULT '',
  photo TEXT,
  price_cents INTEGER,
  packages TEXT NOT NULL DEFAULT '[]',    -- JSON [{sessions, price_cents}]
  state TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  city_norm TEXT NOT NULL DEFAULT '',
  has_clinic INTEGER NOT NULL DEFAULT 0,
  clinic_name TEXT NOT NULL DEFAULT '',
  clinic_address TEXT NOT NULL DEFAULT '',
  pix_key TEXT NOT NULL DEFAULT '',
  subscription_until TEXT,                -- data (AAAA-MM-DD) até quando a mensalidade está paga
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  cpf TEXT NOT NULL UNIQUE,               -- somente dígitos
  cpf_name_verified INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  city TEXT NOT NULL,
  city_norm TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',  -- nome exibido no chat (o nome do CPF não muda)
  photo TEXT,
  status TEXT NOT NULL DEFAULT 'ativo',   -- ativo | bloqueado
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS favorites (
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  professional_id INTEGER NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (patient_id, professional_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  professional_id INTEGER NOT NULL REFERENCES professionals(id),
  archived_by_patient INTEGER NOT NULL DEFAULT 0,
  archived_by_professional INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (patient_id, professional_id)
);

-- Mensagens nunca são apagadas: não existe rota de exclusão.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  sender_role TEXT NOT NULL,              -- patient | professional
  kind TEXT NOT NULL DEFAULT 'text',      -- text | pix | call
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  professional_id INTEGER NOT NULL REFERENCES professionals(id),
  patient_label TEXT NOT NULL,            -- nome real ou fictício do paciente
  patient_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ativo',   -- ativo | finalizado
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_active ON calls(status, patient_code);

-- Impede que as mensagens sejam apagadas ou alteradas, mesmo por engano no código.
CREATE TRIGGER IF NOT EXISTS messages_no_delete BEFORE DELETE ON messages
BEGIN SELECT RAISE(ABORT, 'mensagens não podem ser apagadas'); END;
CREATE TRIGGER IF NOT EXISTS messages_no_body_update BEFORE UPDATE OF body, sender_role, conversation_id ON messages
BEGIN SELECT RAISE(ABORT, 'mensagens não podem ser alteradas'); END;
`);

// Migrações simples (colunas novas em bancos já existentes)
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('professionals', 'document_file', 'TEXT');              // foto/PDF da carteirinha (pasta privada)
addColumn('professionals', 'legal_name', 'TEXT');                 // nome completo da carteirinha (não muda)
addColumn('professionals', 'registry_verified', 'INTEGER NOT NULL DEFAULT 0'); // conferido no conselho por API
fs.mkdirSync(path.join(DATA_DIR, 'documents'), { recursive: true });

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, tx, DATA_DIR };
