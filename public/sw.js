/* Service worker — permite instalar o app e abre mais rápido.
   Dados (API, chat, chamadas) nunca são guardados em cache. */
const VERSION = 'acolia-v4';
const SHELL = ['/css/app.css', '/js/common.js', '/js/chat.js', '/js/catalog.js', '/js/profile-view.js', '/img/logo-simbolo.png', '/img/logo-nome.png', '/img/favicon.png', '/img/app-icon-192.png', '/offline.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/uploads/')) return;

  if (e.request.mode === 'navigate') {
    // Páginas: sempre da rede; sem internet, mostra aviso
    e.respondWith(fetch(e.request).catch(() => caches.match('/offline.html')));
    return;
  }
  // Arquivos estáticos: rede primeiro, cache como reserva
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request)),
  );
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
