# ArcTeknik v1.7.0 — Faz 2 Yayını

**Tarih:** 2026-05-30  
**Durum:** ✅ Üretim Hazır

---

## 📦 Bu Sürümde Neler Var

### Faz 1: Gelişmiş Stok Altyapısı (Tamamlandı)
- **Kategori & Marka Yönetimi** — stok kartlarına kurumsal sınıflandırma
- **Çoklu Barkod (Varyantlar)** — bir ürüne sınırsız alt barkod bağlama (kolilik, ebat vb.)
- **Excel/CSV Toplu İçe Aktarım** — istemci tarafında bağımlılıksız XLSX parse
  - Stok toplu aktarım: Barkod varsa miktar üzerine eklenir, fiyat güncellenir; yoksa yeni kart açılır
  - Müşteri toplu aktarım: VKN/telefon eşleştirme, eksik alanlar korunur

**Sayfalar:**
- `/stok` — Stok yönetimi (kategori/marka dropdown, alt barkod chip listesi, Excel import)
- Müşteri sayfası (`/kabul`) — Excel/CSV müşteri toplu aktarım paneli

---

### Faz 2: e-Fatura / e-Arşiv Paneli + Akıllı Gelen Fatura (YENİ ✨)

#### 🎯 Bağımsız e-Fatura Kontrolü Paneli (`/e-fatura` — admin, izole)

**3 Sekme:**

1. **Giden Faturalar** — Kesilen resmi faturalar (Documents tablosu)
   - Fatura No, ETTN, Müşteri, Tutar, GİB Durum (Taslak / Gönderildi / Onaylandı)

2. **Gelen Faturalar** — Toptancıdan gelen e-Faturalar
   - XML'den ayrıştırılmış kalemler (Ürün, Barkod, Adet, Birim Fiyat)
   - **Tek Tıkla Stoğa Aktar** — 🚀 ACID transaction'da:
     * Her kalem barkodu Stocks.Barcode VEYA ProductBarcodes'ta aranır
     * Eşleşirse: stok +qty, PurchasePrice (alış fiyatı) güncellenir
     * Eşleşmezse: 'Genel' kategorili yeni stok kartı otomatik açılır
     * Tedarikçi (Satıcı) cari kartı VKN ile bulunur/açılır
     * Fatura tutarı **Alacaklandır** hareketi (bizim borcumuz) olarak cari'ye yazılır
   - **Örnek Fatura Oluştur** — entegratör bağlanana kadar test için simülasyon

3. **Entegratör Ayarları**
   - Firma (Logo, Mali Suit, Uyumsoft vb.), Kullanıcı Adı, Şifre
   - Fatura ön eki (ARC, POS vb.)
   - TEST / CANLI (GİB) modu

#### 🔧 Backend

- **`/api/einvoice/outbound`** — giden faturaları listele
- **`/api/einvoice/inbound`** — gelen faturaları listele
- **`/api/einvoice/inbound/:id`** — detay + XML'den ayrıştırılmış kalemler
- **`POST /api/einvoice/inbound/import`** — ham XML kaydı
- **`POST /api/einvoice/inbound/simulate`** — örnek fatura üret (test amaçlı)
- **`POST /api/einvoice/process-inbound/:id`** ⭐ KRİTİK — gelen fatura → ACID stok girişi + cari Alacaklandır
- **`/api/einvoice/settings`** — entegratör ayarları GET/PUT (şifre maskelenir)

#### 🛠️ XML Motoru

- **`services/einvoiceXml.js`** — bağımlılıksız UBL-TR parser (regex, namespace-toleranslı)
  * `parseInboundInvoiceXml()` — ETTN, fatura no, VKN, ünvan, tarih, kalemler (barkod, miktar, fiyat)
  * `buildSampleInvoiceXml()` — test için örnek XML üreteci
  * Gerçek entegratöre geçişte (Logo API vb.) bu modülü besleyecek

---

## 🔐 ACID Tasarımı

Tüm kritik işlemler tek transaction'da atomik:
- Stok girişi (`adjustStock`) — miktar kilit, hareket defteri
- Cari hareketi (`applyMovement`) — bakiye kilit, ekstre
- Mükerrer koruma — `InboundInvoices.IsProcessed` + `UPDLOCK`

---

## 📊 Veritabanı

**Yeni Tablolar:**
- `Categories` — stok kategorileri
- `Brands` — stok markaları
- `ProductBarcodes` — çoklu barkodlar (Stocks.StockID FK CASCADE)
- `InboundInvoices` — gelen faturalar (ETTN unique, IsProcessed koruması)

**Yeni CompanySettings Kolonları:**
- `EInvoiceProvider/Username/Password/Prefix/TestMode`

---

## ✅ Doğrulandı

- ✓ Node.js sözdizimi kontrolü (4 dosya: db.js, routes/eInvoice.js, services/einvoiceXml.js, server.js)
- ✓ UBL-TR parser round-trip test (ETTN, VKN, toplam 854.50 ₺, 2 kalem, barkodlar doğru)
- ✓ Vite istemci derlemesi (`✓ built`, 1856 modül)

---

## 🚀 Sonraki Adımlar (Faz 3+)

- Gerçek entegratör bağlantıları (Logo, Uyumsoft, vb.) — XML webhook/polling
- Giden fatura GİB gönderimi (POST /outbound/send)
- e-Arşiv sorgulama (geçmiş faturaları çek)
- Sektör profilleri (white-label çok-sektörlü destek)

---

## 📝 Kullanım

```bash
# Geliştirme
npm run dev:web  # Server + Client eş zamanlı

# Üretim Derlemesi
npm run build:client  # Vite bundle

# Veritabanı Başlatması
# (İlk çalışmada otomatik, config/db.js initializeDatabase())
```

**Admin Sayfalar:**
- `/stok` — Stok & Depo (kategoriler, markalar, alt barkodlar, Excel import)
- `/belgeler` — Belge Zinciri (Teklif→Sipariş→İrsaliye→Fatura, PDF, e-Fatura modeli)
- `/e-fatura` — e-Fatura Paneli (gelen fatura ACID stoğa aktarım, entegratör ayarları) — YENİ
- `/cari` — Açık Hesap (müşteri veresiyesi, tedarikçi borcu, Alacaklandır otomasyonu)

---

**Sürüm:** `1.7.0` | **Lisans:** Proprietary (ArcTeknik)
