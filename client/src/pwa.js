// PWA — sürüme (edition) göre manifest + iOS ana ekran adı, ve service worker kaydı.
// Aynı client paketi hem ERP (suite) hem ArcTeknik Şef (restaurant) olarak çalışır;
// bu yüzden manifest statik olamaz, runtime'da edition'a göre ayarlanır.

export function applyPwaForEdition(edition) {
  const isRestaurant = edition === 'restaurant';
  // Şef garson terminali kendi manifestini kullanır (scope: /restoran/garson).
  const manifestHref = isRestaurant ? '/manifest.webmanifest' : '/erp.webmanifest';
  // iOS Safari ana ekran ADINI manifest'ten değil bu meta'dan okur.
  const appleTitle = isRestaurant ? 'Şef Garson' : 'ArcTeknik';

  const link = document.querySelector('link[rel="manifest"]');
  if (link) link.setAttribute('href', manifestHref);

  const apple = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (apple) apple.setAttribute('content', appleTitle);
}

// Service worker YALNIZ güvenli + uzak bağlamda (Tailscale HTTPS / yayın) kaydedilir.
// Electron ve localhost'ta KAYDETME: paketlenmiş asset'ler hash'li olduğundan eski
// cache yeni sürümle çakışabilir; masaüstü uygulamasında PWA'ya da gerek yok.
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!window.isSecureContext) return; // http://LAN-IP secure değil → atla
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* sessizce geç */ });
  });
}
