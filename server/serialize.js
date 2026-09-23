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

// Visitante sem conta tem um acesso básico: vê localização, Instagram, duração da sessão,
// se há pacotes e as 2 primeiras fotos da galeria. Valores, o "Sobre", o endereço da
// clínica e o resto da galeria ficam para quem cria a conta grátis.
const FREE_GALLERY = 2;

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
  const gallery = parseGallery(p.gallery).filter(Boolean);
  const common = {
    state: p.state,
    city: p.city,
    has_clinic: !!p.has_clinic,
    instagram: p.instagram || '',
  };
  if (!loggedIn) {
    const packages = parsePackages(p.packages);
    const { bio, ...rest } = base;
    return {
      ...rest,
      ...common,
      locked: true,
      has_bio: !!bio,
      has_price: p.price_cents != null,
      package_sessions: packages.map((k) => k.sessions),
      gallery: gallery.slice(0, FREE_GALLERY),
      gallery_hidden: Math.max(0, gallery.length - FREE_GALLERY),
    };
  }
  return {
    ...base,
    locked: false,
    favorite: !!favorite,
    ...common,
    price_cents: p.price_cents,
    packages: parsePackages(p.packages),
    clinic_name: p.has_clinic ? p.clinic_name : '',
    clinic_address: p.has_clinic ? p.clinic_address : '',
    gallery,
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
