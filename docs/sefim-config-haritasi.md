# Vega Şefim — config.exe ("VR Config") Tam Haritası

Kaynak: `C:\Program Files (x86)\Vega\Sefim` (kurulu, incelendi 2026-06-16, şifre "0").
Amaç: bu config yeteneklerini **ArcTeknik Şef**'e taşımak. Flag kataloğu: `Sefim\How to enable features.txt` (~200 `Feature.*`).

## Ribbon sekmeleri
1. **Tanımlar** — Tanımlar(genel), Ürün Tanımları, Menü Tanımları, Cari Tanımları, Yazıcı Tanımları, Happy Hour/Fiyat Listeleri, Favoriler, Ödeme Grupları, Ürün Eşleştir, E Fatura Ayarları, Marşlanacak Ürünler
2. **Raporlar** — Gün Sonu, Günlük toplam, Özet/Masalara göre Ciro, Personel Tahsilat, Faaliyet, Aktif Masalar, Fiyat Listesi, Gider-Gelir, Açık Hesap, Silinen Sipariş, Satış rap/toplam, Özel Rapor
3. **Paket Servisi Raporları** — Gün Sonu, Eski Tahsilat Tarama, Satış rap/toplam, Paket-Rest Birleşik Gün Sonu
4. **Rezervasyon Raporları** — Rezervasyon Listesi
5. **Ayarlar** — Arctos DB Ayarları + Firma/Dönem Seçimi (Cost/ERP bağlantı), Lisans Ayarları, **Özelleştirme** (=Feature.* flag editörü), Web Api Ayarları
6. **Yedekleme** — Şefim Merkez Bilgileri (şube replikasyon), Veritabanı Yedekleme

## Tanımlar > "Tanımlar" genel ayar modalı (8 sekme)
- **Tanımlar:** Garson girişi yapılsın (E/H), Buton boyutu (Orta…), Hesap Pusula → Fatura Yazıcısı + tasarım butonları (Pusula/Fiş-Fatura/Mutfak Listesi/Marka çıktı/E-Adisyon tasarımı)
- **Kullanıcılar:** grid — Kullanıcı Adı, Fiyat Listesi, **Şifre**, İskonto Oranı, İskonto Tutarı, Kasa Portu, **Yetkiler**(buton), Şube/Departman, **Ürün Yetkilendir**. (Fiyat listesi boş = happy hour fiyatı kullanır)
- **Masa Grupları:** Grup adı, **Prefix/İsimler** (B-, S-, veya isim listesi), Masa Sayısı, Ayarlar. ([R] prefix = rezervasyon)
- **Barkod:** terazi barkod deseni (G=gramaj, A=adet, C=checkdigit, B=barkod)
- **Diğer:** Ürün ismi görünümü, Bilgisayar adı
- **Paket servisi ücretleri:** "Bu tutara kadar" → eklenecek servis ürünü + ücret (fiyat veya %)
- **Sms Ayarları:** rezervasyon SMS (başlık, kullanıcı/parola, şablon {0}ad {1}tarih {2}saat {3}irtibat)
- **Restoran Durumu:** öğün saatleri (Sabah/Öğle/Akşam) + Rezervasyon Uyarı Süresi (dk)

## Tanımlar > Ürün Tanımları
Ürün/Stok Kodu, Ad, Sıra, İkram(bool), Ürün Tipi, KDV Dahil Fiyat, KDV Oranı, **Fatura Grubu**, **Ürün Grubu**, PLU, Favoriler, İstisna/Özel Matrah Kodu, Resim. **1. ve 2. Seviye Seçim** (zorunlu seçim kademeleri, fiyat +/-), **Seçenekler + Seçenek kategorileri** (Fiyat +/-, Miktarlı). → çok-kademeli opsiyon/modifier.

## Tanımlar > Menü Tanımları
Menü (combo): Menü Adı, Resim, KDV Dahil Fiyat, Ürün Sayısı, Aktif. **Menü Ürün Listesi** (ürün + fiyat +/-).

## Tanımlar > Cari Tanımları
Filtre/kart okut, Nihai Tüketici vb. cariler, Yeni/Düzenle, Pasifleri gizle.

