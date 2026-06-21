# Bayraktar Yazılım Suite — ArcTeknik ERP · ArcTeknik Şef

Tek bir kod tabanından (**monolit, çift/çoklu-EXE**) bağımsız ticari ürünler dağıtan,
**tamamen çevrimdışı (offline)** çalışan kurumsal otomasyon paketi:

| Ürün | Kime | Çalışma modu | Veritabanı |
|------|------|--------------|------------|
| **ArcTeknik ERP** | Teknik servis + perakende | `--mode=service` → `/` | TEKNIKDB |
| **ArcTeknik Şef** | Restoran/kafe otomasyonu (bağımsız ürün) | `--mode=restaurant` → `/restoran` | **ARCSEFDB** |

> **FastPOS askıda (2026-06):** hızlı kasa terminali tüm sistemden çıkarıldı; ileride
> devam edilecek — kaynak ve geri getirme adımları `.archive/fastpos/README.md`.
> **e-Fatura ERP'den çıkarıldı:** Şef benzeri **ayrı bir uygulama** (ayrı veritabanı)
> olarak yeniden yapılacak — çekirdek kaynak `.archive/efatura/README.md`.

Dükkân bilgisayarına `.exe` ile kurulur, SQL Server Express üzerinde çalışır, internet
gerektirmez. Lisanslama (RSA-2048, donanım bağlı) ve premium modüllerle genişler.

**Teknoloji yığını**
- **Frontend:** React 19 + Vite + TailwindCSS + lucide-react + react-hot-toast
- **Backend:** Node.js + Express (tek `server.js`, forked child process)
- **Veritabanı:** Microsoft SQL Server (MSSQL) — `mssql`/`tedious`
- **Masaüstü:** Electron 35 + electron-builder 25 (NSIS kurulum) + electron-updater
- **Güvenlik:** JWT, bcryptjs, Helmet, express-rate-limit, AES-256-GCM, RSA-2048
- **Otomasyon:** `@whiskeysockets/baileys` (WhatsApp), `node-cron` (zamanlı işler)

---

