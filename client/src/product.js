// ─── Ürün kimliği ────────────────────────────────────────────────────────────
// Tek ürün: ArcTeknik Şef (bağımsız restoran otomasyonu). ArcTeknik ERP ayrı
// klasör/repo'ya taşındı.
export const PRODUCT = 'SEF';

export const productMeta = { short: 'ArcTeknik Şef', title: 'ArcTeknik Şef' };

// Sekme/pencere başlığını ürüne göre ayarla.
if (typeof document !== 'undefined') {
  document.title = productMeta.title;
}
