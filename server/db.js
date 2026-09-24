'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { DATA_DIR, DB_FILE } = require('./paths');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new DatabaseSync(DB_FILE);
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

-- Quem enviou pode apagar a própria mensagem: o conteúdo é apagado do banco e fica só "Mensagem apagada".
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

-- Mensagens podem ser apagadas de verdade (apagar para mim / para todos, limpar conversa,
-- bloquear, conta apagada). Só não podem ser EDITADAS:
DROP TRIGGER IF EXISTS messages_no_delete;
-- Mensagem não pode ser editada; a única mudança permitida é apagar o conteúdo (kind = 'deleted', body vazio)
DROP TRIGGER IF EXISTS messages_no_body_update;
CREATE TRIGGER IF NOT EXISTS messages_only_erase BEFORE UPDATE OF body, sender_role, conversation_id, kind ON messages
WHEN NOT (NEW.kind = 'deleted' AND NEW.body = '' AND NEW.sender_role = OLD.sender_role AND NEW.conversation_id = OLD.conversation_id)
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
addColumn('professionals', 'slug', 'TEXT');                        // link próprio: site.com/<slug>
addColumn('professionals', 'is_test', 'INTEGER NOT NULL DEFAULT 0');  // conta de teste (o admin pode apagar)
addColumn('professionals', 'session_minutes', 'INTEGER');          // duração de cada sessão
addColumn('professionals', 'instagram', "TEXT NOT NULL DEFAULT ''");  // @ do Instagram (sem o link)
addColumn('professionals', 'gallery', "TEXT NOT NULL DEFAULT '[]'");  // até 6 fotos: [url|null, ...] (posições 1 a 6)
addColumn('professionals', 'maps_url', "TEXT NOT NULL DEFAULT ''");   // link do Google Maps da clínica
addColumn('professionals', 'maps_query', "TEXT NOT NULL DEFAULT ''"); // o que o mini mapa mostra (coordenadas/local)
addColumn('patients', 'is_test', 'INTEGER NOT NULL DEFAULT 0');
addColumn('patients', 'birth_date', 'TEXT');
addColumn('professionals', 'accepts_insurance', 'INTEGER NOT NULL DEFAULT 0'); // aceita plano de saúde (online ou presencial) // data de nascimento (AAAA-MM-DD): não muda depois de informada
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_professionals_slug ON professionals(slug)');
fs.mkdirSync(path.join(DATA_DIR, 'documents'), { recursive: true });

// Quem ainda não tem link ganha um a partir do nome (não altera nenhum outro dado)
{
  const { uniqueSlug } = require('./slug');
  for (const p of db.prepare("SELECT id, name FROM professionals WHERE slug IS NULL AND status <> 'excluido'").all()) {
    db.prepare('UPDATE professionals SET slug = ? WHERE id = ?').run(uniqueSlug(db, p.name, p.id), p.id);
  }
}

// ---------- Versão 1.2: Início estilo Instagram (só acrescenta tabelas) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  professional_id INTEGER NOT NULL REFERENCES professionals(id),
  image TEXT NOT NULL,                     -- /uploads/...
  caption TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_pro ON posts(professional_id, id);
