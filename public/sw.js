/* Service worker — permite instalar o app e abre mais rápido.
   Dados (API, chat, chamadas) nunca são guardados em cache. */
const VERSION = 'acolia-v64';
const SHELL = ['/css/app.css', '/js/common.js', '/js/chat.js', '/js/voice.js', '/js/social.js', '/js/catalog.js', '/js/profile-view.js', '/js/call.js', '/js/painel.js', '/js/delete-account.js', '/js/docs.js',
  '/img/logo-simbolo.png', '/img/logo-nome.png', '/img/logo-completo-branco.png', '/img/favicon.png', '/img/app-icon-192.png', '/offline.html'];
// Páginas guardadas para abrir rápido (e sem internet mostrar a última versão)
const PAGES = ['/', '/app', '/painel', '/entrar'];
const MEDIA = 'acolia-fotos'; // fotos já vistas (/uploads) ficam no aparelho: não baixa de novo
const MEDIA_MAX = 300;

self.addEventListener('install', (e) => {
  // cache: 'reload' = pega do servidor mesmo (não a cópia velha do navegador), senão a versão nova do app
  // podia ficar com o JavaScript antigo e dar erro
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))).then(() => Promise.all(PAGES.map((u) => c.add(u).catch(() => {}))))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== MEDIA).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Guarda no máximo MEDIA_MAX fotos (as mais antigas saem)
async function trimMedia() {
  const c = await caches.open(MEDIA);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MEDIA_MAX; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  // Fotos enviadas (nome único, nunca mudam): do aparelho primeiro; vídeos vão direto (streaming)
  if (url.pathname.startsWith('/uploads/')) {
    if (!/\.(jpe?g|png|webp)$/i.test(url.pathname)) return;
    e.respondWith(caches.open(MEDIA).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) { c.put(e.request, res.clone()).then(trimMedia).catch(() => {}); }
      return res;
    }));
    return;
  }

  if (e.request.mode === 'navigate') {
    // Páginas: busca na internet (até 4 s); se estiver lenta ou sem internet, abre a versão guardada
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const net = fetch(e.request).then((res) => {
        if (res.ok && PAGES.includes(url.pathname)) cache.put(url.pathname, res.clone()).catch(() => {});
        return res;
      });
      const saved = await cache.match(url.pathname);
      if (!saved) return net.catch(() => caches.match('/offline.html'));
      const timeout = new Promise((r) => setTimeout(() => r(saved), 4000));
      return Promise.race([net.catch(() => saved), timeout]);
    })());
    return;
  }
  // CSS e JS do site: confere com o servidor (se não mudou, a resposta é um "304" minúsculo) para a
  // página e o código estarem sempre na mesma versão; sem internet ou lento (3 s), usa o guardado.
  if (/\.(js|css)$/.test(url.pathname)) {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(e.request, { ignoreSearch: true });
      const net = fetch(e.request, { cache: 'no-cache' }).then((res) => {
        if (res.ok) c.put(e.request, res.clone()).catch(() => {});
        return res;
      });
      if (!hit) return net;
      const slow = new Promise((r) => setTimeout(() => r(hit), 3000));
      return Promise.race([net.catch(() => hit), slow]);
    }));
    return;
  }
  // Imagens do site: abre na hora o que está guardado e atualiza por baixo
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(e.request);
    const net = fetch(e.request).then((res) => {
      if (res.ok) c.put(e.request, res.clone()).catch(() => {});
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});

// ---------- Notificações de mensagem (Web Push) ----------
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Acolia', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Acolia', {
    body: data.body || 'Você recebeu uma nova mensagem.',
    icon: '/img/app-icon-192.png',
    badge: '/img/app-icon-192.png',
    tag: data.tag,
    renotify: true,
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).pathname === new URL(url).pathname && 'focus' in w) {
        await w.focus();
        if ('navigate' in w) await w.navigate(url).catch(() => {});
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
