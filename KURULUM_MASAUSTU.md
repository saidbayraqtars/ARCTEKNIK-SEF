# Teknik Servis — Masaüstü Kurulum Rehberi

Bu rehber, uygulamayı tarayıcı yerine **Windows masaüstü programı** (masaüstü kısayolu + kurulum sihirbazı) olarak çalıştırmanız içindir.

---

## Nasıl çalışır?

| Bileşen | Açıklama |
|---------|----------|
| **Electron** | Uygulama penceresini açar (Chrome tabanlı) |
| **Gömülü sunucu** | Arka planda Node.js API çalışır |
| **SQL Express** | Veritabanı; **TEKNIKDB otomatik oluşturulur** |
| **Veriler** | `%APPDATA%\teknik-servis-desktop\` altında (.env, fotoğraflar, WhatsApp oturumu) |

İlk açılışta sistem:
1. SQL Server Express’e bağlanmayı dener (`localhost\SQLEXPRESS`, Windows kimliği)
2. `TEKNIKDB` veritabanını yoksa **kendisi oluşturur**
3. Tabloları ve varsayılan `admin` kullanıcısını kurar
4. Uygulama penceresini açar

**Manuel `CREATE DATABASE` gerekmez.**

---

## Ön gereksinim: SQL Server Express (ELLE kurulur)

> ⚠️ **ÖNEMLİ:** Uygulama SQL'i otomatik kurmaz. Aşağıdaki adımlar atlanırsa
> sihirbazda **"getaddrinfo ENOTFOUND"** veya **"Login failed for user 'sa'"**
> hatası alırsınız. Sırayla yapın:

1. **İndirin:** [SQL Server Express](https://www.microsoft.com/tr-tr/sql-server/sql-server-downloads) (Custom/İndir-ve-Kur).
2. **Kurulum tipi:** "Custom" → **Database Engine Services**. Instance adı: **`SQLEXPRESS`**.
3. **Kimlik doğrulama modu:** **Mixed Mode (SQL Server + Windows)** seçin ve **`sa` şifresi** belirleyin (politikaya uygun: büyük+küçük+rakam+sembol, ör. `Arc1234.`). *(Bu adım şart — yoksa `sa` ile bağlanılamaz.)*
4. **TCP/IP'yi açın:** SQL Server Configuration Manager → SQL Server Network Configuration → Protocols for SQLEXPRESS → **TCP/IP = Enabled**. IPAll altında **TCP Port = 1433** (statik) verin.
5. **SQL Browser servisini başlatın:** Services (`services.msc`) → **SQL Server Browser** → Başlangıç tipi **Automatic** + **Başlat**. *(Named instance `localhost\SQLEXPRESS` için gerekli.)*
6. **`MSSQL$SQLEXPRESS` servisini yeniden başlatın** (TCP değişikliği otursun).
7. **Güvenlik duvarı (ağdan erişim için):** TCP **1433** ve UDP **1434** portlarını açın.

### Sihirbazda girilecekler
- **Sunucu:** `localhost\SQLEXPRESS` (veya statik port verdiyseniz `localhost`)
- **Kimlik:** SQL Server — kullanıcı `sa`, şifre (3. adımdaki).
- `(local)` **yazmayın** — sürücü onu çözemez.

### İsteğe bağlı: .env ile elle yapılandırma
`%APPDATA%\teknik-servis-desktop\.env`:

```env
DB_SERVER=localhost\SQLEXPRESS
DB_USE_WINDOWS_AUTH=false
DB_USER=sa
DB_PASSWORD=sizin_sifreniz
DB_NAME=TEKNIKDB
```

---

## Geliştirici: Masaüstünü test etme

```powershell
cd "proje teknik"
npm run install:all
npm run desktop:dev
```

Electron penceresi açılır; veritabanı otomatik kurulur.

---

## Kurulum paketi (.exe) oluşturma

Yönetici PowerShell:

```powershell
cd "proje teknik"
.\scripts\build-installer.ps1
```

Çıktı: `desktop\release\Teknik Servis Setup x.x.x.exe`

Kurulum sonrası:
- Başlat menüsü kısayolu
- **Masaüstü simgesi**
- Kaldırma: Denetim Masası → Programlar

### İkon dosyaları

Kurulum paketi için `desktop\assets\` klasörüne ekleyin:
- `icon.ico` (256×256, kurulum ve kısayol)
- `icon.png` (pencere simgesi)

Yoksa Electron varsayılan simge kullanır.

---

## Web panel vs masaüstü

| | Web (eski) | Masaüstü (yeni) |
|--|------------|-----------------|
| Başlatma | `npm run dev` + tarayıcı | Tek tık / kısayol |
| Veritabanı | Manuel TEKNIKDB | **Otomatik** |
| Port | 3000 + 5000 | Tek port (51234) |
| Veri yolu | `server/` klasörü | `%APPDATA%` |

Web modu hâlâ çalışır: `npm run dev:web`

---

## Sorun giderme

**“SQL Server bağlantısı kurulamadı”**
- SQL Express kurulu mu? Hizmet çalışıyor mu? (`services.msc` → SQL Server (SQLEXPRESS))
- `.env` içinde `DB_SERVER` doğru mu?
- Windows Auth için SQL’de oturum açma izni var mı?

**Pencere boş / beyaz ekran**
- `client` derlemesi yapılmış mı? (`npm run build:desktop`)
- Antivirüs 51234 portunu engelliyor olabilir

**WhatsApp QR**
- İlk kurulumda terminal/log yerine uygulama klasöründeki `wwebjs_auth` kullanılır (`%APPDATA%\...\wwebjs_auth`)

---

## Teknik mimari

```
[Kullanıcı] → Electron penceresi → http://127.0.0.1:51234
                                      ↓
                              Express (API + React dist)
                                      ↓
                              SQL Server Express / TEKNIKDB
```
