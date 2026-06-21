# Arctos (Vega) Ön Muhasebe / ERP — İnceleme Raporu

> Kaynak: `C:\arctos` (yüklü ve çalışır) · SQL Server `localhost\SQLEXPRESS` · veritabanı `VEGADB` (1798 tablo, ~1.8 GB).
> İnceleme tarihi: 2026-06-15. Veri tabloları demo/taze firmada boş; **şema, tanımlar ve uygulama yüzeyi** tam okundu.
> Amaç: Arctos'un çalışma mantığı + belge türlerini çıkarıp kendi ERP'mize benzer bir sistem uygulamak.

---

## 1. Kimlik ve Genel Yapı

**Arctos**, Vega Yazılım altyapısı üzerine kurulu **tam kapsamlı ticari + genel muhasebe ERP**'sidir (yalnız "ön muhasebe" değil — 7/A tek düzen hesap planı, yevmiye, çift taraflı muhasebe içerir).

Klasör yapısı (`C:\arctos`):
- `Bin\` (197 öğe) — ~150 ayrı **.exe modül** (her iş kolu ayrı çalıştırılabilir program).
- `Plugins\` (26 dll) — belge ekran genişletmeleri (`pluginBelge*`).
- `Lib\` (429) — ortak kütüphaneler. `cube\` — OLAP/rapor küpü. `ares\` — eski Access tabanlı modül (`Data.mdb`).
- `Data\` — `VEGADB.MDF` (SQL Server), `VegaSystemConfig.exe`.
- `Vega.Service\`, `Vega Update\` — Windows servisi + otomatik güncelleyici.

**Ana giriş:** `Arctos.exe` (launcher). Mimari = **çok-exe**: tek paylaşılan DB üzerinde onlarca bağımsız uygulama (`StokYonetimi`, `FasterPOS`, `Rapor`, `YoneticiPaneli`, `MustahsilMakbuzu`, `Plasiyer` …). Bizim "çift-exe" yaklaşımımızın aşırı genişlemiş hâli.

---

## 2. Veritabanı Mimarisi — Üç Katmanlı Ön-Ek Şeması

Vega tabloları isim ön-ekiyle kapsamlandırılır (çoklu firma + çoklu dönem):

| Ön-ek | Anlam | İçerik | Örnek |
|---|---|---|---|
| `TBL...` | **Ortak/sistem** | Ülke, il/ilçe, hesap planı şablonu, alan açıklamaları, parametreler | `TBLHESAPSABLONU`, `TBLULKELER` |
| `F0100TBL...` | **Firma (01)** | Master/tanım kartları — dönemler arası kalıcı | `F0100TBLCARI`, `F0100TBLSTOKLAR` |
| `F0100D0001TBL...` | **Firma+Dönem (01/0001)** | İşlem/hareket verisi — döneme özel (358 tablo) | `F0100D0001TBLHAREKET`, `...TBLFIS` |

> Bizdeki tek-firma/tek-dönem modelinin karşılığı: Vega her firma için master tabloları kopyalar, her muhasebe dönemi için hareket tablolarını kopyalar. Yıl/dönem kapanışı = yeni `D` seti + devir fişleri.

**Çekirdek tablolar:**
- `F0100D0001TBLHAREKET` — **evrensel kalem/hareket satırı** (her belgenin stok satırları burada).
- `F0100D0001TBLFIS` — **muhasebe fişi** (çift taraflı, yevmiye).
- `TBLHESAP` (999 satır) — **tek düzen hesap planı** (100 KASA, 102 BANKALAR, 120 ALICILAR…), `DBORC/DALACAK` dövizli, `KOD1-6` masraf boyutları.
- `F0100TBLCARI` — cari kart. `F0100TBLSTOKLAR` — stok kart.

---

## 3. Master Kart Modeli (alan zenginliği)

### Cari Kart (`F0100TBLCARI` — ~130 kolon)
Öne çıkanlar:
- Kimlik: `FIRMAKODU, FIRMAADI, UNVAN, VERGIDAIRESI, VERGINO, STCNO(TCKN), SICILNO, NACEKODU, GLNKODU`.
- Risk/finans: `RISKLIMITI, KREDILIMITI, KREDILIMITIKONTROL, ISKONTO, AYLIKVADE, TAKSITTIPI/GUNU, GECIKMEFAIZI, ODEMESEKLI, PARABIRIMI, KURTIPI, BAKIYE`.
- Davranış kilitleri: `SATISYAPILMASIN, ALISYAPILMASIN, SIPARISYAPILMASIN, TAHSILATYAPILMASIN, ODEMEYAPILMASIN, IADEFATURASIKESILMESIN` (cari bazında işlem yasakları).
- Kefil: `KEFIL1/2 + adres + telefon + TCKIMLIKNO + TAKIPKODU`.
- e-Belge: `EFATURAKULLANICISI, EFATURASENARYO, EIRSALIYE, ALIAS, EARSIVTESLIMTIPI`.
- KVKK/izin: `SMSIZNIVAR, KVKKIZNIVAR, SMSGONDER, EMAILGONDER`.
- Adres: ayrı `ADRESPOSTA / ADRESFATURA / ADRESSEVK`. Analiz: `KOD1..KOD7, GRUPKODU, SEKTOR, BOLGE`.

### Stok Kart (`F0100TBLSTOKLAR` — ~140 kolon)
- Kimlik: `STOKKODU, MALINCINSI, ANABIRIM, BIRIMEX(alt birim), ICMIKTAR, STOKGRUBU, URETICI, MENSEIIND`.
- Seviye: `KRITIKSEVIYE, ALTSEVIYE, USTSEVIYE, DEPOSEVIYESI, KALAN, REZERV` (kritik stok + rezerv).
- Fiyat: `ALISFIYATI, DALISFIYATI(döviz), DEFAULTALISFIYATI, MALIYET, KARORANI, HEDEFSATISFIAYTI, IMALATCISATISFIYATI`, **6 kademe iskontolu satış fiyatı** `ISKSATISFIYATI2..6`, `APB/DAPB(para birimi+kur)`.
- Vergi: `KDVGRUBU, ALISKDVORANI, OTV, OIV, TAXE`, **tevkifat** `TEVKIFATUYG/KODU/ORAN`, `ISTISNAKOD, OZELMATRAHKOD, IHRACKOD`.
- Takip: `STOKTAKIP(seri/lot), SERINO, RAFOMRU(SKT), GARANTI, ITSBILDIRIMI/UTSBILDIRIMI(ilaç takip), YAZARKASA`.
- 21 adet `KOD1..KOD21` analiz boyutu.

> **Çıkarım:** Vega'nın gücü "az tablo, çok kolon" + esnek `KOD` boyutları. Tek stok/cari kartı onlarca sektörü karşılar.

---

## 4. Belge (Evrak) Türleri

Vega'da her belge türü kendi **BASLIK (başlık) + HAREKET (kalem)** tablo çiftine sahiptir; kalemler ortak `TBLHAREKET` yapısını paylaşır. İsimlendirme = `[SAT|AL][FAT|IRS|SIP|...]`.

### 4.1 Ticari Belgeler (Alış/Satış)
| Belge | Tablolar | Stok | Cari |
|---|---|---|---|
| Satış Siparişi | `TBLVERSIPHAREKET / TBLVERSIPARISLINKS` | Rezerv | — |
| Alış Siparişi | `TBLALSIPHAREKET / TBLALSIPARISLINKS` | — | — |
| Satış İrsaliyesi | `TBLSATIRSHAREKET` | Çıkış | (faturada) |
| Alış İrsaliyesi | `TBLALIRSHAREKET` | Giriş | (faturada) |
| Satış Faturası | `TBLSATFATBASLIK / TBLSATFATHAREKET` | Çıkış | Borç |
| Alış Faturası | `TBLALFATHAREKET` | Giriş | Alacak |
| Vadeli Fatura | `TBLSATVADFATHAREKET / TBLALVADFATHAREKET` | ↑ | ↑ + ödeme planı |
| Proforma / Teklif | `TBLPROFATHAREKET / TBLSPTEKLIFHAREKET / TBLFIYATTEKLIFIODEMEPLANIHAREKET` | — | — |
| İade (alış/satış) | `TBLCARGIRIADEHAREKET / TBLCARCIKIADEHAREKET`, başlıkta `IADE` bayrağı | ters | ters |
| Müstahsil Makbuzu | `MustahsilMakbuzu.exe`, `TBLMUSTAHSIL*` | Giriş | Alacak + stopaj |
| İhracat / ETGB | `pluginIhracat`, `pluginBelgeETGB`, `TBLIHRACATPAKETTIPLERI` | Çıkış | döviz |
| Yolcu Beraberi (Tax-Free) | `pluginBelgeYolcuYanindaFatura`, `TBLTAXFREEPARAMETRELERI` | Çıkış | KDV iade |

**Satış Faturası başlığı** (`TBLSATFATBASLIK`) örnek alanlar: `BELGENO, TARIH, TUTAR, ARATOPLAM, KDV, PARABIRIMI, KUR, YUVARLAMA, ODENEN, TAHSILATTUTARI, MASRAF1-4 + MASRAFKDV1-4, TEVKIFATORAN, IADE, IPTAL, CONVERTED, BELGETIPI, EKBELGETIPI, STOKHAREKETEYAZ, CARIHAREKETEYAZ, MUHASEBELESMEYECEK, EFATURA/EFATURATIPI/EFATURAUUID/EFATURANO/SENTSTATUS, IRSALIYELIFATURA, YAZARKASAFISI`.
> Dikkat: `STOKHAREKETEYAZ` / `CARIHAREKETEYAZ` / `MUHASEBELESMEYECEK` = belgenin stok/cari/muhasebe etkisini **anahtarla aç/kapat**. Bizim `StockApplied/CariApplied` bayraklarımızın gelişmiş hâli (oluşturma anında seçilebilir).

### 4.2 Stok Belgeleri
Giriş/Çıkış fişi (`TBLSTKGIRHAREKET/TBLSTKCIKHAREKET`), Sayım (`TBLSAYIMGIRIS/CIKISHAREKET`), Devir (`TBLDEVGIRHAREKET`), Rezervasyon (`TBLREZERVGIRIS/CIKISHAREKET`), Depo sevkiyat/transfer (`TBLSEVKHAREKET, TBLSEVKEMRIHAREKET, DepoSevkiyat.exe`), Emanet (`EmanetStokTakibi.exe`), Fire/imha.

### 4.3 Cari Belgeleri
Borç/Alacak dekontu (`TBLCARGIRHAREKET/TBLCARCIKHAREKET`), Cari devir (`TBLCAR[GIR|CIK]DEVIRHAREKET`), Kur farkı (`TBLCARKARHAREKET`), Virman, Toplu cari bordro (`TBLTOPLUCARIBORDRO*`).

### 4.4 Kasa / Banka
Tahsilat/Ödeme (`TBLTAHSILHAREKET/TBLODEMEHAREKET`), Kasa (`TBLKASA`), Banka giriş/çıkış/virman (`TBLBANK[GIR|CIK|HAR]HAREKET`), EFT (`TBLEFTHAREKET`), Banka tahsilat/POS (`TBLBANKTAHSILHAREKET, TBLBNKVISATAHSILHAREKET`), POS Z raporu (`TBLPOSZRPHAREKET, kredikartZRaporlari.exe`).

### 4.5 Çek / Senet
Müşteri çeki/senedi giriş (`TBLCEKGIRIS/TBLSENETGIRIS`), kendi çek/senedimiz (`TBLSAHSICEKLER/TBLSAHSISENETLER`), portföy (`...PORTFOY`), çıkış/ciro (`TBLCEKCIKIS/TBLSENETCIKIS`), tahsil/karşılıksız (`TBLCEKHAREKETLERI`), icra/avukat takibi (`TBLICRAVUKAT*`).

### 4.6 Genel Muhasebe Fişleri
Mahsup / Tahsil / Tediye / Açılış / Kapanış fişleri → `TBLFIS` (`FISTIPI, YEVMIYE, BORC/ALACAK, KOD1-8`). Enflasyon muhasebesi (`TBLMUHENFFIS, TBLMUHENFISLEM, TBLMUHENFENDEKS`). Muhasebe entegrasyonu (`veMuhasebeEntegrasyonu.exe` → Logo/Mikro/Luca aktarımı). Belge→fiş otomatik muhasebeleşme (`TBLMUHBELGEHESAPKODUEX` = belge tipi → hesap kodu eşlemesi).

### 4.7 Üretim / Sektörel
Reçete + iş emri (`TBLMOBRECETEHAREKET, TBLMOBISEMRIHAREKET` mobilya; `TBLOPTRECETEHAREKET, TBLOPTCAMHAREKETLERI` optik; `TBLUREBELGE, TBLUREPLANSIPARIS` genel), Randıman (`pluginRandiman`), Metraj (`PluginMetraj`), Demirbaş/zimmet (`TBLDMBFAYDALIOMUR, veDemirbasZimmetFisi.exe`), Hal otomasyonu (`veHalOtomasyon`), Kira/sözleşme (`veKiraTakip`), Tarım/SGK (`veTarimBildirim, TarimBildirim, pluginSGKFatura`).

### 4.8 e-Dönüşüm (e-Belge)
`TBLMUHBELGETANIMEX` (107 satır) = e-Fatura/e-Arşiv **alan-formül eşlemesi** (TIP: 2=toplamlar, 3=kalem, 8=kodlar, 12=vergi). e-İrsaliye (`pluginEIrsaliyeEkBilgiler`), e-Belge başlık (`TBLMUHBELGEBASLIK/DETAY`).

---

## 5. Belge Zinciri ve İş Akışı

- **Zincir:** Sipariş → İrsaliye → Fatura (alış ve satış ayrı). Bağlar `TBL...LINKS` ve `TBLBELGELEME / TBLBELGELEMELINKS` tablolarında tutulur (bizim `SourceDocumentID` mantığı, ama çok-kaynaklı: 3 irsaliye → 1 fatura "toplu faturalama" `TBLTOPLUFATURAYAZDIR`).
- **Süreç takibi:** `BelgeSurecTakip.exe` + başlıktaki `SUREC_IND` — belge onay/iş akışı durumu.
- **Toplu işlemler:** `TopBelgeOlustur, TopBelgeIslemleri, TopCariMuh, TopStokMuh` — toplu belge/muhasebe üretimi.
- **Ödeme planı:** `TBLBELGEODEMEPLANIBASLIK/HAREKET` — vadeli belgeye taksit planı.
- **İptal:** `TBLIPTALBELGELER` + başlıkta `IPTAL` bayrağı (silmez, iptal işaretler — bizdeki gibi).

---

## 6. Öne Çıkan Yetenekler (bizde olmayan / kısmi olanlar)

| Yetenek | Vega | Bizim ERP (mevcut) |
|---|---|---|
| Çoklu firma + çoklu dönem | ✓ (F/D ön-ek) | ✗ (tek firma) |
| Genel muhasebe (yevmiye, 7/A) | ✓ (`TBLFIS`, `TBLHESAP`) | ✗ |
| Muhasebe entegrasyonu (Logo/Mikro) | ✓ | ✗ |
| Satır-bazlı çoklu para + kur | ✓ (`TBLHAREKET.PARABIRIMI/KUR`) | ✓ (yeni — belge bazında) |
| 6 kademe iskonto | ✓ (`ISK1..6`) | ✗ (tek iskonto oranı) |
| Tevkifat / OTV / OİV / gümrük | ✓ | ✗ (sadece KDV) |
| Çoklu depo + transfer/sevk | ✓ (`DEPO`, sevk emri) | ✗ (tek depo) |
| Seri/lot + SKT (raf ömrü) takibi | ✓ (`STOKTAKIP, SERINO, RAFOMRU`) | ✗ |
| Çek/senet portföy yönetimi | ✓ | ✗ |
| Risk/kredi limiti + işlem kilitleri | ✓ (cari kartta) | kısmi (cari bakiye var) |
| Fiyat listeleri / iskonto kartı | ✓ (`SATISKARTI`) | ✗ |
| Çok boyutlu analiz (`KOD1..N`) | ✓ (cari 7, stok 21, fiş 8) | ✗ |
| Üretim (reçete/iş emri/randıman) | ✓ | kısmi (Şef reçete→sarfiyat) |
| e-Fatura/e-Arşiv/e-İrsaliye | ✓ entegre | ✗ (ayrı uygulamaya taşındı) |
| Belge bazında stok/cari/muhasebe etkisi anahtarı | ✓ (`STOKHAREKETEYAZ` vb.) | kısmi (`StockApplied/CariApplied`) |

Bizde **daha iyi/eşit** olanlar: modern web/Electron arayüz, lisans-modül mimarisi, sektör özellik bayrakları, WhatsApp/B2B entegrasyonu, otomatik yedek, RBAC.

---

## 7. Kendi ERP'mize Uygulama Önerisi (Yol Haritası)

Mevcut modelimiz (`Documents` + `DocType` ayrımcısı, `Teklif→Sipariş→İrsaliye→Fatura` zinciri, `Stocks`, `CurrentAccounts`, `Transactions`, yeni çoklu para) Vega'nın **çekirdek mantığıyla uyumlu** — eksik olan derinlik. Önerilen fazlar:

**Faz A — Belge modelini güçlendir (düşük risk, yüksek değer)**
1. Belge başlığına Vega'daki etki-anahtarları: `StokEtkile / CariEtkile / MuhasebeEtkile` (oluşturmada seçilebilir) — şu an otomatik.
2. Kalem modeline: çoklu iskonto (`ISK1..3`), tevkifat alanları (zaten stok kartına eklenebilir), masraf dağıtımı (`MASRAF1-4`).
3. Belgeye ödeme planı/taksit tablosu (`BELGEODEMEPLANI`).
4. Toplu faturalama: N irsaliye → 1 fatura (çok-kaynaklı `SourceDocumentID` → ara bağ tablosu `DocumentLinks`).

**Faz B — Stok derinliği**
5. **Çoklu depo** (`Warehouses` + hareketlerde `WarehouseID` + transfer/sevk belgesi).
6. **Seri/lot + SKT** takibi (`StockLots`).
7. Fiyat listeleri / müşteri iskonto kartı.

**Faz C — Cari/Finans derinliği**
8. Cari risk/kredi limiti + işlem kilitleri (kartta bayraklar).
9. **Çek/senet portföy** modülü (giriş/çıkış/ciro/tahsil + durum).
10. Çok boyutlu analiz kodları (`Kod1..N` cari/stok/işlemde — opsiyonel, sektöre göre özellik bayrağıyla).

**Faz D — Muhasebe (büyük, ayrı modül)**
11. Tek düzen hesap planı + belge→fiş otomatik muhasebeleşme (belge tipi→hesap kodu eşlemesi).
12. Mali müşavir için Logo/Mikro/Luca **muhasebe aktarımı** (e-defter öncesi en çok istenen).

**Faz E — Çoklu firma/dönem** (en büyük mimari değişiklik)
13. Vega'nın F/D ön-ek yerine bizde `CompanyID + PeriodID` kolonları + dönem kapanış/devir akışı. Tek-firma müşteriler etkilenmez (varsayılan 1 firma / açık dönem).

> Mimari ilke (Vega'dan ders): **"az tablo + zengin kolon + esnek KOD boyutları"** tek kod tabanını çok sektöre taşır. Bizim sektör-özellik-bayrağı sistemimiz bu esnekliği UI tarafında zaten sağlıyor; veri tarafında da `Kod*` analiz boyutları + etki-anahtarlarıyla aynı yöne gidebiliriz.

---

## 8. Teknik Notlar (entegrasyon için)
- DB: SQL Server (Express). Master cari/stok firma-düzey, hareketler dönem-düzey.
- Bağlantı: Windows auth ile `localhost\SQLEXPRESS` üzerinden okunabildi (config'te düz bağlantı dizesi yok — Vega registry/şifreli tutuyor).
- Veri taşıma/karşılaştırma araçları mevcut: `VegaExport.exe, DBManager.exe, DBMerger.exe, VJSONCompare.exe, MetinAktar.exe` — bir müşteriyi Arctos'tan bizim ERP'ye geçirmek istenirse `VegaExport` çıktısı + `F0100TBLCARI/STOKLAR` doğrudan okunabilir.
