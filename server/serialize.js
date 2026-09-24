'use strict';
const { todayISO, addDaysISO } = require('./util');
const maps = require('./maps');

// Mapa da clínica (só para quem tem conta): usa o link do Google Maps ou, sem link, o endereço
function clinicMap(p) {
  if (!p.has_clinic) return { maps_url: '', map_embed: '' };
  const address = [p.clinic_address, p.city && `${p.city} - ${p.state}`].filter(Boolean).join(', ');
  const query = p.maps_query || maps.mapQuery(p.maps_url, p.clinic_address ? address : '');
  return { maps_url: p.maps_url || (query ? maps.searchUrl(query) : ''), map_embed: maps.embedUrl(query) };
}

// Profissional aparece na vitrine se estiver aprovado e com a mensalidade em dia.
// A assinatura vale até o dia do vencimento e mais 1 dia (no outro dia a conta é bloqueada).
const VISIBLE_SQL = "p.status = 'aprovado' AND p.subscription_until IS NOT NULL AND p.subscription_until >= date('now', '-1 day')";

function isVisible(p) {
  return p.status === 'aprovado' && !!p.subscription_until && p.subscription_until >= addDaysISO(todayISO(), -1);
}

function parsePackages(json) {
  try {
    const arr = JSON.parse(json || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

const GALLERY_SLOTS = 6;
const PROFILE_POSTS = 4; // publicações que aparecem no perfil

// Galeria: 6 posições fixas (Foto 1 a Foto 6); posição vazia = null
function parseGallery(json) {
  let arr;
  try { arr = JSON.parse(json || '[]'); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  return Array.from({ length: GALLERY_SLOTS }, (_, i) => (typeof arr[i] === 'string' && arr[i].startsWith('/uploads/') ? arr[i] : null));
}

// Visitante sem conta tem um acesso básico: vê nome, registro, especialidades, localização,
// Instagram, se há pacotes e até 2 fotos da galeria (sem ampliar). Valores, duração da sessão, o
// "Sobre", o endereço da clínica e o resto da galeria ficam para quem cria a conta grátis.
// Fotos abertas para o visitante: 1 foto → 0, 2 ou 3 fotos → 1, 4 ou mais → 2
function freeGalleryCount(n) {
  if (n <= 1) return 0;
  if (n <= 3) return 1;
  return 2;
}

function publicProfessional(p, { loggedIn = false, favorite = false } = {}) {
  const base = {
    id: p.id,
    slug: p.slug,
    name: p.name,
    profession: p.profession,
    registry: p.registry,
    bio: p.bio,
    specialties: p.specialties,
    photo: p.photo,
  };
  // No perfil aparecem só as 4 publicações mais recentes; "Ver todas" abre a página de publicações
  const { db } = require('./db');
  // Fotos e vídeos (Reels) ficam separados no perfil: 4 de cada, cada um na sua aba
  const recent = db.prepare(`SELECT id, image, thumb FROM posts WHERE professional_id = ? AND kind = 'photo' ORDER BY id DESC LIMIT ${PROFILE_POSTS}`).all(p.id);
  const recentReels = db.prepare(`SELECT id, image, thumb FROM posts WHERE professional_id = ? AND kind = 'reel' ORDER BY id DESC LIMIT ${PROFILE_POSTS}`).all(p.id);
  const postsCount = db.prepare('SELECT COUNT(*) n FROM posts WHERE professional_id = ?').get(p.id).n;
  const photosCount = db.prepare("SELECT COUNT(*) n FROM posts WHERE professional_id = ? AND kind = 'photo'").get(p.id).n;
  const reelsCount = postsCount - photosCount;
  const gallery = recent.map((r) => r.thumb || r.image); // miniatura leve (600 px) quando existe
  const social = {
    posts_count: postsCount,
    photos_count: photosCount,
    reels_count: reelsCount,
    // +1 nos dois: a Acolia Brasil segue todo profissional e todo profissional segue a Acolia Brasil
    followers_count: db.prepare('SELECT COUNT(*) n FROM follows WHERE professional_id = ?').get(p.id).n + 1,
    following_count: db.prepare("SELECT COUNT(*) n FROM follows WHERE follower_role = 'professional' AND follower_id = ?").get(p.id).n + 1,
  };
  const common = {
    state: p.state,
    city: p.city,
    has_clinic: !!p.has_clinic,
    accepts_insurance: !!p.accepts_insurance,
    instagram: p.instagram || '',
  };
  if (!loggedIn) {
    const packages = parsePackages(p.packages);
    const { bio, ...rest } = base;
    const free = freeGalleryCount(gallery.length);
    return {
      ...rest,
      ...common,
      ...social,
      locked: true,
      has_bio: !!bio,
      has_price: p.price_cents != null,
      package_sessions: packages.map((k) => k.sessions),
      has_session_minutes: !!p.session_minutes,
      gallery: gallery.slice(0, free),
      gallery_hidden: photosCount - free,
      reels: recentReels.slice(0, freeGalleryCount(recentReels.length)).map((r) => r.image),
      reels_hidden: reelsCount - freeGalleryCount(recentReels.length),
    };
  }
  return {
    ...base,
    locked: false,
    favorite: !!favorite,
    ...common,
    ...social,
    session_minutes: p.session_minutes || null,
    price_cents: p.price_cents,
    packages: parsePackages(p.packages),
    clinic_name: p.has_clinic ? p.clinic_name : '',
    clinic_address: p.has_clinic ? p.clinic_address : '',
    ...clinicMap(p),
    gallery,
    gallery_posts: recent.map((r) => ({ ...r, count: Math.max(1, db.prepare('SELECT COUNT(*) n FROM post_images WHERE post_id = ?').get(r.id).n) })),
    reels_posts: recentReels.map((r) => ({ ...r, kind: 'reel', count: 1 })),
    gallery_hidden: 0,
  };
}

function ownProfessional(p) {
  return {
    id: p.id,
    slug: p.slug,
    code: p.code,
    name: p.name,
    profession: p.profession,
    registry: p.registry,
    email: p.email,
    phone: p.phone,
    status: p.status,
    bio: p.bio,
    specialties: p.specialties,
    photo: p.photo,
    price_cents: p.price_cents,
    packages: parsePackages(p.packages),
    state: p.state,
    city: p.city,
    has_clinic: !!p.has_clinic,
    accepts_insurance: !!p.accepts_insurance,
    clinic_name: p.clinic_name,
    clinic_address: p.clinic_address,
    maps_url: p.maps_url || '',
    map_embed: clinicMap(p).map_embed,
    pix_key: p.pix_key,
    session_minutes: p.session_minutes || null,
    instagram: p.instagram || '',
    gallery: parseGallery(p.gallery),
    subscription_until: p.subscription_until,
    visible: isVisible(p),
    created_at: p.created_at,
  };
}

function ownPatient(p) {
  return {
    id: p.id,
    name: p.name,
    display_name: p.display_name || '',
    cpf_masked: `***.${p.cpf.slice(3, 6)}.${p.cpf.slice(6, 9)}-**`,
    birth_date: p.birth_date || '',
    state: p.state,
    city: p.city,
    photo: p.photo,
  };
}

module.exports = { PROFILE_POSTS, freeGalleryCount, VISIBLE_SQL, isVisible, parsePackages, parseGallery, GALLERY_SLOTS, publicProfessional, ownProfessional, ownPatient };