## Tanımlar > Yazıcı Tanımları  ★ (kullanıcının vurguladığı)
3 sekme: **Mutfak Çıktıları / Pusula Çıktıları / Resmi Adisyon**. Kural bazlı yönlendirme:
- Mutfak: **Kaynak** (İşlem Yapılan Bilgisayar, Masa Prefix, Garson, Ürün Grubu, Ürün) → **Yazıcı** + **Mutfak Ekranı (KDS)**
- Pusula/Resmi: (Bilgisayar, Garson) → Yazıcı
- `*` garson/ürün alanında = TÜM garsonlar/ürünler. **Yazıcı adı `kasa;pide` gibi `;` ile çoklu → her ikisine de gönderir.**

## Tanımlar > Happy Hour / Fiyat Listeleri
3 sekme: **Fiyat Listeleri** (çoklu şablon; Yeni/Güncelle/Devre dışı/Aktif yap), **Fiyat Listesi Kuralları** (Cari Kategorisi + Masa Grubu → Fiyat Listesi), **Otomasyon** (Şablon + Dönem baş/son + Başlangıç/Bitiş saati + Aktif Günler → zamanlı happy hour).

## Tanımlar > Favoriler / Ödeme Grupları / Ürün Eşleştir
- **Favoriler:** ürünleri favori menüsüne ata (ProductName/Group/InvoiceName)
- **Ödeme Grupları:** Ödeme Grubu + Ödeme Yöntemi + Uygulama (nakit/kart/ticket → entegrasyon)
- **Ürün Eşleştir:** Şefim ürünü ↔ ERP(Vegawin/Arctos) stok eşleme (Stok Adı/Grup/Seçenek1-2)

---

## ArcTeknik Şef'te MEVCUT (karşılaştırma)
`RestoranSettings` (Id=1): CoverCharge, HappyEnabled/Start/End/Percent, LoyaltyPercent — minimal. RestaurantControl.jsx "Menü & Masa" mgmt. Zaten var: bölüm/masa/kategori/ürün/seçenek/reçete, çoklu yazıcı+sıra, combo, ikram/iptal-zayi, masa birleştir, KDS, ön hesap, masa süre, paket, PIN, auto-lock, rezervasyon, sadakat (Faz 0-6 + 13 saha isteği).

## GAP → ArcTeknik Şef'e portlanacak config yetenekleri (öneri, fazlı)
**Faz K1 — Genel Ayarlar ekranı (Feature toggles):** `RestoranSettings`'i genişlet + `RestoranFeatures` (key/value JSON) → RestaurantControl'de "Ayarlar" sekmesi. Davranış flag'leri: ödeme yöntemi aç/kapa, kuver oto-ekle, iskonto/ikram/iptal NEDEN sorma, garson girişi modu, buton boyutu, yuvarlama/para formatı, ön ödeme, masa bilgi göstergeleri (süre/kişi/son garson/pusula), tek-kullanıcı modu, mutfak çıktı gruplama/marşlama.
**Faz K2 — Yazıcı yönlendirme kuralları:** kural tablosu (Masa Prefix/Garson/Ürün Grubu/Ürün/`*` → Yazıcı `;`çoklu + KDS). Mutfak/Pusula/Resmi ayrı.
**Faz K3 — Fiyat listeleri + kural + happy-hour otomasyon:** çoklu fiyat listesi, (cari kategori + masa grubu → liste), zaman bazlı otomatik aktivasyon.
**Faz K4 — Kullanıcı/yetki derinleştirme:** kullanıcı bazlı fiyat listesi, iskonto limiti, ürün yetkilendirme, şube/departman.
**Faz K5 — Yan ayarlar:** paket servis ücret kademeleri, rezervasyon SMS, öğün saatleri, terazi barkod parse, favori ekran atama, ödeme grupları.
**ATLA (Vega-özel donanım):** ÖKC marka entegrasyonları (Ingenico/Hugin/Inpos/Pavo/Vera/Olivetti), terazi donanım sürücüleri, çekmece exe, Digipan, müşteri LCD/VFD — bizim Electron+web donanım katmanı farklı (Faz 6'da ayrı ele alınır). Arctos/Vegawin ERP eşleştirme de bize gerekmez (kendi ERP'miz var).
