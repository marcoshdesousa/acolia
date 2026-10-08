'use strict';
// Paciente que cria a conta pelo link do profissional (site.com/<link> ou profissional.html?id=):
// o profissional recebe um aviso nas mensagens e no aparelho ("Fulano criou uma conta pelo seu link")
// e pode mandar mensagem para ele, mesmo que o paciente ainda não tenha escrito.
// Cadastro feito pelo site sem link de profissional não avisa ninguém.
const { db } = require('./db');

try { db.exec('ALTER TABLE patients ADD COLUMN ref_professional_id INTEGER'); } catch { /* já existe */ }

// "/joao-silva", "/joao-silva?x#y" ou "/profissional.html?id=12" → profissional ativo (nunca o perfil oficial ou de clínica)
function resolve(path) {
  const s = String(path || '').trim();
  if (!s.startsWith('/') || s.startsWith('//')) return null;
  const [base, query = ''] = s.split('#')[0].split('?');
  let pro = null;
  if (/^\/profissional(\.html)?$/.test(base)) {
    const id = Number(new URLSearchParams(query).get('id'));
    if (id) pro = db.prepare('SELECT * FROM professionals WHERE id = ?').get(id);
  } else {
    const m = base.match(/^\/([a-zA-Z0-9-]{3,40})\/?$/);
    if (m) pro = db.prepare('SELECT * FROM professionals WHERE slug = ?').get(m[1].toLowerCase());
  }
  if (!pro || !['aprovado', 'restrito'].includes(pro.status) || pro.is_test) return null;
  return pro;
}

function notify(patientId, pro) {
  const pt = db.prepare('SELECT id, name, status FROM patients WHERE id = ?').get(patientId);
  if (!pt || pt.status !== 'ativo' || !pro) return null;
  db.prepare('UPDATE patients SET ref_professional_id = ? WHERE id = ?').run(pro.id, pt.id);
  // A conversa aparece para o profissional (como se ele tivesse aberto); para o paciente, só quando
  // chegar a primeira mensagem de verdade
  let c = db.prepare('SELECT * FROM conversations WHERE patient_id = ? AND professional_id = ?').get(pt.id, pro.id);
  if (!c) {
    const info = db.prepare('INSERT INTO conversations (patient_id, professional_id, pro_started) VALUES (?, ?, 1)').run(pt.id, pro.id);
    c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(info.lastInsertRowid));
  } else db.prepare('UPDATE conversations SET pro_started = 1, archived_by_professional = 0 WHERE id = ?').run(c.id);
  // Aviso só para o profissional (o paciente não vê)
  const text = `${pt.name} criou uma conta na Acolia pelo seu link.`;
  const info = db.prepare("INSERT INTO messages (conversation_id, sender_role, kind, body, hidden_for_patient) VALUES (?, 'patient', 'notice', ?, 1)").run(c.id, text);
  const msg = db.prepare('SELECT id, conversation_id, sender_role, kind, body, read_at, created_at FROM messages WHERE id = ?').get(Number(info.lastInsertRowid));
  require('./realtime').emit(`professional:${pro.id}`, 'message:new', msg);
  require('./push').notify('professional', pro.id, {
    title: 'Novo paciente pelo seu link', body: `${text} Você já pode mandar mensagem.`, url: `/painel#conversas/${c.id}`, tag: `conversa-${c.id}`,
  });
  return c.id;
}

module.exports = { resolve, notify };
