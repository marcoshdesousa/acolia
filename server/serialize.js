'use strict';
const { todayISO } = require('./util');

// Profissional aparece na vitrine se estiver aprovado e com a mensalidade em dia
const VISIBLE_SQL = "p.status = 'aprovado' AND p.subscription_until IS NOT NULL AND p.subscription_until >= date('now')";

function isVisible(p) {
  return p.status === 'aprovado' && !!p.subscription_until && p.subscription_until >= todayISO();
}

function parsePackages(json) {
  try {
    const arr = JSON.parse(json || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

const GALLERY_SLOTS = 6;

// Galeria: 6 posições fixas (Foto 1 a Foto 6); posição vazia = null
function parseGallery(json) {
  let arr;
  try { arr = JSON.parse(json || '[]'); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  return Array.from({ length: GALLERY_SLOTS }, (_, i) => (typeof arr[i] === 'string' && arr[i].startsWith('/uploads/') ? arr[i] : null));
}

// Visitante sem conta vê o profissional, mas sem valores e sem localização
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
    session_minutes: p.session_minutes || null,
  };
  if (!loggedIn) return { ...base, locked: true };
  return {
    ...base,
    locked: false,
    favorite: !!favorite,
    price_cents: p.price_cents,
    packages: parsePackages(p.packages),
    state: p.state,
    city: p.city,
    has_clinic: !!p.has_clinic,
    clinic_name: p.has_clinic ? p.clinic_name : '',
    clinic_address: p.has_clinic ? p.clinic_address : '',
    // Galeria e Instagram: só para quem tem conta
    gallery: parseGallery(p.gallery).filter(Boolean),
    instagram: p.instagram || '',
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
    clinic_name: p.clinic_name,
    clinic_address: p.clinic_address,
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
    state: p.state,
    city: p.city,
    photo: p.photo,
  };
}

module.exports = { VISIBLE_SQL, isVisible, parsePackages, parseGallery, GALLERY_SLOTS, publicProfessional, ownProfessional, ownPatient };