## İçindekiler
1. [Mimari — neden monolit çift-EXE](#1-mimari--neden-monolit-çift-exe)
2. [Sürüm (edition) sistemi — tek kod, iki ürün](#2-sürüm-edition-sistemi--tek-kod-iki-ürün)
3. [ArcTeknik ERP özellikleri](#3-arcteknik-erp-özellikleri)
4. [FastPOS — hızlı satış terminali (ASKIDA)](#4-fastpos--hızlı-satış-terminali-askida)
5. [ArcTeknik Şef — restoran otomasyonu](#5-arcteknik-şef--restoran-otomasyonu)
6. [Lisanslama ve modüller](#6-lisanslama-ve-modüller)
7. [Veritabanı tasarımı ve ACID](#7-veritabanı-tasarımı-ve-acid)
8. [Yapılandırma şifreleme (HWID-AES)](#8-yapılandırma-şifreleme-hwid-aes)
9. [Şef bağımsızlaştırma + installer küçültme (neden/nasıl)](#9-şef-bağımsızlaştırma--installer-küçültme-nedennasıl)
10. [Online sipariş altyapısı (Faz 3 iskeleti)](#10-online-sipariş-altyapısı-faz-3-iskeleti)
11. [Kurulum, geliştirme ve derleme](#11-kurulum-geliştirme-ve-derleme)
12. [Klasör yapısı ve destek için kopyalama](#12-klasör-yapısı-ve-destek-için-kopyalama)
13. [Güvenlik notları](#13-güvenlik-notları)

---

## 1. Mimari — neden monolit çift-EXE

### Ne
Tüm ürünler **tek bir Electron süreci** ve **tek bir yerel Node.js sunucusu** (`server/server.js`,
masaüstünde **51234** portu) üzerinde çalışır. Başlangıç argümanı hangi pencerenin/route'un
açılacağını belirler:

| Argüman | Pencere | URL | Tip |
|---------|---------|-----|-----|
| `--mode=service` | ArcTeknik ERP | `/` | Normal (sidebar'lı) |
| `--mode=restaurant` | ArcTeknik Şef | `/restoran` | Kiosk (tam ekran dokunmatik) |
| `--mode=kitchen` | Mutfak ekranı | `/restoran/mutfak` | Kiosk |
| `--mode=control` | Şef Yönetim/Kontrol Paneli | `/restoran/yonetim` | Normal pencere |
| `--backup-mode` | ARC Yedekleme Merkezi | (yerel HTML) | Sunucu **forklamaz** |

### Neden
Önceki tasarım üç ayrı uygulamaydı (`project_suite_architecture` — **arşivlendi**). Üç ayrı
kod tabanı = her hata düzeltmesini üç yerde tekrarlamak, üç ayrı sürüm, kopyala-yapıştır
sapması. Bunun yerine **tek kaynak (SSOT) `server/` + `client/`** seçildi:

- Ortak modüller (kullanıcı, lisans, kasa, stok, ayar, kimlik) **bir kez** yazılır, hepsinde çalışır.
- Tek hata düzeltmesi tüm ürünleri düzeltir.
- `client/dist` tek bundle; ürün ayrımı **çalışma zamanında** yapılır (bkz. §2).

### Nasıl
- **Tekil süreç kilidi (`requestSingleInstanceLock`):** İki kısayol iki kez tıklansa bile ikinci
  süreç açılmaz; argümanı birincil sürece iletir → o, istenen modda yeni pencere açar. Böylece
  iki pencere de **aynı sunucuya** bağlanır, **port çakışması olmaz**.
- **`fork()` ile tek sunucu:** `desktop/main.js` `server.js`'i bir kez fork eder, `"Sunucu
  http://127.0.0.1:<port>"` çıktısını yakalayıp pencereyi o porta yükler. Sunucu beklenmedik
  kapanırsa otomatik yeniden başlatır ve açık pencereleri yeni porta yönlendirir.
- **Açılış (splash) ekranı:** Sunucu hazır olana kadar markalı, çerçevesiz splash gösterilir;
  ana içerik yüklenince kapanır (boş/beyaz ekran görünmez).
- **Kiosk çıkışı:** Tam ekran terminallerde Görev Yöneticisi gerektirmeden **Ctrl+Shift+Q**
  (`before-input-event`, `input.code==='KeyQ'` → klavye düzeninden bağımsız) pencereyi kapatır.
- **Otomatik güncelleme:** `electron-updater` açılışta arka planda yeni sürüm arar; indirilince
  native "Şimdi yeniden başlat / Sonra" diyaloğu (yalnız paketli `.exe`).

---

## 2. Sürüm (edition) sistemi — tek kod, iki ürün

### Ne
Aynı `server/` ve `client/dist`, iki ayrı ticari ürün üretir: **suite** (TEKNIKDB, ERP+Şef
tek çatı) ve **restaurant** (ARCSEFDB, bağımsız ArcTeknik Şef).

### Nasıl — uçtan uca edition sinyali
1. **Derleme zamanı:** `electron-builder-restaurant.json` paketlenen `package.json`'a
   `extraMetadata: { "edition": "restaurant" }` gömer.
2. **Çalışma zamanı (Electron):** `main.js` → `EDITION = process.env.ARC_EDITION || pkg.edition || 'suite'`.
   Restaurant ise sunucuya `process.env.APP_EDITION = 'restaurant'` geçer ve `DB_NAME=ARCSEFDB`
   varsayılanını ayarlar.
3. **userData izolasyonu (kritik):** Restaurant sürümünde, **tekil-süreç kilidinden ÖNCE**
   `app.setName('ArcTeknik Sef')` + `app.setPath('userData', %APPDATA%/ArcTeknik Sef)` çağrılır.
   Aksi halde paketteki `name='teknik-servis-desktop'` yüzünden Şef, Suite ile aynı klasörü
   (`.env`, `setup.json`, lisans, log, kilit) paylaşır → Suite'in kurulumunu ve DB kimliğini
   miras alıp sihirbazı hiç açmazdı. **Artık Şef tamamen izole.**
4. **Sunucu:** `APP_EDITION`'a göre rota ağacını ve WhatsApp/teknik servisleri ayırır (§9).
   `GET /api/setup/status` yanıtında `edition` döner.
5. **İstemci (`App.jsx`):** Açılışta `/setup/status`'tan `edition` okur; `restaurant` ise
   **yalnızca** restoran route ağacını render eder (`/login`, `/restoran`, `/restoran/mutfak`,
   `/restoran/garson`, `/restoran/yonetim`, `*` → `/restoran`). Teknik rotalar (Dashboard, kabul,
   analiz, ...) hiç kayıtlı değildir → erişilemez, "Panele Dön" yoktur.

> **Gizli hata düzeltmesi (2026-06-06):** Kurulum bittikten sonra normal sunucu `/setup/status`
> shim'i yalnız `{complete:true}` dönüyordu (edition yok) → Şef "suite" sanılıp teknik ağacı geri
> getirecekti. Shim artık `edition` döndürüyor; ayrım kurulum-öncesi **ve** sonrası tutar.

---

## 3. ArcTeknik ERP özellikleri

### Temel iş akışı
1. **Müşteri & Cihaz Kabulü** — marka/model/şifre/şikayet; yazdırılabilir servis formu; QR etiket.
2. **Kasa & Finans** — gelir/gider, kapora, aylık filtre; teslimde **otomatik tahsilat**.
3. **Stok & Depo** — parça kartları, **kategoriler, markalar, çoklu barkod (ProductBarcodes)**,
   kritik stok uyarısı, alış/satış fiyatı, **Excel/CSV toplu içe aktarım**.
4. **Servis ↔ Stok (ACID):** Servise eklenen parça stoktan tek transaction'da düşülür, iade
   edilince geri yüklenir; **maliyet servis anında snapshot'lanır** (sonradan fiyat değişse de
   geçmiş kâr bozulmaz).
5. **Net kâr analizi** — teslim edilen servislerde `Tahsil Edilen Gelir − Parça Maliyeti`.

### Müşteri iletişimi & takip
6. **WhatsApp CRM** (baileys) — kabul/onay/tamir/teslim mesajları + takip linki; bağlantı
   koptuğunda mesaj kuyruğu. *(Yalnız Suite — Şef'te yoktur, §9.)*
7. **Müşteri Sorgulama Portalı** `/sorgula` — servis no + telefon → timeline.
8. **Müşteri fiyat onayı** — `/sorgula`'da Onaylıyorum / İade İstiyorum.
9. **Medya (foto/video)** — kabul hasar kanıtı + tamir sonrası (müşteri portalında).
10. **CRM hatırlatmaları** (`node-cron`, 09:00) — teslim alınmayan cihaz + periyodik bakım.
11. **Garanti takibi** — seri no ile aktif garanti uyarısı.

### Gelişmiş ticari modüller
12. **Gelişmiş Cari Hesap** — açık hesap (müşteri veresiyesi + tedarikçi borcu), mal alımı,
    ekstre; Kasa ile **ACID**; bakiye işaret kuralı.
13. **Belge Zinciri** — Teklif → Sipariş → İrsaliye → Fatura; PDF; stok/cari ACID; sayaçlar.
14. ~~e-Fatura & Gelen Fatura~~ — **ERP'den çıkarıldı (2026-06)**; ayrı uygulama olarak
    yeniden yapılacak (kaynak: `.archive/efatura/`). Belge zinciri ERP'de durur.

### Yönetim, güvenlik, kurumsallık
15. **RBAC** — Admin (kasa/personel/fiyat/maliyet/stok/finans) vs Teknisyen (durum/parça/not;
    fiyat-maliyet API'den gizli). Genişletme: **patron komuta merkezi, teknisyene iş atama,
    seat (koltuk) lisansı**.
16. **Denetim İzi (Audit Log)** — kim/ne zaman; dashboard modalı.
17. **İstatistikler** `/analiz` — marka/arıza grafikleri, teknisyen performansı (ciro, maliyet,
    net kâr).
18. **Güvenlik** — giriş/sorgulama rate limit, CORS, production'da `JWT_SECRET` zorunlu.
19. **İlk Kurulum (Onboarding) Sihirbazı** — yönetici yoksa: (1) Firma, (2) Yönetici → otomatik giriş.
20. **Sunucu/İstemci modu** — çok bilgisayar tek SQL'i paylaşır (`APP_ROLE`, uzak SQL 1433, SQL auth).
21. **B2B Web Senkronizasyonu** *(B2B modülü)* — "Web'de Göster" stokları uzak mağazaya
    fail-safe köprüyle senkronlar.
22. **Yedekleme Merkezi** (`--backup-mode`) — SQL yedek al/geri yükle (sunucu forklamadan).

---

## 4. FastPOS — hızlı satış terminali (ASKIDA)

**Askıya alındı (2026-06), ileride devam edilecek.** Tam ekran kasa terminali (barkod
dinleyici, askıda sepet, ACID checkout) tüm sistemden çıkarıldı; çalışır kaynak ve
geri getirme adımları `.archive/fastpos/README.md` içinde. `GET /api/stocks/barcode/:code`
ucu genel arama için ERP'de kaldı.

---

## 5. ArcTeknik Şef — restoran otomasyonu

Bağımsız satılabilir ürün. Çoğu özellik dokunmatik kiosk için tasarlandı.

### Satış / servis
- **Kat planı:** bölümler (salon/teras/bahçe), masalar; sürükle-yerleştir düzen.
- **Menü yönetimi:** kategoriler, ürünler, **seçenek grupları + seçenekler** (örn. pişme
  derecesi, ekstra malzeme), kuver/happy-hour.
- **Adisyon/sipariş:** masa açma, ürün ekleme, kısmi tahsilat, hesap bölme, birim seçimi.
- **Mutfak ekranı** `/restoran/mutfak` (`--mode=kitchen`) — gelen siparişler, hazır işaretleme.
- **Garson PWA** `/restoran/garson` — telefon/tabletten masaya sipariş (aynı ağ, 51234 portu
  installer'da firewall'da açılır). **Faz 4 ✓**

### Donanım / yazdırma
- **Sessiz termal yazdırma:** renderer her fiş için tam HTML yollar; gizli `BrowserWindow`'da
  `webContents.print({ silent:true, deviceName })` ile **Windows diyaloğu olmadan** basılır.
- **Yazıcı eşleme:** Kasa / Mutfak / Bar + `_default`, terminal başına (localStorage
  `sef_printer_map`). Mutfak işi birden çok hedefe ayrı ayrı gider.
- **Geri uyum:** tanımlı yazıcı yoksa `window.print()` diyaloğuna düşer (kırılmaz).

### Yönetim ve raporlama
- **Personel/garson hesapları:** ekle, şifre sıfırla, aktif/pasif; **seat lisans limiti** (maxUsers)
  aşılırsa 409.
- **Rezervasyon** yönetimi.
- **Raporlar** — satış/garson performansı.
- **Reçete → stok sarfiyatı:** ürün reçetesi tanımlı ise satışta hammadde stoktan ACID düşer.
- **Sadakat:** restoran müşterisi + puan işlemleri (`RestoranCustomers`, `RestoranLoyaltyTransactions`).
- **Kontrol Paneli** `/restoran/yonetim` (`--mode=control`, ayrı normal pencere): program
  açılmadan **tek yerden** her şeyi hazırla — durum kartları (DB/edition, lisans, kullanıcı seat),
  menü&masa, personel, rezervasyon, raporlar, yazıcılar, lisans aktivasyonu. Restaurant.jsx'teki
  5 modal `export` edilip burada **yeniden kullanılır (kod tekrarı yok)**.

> **Tam bağımsızlık:** Şef sürümünde teknik servis paneline/route'una **hiç** bağ yoktur;
> bilinmeyen yollar `/restoran`'a yönlenir.

---

## 6. Lisanslama ve modüller

**RSA-2048 imzalı, çevrimdışı, donanım bağlı** lisans:

- **Donanım bağlama:** anakart seri no + sistem UUID → **SHA-256 Hardware ID** (MAC fallback).
- **Şifreli depolama:** lisans dosyası HWID'den türetilen anahtarla **AES-256-GCM**, gizli `.tslic`.
- **Saat geri-alma koruması:** sentinel zaman damgaları (dosya + registry), 10 dakikada bir tazelenir.
- **Aktivasyon ekranı:** lisans yok/süre dolmuş → tüm özellikler kilitli; Hardware ID gösterilir.
- **Payload:** `{ modules[], maxUsers (seat), expiresAt }`. Uçlar `requireModule('X')` ile kapılı —
  UI gizlese de API 403 verir.
- **Yönetim paneli** (`license-manager/`): HWID + süre + modül seçerek lisans üretir; bilgisayar
  değişiminde kalan süre kadar **reissue**. *(`private.key` gizli, asla dağıtılmaz.)*

| Modül | Açıklama |
|-------|----------|
| **RESTAURANT** | ArcTeknik Şef'in tamamı |
| **B2B** | Web mağaza stok senkronizasyonu |
| **EFATURA** | e-Fatura — gelecekteki **ayrı uygulama** için üretilir (ERP'de işlevsiz) |
| ~~POS~~ | FastPOS askıda — üretimi kapalı; eski POS'lu lisanslar geçerli kalır |

---

## 7. Veritabanı tasarımı ve ACID

- **İki ayrı veritabanı:** `TEKNIKDB` (suite) / `ARCSEFDB` (restaurant) — edition'a göre seçilir.
  İlk çalıştırmada **otomatik** oluşturulur (manuel `CREATE DATABASE` gerekmez).
- **Idempotent (tekrar güvenli) şema:** her tablo `IF NOT EXISTS (sysobjects)`; her kolon
  `COL_LENGTH` kontrolüyle eklenir → her açılışta güvenle çalışır, mevcut veriyi bozmaz.
- **Ertelenmiş FK düzeltmesi (taze-DB tuzağı):** Bir tablo, referans verdiği tablodan **önce**
  oluşuyorsa taze DB'de `Could not create constraint or index` patlar. Bu yüzden `AuditLog→Users`,
  `Services→Users (AssignedTechnician)` gibi FK'ler tablo gövdesinden çıkarılıp, hedef tablo
  oluştuktan sonra **`sys.foreign_keys` + `OBJECT_ID` ile korumalı `ALTER`** olarak eklenir
  (mevcut DB'de çift FK olmaz, taze DB'de hata olmaz).
- **ACID transaction'lar:** stok düşümü/iadesi, restoran checkout, cari ekstre, belge zinciri,
  reçete sarfiyatı — hepsi tek transaction; kısmi başarı olmaz.

---

## 8. Yapılandırma şifreleme (HWID-AES)

### Ne / Neden
`.env` içindeki **DB şifresi** artık diskte düz metin durmaz. Forklanan Node sunucusunda
Electron `safeStorage` yok; bu yüzden lisans sistemiyle aynı yöntem kullanıldı.

### Nasıl (`server/config/secret.js`)
- `encryptSecret(plain)` → `enc:<base64>` *(anahtar = `SHA-256('TS-CONFIG-AES-v1::' + HWID)`,
  AES-256-GCM `[12B IV][16B TAG][veri]`)*.
- `decryptSecret(value)` → `enc:` öneki yoksa **düz metni aynen döndürür (geriye tam uyum)**;
  çözülemezse `''` (yanlış makine) → sihirbaz tekrar sorar.
- `bootstrapDb.js` okurken çözer, yazarken şifreler; `db.js` ilk açılışta eski düz-metin `.env`'i
  **bir kez** şifreye geçirir (best-effort, bağlantıyı engellemez).
- `.env` `%APPDATA%`'dadır (proje klasöründe değil) → destek için klasör kopyalamayı etkilemez.

---

## 9. Şef bağımsızlaştırma + installer küçültme (neden/nasıl)

### Sorun
Şef installer'ı Suite ile **aynı boyuttaydı (~120 MB)** — yani gereksiz teknik servis kodunu ve
ağır WhatsApp bağımlılıklarını da paketliyordu. Tek monolit `server/` her sürümde tüm rotaları
ve `node_modules`'ü yüklüyordu.

### Çözüm (kaynak fork DEĞİL — şişkinlik giderme)
1. **Sürüm bazlı rota ayrımı** (`server.js`): Paylaşılan uçlar her sürümde
   (`onboarding/auth/public/transactions/stocks/stock-*/users/settings/connection/audit` +
   `restoran*`). **Teknik-only** uçlar **yalnız suite**'te `if(!isRestaurantEdition)` içinde
   mount edilir: `customers/dashboard/services/media/accounts/documents/analytics/whatsapp`.
   Şef'te bu uçlar 404; `require()` **hiç** çalışmaz → arka planda teknik "kurulmaz".
2. **baileys/WhatsApp + reminders'ı boot'tan ayır:** `server.js` üst düzey
   `require('./services/whatsapp'|reminders')` kaldırıldı; yalnız suite'te lazy require edilir.
   `routes/setup.js` WhatsApp require'ı lazy + edition-aware yapıldı (Şef'te `/whatsapp` uçları
   404, modül hiç yüklenmez).
3. **Paketten dışla:** Şef artık baileys'i hiç yüklemediği için ağır bağımlılıklar
   `electron-builder-restaurant.json` filtresiyle çıkarıldı:
   `@whiskeysockets, libsignal, sharp, @img, protobufjs` (~35 MB WhatsApp kümesi). Ek olarak
   **her iki üründen** ölü ağırlık `javascript-obfuscator, class-validator, libphonenumber-js`
   (~26 MB; `dependencies`'te olmasına rağmen koddan **hiç** require edilmiyor) çıkarıldı.

### Doğrulama (rastgele kırılmasın diye)
Dışlanan dizinler geçici taşınıp **boot modül grafiği** require edildi:
**Şef 24/24, Suite 28/28, exit 0** — eksik modül yok. Paketlenen çıktıda 8 paketin de yokluğu
teyit edildi.

### Sonuç
| Installer | Önce | Sonra |
|-----------|------|-------|
| **ArcTeknik Şef** | 120.4 MB | **107.1 MB** |
| **Suite** | 114.8 MB | 114.8 MB (saf-JS sıkışıyor; ama artık güncel kod) |

> **Tablo gating reddedildi:** `Transactions→Services` ve `StockMovements→Documents` FK'leri
> Şef'in **paylaştığı** tablolarda. Teknik tabloları atlamak taze ARCSEFDB'de FK oluşumunu kırar.
> Boş teknik tabloları zararsız (hiçbir route yazmıyor) → bırakıldı.
>
> ⚠️ **DERS:** Paylaşılan `server/` veya `client/` değişince **iki installer da** yeniden
> derlenmeli (ikisi de aynı kaynağı paketler).

---

## 10. Online sipariş altyapısı (Faz 3 iskeleti)

Yemeksepeti / Getir / Trendyol / Migros gibi platformlardan sipariş almak için **iskelet hazır**
(gerçek entegrasyon API anahtarı gelince doldurulacak):

- `server/routes/restoranIntegrations.js` — admin: `GET /` durum + `PUT /:provider` config
  (gizli alanlar **maskeli**, şifreli saklanır).
- `server/routes/restoranWebhooks.js` — **açık uç** (JWT yok, dış servis çağırır): sağlayıcı
  imza doğrulaması; etkin değil → 503, imza geçersiz → 401, adaptör yok → 501.
- `server/services/restaurantIntegrations.js` — `isKnown/isEnabled/getStatus/saveConfig`,
  `verifyWebhook` (stub), `normalizeOrder` (şimdilik `NOT_IMPLEMENTED` fırlatır).
- Tümü `requireModule('RESTAURANT')`; özgül yollar `restoran`'dan önce mount edilir.

---

## 11. Kurulum, geliştirme ve derleme

### Son kullanıcı (önerilen)
1. **SQL Server Express** kurulu olmalı.
2. İlgili installer'ı çalıştır:
   - Suite: `desktop/release/Bayraktar_Yazilim_Suite_Setup.exe`
   - Şef: `desktop/release-restaurant/ArcTeknik_Sef_Setup.exe`
3. İlk açılışta **Kurulum Sihirbazı** SQL bağlantısını test eder, DB'yi (TEKNIKDB/ARCSEFDB)
   oluşturur, yöneticiyi tanımlar; sonra otomatik yeniden başlar.

### Geliştirme
```bash
# Backend
cd server && npm install && npm run dev
# Frontend
cd client && npm install && npm run dev      # http://localhost:3000
# Lisans üretici (yalnız üretim)
cd license-manager && npm install && npm start
```
Dev'de sürümü zorlamak: `ARC_EDITION=restaurant` (Şef) ortam değişkeni.

### Installer derleme (`desktop/`)
```powershell
cd client; npm run build            # ÖNCE taze client/dist
cd ../desktop
npm run dist -- --publish never     # Suite  → release/
npm run dist:restaurant             # Şef    → release-restaurant/
```
> **GOTCHA:** restaurant config'te `"publish": "never"` **yazma** — electron-builder onu provider
> sanıp `Cannot find module 'electron-publisher-never'` atar. Doğrusu: config `"publish": null` +
> script'te `--publish never`.

**Önemli `.env` değişkenleri:** `DB_SERVER/DB_USER/DB_PASSWORD/DB_NAME`, `JWT_SECRET`
(production zorunlu), `PUBLIC_FRONTEND_URL`, `ALLOWED_ORIGINS`, `APP_ROLE` (server/client),
`SEED_DEFAULT_ADMIN`.

---

## 12. Klasör yapısı ve destek için kopyalama

```
proje teknik/
├─ server/            # SSOT backend (Express, MSSQL, lisans, tüm rotalar+config)
│  ├─ routes/         # auth, services, stocks, restoran, restoranIntegrations, ...
│  ├─ services/       # whatsapp(baileys), reminders, license, restaurantIntegrations
│  └─ config/         # db.js, bootstrapDb.js, secret.js (HWID-AES), paths.js
├─ client/            # React + Vite (tek bundle; edition runtime ayrımı App.jsx)
│  └─ src/pages/      # Restaurant.jsx, RestaurantControl.jsx, RestaurantKitchen/Waiter, ...
├─ desktop/           # Electron paketleme
│  ├─ main.js         # mode/edition yönetimi, fork, splash, sessiz yazdırma, updater
│  ├─ package.json    # SUITE build config (release/)
│  ├─ electron-builder-restaurant.json  # ŞEF build config (release-restaurant/)
│  └─ installer*.nsh  # NSIS kısayolları + firewall
└─ license-manager/   # RSA lisans üretici (private.key GİZLİ)
```

> **Destek için kopyalama:** Çalışma verisi (`.env`, `setup.json`, lisans, log, yüklemeler)
> proje klasöründe **değil**, `%APPDATA%/<ürün adı>` altındadır. Kaynağı paylaşmak için bu klasörü
> kopyalamak yeterlidir; hassas çalışma sırları sızmaz. *(Tam "tek klasör = tek ürün" kaynak
> ayrımı yerine, bilinçli olarak monolit + sürüm-filtreli installer yaklaşımı korunuyor — bkz. §1, §9.)*

---

## 13. Güvenlik notları

- `license-manager/data/private.key` **asla** sürüm kontrolüne/pakete eklenmez (lisans imza anahtarı).
- WhatsApp oturum klasörleri (`.wwebjs_auth/`, `baileys-auth/`) git'e eklenmez; installer'dan da dışlanır.
- Production'da `NODE_ENV=production` + güçlü `JWT_SECRET` zorunlu.
- DB şifresi diskte **AES-256-GCM** ile şifreli (§8).
- Giriş ve müşteri sorgulama uçlarında **rate limit**; modül uçları `requireModule` ile API
  seviyesinde kapalı (UI gizlemesine güvenilmez).
- Tüm tablo/uç değişikliklerinden sonra **iki installer da** yeniden derlenmeli.

---

*Bu README projenin güncel mimari + özellik referansıdır. Detaylı ticari modül notları ayrıca
`license-manager/` ve ilgili sektör/yol-haritası belgelerinde tutulur.*
