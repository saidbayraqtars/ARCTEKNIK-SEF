// Minimal service worker — PWA "yüklenebilir" olsun + temel açılış hızı.
// ÖNEMLİ: ERP verisi taze kalmalı → /api/ İSTEKLERİ ASLA önbelleğe alınmaz.
// Sadece statik uygulama kabuğu (shell) offline'da fallback olarak tutulur.
// Manifest'i SHELL'e koymuyoruz: sürüme göre değişir (erp/şef) ve fetch handler
// istenince zaten cache'ler → edition-bağımsız, yanlış manifest precache edilmez.
const CACHE = 'arcteknik-shell-v1';
const SHELL = ['/', '/index.html', '/icon.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Ağ-öncelikli (network-first): çevrimiçiyken HER ZAMAN taze sürüm gelir,
// yalnız ağ koptuğunda kabuk cache'ten açılır. API istekleri hiç dokunulmaz.
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return; // API daima ağdan
  e.respondWith(
    fetch(request)
      .then((res) => {
        // Başarılı GET'leri kabuk cache'inde güncel tut (yalnız aynı origin).
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(request).then((r) => r || caches.match('/index.html')))
  );
});
