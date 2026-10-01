'use strict';
// Link próprio do profissional: seusite.com/<slug>
const fs = require('node:fs');
const path = require('node:path');
const U = require('./util');

// Endereços que já são páginas do site (ou podem vir a ser) não podem virar link de profissional
const RESERVED = new Set([
  'api', 'app', 'admin', 'painel', 'entrar', 'sair', 'login', 'cadastro', 'cadastro-paciente', 'cadastro-profissional',
  'atendimento', 'profissional', 'profissionais', 'paciente', 'pacientes', 'uploads', 'img', 'css', 'js', 'socket-io',
  'socket.io', 'sw', 'manifest', 'offline', 'index', 'p', 'acolia', 'ajuda', 'suporte', 'contato', 'termos', 'privacidade',
  'blog', 'sobre', 'www', 'static', 'assets', 'favicon', 'robots', 'sitemap', '404', 'clinica', 'clinicas', 'cadastro-clinica',
]);
try {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'public'))) RESERVED.add(f.replace(/\.[^.]+$/, '').toLowerCase());
} catch { /* ignora */ }

function slugify(text) {
  return U.norm(text).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

// Retorna o slug limpo ou lança HttpError explicando o problema
function validateSlug(raw) {
  const slug = slugify(raw);
  if (slug.length < 3) throw new U.HttpError(400, 'O link precisa ter pelo menos 3 letras ou números.');
  if (RESERVED.has(slug)) throw new U.HttpError(400, 'Este link é reservado pelo site. Escolha outro.');
  return slug;
}

// O link (site.com/<slug>) é um só para profissionais e clínicas: não pode repetir entre eles
function slugTaken(db, slug, { proId = 0, clinicId = 0 } = {}) {
  if (db.prepare('SELECT 1 FROM professionals WHERE slug = ? AND id <> ?').get(slug, proId)) return true;
  try { return !!db.prepare('SELECT 1 FROM clinics WHERE slug = ? AND id <> ?').get(slug, clinicId); } catch { return false; }
}

// Gera um slug livre a partir do nome (joao-pereira, joao-pereira-2, …)
function uniqueSlug(db, name, excludeId = 0, { clinic = false } = {}) {
  let base = slugify(name) || (clinic ? 'clinica' : 'profissional');
  if (base.length < 3 || RESERVED.has(base)) base = `${base}-${clinic ? 'clinica' : 'psi'}`.replace(/^-/, '');
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    if (!slugTaken(db, candidate, clinic ? { clinicId: excludeId } : { proId: excludeId })) return candidate;
  }
}

module.exports = { slugify, validateSlug, uniqueSlug, slugTaken, RESERVED };
