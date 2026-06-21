// ─── Gece modu (tema) ────────────────────────────────────────────────────────
// Tema <html> üzerindeki 'dark' sınıfıyla uygulanır; görsel kurallar
// index.css'teki `.dark` katmanında toplanır (sayfaları tek tek elden
// geçirmeden tüm ERP karanlık olur). Seçim localStorage'da kalıcıdır.
// Restoran/kiosk ekranları zaten koyu tasarımlıdır — bu anahtar yalnızca
// ERP yönetim panelinin (Layout) başlığından değiştirilir.

const STORAGE_KEY = 'arc-theme';

export const getTheme = () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch { /* localStorage kapalıysa varsayılana düş */ }
  return 'light';
};

export const applyTheme = (theme) => {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* sessizce geç */ }
};

// Uygulama açılışında kayıtlı temayı uygula (FOUC olmaması için main.jsx'te,
// React render başlamadan önce çağrılır).
export const initTheme = () => applyTheme(getTheme());