CREATE TABLE IF NOT EXISTS post_likes (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  role TEXT NOT NULL, user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (post_id, role, user_id)
);
CREATE TABLE IF NOT EXISTS post_comments (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  role TEXT NOT NULL, user_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON post_comments(post_id, id);
CREATE TABLE IF NOT EXISTS post_views (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  role TEXT NOT NULL, user_id INTEGER NOT NULL,
  PRIMARY KEY (post_id, role, user_id)
);
CREATE TABLE IF NOT EXISTS follows (
  follower_role TEXT NOT NULL, follower_id INTEGER NOT NULL,
  professional_id INTEGER NOT NULL REFERENCES professionals(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (follower_role, follower_id, professional_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_pro ON follows(professional_id);
CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY,
  professional_id INTEGER NOT NULL REFERENCES professionals(id),
  media TEXT NOT NULL,                     -- /uploads/...
  kind TEXT NOT NULL,                      -- image | video
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_stories_pro ON stories(professional_id, id);
CREATE TABLE IF NOT EXISTS story_likes (
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  role TEXT NOT NULL, user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (story_id, role, user_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  recipient_role TEXT NOT NULL, recipient_id INTEGER NOT NULL,
  type TEXT NOT NULL,                      -- follow | like_post | comment | like_story
  actor_role TEXT, actor_id INTEGER,
  post_id INTEGER, story_id INTEGER, comment_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_to ON notifications(recipient_role, recipient_id, id);
`);

addColumn('posts', 'thumb', 'TEXT'); // miniatura leve para a prévia do link (WhatsApp etc.)
addColumn('stories', 'post_id', 'INTEGER'); // story que mostra uma publicação do próprio profissional
// Reels: a publicação pode ser um vídeo (kind = 'reel'); posts.image guarda a capa do vídeo
addColumn('posts', 'kind', "TEXT NOT NULL DEFAULT 'photo'");
addColumn('posts', 'video', 'TEXT');
addColumn('posts', 'duration', 'REAL');
addColumn('posts', 'aspect', 'TEXT');
// Chat: "apagar para mim" — cada lado esconde a mensagem só para si; quando os dois apagaram,
// a mensagem sai do banco de vez
addColumn('messages', 'hidden_for_patient', 'INTEGER NOT NULL DEFAULT 0');
addColumn('messages', 'hidden_for_professional', 'INTEGER NOT NULL DEFAULT 0');
// Conversa já teve mensagem do paciente (o profissional passa a ver a conversa) — fica gravado
// mesmo se as mensagens forem apagadas depois
addColumn('calls', 'conversation_id', 'INTEGER'); // atendimento criado pela conversa (horário do último atendimento nos documentos)
addColumn('conversations', 'patient_wrote', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`UPDATE conversations SET patient_wrote = 1 WHERE patient_wrote = 0
  AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id AND m.sender_role = 'patient')`);
// Chat: bloquear alguém (só as mensagens: quem foi bloqueado não consegue mais mandar mensagem)
db.exec(`CREATE TABLE IF NOT EXISTS chat_blocks (
  conversation_id INTEGER NOT NULL,
  blocker_role TEXT NOT NULL,              -- patient | professional
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (conversation_id, blocker_role)
)`); // formato das fotos: 4:5 | 1:1 | 1.91:1 (publicações antigas: vazio)
// Envio de vídeo em pedaços (continua de onde parou se a internet cair ou o app for para o fundo)
db.exec(`CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  professional_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                      -- reel
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// Carrossel: até 10 fotos por publicação (a 1ª também fica em posts.image, como capa)
db.exec(`CREATE TABLE IF NOT EXISTS post_images (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  image TEXT NOT NULL,
  PRIMARY KEY (post_id, position)
)`);

// Uma vez só: as fotos da galeria antiga viram as primeiras publicações do profissional
{
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'gallery_to_posts_v1'").get()) {
    const pros = db.prepare("SELECT id, gallery, created_at FROM professionals WHERE gallery IS NOT NULL AND gallery <> '[]'").all();
    for (const p of pros) {
      let g = [];
      try { g = JSON.parse(p.gallery) || []; } catch { g = []; }
      const has = db.prepare('SELECT COUNT(*) n FROM posts WHERE professional_id = ?').get(p.id).n;
      if (has) continue;
      g.filter((u) => typeof u === 'string' && u.startsWith('/uploads/')).reverse().forEach((u, i) => {
        db.prepare('INSERT INTO posts (professional_id, image, caption, created_at) VALUES (?, ?, \'\', datetime(?, ?))')
          .run(p.id, u, p.created_at, `+${i} seconds`);
      });
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('gallery_to_posts_v1', ?)").run(new Date().toISOString());
  }
}

require('./cloud').attachDb(db);

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
