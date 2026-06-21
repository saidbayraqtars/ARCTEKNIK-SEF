const sql = require('mssql');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const { getEnvPath } = require('./paths');
const { ensureDatabaseExists, ensureDesktopEnv, importDbInit, buildConfig, DB_NAME } = require('./bootstrapDb');

// Note: server.js loadEnv() is responsible for the initial dotenv.config().
// connectDatabase() below reloads with override:true after setup/sql/save to
// pick up newly-written DB credentials without restarting the process.

let pool = null;
let reconnecting = null; // eşzamanlı istekler tek yeniden-bağlanmayı paylaşır (stampede koruması)

// Eski kurulumlarda .env'deki DB_PASSWORD düz metin olabilir → ilk açılışta
// HWID-bağlı AES ile şifrele (disk üstünde). process.env düz kalır (bağlantı çalışır).
const migratePlaintextPassword = () => {
    try {
        const { isEncrypted } = require('./secret');
        const { setEnvVars } = require('./bootstrapDb');
        const pw = process.env.DB_PASSWORD;
        if (pw && !isEncrypted(pw)) {
            setEnvVars({ DB_PASSWORD: pw }); // setEnvVars DB_PASSWORD'ü şifreler
        }
    } catch { /* göç best-effort — bağlantıyı engelleme */ }
};

const connectDatabase = async () => {
    if (process.env.DESKTOP_MODE === '1') {
        ensureDesktopEnv();
        // Installer'ın yazdığı .dbinit (SQL sessiz kurulum sa şifresi) varsa .env'e
        // şifreli aktar; dotenv override ardından yeni bilgileri yükler.
        importDbInit();
        dotenv.config({ path: getEnvPath(), override: true });
        migratePlaintextPassword();
    }

    // İstemci modu: uzak sunucudaki mevcut veritabanına doğrudan bağlan (keşif/oluşturma yok).
    if (process.env.APP_ROLE === 'client') {
        const config = buildConfig(DB_NAME, { role: 'client' });
        pool = await new sql.ConnectionPool(config).connect();
        pool.on('error', (err) => console.error('SQL havuz hatası:', err.message));
        console.log(`SQL Server (istemci → ${config.server}:${config.port || 1433}/${DB_NAME}) bağlantısı başarılı.`);
        return pool;
    }

    await ensureDatabaseExists();

    const config = buildConfig(DB_NAME);
    pool = await new sql.ConnectionPool(config).connect();
    pool.on('error', (err) => console.error('SQL havuz hatası:', err.message));
    console.log(`SQL Server (${DB_NAME}) bağlantısı başarılı.`);
    return pool;
};

// Havuzu döndürür; bağlantı düşmüşse (SQL servisi yeniden başladı, ağ koptu)
// otomatik yeniden bağlanır. Eşzamanlı çağrılar TEK reconnect denemesini bekler —
// her istek ayrı havuz açmaya kalkmaz.
const getPool = async () => {
    if (pool && pool.connected) return pool;
    if (!reconnecting) {
        reconnecting = (async () => {
            try {
                if (pool) {
                    try { await pool.close(); } catch { /* zaten kopuk */ }
                    pool = null;
                    console.warn('SQL bağlantısı düşmüş — yeniden bağlanılıyor...');
                }
                return await connectDatabase();
            } finally {
                reconnecting = null;
            }
        })();
    }
    await reconnecting;
    return pool;
};

const initializeDatabase = async () => {
    // İstemci modunda şema/tablo oluşturma uzak sunucunun sorumluluğundadır.
    if (process.env.APP_ROLE === 'client') {
        await getPool(); // bağlantıyı doğrula
        console.log('İstemci modu: şema oluşturma atlandı (uzak sunucu yönetir).');
        return;
    }

    try {
        const db = await getPool();

        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Customers' and xtype='U')
            BEGIN
                CREATE TABLE Customers (
                    CustomerID INT IDENTITY(1,1) PRIMARY KEY,
                    FullName NVARCHAR(255) NOT NULL,
                    Phone NVARCHAR(50) NOT NULL,
                    Address NVARCHAR(500) NULL,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);

        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Devices' and xtype='U')
            BEGIN
                CREATE TABLE Devices (
                    DeviceID INT IDENTITY(1,1) PRIMARY KEY,
                    CustomerID INT NOT NULL FOREIGN KEY REFERENCES Customers(CustomerID),
                    Brand NVARCHAR(100) NOT NULL,
                    Model NVARCHAR(100) NOT NULL,
                    SerialNumber NVARCHAR(100) NULL,
                    Password NVARCHAR(100) NULL,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);

        // Oto servis (araç) sektörü için araç kartı alanları — diğer sektörlerde NULL kalır.
        const deviceColumns = [
            ['Plate', 'NVARCHAR(20) NULL'],      // plaka (araç birincil kimliği, geçmiş sorgu)
            ['ChassisNo', 'NVARCHAR(40) NULL'],  // şasi / şase no (VIN)
            ['Mileage', 'INT NULL'],             // km
            ['FuelType', 'NVARCHAR(20) NULL'],   // benzin/dizel/LPG/hibrit/elektrik
            ['ModelYear', 'INT NULL'],
            ['Color', 'NVARCHAR(30) NULL'],
        ];
        for (const [col, def] of deviceColumns) {
            await db.request().query(`
                IF COL_LENGTH('Devices', '${col}') IS NULL
                BEGIN ALTER TABLE Devices ADD ${col} ${def} END
            `);
        }

        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Services' and xtype='U')
            BEGIN
                CREATE TABLE Services (
                    ServiceID INT IDENTITY(1,1) PRIMARY KEY,
                    DeviceID INT NOT NULL FOREIGN KEY REFERENCES Devices(DeviceID),
                    FaultDescription NVARCHAR(MAX) NOT NULL,
                    Status NVARCHAR(50) DEFAULT 'Teslim Alındı',
                    EstimatedPrice DECIMAL(10,2) NULL,
                    EntryDate DATETIME DEFAULT GETDATE(),
                    ExitDate DATETIME NULL,
                    TechnicianNotes NVARCHAR(MAX) NULL
                )
            END
        `);

        await db.request().query(`
            IF COL_LENGTH('Services', 'CostPrice') IS NULL
            BEGIN ALTER TABLE Services ADD CostPrice DECIMAL(10,2) NULL END
        `);

        const serviceColumns = [
            ['CustomerApproval', 'NVARCHAR(30) NULL'],
            ['ApprovalAt', 'DATETIME NULL'],
            ['AssignedTechnicianID', 'INT NULL'],
            ['WarrantyMonths', 'INT NULL'],
            ['WarrantyUntil', 'DATETIME NULL'],
            ['WarrantyDescription', 'NVARCHAR(500) NULL'],
            ['MaintenanceReminderMonths', 'INT NULL'],
            ['ReadyAt', 'DATETIME NULL'],
            ['LastPickupReminderAt', 'DATETIME NULL'],
            ['LastMaintenanceReminderAt', 'DATETIME NULL'],
            // Toplu (B2B) kabulde aynı anda gelen cihazları gruplamak için.
            ['BatchId', 'NVARCHAR(50) NULL'],
        ];
        for (const [col, def] of serviceColumns) {
            await db.request().query(`
                IF COL_LENGTH('Services', '${col}') IS NULL
                BEGIN ALTER TABLE Services ADD ${col} ${def} END
            `);
        }

        // Atanan teknisyen → Users FK (ON DELETE SET NULL). Kullanıcı hard-delete edilse
        // bile (normalde soft-delete) servis kaydı kalır, atama NULL olur. Önce yetim
        // değerleri temizle (silinmiş/eski kullanıcı id'leri) ki FK kurulabilsin.
        await db.request().query(`
            IF OBJECT_ID('Users') IS NOT NULL AND COL_LENGTH('Services', 'AssignedTechnicianID') IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Services_AssignedTech')
            BEGIN
                UPDATE Services SET AssignedTechnicianID = NULL
                WHERE AssignedTechnicianID IS NOT NULL
                  AND AssignedTechnicianID NOT IN (SELECT UserID FROM Users);
                ALTER TABLE Services ADD CONSTRAINT FK_Services_AssignedTech
                    FOREIGN KEY (AssignedTechnicianID) REFERENCES Users(UserID) ON DELETE SET NULL;
            END
        `);

        // Denetim İzi (Audit Trail) — kritik işlemler (silme/iptal/devir/pasife alma)
        // kim+ne+ne zaman olarak loglanır. Username snapshot tutulur (kullanıcı silinse de okunur).
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='AuditLog' and xtype='U')
            BEGIN
                CREATE TABLE AuditLog (
                    AuditID INT IDENTITY(1,1) PRIMARY KEY,
                    -- FK → Users SONRADAN eklenir (Users bu tablodan SONRA oluşturulur;
                    -- taze DB'de inline FK 'invalid table Users' hatası veriyordu). Bkz. aşağı ALTER.
                    UserID INT NULL,
                    Username NVARCHAR(100) NULL,
                    Action NVARCHAR(50) NOT NULL,
                    Entity NVARCHAR(50) NULL,
                    EntityID NVARCHAR(50) NULL,
                    Detail NVARCHAR(1000) NULL,
                    CreatedAt DATETIME NOT NULL DEFAULT GETDATE()
                )
                CREATE INDEX IX_AuditLog_Id ON AuditLog(AuditID DESC)
                CREATE INDEX IX_AuditLog_Entity ON AuditLog(Entity, EntityID)
            END
        `);

        // Bireysel/Kurumsal (B2B) müşteri ayrımı ve fatura bilgileri için ek kolonlar.
        const customerColumns = [
            ['CustomerType', "NVARCHAR(20) NOT NULL DEFAULT 'Bireysel'"],
            ['TaxOffice', 'NVARCHAR(150) NULL'],
            ['TaxNumber', 'NVARCHAR(50) NULL'],
        ];
        for (const [col, def] of customerColumns) {
            await db.request().query(`
                IF COL_LENGTH('Customers', '${col}') IS NULL
                BEGIN ALTER TABLE Customers ADD ${col} ${def} END
            `);
        }

        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Transactions' and xtype='U')
            BEGIN
                CREATE TABLE Transactions (
                    TransactionID INT IDENTITY(1,1) PRIMARY KEY,
                    ServiceID INT NULL FOREIGN KEY REFERENCES Services(ServiceID),
                    Amount DECIMAL(10,2) NOT NULL,
                    Type NVARCHAR(20) NOT NULL,
                    Description NVARCHAR(500) NULL,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);

        await db.request().query(`
            IF COL_LENGTH('Transactions', 'PaymentMethod') IS NULL
            BEGIN ALTER TABLE Transactions ADD PaymentMethod NVARCHAR(50) DEFAULT 'Nakit' END
        `);

        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ServiceHistory' and xtype='U')
            BEGIN
                CREATE TABLE ServiceHistory (
                    HistoryID INT IDENTITY(1,1) PRIMARY KEY,
                    ServiceID INT NOT NULL FOREIGN KEY REFERENCES Services(ServiceID),
                    OldStatus NVARCHAR(50) NULL,
                    NewStatus NVARCHAR(50) NOT NULL,
                    ChangedBy NVARCHAR(100) DEFAULT 'Sistem',
                    ChangedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);

        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Users' and xtype='U')
            BEGIN
                CREATE TABLE Users (
                    UserID INT IDENTITY(1,1) PRIMARY KEY,
                    Username NVARCHAR(100) NOT NULL UNIQUE,
                    PasswordHash NVARCHAR(255) NOT NULL,
                    FullName NVARCHAR(255) NOT NULL,
                    Role NVARCHAR(50) NOT NULL DEFAULT 'Teknisyen',
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);

        await db.request().query(`
            IF COL_LENGTH('Users', 'Permissions') IS NULL
            BEGIN ALTER TABLE Users ADD Permissions NVARCHAR(MAX) NULL END
        `);

        // ArcTeknik Şef — dokunmatik PIN girişi: hızlı giriş için sayısal PIN (bcrypt hash).
        // Parola yedek kalır (admin). Garson/personel PIN ile saniyede girer.
        await db.request().query(`
            IF COL_LENGTH('Users', 'Pin') IS NULL
            BEGIN ALTER TABLE Users ADD Pin NVARCHAR(255) NULL END
        `);

        // AuditLog.UserID → Users(UserID) FK'sini BURADA ekle (Users artık kesin var).
        // Mevcut DB'de inline auto-isimli FK zaten olabilir → referans varsa ATLA (çift FK yok).
        // Taze DB'de AuditLog inline FK olmadan oluştu → bu ALTER bağlar. ON DELETE SET NULL.
        await db.request().query(`
            IF OBJECT_ID('AuditLog') IS NOT NULL AND OBJECT_ID('Users') IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1 FROM sys.foreign_keys
                   WHERE parent_object_id = OBJECT_ID('AuditLog')
                     AND referenced_object_id = OBJECT_ID('Users')
               )
            BEGIN
                ALTER TABLE AuditLog ADD CONSTRAINT FK_AuditLog_User
                    FOREIGN KEY (UserID) REFERENCES Users(UserID) ON DELETE SET NULL
            END
        `);

        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ServiceMedia' and xtype='U')
            BEGIN
                CREATE TABLE ServiceMedia (
                    MediaID INT IDENTITY(1,1) PRIMARY KEY,
                    ServiceID INT NOT NULL FOREIGN KEY REFERENCES Services(ServiceID) ON DELETE CASCADE,
                    MediaType NVARCHAR(30) NOT NULL,
                    FileName NVARCHAR(255) NOT NULL,
                    OriginalName NVARCHAR(255) NULL,
                    MimeType NVARCHAR(100) NULL,
                    FileSize INT NULL,
                    UploadedBy NVARCHAR(100) NULL,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);

        // Stok / Yedek Parça envanteri.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Stocks' and xtype='U')
            BEGIN
                CREATE TABLE Stocks (
                    StockID INT IDENTITY(1,1) PRIMARY KEY,
                    Name NVARCHAR(255) NOT NULL,
                    Barcode NVARCHAR(100) NULL,
                    Quantity INT NOT NULL DEFAULT 0,
                    PurchasePrice DECIMAL(10,2) NULL,
                    SalePrice DECIMAL(10,2) NULL,
                    CriticalLevel INT NOT NULL DEFAULT 0,
                    CreatedAt DATETIME DEFAULT GETDATE(),
                    UpdatedAt DATETIME NULL
                )
            END
        `);

        // Servise kullanılan parçalar. Maliyet/satış fiyatı KAYIT ANINDA snapshot'lanır;
        // stok fiyatı sonradan değişse veya stok silinse bile servisin net kârı bozulmaz.
        // ServiceID -> CASCADE (servis silinince parça kayıtları da silinir, ServiceMedia gibi).
        // StockID  -> SET NULL (stok silinse bile geçmiş parça kaydı korunur, snapshot sayesinde).
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ServiceParts' and xtype='U')
            BEGIN
                CREATE TABLE ServiceParts (
                    ServicePartID INT IDENTITY(1,1) PRIMARY KEY,
                    ServiceID INT NOT NULL FOREIGN KEY REFERENCES Services(ServiceID) ON DELETE CASCADE,
                    StockID INT NULL FOREIGN KEY REFERENCES Stocks(StockID) ON DELETE SET NULL,
                    PartName NVARCHAR(255) NOT NULL,
                    Quantity INT NOT NULL DEFAULT 1,
                    UnitPurchasePrice DECIMAL(10,2) NULL,
                    UnitSalePrice DECIMAL(10,2) NULL,
                    CreatedBy NVARCHAR(100) NULL,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);

        // Firma ayarları — tek satırlık (Id=1) yapılandırma tablosu (fiş/etiket için).
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='CompanySettings' and xtype='U')
            BEGIN
                CREATE TABLE CompanySettings (
                    Id INT NOT NULL PRIMARY KEY,
                    CompanyName NVARCHAR(255) NULL,
                    LogoUrl NVARCHAR(MAX) NULL,
                    Phone NVARCHAR(100) NULL,
                    Address NVARCHAR(500) NULL,
                    Email NVARCHAR(255) NULL,
                    Website NVARCHAR(255) NULL,
                    LegalTerms NVARCHAR(MAX) NULL,
                    UpdatedAt DATETIME DEFAULT GETDATE()
                )
                INSERT INTO CompanySettings (Id, CompanyName, Phone, Address, LegalTerms)
                VALUES (
                    1, N'ARCTEKNİK', N'', N'',
                    N'1) Cihaz, teslim sırasında belirtilen arıza için kabul edilmiştir; tespit edilemeyen gizli arızalardan firmamız sorumlu değildir.
2) Teslim tarihinden itibaren 30 gün içinde teslim alınmayan cihazlardan firmamız sorumlu tutulamaz.
3) Verilen garanti yalnızca yapılan işlem ve değiştirilen parça için geçerlidir; sıvı teması, düşme ve fiziksel darbe garanti kapsamı dışındadır.
4) Cihaz içindeki veri/bilgilerin yedeklenmesi müşterinin sorumluluğundadır; olası veri kaybından firmamız sorumlu değildir.
5) Bu fişi imzalayan müşteri yukarıdaki şartları okuyup kabul etmiş sayılır.'
                )
            END
        `);

        // Firma ayarlarına Vergi Dairesi alanı (Kurulum Sihirbazı Adım 1 için).
        await db.request().query(`
            IF COL_LENGTH('CompanySettings', 'TaxOffice') IS NULL
            BEGIN ALTER TABLE CompanySettings ADD TaxOffice NVARCHAR(150) NULL END
        `);

        // Firma tipi (sektör) — kurulumda seçilir; arayüz başlığı ve hazır mesaj
        // şablonları buna göre tohumlanır. Varsayılan 'teknik_servis' (geri uyum).
        await db.request().query(`
            IF COL_LENGTH('CompanySettings', 'CompanyType') IS NULL
            BEGIN ALTER TABLE CompanySettings ADD CompanyType NVARCHAR(50) NOT NULL DEFAULT 'teknik_servis' END
        `);

        // Ekran/özellik bayrakları (sektör varsayılanını ezen JSON override).
        // { featureKey: true/false }. Boş → sektör varsayılanları geçerli.
        // Bkz. utils/featureProfiles.js (efektif = lisans && (override ?? sektör)).
        await db.request().query(`
            IF COL_LENGTH('CompanySettings', 'FeatureFlags') IS NULL
            BEGIN ALTER TABLE CompanySettings ADD FeatureFlags NVARCHAR(MAX) NULL END
        `);

        // ─── Yazdırma Dizaynları (Dizayn Düzenleyici) ─────────────────────────
        // Kullanıcının GrapesJS ile düzenlediği şablonlar. TemplateKey:
        // 'service-receipt' | 'document' | 'service-label'. Satır yoksa koddaki
        // varsayılan şablona düşülür. Alt-orta marka (reklam) render'da daima eklenir.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='PrintTemplates' and xtype='U')
            BEGIN
                CREATE TABLE PrintTemplates (
                    TemplateKey NVARCHAR(50) NOT NULL PRIMARY KEY,
                    Html NVARCHAR(MAX) NULL,
                    Css NVARCHAR(MAX) NULL,
                    PageSize NVARCHAR(20) NULL,
                    UpdatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);
        // Seçenek tabanlı dizayn: kullanıcı ayarları JSON olarak Options'ta tutulur.
        await db.request().query(`
            IF COL_LENGTH('PrintTemplates', 'Options') IS NULL
            BEGIN ALTER TABLE PrintTemplates ADD Options NVARCHAR(MAX) NULL END
        `);

        // B2B Web Mağaza Entegrasyonu — Stocks web alanları.
        await db.request().query(`
            IF COL_LENGTH('Stocks', 'ShowOnWeb') IS NULL
            BEGIN ALTER TABLE Stocks ADD ShowOnWeb BIT NOT NULL DEFAULT 0 END
        `);
        await db.request().query(`
            IF COL_LENGTH('Stocks', 'WebDescription') IS NULL
            BEGIN ALTER TABLE Stocks ADD WebDescription NVARCHAR(MAX) NULL END
        `);

        // Kritik stok uyarısı parça bazında kapatılabilir; eski kayıtlar varsayılan AÇIK.
        await db.request().query(`
            IF COL_LENGTH('Stocks', 'AlertEnabled') IS NULL
            BEGIN ALTER TABLE Stocks ADD AlertEnabled BIT NOT NULL DEFAULT 1 END
        `);

        // ─── Gelişmiş Stok: Kategori / Marka / Çoklu Barkod ───────────────────
        // Kurumsal geçiş ve perakende onboarding için ürün kartına kategori, marka
        // ve sınırsız alt barkod (varyant) bağlanabilir. Hepsi idempotent oluşturulur.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Categories' and xtype='U')
            BEGIN
                CREATE TABLE Categories (
                    CategoryID INT IDENTITY(1,1) PRIMARY KEY,
                    Name NVARCHAR(200) NOT NULL UNIQUE,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);

        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Brands' and xtype='U')
            BEGIN
                CREATE TABLE Brands (
                    BrandID INT IDENTITY(1,1) PRIMARY KEY,
                    Name NVARCHAR(200) NOT NULL UNIQUE,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);

        // Bir ürün kartına bağlı ek barkodlar (varyant/koli vb.). Barcode genelinde
        // benzersizdir; stok silinince alt barkodlar da silinir (CASCADE).
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ProductBarcodes' and xtype='U')
            BEGIN
                CREATE TABLE ProductBarcodes (
                    BarcodeID INT IDENTITY(1,1) PRIMARY KEY,
                    StockID INT NOT NULL FOREIGN KEY REFERENCES Stocks(StockID) ON DELETE CASCADE,
                    Barcode NVARCHAR(100) NOT NULL UNIQUE,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);

        // Stocks → Categories / Brands ilişkileri (önce kolon, sonra FK; idempotent).
        await db.request().query(`
            IF COL_LENGTH('Stocks', 'CategoryID') IS NULL
            BEGIN ALTER TABLE Stocks ADD CategoryID INT NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('Stocks', 'BrandID') IS NULL
            BEGIN ALTER TABLE Stocks ADD BrandID INT NULL END
        `);
        await db.request().query(`
            IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Stocks_Categories')
            BEGIN
                ALTER TABLE Stocks ADD CONSTRAINT FK_Stocks_Categories
                    FOREIGN KEY (CategoryID) REFERENCES Categories(CategoryID)
            END
        `);
        await db.request().query(`
            IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Stocks_Brands')
            BEGIN
                ALTER TABLE Stocks ADD CONSTRAINT FK_Stocks_Brands
                    FOREIGN KEY (BrandID) REFERENCES Brands(BrandID)
            END
        `);

        // ─── e-Fatura / e-Arşiv: Gelen Fatura (Inbound XML) ───────────────────
        // Toptancılardan gelen resmi faturalar burada saklanır; "Stoğa Aktar"
        // işlemi process-inbound ucu ile tek ACID transaction'da uygulanır.
        // IsProcessed=1 olunca bir daha stoğa/cariye işlenemez (mükerrer koruması).
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='InboundInvoices' and xtype='U')
            BEGIN
                CREATE TABLE InboundInvoices (
                    InboundInvoiceID INT IDENTITY(1,1) PRIMARY KEY,
                    ETTN UNIQUEIDENTIFIER NULL,
                    InvoiceNumber NVARCHAR(50) NULL,
                    SupplierTaxNumber NVARCHAR(11) NULL,
                    SupplierName NVARCHAR(255) NULL,
                    TotalAmount DECIMAL(18,4) NOT NULL DEFAULT 0,
                    InvoiceDate DATETIME NULL,
                    IsProcessed BIT NOT NULL DEFAULT 0,
                    RawXml NVARCHAR(MAX) NULL,
                    ProcessedAt DATETIME NULL,
                    AccountID INT NULL,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
                CREATE INDEX IX_InboundInvoices_Processed ON InboundInvoices(IsProcessed, CreatedAt DESC)
            END
        `);

        // e-Fatura Entegratör Ayarları — CompanySettings üzerinde tek satır (Id=1).
        // Şifre bu uygulamada lokal/masaüstü saklanır; genel GET /settings'te DÖNMEZ.
        const eInvoiceColumns = [
            ['EInvoiceProvider', 'NVARCHAR(100) NULL'],     // entegratör firma adı
            ['EInvoiceUsername', 'NVARCHAR(150) NULL'],
            ['EInvoicePassword', 'NVARCHAR(255) NULL'],
            ['EInvoicePrefix', "NVARCHAR(10) NULL"],        // fatura ön eki (ARC, POS...)
            ['EInvoiceTestMode', 'BIT NOT NULL DEFAULT 1'],
        ];
        for (const [col, def] of eInvoiceColumns) {
            await db.request().query(`
                IF COL_LENGTH('CompanySettings', '${col}') IS NULL
                BEGIN ALTER TABLE CompanySettings ADD ${col} ${def} END
            `);
        }

        // B2B Web Mağaza Entegrasyonu — CompanySettings köprü ayarları.
        await db.request().query(`
            IF COL_LENGTH('CompanySettings', 'B2BLicenseKey') IS NULL
            BEGIN ALTER TABLE CompanySettings ADD B2BLicenseKey NVARCHAR(255) NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('CompanySettings', 'B2BApiEndpoint') IS NULL
            BEGIN ALTER TABLE CompanySettings ADD B2BApiEndpoint NVARCHAR(500) NULL END
        `);

        // ─── Gelişmiş Cari (Açık Hesap) Yönetimi ──────────────────────────────
        // Cari Kartlar: Alıcı (müşteri/veresiye), Satıcı (toptancı/borç), Personel.
        // Balance işareti: carinin BİZE olan net borcu.
        //   Balance > 0  → cari bize borçlu (alacağımız; ör. müşteri veresiyesi)
        //   Balance < 0  → biz cariye borçluyuz (ör. toptancıya mal borcu)
        // CustomerID: mevcut Customers kaydına esnek bağ (varsa). Veri taşınmaz,
        // ihtiyaç anında (lazy) müşteriden cari kart üretilir.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='CurrentAccounts' and xtype='U')
            BEGIN
                CREATE TABLE CurrentAccounts (
                    AccountID INT IDENTITY(1,1) PRIMARY KEY,
                    Name NVARCHAR(255) NOT NULL,
                    Type NVARCHAR(20) NOT NULL DEFAULT 'Alıcı',
                    Phone NVARCHAR(50) NULL,
                    TaxOffice NVARCHAR(150) NULL,
                    TaxNumber NVARCHAR(50) NULL,
                    Balance DECIMAL(12,2) NOT NULL DEFAULT 0,
                    CustomerID INT NULL FOREIGN KEY REFERENCES Customers(CustomerID) ON DELETE SET NULL,
                    Note NVARCHAR(500) NULL,
                    CreatedAt DATETIME DEFAULT GETDATE(),
                    UpdatedAt DATETIME NULL
                )
            END
        `);

        // Mal Alım Fişi (toptancıdan stok girişi). Stok artışı + Satıcı carisine borç.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='StockReceipts' and xtype='U')
            BEGIN
                CREATE TABLE StockReceipts (
                    ReceiptID INT IDENTITY(1,1) PRIMARY KEY,
                    AccountID INT NULL FOREIGN KEY REFERENCES CurrentAccounts(AccountID) ON DELETE SET NULL,
                    TotalAmount DECIMAL(12,2) NOT NULL DEFAULT 0,
                    Note NVARCHAR(500) NULL,
                    CreatedBy NVARCHAR(100) NULL,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);

        // Fiş kalemleri — fiyat/ad KAYIT ANINDA snapshot'lanır (stok sonradan değişse de fiş bozulmaz).
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='StockReceiptItems' and xtype='U')
            BEGIN
                CREATE TABLE StockReceiptItems (
                    ItemID INT IDENTITY(1,1) PRIMARY KEY,
                    ReceiptID INT NOT NULL FOREIGN KEY REFERENCES StockReceipts(ReceiptID) ON DELETE CASCADE,
                    StockID INT NULL FOREIGN KEY REFERENCES Stocks(StockID) ON DELETE SET NULL,
                    Name NVARCHAR(255) NOT NULL,
                    Quantity INT NOT NULL DEFAULT 1,
                    UnitPurchasePrice DECIMAL(10,2) NOT NULL DEFAULT 0,
                    LineTotal DECIMAL(12,2) NOT NULL DEFAULT 0
                )
            END
        `);

        // Cari Hareketler (ekstre). Her hareket BalanceAfter snapshot'ı taşır.
        //   Borçlandır   → Balance += Amount (cari bize borçlandı; ör. müşteri veresiyesi)
        //   Alacaklandır → Balance -= Amount (biz cariye borçlandık; ör. mal alımı)
        //   Tahsilat     → Balance -= Amount (+ Kasa'ya Gelir)  müşteriden para alındı
        //   Ödeme        → Balance += Amount (+ Kasa'ya Gider)  toptancıya para verildi
        // RelatedCashTxnID: Tahsilat/Ödeme'nin Kasa (Transactions) karşılığı.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='AccountTransactions' and xtype='U')
            BEGIN
                CREATE TABLE AccountTransactions (
                    AccountTransactionID INT IDENTITY(1,1) PRIMARY KEY,
                    AccountID INT NOT NULL FOREIGN KEY REFERENCES CurrentAccounts(AccountID) ON DELETE CASCADE,
                    Type NVARCHAR(20) NOT NULL,
                    Amount DECIMAL(12,2) NOT NULL,
                    Description NVARCHAR(500) NULL,
                    BalanceAfter DECIMAL(12,2) NULL,
                    PaymentMethod NVARCHAR(50) NULL,
                    RelatedServiceID INT NULL,
                    RelatedStockReceiptID INT NULL,
                    RelatedCashTxnID INT NULL,
                    CreatedBy NVARCHAR(100) NULL,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);

        // ─── Belge Zinciri: Teklif → Sipariş → İrsaliye → Fatura ──────────────
        // Tek başlık tablosu (Documents) tüm belge türlerini taşır; her tür aynı
        // yapıyı (cari + kalemler + KDV + toplamlar) paylaşır, davranışı DocType ile
        // ayrılır. Veri modeli e-Fatura'ya hazır (Ettn, Scenario, EInvoiceStatus).
        //   Teklif/Sipariş  → finansal/stok etkisi YOK (sadece kayıt).
        //   İrsaliye        → stok ÇIKIŞI (StockApplied).
        //   Fatura          → cariye Borç + (önceki irsaliye yoksa) stok ÇIKIŞI.
        // Party* alanları KAYIT ANINDA snapshot'lanır (cari sonradan değişse de belge bozulmaz).
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Documents' and xtype='U')
            BEGIN
                CREATE TABLE Documents (
                    DocumentID INT IDENTITY(1,1) PRIMARY KEY,
                    DocType NVARCHAR(20) NOT NULL,            -- 'Teklif','Siparis','Irsaliye','Fatura'
                    DocNo NVARCHAR(40) NOT NULL,              -- ör. FAT2026000000001
                    Series NVARCHAR(10) NULL,                 -- 'TEK','SIP','IRS','FAT'
                    Direction NVARCHAR(10) NOT NULL DEFAULT 'Satis', -- 'Satis' / 'Alis'
                    AccountID INT NULL FOREIGN KEY REFERENCES CurrentAccounts(AccountID) ON DELETE SET NULL,
                    CustomerID INT NULL,
                    PartyName NVARCHAR(255) NULL,
                    PartyTaxOffice NVARCHAR(150) NULL,
                    PartyTaxNumber NVARCHAR(50) NULL,
                    PartyAddress NVARCHAR(500) NULL,
                    PartyPhone NVARCHAR(50) NULL,
                    Status NVARCHAR(30) NOT NULL DEFAULT 'Taslak',
                    IssueDate DATETIME NOT NULL DEFAULT GETDATE(),
                    DueDate DATETIME NULL,
                    Currency NVARCHAR(5) NOT NULL DEFAULT 'TRY',
                    SubTotal DECIMAL(14,2) NOT NULL DEFAULT 0,      -- KDV hariç matrah (indirim sonrası)
                    DiscountTotal DECIMAL(14,2) NOT NULL DEFAULT 0,
                    VatTotal DECIMAL(14,2) NOT NULL DEFAULT 0,
                    GrandTotal DECIMAL(14,2) NOT NULL DEFAULT 0,
                    Note NVARCHAR(MAX) NULL,
                    Ettn UNIQUEIDENTIFIER NULL,
                    Scenario NVARCHAR(30) NULL,
                    EInvoiceStatus NVARCHAR(30) NULL,
                    SourceDocumentID INT NULL,
                    StockApplied BIT NOT NULL DEFAULT 0,
                    CariApplied BIT NOT NULL DEFAULT 0,
                    RelatedCashTxnID INT NULL,
                    CreatedBy NVARCHAR(100) NULL,
                    CreatedAt DATETIME DEFAULT GETDATE(),
                    UpdatedAt DATETIME NULL
                )
                CREATE INDEX IX_Documents_Type ON Documents(DocType, CreatedAt DESC)
                CREATE INDEX IX_Documents_Account ON Documents(AccountID)
            END
        `);

        // Belge kalemleri — ad/fiyat/oran KAYIT ANINDA snapshot'lanır.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='DocumentItems' and xtype='U')
            BEGIN
                CREATE TABLE DocumentItems (
                    DocItemID INT IDENTITY(1,1) PRIMARY KEY,
                    DocumentID INT NOT NULL FOREIGN KEY REFERENCES Documents(DocumentID) ON DELETE CASCADE,
                    StockID INT NULL FOREIGN KEY REFERENCES Stocks(StockID) ON DELETE SET NULL,
                    Name NVARCHAR(255) NOT NULL,
                    Description NVARCHAR(500) NULL,
                    Quantity DECIMAL(12,3) NOT NULL DEFAULT 1,
                    Unit NVARCHAR(20) NOT NULL DEFAULT 'Adet',
                    UnitPrice DECIMAL(14,2) NOT NULL DEFAULT 0,    -- KDV hariç birim fiyat
                    DiscountRate DECIMAL(5,2) NOT NULL DEFAULT 0,  -- %
                    VatRate DECIMAL(5,2) NOT NULL DEFAULT 20,      -- %
                    LineNet DECIMAL(14,2) NOT NULL DEFAULT 0,      -- (qty*price) - indirim
                    LineVat DECIMAL(14,2) NOT NULL DEFAULT 0,
                    LineTotal DECIMAL(14,2) NOT NULL DEFAULT 0,    -- net + KDV
                    SortOrder INT NOT NULL DEFAULT 0
                )
            END
        `);

        // Ön Muhasebe — belge kalemine 2. ve 3. kademe zincirleme iskonto.
        // Varsayılan 0 → eski tek-iskonto davranışı korunur (geriye uyum).
        // NOT: DocumentItems CREATE'inden SONRA çalışmalı (fresh DB sıralaması).
        // OBJECT_ID guard: tablo yoksa ALTER hiç çalışmaz (fresh DB'de "Cannot find
        // object DocumentItems" çökmesini önler — sıra bozulsa bile güvenli).
        await db.request().query(`
            IF OBJECT_ID('DocumentItems', 'U') IS NOT NULL AND COL_LENGTH('DocumentItems', 'DiscountRate2') IS NULL
            BEGIN ALTER TABLE DocumentItems ADD DiscountRate2 DECIMAL(5,2) NOT NULL CONSTRAINT DF_DocItems_Disc2 DEFAULT 0 END
        `);
        await db.request().query(`
            IF OBJECT_ID('DocumentItems', 'U') IS NOT NULL AND COL_LENGTH('DocumentItems', 'DiscountRate3') IS NULL
            BEGIN ALTER TABLE DocumentItems ADD DiscountRate3 DECIMAL(5,2) NOT NULL CONSTRAINT DF_DocItems_Disc3 DEFAULT 0 END
        `);

        // Belge numara sayaçları — tür+seri+yıl başına. ACID transaction içinde UPDLOCK ile artırılır.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='DocumentCounters' and xtype='U')
            BEGIN
                CREATE TABLE DocumentCounters (
                    CounterKey NVARCHAR(40) NOT NULL PRIMARY KEY,  -- ör. 'FAT-2026'
                    LastNo INT NOT NULL DEFAULT 0
                )
            END
        `);

        // Stok Hareket Defteri — her giriş/çıkış burada loglanır (tam izlenebilirlik).
        // Mevcut akışlar (mal alımı, satış, servis, POS) buraya hareket yazar; ayrıca
        // manuel giriş/çıkış (sayım/fire/iade) bu defter üzerinden yapılır.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='StockMovements' and xtype='U')
            BEGIN
                CREATE TABLE StockMovements (
                    MovementID INT IDENTITY(1,1) PRIMARY KEY,
                    StockID INT NULL FOREIGN KEY REFERENCES Stocks(StockID) ON DELETE SET NULL,
                    StockName NVARCHAR(255) NULL,            -- snapshot
                    Direction NVARCHAR(10) NOT NULL,         -- 'Giris' / 'Cikis'
                    Reason NVARCHAR(30) NOT NULL,            -- 'Mal Alımı','Satış','Fatura','İrsaliye','Sayım','Fire','İade','Manuel','Servis'
                    Quantity DECIMAL(12,3) NOT NULL,         -- her zaman pozitif
                    QuantityAfter INT NULL,                  -- işlem sonrası stok adedi (snapshot)
                    UnitPrice DECIMAL(14,2) NULL,
                    RelatedDocumentID INT NULL,
                    RelatedReceiptID INT NULL,
                    RelatedServiceID INT NULL,
                    Note NVARCHAR(500) NULL,
                    CreatedBy NVARCHAR(100) NULL,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
                CREATE INDEX IX_StockMovements_Stock ON StockMovements(StockID, CreatedAt DESC)
            END
        `);

        // ─── Çapraz Uygulama Haberdarlığı (AppEvents) ─────────────────────────
        // Üç ayrı uygulama (FastPOS / Servis Paneli / e-Fatura) ayrı süreçlerdir,
        // ama TEK veritabanını paylaşır. Süreçler arası "gerçek zamanlı" bildirim
        // bu paylaşılan tablo üzerinden yapılır: her uygulama önemli olayları buraya
        // yazar (POS satışı, gelen fatura stoğa işlendi, servis hazır...), diğer
        // uygulamalar da kısa aralıklı sorgu (polling) ile yeni olayları "çan"da gösterir.
        // İstemci son gördüğü EventID'yi tutar → sunucu durumsuz kalır.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='AppEvents' and xtype='U')
            BEGIN
                CREATE TABLE AppEvents (
                    EventID INT IDENTITY(1,1) PRIMARY KEY,
                    SourceApp NVARCHAR(20) NOT NULL,         -- 'POS','SERVIS','EFATURA','SYSTEM'
                    EventType NVARCHAR(50) NOT NULL,         -- 'pos.sale','einvoice.inbound.processed',...
                    Title NVARCHAR(255) NULL,
                    Message NVARCHAR(1000) NULL,
                    RefTable NVARCHAR(50) NULL,              -- ilgili kayıt tablosu (opsiyonel)
                    RefID INT NULL,                          -- ilgili kayıt id (opsiyonel)
                    Payload NVARCHAR(MAX) NULL,              -- JSON ek veri
                    Severity NVARCHAR(20) NOT NULL DEFAULT 'info', -- info|success|warning|error
                    CreatedBy NVARCHAR(100) NULL,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
                CREATE INDEX IX_AppEvents_Id ON AppEvents(EventID DESC)
            END
        `);

        // Fatura/belge PDF başlığı için firma vergi no + IBAN alanları.
        await db.request().query(`
            IF COL_LENGTH('CompanySettings', 'TaxNumber') IS NULL
            BEGIN ALTER TABLE CompanySettings ADD TaxNumber NVARCHAR(50) NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('CompanySettings', 'IBAN') IS NULL
            BEGIN ALTER TABLE CompanySettings ADD IBAN NVARCHAR(50) NULL END
        `);

        // ─── v1.8.x Sağlamlaştırma (Hardening) Göçleri ────────────────────────
        // e-Fatura finansal bütünlük + güvenlik düzeltmeleri. Hepsi idempotent:
        // mevcut veriyi bozmaz, kolon tipini yalnızca gerekiyorsa genişletir.

        // 1) Küsuratlı stok: Stocks.Quantity INT → DECIMAL(18,3) (kg/metre/litre).
        //    Mevcut tam sayı değerler x.000 olur; veri kaybı yok.
        //    DİKKAT: ALTER COLUMN, kolona BAĞLI HER nesneye takılır → SQL 4922
        //    ("one or more objects access this column") + 5074 ("object X is dependent on column").
        //    Eski sürümlerden kalma veritabanlarında Quantity üzerinde DEFAULT dışında
        //    CHECK constraint, indeks veya kullanıcı istatistiği de olabilir. Bu yüzden tipi
        //    değiştirmeden önce BAĞLI TÜM nesneleri (default + check + nonclustered indeks +
        //    user-stat) dinamik olarak bulup düşürürüz, sonra default'u geri ekleriz.
        //    Idempotent: yalnızca kolon hâlâ 'int' iken çalışır; tekrar çalıştırmada no-op.
        await db.request().query(`
            IF EXISTS (
                SELECT 1 FROM sys.columns c JOIN sys.types t ON c.user_type_id = t.user_type_id
                WHERE c.object_id = OBJECT_ID('Stocks') AND c.name = 'Quantity' AND t.name = 'int')
            BEGIN
                DECLARE @qid INT = (SELECT column_id FROM sys.columns WHERE object_id = OBJECT_ID('Stocks') AND name = 'Quantity');
                DECLARE @sql NVARCHAR(MAX) = N'';
                -- DEFAULT constraint (isimli veya isimsiz)
                SELECT @sql += 'ALTER TABLE Stocks DROP CONSTRAINT [' + dc.name + '];'
                FROM sys.default_constraints dc
                WHERE dc.parent_object_id = OBJECT_ID('Stocks') AND dc.parent_column_id = @qid;
                -- Quantity'ye atıf yapan CHECK constraint'ler
                SELECT @sql += 'ALTER TABLE Stocks DROP CONSTRAINT [' + cc.name + '];'
                FROM sys.check_constraints cc
                WHERE cc.parent_object_id = OBJECT_ID('Stocks') AND cc.definition LIKE '%Quantity%';
                -- Quantity içeren nonclustered indeksler (PK/unique constraint hariç)
                SELECT @sql += 'DROP INDEX [' + i.name + '] ON Stocks;'
                FROM sys.indexes i
                JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                WHERE i.object_id = OBJECT_ID('Stocks') AND ic.column_id = @qid
                  AND i.type = 2 AND i.is_primary_key = 0 AND i.is_unique_constraint = 0;
                -- Kullanıcı istatistikleri (auto-stat'ları ALTER kendisi yönetir)
                SELECT @sql += 'DROP STATISTICS Stocks.[' + s.name + '];'
                FROM sys.stats s
                JOIN sys.stats_columns sc ON s.object_id = sc.object_id AND s.stats_id = sc.stats_id
                WHERE s.object_id = OBJECT_ID('Stocks') AND sc.column_id = @qid AND s.user_created = 1;
                IF @sql <> N'' EXEC sys.sp_executesql @sql;
                ALTER TABLE Stocks ALTER COLUMN Quantity DECIMAL(18,3) NOT NULL;
            END
            -- Default'u garanti altına al (yukarıda düşürülmüş veya hiç olmamış olabilir)
            IF NOT EXISTS (
                SELECT 1 FROM sys.default_constraints dc
                JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
                WHERE c.object_id = OBJECT_ID('Stocks') AND c.name = 'Quantity')
                ALTER TABLE Stocks ADD CONSTRAINT DF_Stocks_Quantity DEFAULT 0 FOR Quantity;
        `);
        // Hareket defteri snapshot'ı da küsuratlı olmalı (yoksa yuvarlanır).
        await db.request().query(`
            IF EXISTS (
                SELECT 1 FROM sys.columns c JOIN sys.types t ON c.user_type_id = t.user_type_id
                WHERE c.object_id = OBJECT_ID('StockMovements') AND c.name = 'QuantityAfter' AND t.name = 'int')
            BEGIN ALTER TABLE StockMovements ALTER COLUMN QuantityAfter DECIMAL(18,3) NULL END
        `);

        // Kullanıcı pasife alma (soft-delete): silmek yerine IsActive=0.
        // Geçmiş kayıt (servis/fatura/stok) bağları korunur; pasif kullanıcı girişe
        // çıkamaz ve seat (lisans) kotasından sayılmaz. Mevcut kullanıcılar aktif (1).
        await db.request().query(`
            IF COL_LENGTH('Users', 'IsActive') IS NULL
            BEGIN ALTER TABLE Users ADD IsActive BIT NOT NULL DEFAULT 1 END
        `);

        // 2) Stok kartına KDV oranı — gelen faturadan okunup yazılır, satışta kullanılır.
        await db.request().query(`
            IF COL_LENGTH('Stocks', 'VatRate') IS NULL
            BEGIN ALTER TABLE Stocks ADD VatRate DECIMAL(5,2) NULL END
        `);

        // 3) Entegratör şifresi artık AES-256-GCM ile şifreli saklanır → blob daha
        //    uzun. Kolonu 255 → 512'ye genişlet (idempotent, sadece genişletir).
        await db.request().query(`
            IF EXISTS (
                SELECT 1 FROM sys.columns
                WHERE object_id = OBJECT_ID('CompanySettings') AND name = 'EInvoicePassword' AND max_length < 1024)
            BEGIN ALTER TABLE CompanySettings ALTER COLUMN EInvoicePassword NVARCHAR(512) NULL END
        `);

        // 4) Giden fatura gönderim izlenebilirliği (gerçek ETTN/entegratör akışı).
        await db.request().query(`
            IF COL_LENGTH('Documents', 'EInvoiceSentAt') IS NULL
            BEGIN ALTER TABLE Documents ADD EInvoiceSentAt DATETIME NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('Documents', 'EInvoiceProviderRef') IS NULL
            BEGIN ALTER TABLE Documents ADD EInvoiceProviderRef NVARCHAR(100) NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('Documents', 'EInvoiceError') IS NULL
            BEGIN ALTER TABLE Documents ADD EInvoiceError NVARCHAR(500) NULL END
        `);

        // 5) Gelen fatura: döviz + KDV + alıcı VKN izlenebilirliği.
        await db.request().query(`
            IF COL_LENGTH('InboundInvoices', 'Currency') IS NULL
            BEGIN ALTER TABLE InboundInvoices ADD Currency NVARCHAR(3) NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('InboundInvoices', 'TaxTotal') IS NULL
            BEGIN ALTER TABLE InboundInvoices ADD TaxTotal DECIMAL(18,4) NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('InboundInvoices', 'BuyerTaxNumber') IS NULL
            BEGIN ALTER TABLE InboundInvoices ADD BuyerTaxNumber NVARCHAR(11) NULL END
        `);

        // 6) ESKİ VERİ TEMİZLİĞİ — sahte NEWID() ETTN düzeltmesi.
        //    Hardening öncesi her Fatura'ya lokal rastgele ETTN atanıp durumu
        //    'Hazır'/'GİB'e Gönderildi' kalıyordu (gerçekte GÖNDERİLMEDİ).
        //    Gerçekten gönderilen faturalar artık EInvoiceSentAt + EInvoiceProviderRef
        //    taşır; bunlar ASLA dokunulmaz. Yalnızca hiç gönderilmemiş sahte
        //    kayıtların ETTN'i NULL'lanır, durumu 'Taslak'a döner. Koşul kendini
        //    sınırlar → idempotent (tekrar çalışınca etkisiz).
        await db.request().query(`
            UPDATE Documents
            SET Ettn = NULL, EInvoiceStatus = 'Taslak', UpdatedAt = GETDATE()
            WHERE DocType = 'Fatura'
              AND Ettn IS NOT NULL
              AND EInvoiceSentAt IS NULL
              AND EInvoiceProviderRef IS NULL
        `);

        // ─── v1.9 Aşama 2 (P1) Ticari Esneklik Göçleri ───────────────────────
        // 7) Stok kartına Birim (Unit) — 'Adet','KG','Metre','Litre'. Adet ise tam
        //    sayı, diğerlerinde küsuratlı miktar (DECIMAL Quantity ile uyumlu).
        await db.request().query(`
            IF COL_LENGTH('Stocks', 'Unit') IS NULL
            BEGIN ALTER TABLE Stocks ADD Unit NVARCHAR(20) NOT NULL CONSTRAINT DF_Stocks_Unit DEFAULT 'Adet' END
        `);

        // 8) Belge tahsilatlarını kasaya bağla: Transactions.DocumentID. Belge
        //    üzerinden (Teklif/İrsaliye/Fatura) alınan kısmi/tam ödemeler bu kolonla
        //    belgeye iliştirilir → "Kalan Alacak" = GrandTotal − SUM(Gelir). FK SET
        //    NULL: belge silinse bile kasa hareketi geçmişte korunur. Idempotent.
        await db.request().query(`
            IF COL_LENGTH('Transactions', 'DocumentID') IS NULL
            BEGIN ALTER TABLE Transactions ADD DocumentID INT NULL END
        `);
        await db.request().query(`
            IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Transactions_Documents')
            AND OBJECT_ID('Documents') IS NOT NULL
            BEGIN
                ALTER TABLE Transactions ADD CONSTRAINT FK_Transactions_Documents
                    FOREIGN KEY (DocumentID) REFERENCES Documents(DocumentID) ON DELETE SET NULL
            END
        `);

        // ─── Çoklu Para Birimi (TCMB Döviz) ──────────────────────────────────
        // Stok fiyatları + belgeler (Teklif/Fatura) yabancı para biriminde olabilir.
        // Belge düzenlenirken o günün TCMB kuru çekilir; cari/kasa TL tabanlı
        // kaldığından dövizli belgenin TL karşılığı (GrandTotalTRY) ayrıca tutulur.

        // 9a) TCMB kur önbelleği — istenen takvim günü + para birimi anahtarlı.
        //     EffectiveDate: TCMB'nin gerçekten yayınladığı gün (tatilde geri yürünür).
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ExchangeRates' and xtype='U')
            BEGIN
                CREATE TABLE ExchangeRates (
                    RateDate DATE NOT NULL,
                    Currency NVARCHAR(5) NOT NULL,
                    ForexBuying DECIMAL(18,6) NULL,      -- Döviz Alış (faturada kullanılan)
                    ForexSelling DECIMAL(18,6) NULL,     -- Döviz Satış
                    BanknoteBuying DECIMAL(18,6) NULL,   -- Efektif Alış
                    EffectiveDate DATE NULL,
                    Source NVARCHAR(30) NULL,
                    FetchedAt DATETIME DEFAULT GETDATE(),
                    CONSTRAINT PK_ExchangeRates PRIMARY KEY (RateDate, Currency)
                )
            END
        `);

        // 9b) Stok kartına para birimi — fiyatlar (alış/satış) bu birimde yorumlanır.
        await db.request().query(`
            IF COL_LENGTH('Stocks', 'Currency') IS NULL
            BEGIN ALTER TABLE Stocks ADD Currency NVARCHAR(5) NOT NULL CONSTRAINT DF_Stocks_Currency DEFAULT 'TRY' END
        `);

        // 9b-2) Oto yedek parça sektörü için stok kartı alanları — diğer sektörlerde NULL.
        const partsStockColumns = [
            ['OemCode', 'NVARCHAR(60) NULL'],        // OEM / orijinal parça kodu (şasi/OEM ile sorgu)
            ['VehicleCompat', 'NVARCHAR(500) NULL'], // uyumlu araçlar (serbest metin)
            ['PartType', 'NVARCHAR(20) NULL'],       // 'orijinal' | 'muadil'
        ];
        for (const [col, def] of partsStockColumns) {
            await db.request().query(`
                IF COL_LENGTH('Stocks', '${col}') IS NULL
                BEGIN ALTER TABLE Stocks ADD ${col} ${def} END
            `);
        }

        // 9c) Belgeye kur + TL karşılığı + kur kaynağı. GrandTotalTRY cari/kasa ve
        //     özet/raporlamada kullanılır (farklı para birimleri TL'de toplanabilsin).
        await db.request().query(`
            IF COL_LENGTH('Documents', 'ExchangeRate') IS NULL
            BEGIN ALTER TABLE Documents ADD ExchangeRate DECIMAL(18,6) NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('Documents', 'GrandTotalTRY') IS NULL
            BEGIN ALTER TABLE Documents ADD GrandTotalTRY DECIMAL(14,2) NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('Documents', 'RateSource') IS NULL
            BEGIN ALTER TABLE Documents ADD RateSource NVARCHAR(30) NULL END
        `);
        // Geçmiş (TL) belgeleri normalize et: kur=1, GrandTotalTRY=GrandTotal.
        await db.request().query(`
            UPDATE Documents
            SET ExchangeRate = ISNULL(ExchangeRate, 1),
                GrandTotalTRY = ISNULL(GrandTotalTRY, GrandTotal)
            WHERE ExchangeRate IS NULL OR GrandTotalTRY IS NULL
        `);

        // 9d) Ön Muhasebe — belge etki anahtarları (Vega STOKHAREKETEYAZ deseni).
        //     Belgenin stok/cari etkisini belge başına elle aç-kapat. NULL = belge
        //     türü varsayılanı (İrsaliye/Fatura→stok, Fatura→cari). Örn: hizmet
        //     faturasında stoğu kapat, İrsaliye'de cariyi aç. Geriye uyum: eski
        //     belgeler NULL kalır → çalışma anında tür varsayılanına düşer.
        await db.request().query(`
            IF COL_LENGTH('Documents', 'AffectsStock') IS NULL
            BEGIN ALTER TABLE Documents ADD AffectsStock BIT NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('Documents', 'AffectsCari') IS NULL
            BEGIN ALTER TABLE Documents ADD AffectsCari BIT NULL END
        `);

        // 9e) Ön Muhasebe — belge ödeme planı / vade-taksit. Bir belge (özellikle
        //     Fatura) birden çok taksite bölünebilir; her taksit kendi vade+tutarı
        //     ile. Tutar belge para biriminde; ödeme durumu toplam tahsilatın (TL)
        //     FIFO dağıtımıyla hesaplanır (çalışma anında). Belge silinince CASCADE.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='DocumentInstallments' and xtype='U')
            BEGIN
                CREATE TABLE DocumentInstallments (
                    InstallmentID INT IDENTITY(1,1) PRIMARY KEY,
                    DocumentID INT NOT NULL,
                    SeqNo INT NOT NULL,
                    DueDate DATETIME NOT NULL,
                    Amount DECIMAL(14,2) NOT NULL,
                    Note NVARCHAR(200) NULL,
                    CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                    CONSTRAINT FK_DocInst_Doc FOREIGN KEY (DocumentID)
                        REFERENCES Documents(DocumentID) ON DELETE CASCADE
                )
                CREATE INDEX IX_DocInst_Doc ON DocumentInstallments(DocumentID, SeqNo)
                CREATE INDEX IX_DocInst_Due ON DocumentInstallments(DueDate)
            END
        `);

        // 9f) Ön Muhasebe — toplu faturalama (N İrsaliye → 1 Fatura) ters bağı.
        //     SourceDocumentID tek-ebeveyn (ileri) bağı taşır; toplu faturada bir
        //     Fatura birden çok İrsaliye'den doğar. Her kaynak İrsaliye'ye hangi
        //     Fatura'ya girdiğinin (geri) bağı yazılır → Fatura detayında kaynak
        //     irsaliyeler listelenir. NULL = tekil/normal belge.
        await db.request().query(`
            IF COL_LENGTH('Documents', 'InvoicedByID') IS NULL
            BEGIN ALTER TABLE Documents ADD InvoicedByID INT NULL END
        `);

        // 10) Ön Muhasebe — masraf dağıtımı (landed cost) Mal Alım Fişi'nde.
        //     Ek masraflar (nakliye/gümrük/sigorta) fiş kalemlerine dağıtılır →
        //     her kalemin gerçek maliyeti (landed cost) Stocks.PurchasePrice'a
        //     yazılır. Dağıtım tabanı: 'tutar' | 'miktar' | 'agirlik'.
        //     ExtraCharges = JSON [{desc, amount}]; ExtraTotal = toplam.
        //     Kalem: Weight (ağırlık tabanı için), AllocatedCost (dağıtılan pay),
        //     LandedUnitCost (birim landed maliyet). NULL = ek masrafsız (eski).
        await db.request().query(`
            IF COL_LENGTH('StockReceipts', 'ExtraCharges') IS NULL
            BEGIN ALTER TABLE StockReceipts ADD ExtraCharges NVARCHAR(MAX) NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('StockReceipts', 'AllocationBasis') IS NULL
            BEGIN ALTER TABLE StockReceipts ADD AllocationBasis NVARCHAR(10) NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('StockReceipts', 'ExtraTotal') IS NULL
            BEGIN ALTER TABLE StockReceipts ADD ExtraTotal DECIMAL(12,2) NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('StockReceiptItems', 'Weight') IS NULL
            BEGIN ALTER TABLE StockReceiptItems ADD Weight DECIMAL(12,3) NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('StockReceiptItems', 'AllocatedCost') IS NULL
            BEGIN ALTER TABLE StockReceiptItems ADD AllocatedCost DECIMAL(12,2) NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('StockReceiptItems', 'LandedUnitCost') IS NULL
            BEGIN ALTER TABLE StockReceiptItems ADD LandedUnitCost DECIMAL(12,2) NULL END
        `);

        // 11) Döviz Cari — cari hesap kendi para biriminde tutulabilir (USD/EUR/GBP).
        //     CurrentAccounts.Currency: carinin para birimi (TRY varsayılan; geriye
        //     uyumlu). Bakiye + tüm hareketler bu birimdedir. Kasa (Transactions)
        //     TL kalır; tahsilat/ödemede TCMB kuruyla TL karşılığı işlenir.
        //     AccountTransactions.ExchangeRate/AmountTRY: kasa-bağlantılı (ve dövizli
        //     belge) hareketlerde kullanılan kur + TL karşılığı (izlenebilirlik).
        await db.request().query(`
            IF COL_LENGTH('CurrentAccounts', 'Currency') IS NULL
            BEGIN ALTER TABLE CurrentAccounts ADD Currency NVARCHAR(5) NOT NULL CONSTRAINT DF_CurrentAccounts_Currency DEFAULT 'TRY' END
        `);
        await db.request().query(`
            IF COL_LENGTH('AccountTransactions', 'ExchangeRate') IS NULL
            BEGIN ALTER TABLE AccountTransactions ADD ExchangeRate DECIMAL(18,6) NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('AccountTransactions', 'AmountTRY') IS NULL
            BEGIN ALTER TABLE AccountTransactions ADD AmountTRY DECIMAL(14,2) NULL END
        `);
        // Cari hareketi belgeye (Fatura/İrsaliye) bağla → ekstrede "Belge #" ile
        // belgeyi girmeden görüntüleme.
        await db.request().query(`
            IF COL_LENGTH('AccountTransactions', 'RelatedDocumentID') IS NULL
            BEGIN ALTER TABLE AccountTransactions ADD RelatedDocumentID INT NULL END
        `);
        // Cari pasife alma (soft-delete): silmek yerine IsActive=0 → listeden gizlenir,
        // geçmiş + bağlı belgeler korunur. Kalıcı silme yalnız "Pasif Cariler"
        // sekmesinden yapılır (FK: AccountTransactions CASCADE, belgeler SET NULL).
        await db.request().query(`
            IF COL_LENGTH('CurrentAccounts', 'IsActive') IS NULL
            BEGIN ALTER TABLE CurrentAccounts ADD IsActive BIT NOT NULL CONSTRAINT DF_CurrentAccounts_IsActive DEFAULT 1 END
        `);

        // ─── Çok-Birimli Cari (Faz 4) ────────────────────────────────────────
        // Bir cari hesapta birden çok para biriminde (₺, $, €…) AYRI bakiye tutulur
        // (bölme/çeviri YOK). AccountBalances birim başına bakiyenin OTORİTESİDİR;
        // CurrentAccounts.Balance birincil (kart) birimin AYNASI olarak kalır →
        // eski okuma/rapor yolları bozulmaz. AccountTransactions.Currency hareketin
        // kendi birimini taşır; BalanceAfter o birimin hareket sonrası bakiyesidir.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='AccountBalances' and xtype='U')
            BEGIN
                CREATE TABLE AccountBalances (
                    AccountBalanceID INT IDENTITY(1,1) PRIMARY KEY,
                    AccountID INT NOT NULL FOREIGN KEY REFERENCES CurrentAccounts(AccountID) ON DELETE CASCADE,
                    Currency NVARCHAR(5) NOT NULL,
                    Balance DECIMAL(14,2) NOT NULL DEFAULT 0,
                    UpdatedAt DATETIME NULL,
                    CONSTRAINT UQ_AccountBalances UNIQUE (AccountID, Currency)
                );
                -- Backfill: her cari için mevcut bakiyeyi KENDİ biriminde tek satır.
                INSERT INTO AccountBalances (AccountID, Currency, Balance)
                SELECT AccountID, ISNULL(Currency, 'TRY'), Balance FROM CurrentAccounts;
            END
        `);
        await db.request().query(`
            IF COL_LENGTH('AccountTransactions', 'Currency') IS NULL
            BEGIN ALTER TABLE AccountTransactions ADD Currency NVARCHAR(5) NULL END
        `);
        // Eski hareketler cari biriminde yapılmıştı → boş Currency'leri doldur.
        await db.request().query(`
            UPDATE at SET at.Currency = ISNULL(ca.Currency, 'TRY')
            FROM AccountTransactions at
            JOIN CurrentAccounts ca ON at.AccountID = ca.AccountID
            WHERE at.Currency IS NULL
        `);

        // ─── ArcTeknik Şef (Restoran Otomasyon) Modülü ───────────────────────
        // Tamamen izole tablolar. Mevcut ERP/POS şemasına dokunmaz; yalnızca
        // tahsilat anında ortak Transactions tablosuna 'Gelir' yazar (kasa
        // entegrasyonu — bkz. routes/restoran.js). Hepsi idempotent.

        // Salon / Bahçe / Teras gibi bölümler.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='RestoranSections' and xtype='U')
            BEGIN
                CREATE TABLE RestoranSections (
                    SectionID INT IDENTITY(1,1) PRIMARY KEY,
                    Name NVARCHAR(100) NOT NULL,
                    SortOrder INT NOT NULL DEFAULT 0,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);

        // Menü kategorileri (Kebaplar, Çorbalar, İçecekler vb.).
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='RestoranCategories' and xtype='U')
            BEGIN
                CREATE TABLE RestoranCategories (
                    CategoryID INT IDENTITY(1,1) PRIMARY KEY,
                    Name NVARCHAR(100) NOT NULL,
                    SortOrder INT NOT NULL DEFAULT 0,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);

        // Menü ürünleri. Restoran menüsü stok/parça mantığından AYRIDIR (izolasyon);
        // adet düşümü yapılmaz, fiyat doğrudan adisyona yansır.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='RestoranProducts' and xtype='U')
            BEGIN
                CREATE TABLE RestoranProducts (
                    ProductID INT IDENTITY(1,1) PRIMARY KEY,
                    CategoryID INT NULL FOREIGN KEY REFERENCES RestoranCategories(CategoryID),
                    Name NVARCHAR(200) NOT NULL,
                    Price DECIMAL(10,2) NOT NULL DEFAULT 0,
                    IsActive BIT NOT NULL DEFAULT 1,
                    SortOrder INT NOT NULL DEFAULT 0,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);

        // Masalar. Status: 'Boş' | 'Dolu' | 'Rezerve'. CurrentOrderID açık adisyona
        // işaret eder (dairesel FK'den kaçınmak için sert kısıt yok; mantıksal bağ).
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='RestoranTables' and xtype='U')
            BEGIN
                CREATE TABLE RestoranTables (
                    TableID INT IDENTITY(1,1) PRIMARY KEY,
                    SectionID INT NULL FOREIGN KEY REFERENCES RestoranSections(SectionID),
                    TableNo NVARCHAR(20) NOT NULL,
                    Status NVARCHAR(20) NOT NULL DEFAULT 'Boş',
                    CurrentOrderID INT NULL,
                    SortOrder INT NOT NULL DEFAULT 0,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);

        // Adisyonlar (açık/kapalı hesaplar). Status: 'Açık' | 'Kapandı' | 'İptal'.
        // TransactionID kapanışta yazılan kasa hareketine bağlar (izlenebilirlik).
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='RestoranOrders' and xtype='U')
            BEGIN
                CREATE TABLE RestoranOrders (
                    OrderID INT IDENTITY(1,1) PRIMARY KEY,
                    TableID INT NOT NULL FOREIGN KEY REFERENCES RestoranTables(TableID),
                    Status NVARCHAR(20) NOT NULL DEFAULT 'Açık',
                    Total DECIMAL(10,2) NOT NULL DEFAULT 0,
                    PaymentMethod NVARCHAR(50) NULL,
                    TransactionID INT NULL,
                    OpenedBy NVARCHAR(255) NULL,
                    OpenedAt DATETIME DEFAULT GETDATE(),
                    ClosedAt DATETIME NULL
                )
            END
        `);

        // Adisyon kalemleri. KitchenStatus (mutfak/KDS): 'Bekliyor' | 'Hazırlanıyor'
        // | 'Hazır' | 'İkram'. 'İkram' = bedelsiz (tahsilat toplamından düşülür).
        // ProductID NULL → elle girilen açık kalem. Note → mutfak notu (Az pişsin vb.).
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='RestoranOrderItems' and xtype='U')
            BEGIN
                CREATE TABLE RestoranOrderItems (
                    ItemID INT IDENTITY(1,1) PRIMARY KEY,
                    OrderID INT NOT NULL FOREIGN KEY REFERENCES RestoranOrders(OrderID),
                    ProductID INT NULL,
                    Name NVARCHAR(200) NOT NULL,
                    UnitPrice DECIMAL(10,2) NOT NULL DEFAULT 0,
                    Quantity INT NOT NULL DEFAULT 1,
                    Note NVARCHAR(300) NULL,
                    KitchenStatus NVARCHAR(20) NOT NULL DEFAULT 'Bekliyor',
                    PaidAt DATETIME NULL,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);

        // ─── ArcTeknik Şef — Faz 0 göçleri (idempotent) ──────────────────────
        // Masa açılışında kişi sayısı (rapor/istatistik).
        await db.request().query(`
            IF COL_LENGTH('RestoranOrders', 'GuestCount') IS NULL
            BEGIN ALTER TABLE RestoranOrders ADD GuestCount INT NULL END
        `);
        // Ödenmez/İkram/Personel kapanışında bedelsiz tutar (ciroya yazmaz; Z raporunda görünür).
        await db.request().query(`
            IF COL_LENGTH('RestoranOrders', 'CompAmount') IS NULL
            BEGIN ALTER TABLE RestoranOrders ADD CompAmount DECIMAL(10,2) NULL END
        `);
        // Kalem mutfağa gönderildi mi (mutfak fişi yalnızca yeni kalemleri basar).
        await db.request().query(`
            IF COL_LENGTH('RestoranOrderItems', 'SentToKitchenAt') IS NULL
            BEGIN ALTER TABLE RestoranOrderItems ADD SentToKitchenAt DATETIME NULL END
        `);
        // Kategori → yazıcı/hazırlama hedefi: serbest isim (Mutfak/Bar/Fırın/Ocakbaşı…).
        await db.request().query(`
            IF COL_LENGTH('RestoranCategories', 'PrinterTarget') IS NULL
            BEGIN ALTER TABLE RestoranCategories ADD PrinterTarget NVARCHAR(20) NULL END
        `);
        // PrinterTarget'ı serbest çoklu-yazıcı isimleri için genişlet (20→40).
        await db.request().query(`
            IF COL_LENGTH('RestoranCategories', 'PrinterTarget') < 80
            BEGIN ALTER TABLE RestoranCategories ALTER COLUMN PrinterTarget NVARCHAR(40) NULL END
        `);

        // ArcTeknik Şef — Combo / Kampanya menüsü. IsCombo=1 ürün, adisyonda tek
        // satır+tek fiyat görünür; mutfağa gönderince bileşenlerine parçalanır.
        await db.request().query(`
            IF COL_LENGTH('RestoranProducts', 'IsCombo') IS NULL
            BEGIN ALTER TABLE RestoranProducts ADD IsCombo BIT NOT NULL DEFAULT 0 END
        `);
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='RestoranComboItems' and xtype='U')
            BEGIN
                CREATE TABLE RestoranComboItems (
                    ComboItemID INT IDENTITY(1,1) PRIMARY KEY,
                    ComboProductID INT NOT NULL,
                    ComponentProductID INT NOT NULL,
                    Quantity INT NOT NULL DEFAULT 1
                )
            END
        `);

        // ─── ArcTeknik Şef — Faz 1 (seçenek/modifier + ayarlar) ──────────────
        // Seçenek grupları (Porsiyon, Ekstra, Çıkar). MinSelect/MaxSelect ile
        // zorunlu/çoklu seçim; MaxSelect=0 → sınırsız.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='RestoranOptionGroups' and xtype='U')
            BEGIN
                CREATE TABLE RestoranOptionGroups (
                    GroupID INT IDENTITY(1,1) PRIMARY KEY,
                    Name NVARCHAR(100) NOT NULL,
                    MinSelect INT NOT NULL DEFAULT 0,
                    MaxSelect INT NOT NULL DEFAULT 0,
                    SortOrder INT NOT NULL DEFAULT 0,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);
        // Grup seçenekleri (Büyük +20, Peynir +15, Soğansız 0). PriceDelta fiyata eklenir.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='RestoranOptions' and xtype='U')
            BEGIN
                CREATE TABLE RestoranOptions (
                    OptionID INT IDENTITY(1,1) PRIMARY KEY,
                    GroupID INT NOT NULL FOREIGN KEY REFERENCES RestoranOptionGroups(GroupID),
                    Name NVARCHAR(100) NOT NULL,
                    PriceDelta DECIMAL(10,2) NOT NULL DEFAULT 0,
                    SortOrder INT NOT NULL DEFAULT 0
                )
            END
        `);
        // Ürün ↔ seçenek grubu bağı (gruplar tekrar kullanılabilir).
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='RestoranProductOptionGroups' and xtype='U')
            BEGIN
                CREATE TABLE RestoranProductOptionGroups (
                    ProductID INT NOT NULL,
                    GroupID INT NOT NULL,
                    CONSTRAINT PK_RestoranProdOptGroup PRIMARY KEY (ProductID, GroupID)
                )
            END
        `);
        // Restoran genel ayarları (tek satır): kuver + happy hour.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='RestoranSettings' and xtype='U')
            BEGIN
                CREATE TABLE RestoranSettings (
                    Id INT PRIMARY KEY DEFAULT 1,
                    CoverCharge DECIMAL(10,2) NOT NULL DEFAULT 0,
                    HappyEnabled BIT NOT NULL DEFAULT 0,
                    HappyStart INT NOT NULL DEFAULT 0,
                    HappyEnd INT NOT NULL DEFAULT 0,
                    HappyPercent DECIMAL(5,2) NOT NULL DEFAULT 0,
                    CONSTRAINT CK_RestoranSettings_Single CHECK (Id = 1)
                )
            END
        `);
        await db.request().query(`
            IF NOT EXISTS (SELECT 1 FROM RestoranSettings WHERE Id = 1)
            BEGIN INSERT INTO RestoranSettings (Id) VALUES (1) END
        `);
        // Restoran özelleştirme (Şefim "Feature.*" karşılığı) — sade key/value.
        // Davranış bayrakları burada (ödeme yöntemi aç/kapa, neden sorma, masa bilgi
        // göstergeleri vb.). Varsayılanlar kodda (restoran.js RESTORAN_FEATURE_DEFAULTS);
        // tabloda yalnız değiştirilen anahtarlar tutulur. UI: Restoran Yönetimi → Ayarlar.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='RestoranFeatures' and xtype='U')
            BEGIN
                CREATE TABLE RestoranFeatures (
                    Name NVARCHAR(80) PRIMARY KEY,
                    Value NVARCHAR(400) NOT NULL DEFAULT N''
                )
            END
        `);
        // Adisyon kalemine seçilen seçeneklerin etiketi (ör. "Büyük, +Peynir, Soğansız").
        await db.request().query(`
            IF COL_LENGTH('RestoranOrderItems', 'Options') IS NULL
            BEGIN ALTER TABLE RestoranOrderItems ADD Options NVARCHAR(500) NULL END
        `);

        // ─── ArcTeknik Şef — Faz 2 (paket servis + müşteri + kurye + açık hesap) ──
        // Müşteri rehberi. Telefon indexli → gelen aramada/elle aramada hızlı bul
        // (Caller-ID donanımının yazılım karşılığı). Restoran müşterisi mevcut
        // Customers/CurrentAccounts'tan AYRIDIR (izolasyon); açık hesap istenirse
        // checkout anında CurrentAccounts'a köprülenir.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='RestoranCustomers' and xtype='U')
            BEGIN
                CREATE TABLE RestoranCustomers (
                    CustomerID INT IDENTITY(1,1) PRIMARY KEY,
                    Name NVARCHAR(255) NOT NULL,
                    Phone NVARCHAR(50) NULL,
                    Note NVARCHAR(500) NULL,
                    AccountID INT NULL,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
                CREATE INDEX IX_RestoranCustomers_Phone ON RestoranCustomers(Phone)
            END
        `);
        // Müşteri adresleri (bir müşteri çok adres: Ev / İş). Directions = tarif/yol.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='RestoranAddresses' and xtype='U')
            BEGIN
                CREATE TABLE RestoranAddresses (
                    AddressID INT IDENTITY(1,1) PRIMARY KEY,
                    CustomerID INT NOT NULL FOREIGN KEY REFERENCES RestoranCustomers(CustomerID) ON DELETE CASCADE,
                    Label NVARCHAR(50) NULL,
                    AddressText NVARCHAR(500) NOT NULL,
                    Directions NVARCHAR(300) NULL,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);
        // Kuryeler (motokurye). Teslimat ataması + kurye dağıtım raporu için.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='RestoranCouriers' and xtype='U')
            BEGIN
                CREATE TABLE RestoranCouriers (
                    CourierID INT IDENTITY(1,1) PRIMARY KEY,
                    Name NVARCHAR(150) NOT NULL,
                    Phone NVARCHAR(50) NULL,
                    IsActive BIT NOT NULL DEFAULT 1,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);

        // RestoranOrders göçleri: paket servis. Sipariş türü + masa OPSİYONEL
        // (paket/gel-al'da masa yok → TableID NULL). Müşteri/kurye + teslim durumu
        // + adres/telefon/ad snapshot (müşteri kaydı sonradan değişse de sipariş bozulmaz).
        await db.request().query(`
            IF COL_LENGTH('RestoranOrders', 'OrderType') IS NULL
            BEGIN ALTER TABLE RestoranOrders ADD OrderType NVARCHAR(20) NOT NULL DEFAULT 'Masa' END
        `);
        await db.request().query(`
            IF COLUMNPROPERTY(OBJECT_ID('RestoranOrders'), 'TableID', 'AllowsNull') = 0
            BEGIN ALTER TABLE RestoranOrders ALTER COLUMN TableID INT NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('RestoranOrders', 'CustomerID') IS NULL
            BEGIN ALTER TABLE RestoranOrders ADD CustomerID INT NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('RestoranOrders', 'CourierID') IS NULL
            BEGIN ALTER TABLE RestoranOrders ADD CourierID INT NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('RestoranOrders', 'DeliveryStatus') IS NULL
            BEGIN ALTER TABLE RestoranOrders ADD DeliveryStatus NVARCHAR(20) NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('RestoranOrders', 'CustomerName') IS NULL
            BEGIN ALTER TABLE RestoranOrders ADD CustomerName NVARCHAR(255) NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('RestoranOrders', 'CustomerPhone') IS NULL
            BEGIN ALTER TABLE RestoranOrders ADD CustomerPhone NVARCHAR(50) NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('RestoranOrders', 'DeliveryAddress') IS NULL
            BEGIN ALTER TABLE RestoranOrders ADD DeliveryAddress NVARCHAR(500) NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('RestoranOrders', 'AssignedAt') IS NULL
            BEGIN ALTER TABLE RestoranOrders ADD AssignedAt DATETIME NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('RestoranOrders', 'DeliveredAt') IS NULL
            BEGIN ALTER TABLE RestoranOrders ADD DeliveredAt DATETIME NULL END
        `);

        // ─── ArcTeknik Şef — Faz 5 (rezervasyon) ────────────────────────────
        // Masa rezervasyon takvimi. TableID OPSİYONEL (belirli masa şart değil).
        // Status: Bekliyor → Geldi (oturdu) / İptal / No-Show (gelmedi).
        // ReservedAt indexli → güne göre hızlı listele. Adisyondan AYRI katman;
        // masanın anlık Boş/Dolu/Rezerve durumunu DEĞİŞTİRMEZ (planlama bilgisidir).
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='RestoranReservations' and xtype='U')
            BEGIN
                CREATE TABLE RestoranReservations (
                    ReservationID INT IDENTITY(1,1) PRIMARY KEY,
                    TableID INT NULL,
                    CustomerName NVARCHAR(255) NOT NULL,
                    CustomerPhone NVARCHAR(50) NULL,
                    GuestCount INT NOT NULL DEFAULT 2,
                    ReservedAt DATETIME NOT NULL,
                    DurationMin INT NOT NULL DEFAULT 120,
                    Status NVARCHAR(20) NOT NULL DEFAULT 'Bekliyor',
                    Note NVARCHAR(500) NULL,
                    CreatedBy INT NULL,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
                CREATE INDEX IX_RestoranReservations_ReservedAt ON RestoranReservations(ReservedAt)
            END
        `);

        // ─── ArcTeknik Şef — Faz 5 (reçete → hammadde sarfiyatı) ────────────
        // Menü ürünü ↔ ERP Stocks hammadde reçetesi. OPT-IN kuplaj: yalnızca
        // reçetesi tanımlı ürün, satışta (checkout) tanımlı miktarda ERP stoğunu
        // ACID düşürür (adjustStock/StockMovements). Reçetesiz ürün eskisi gibi
        // izole (stok düşmez). ProductID → ürün silinince reçete de silinir.
        // (ProductID, StockID) tekil → ürün başına bir hammadde tek satır (upsert).
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='RestoranRecipes' and xtype='U')
            BEGIN
                CREATE TABLE RestoranRecipes (
                    RecipeID INT IDENTITY(1,1) PRIMARY KEY,
                    ProductID INT NOT NULL FOREIGN KEY REFERENCES RestoranProducts(ProductID) ON DELETE CASCADE,
                    StockID INT NOT NULL,
                    Quantity DECIMAL(18,3) NOT NULL DEFAULT 0,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
                CREATE UNIQUE INDEX UX_RestoranRecipes_Product_Stock ON RestoranRecipes(ProductID, StockID)
            END
        `);

        // ─── ArcTeknik Şef — Faz 5 (sadakat / müşteri puanı) ────────────────
        // Müşteri puan bakiyesi (1 puan = 1 TL indirim). Tahsilatta müşterili
        // sipariş (paket veya salon-müşteri bağlı) için LoyaltyPercent oranında
        // puan kazanır; istenirse puan indirim olarak kullanılır.
        await db.request().query(`
            IF COL_LENGTH('RestoranCustomers', 'Points') IS NULL
            BEGIN ALTER TABLE RestoranCustomers ADD Points DECIMAL(12,2) NOT NULL CONSTRAINT DF_RestoranCustomers_Points DEFAULT 0 END
        `);
        await db.request().query(`
            IF COL_LENGTH('RestoranSettings', 'LoyaltyPercent') IS NULL
            BEGIN ALTER TABLE RestoranSettings ADD LoyaltyPercent DECIMAL(5,2) NOT NULL CONSTRAINT DF_RestoranSettings_Loyalty DEFAULT 0 END
        `);
        // Puan defteri (kazanç/harcama izlenebilirliği).
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='RestoranLoyaltyTransactions' and xtype='U')
            BEGIN
                CREATE TABLE RestoranLoyaltyTransactions (
                    LoyaltyTxID INT IDENTITY(1,1) PRIMARY KEY,
                    CustomerID INT NOT NULL,
                    Type NVARCHAR(20) NOT NULL,          -- 'Kazanç' | 'Harcama'
                    Points DECIMAL(12,2) NOT NULL,        -- her zaman pozitif
                    OrderID INT NULL,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
                CREATE INDEX IX_RestoranLoyaltyTx_Customer ON RestoranLoyaltyTransactions(CustomerID)
            END
        `);

        // ─── Faz 3 altyapısı: online sipariş entegrasyonu (Yemeksepeti/Getir/Trendyol/Migros) ───
        // Sipariş kaynağı + dış platform sipariş no (idempotent göç). API anahtarı gelince
        // webhook/adapter bu alanları doldurur; çekirdek akış değişmez (izolasyon korunur).
        await db.request().query(`
            IF COL_LENGTH('RestoranOrders', 'ExternalSource') IS NULL
            BEGIN ALTER TABLE RestoranOrders ADD ExternalSource NVARCHAR(40) NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('RestoranOrders', 'ExternalOrderId') IS NULL
            BEGIN ALTER TABLE RestoranOrders ADD ExternalOrderId NVARCHAR(120) NULL END
        `);
        // Aynı dış siparişin iki kez içeri alınmasını engelle (filtreli benzersiz index).
        await db.request().query(`
            IF COL_LENGTH('RestoranOrders', 'ExternalSource') IS NOT NULL
               AND COL_LENGTH('RestoranOrders', 'ExternalOrderId') IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_RestoranOrders_External')
            BEGIN
                CREATE UNIQUE INDEX UX_RestoranOrders_External
                    ON RestoranOrders(ExternalSource, ExternalOrderId)
                    WHERE ExternalSource IS NOT NULL AND ExternalOrderId IS NOT NULL
            END
        `);
        // Platform başına yapılandırma. ConfigJson = HWID-bağlı AES ile şifreli kimlikler
        // (server/config/secret.js · E maddesiyle aynı yöntem). Provider = sağlayıcı anahtarı.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='RestoranIntegrations' and xtype='U')
            BEGIN
                CREATE TABLE RestoranIntegrations (
                    Provider NVARCHAR(40) NOT NULL PRIMARY KEY,
                    Enabled BIT NOT NULL DEFAULT 0,
                    ConfigJson NVARCHAR(MAX) NULL,
                    UpdatedAt DATETIME NOT NULL DEFAULT GETDATE()
                )
            END
        `);

        // ArcTeknik Şef — yazıcı (fiziksel/mantıksal hedef) kayıt defteri. Bir yazıcıya
        // birden fazla kategori bağlanabilir (kategori.PrinterTarget = yazıcı adı). Çoklu
        // yazıcı yönlendirme: Lahmacun→Fırın, Adana→Ocakbaşı, Kola→Bar vb.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='RestoranPrinters' and xtype='U')
            BEGIN
                CREATE TABLE RestoranPrinters (
                    PrinterID INT IDENTITY(1,1) PRIMARY KEY,
                    Name NVARCHAR(40) NOT NULL UNIQUE,
                    SortOrder INT NOT NULL DEFAULT 0,
                    CreatedAt DATETIME DEFAULT GETDATE()
                )
            END
        `);
        // Varsayılan hedefleri tohumla (geriye uyum: mevcut kategoriler bu adları kullanır).
        await db.request().query(`
            IF EXISTS (SELECT * FROM sysobjects WHERE name='RestoranPrinters' and xtype='U')
            BEGIN
                INSERT INTO RestoranPrinters (Name, SortOrder)
                SELECT v.Name, v.SortOrder FROM (VALUES (N'Mutfak', 0), (N'Bar', 1), (N'Kasa', 2)) AS v(Name, SortOrder)
                WHERE NOT EXISTS (SELECT 1 FROM RestoranPrinters p WHERE p.Name = v.Name)
            END
        `);
        // Mevcut kategorilerde tanımlı ama defterde olmayan hedefleri de ekle (göç).
        await db.request().query(`
            IF EXISTS (SELECT * FROM sysobjects WHERE name='RestoranPrinters' and xtype='U')
               AND EXISTS (SELECT * FROM sysobjects WHERE name='RestoranCategories' and xtype='U')
            BEGIN
                INSERT INTO RestoranPrinters (Name, SortOrder)
                SELECT DISTINCT LTRIM(RTRIM(c.PrinterTarget)), 9
                FROM RestoranCategories c
                WHERE c.PrinterTarget IS NOT NULL AND LTRIM(RTRIM(c.PrinterTarget)) <> ''
                  AND NOT EXISTS (SELECT 1 FROM RestoranPrinters p WHERE p.Name = LTRIM(RTRIM(c.PrinterTarget)))
            END
        `);

        // Self-servis / paket: gün içi sıra numarası (KDS + çağrı ekranı + fişte
        // devasa puntoyla basılır; her gün 1'den başlar — üretimi rota tarafında).
        await db.request().query(`
            IF COL_LENGTH('RestoranOrders', 'OrderNo') IS NULL
            BEGIN ALTER TABLE RestoranOrders ADD OrderNo INT NULL END
        `);

        // ─── Ön Muhasebe (Faz B) — Fiyat Listeleri ───────────────────────────
        // Çoklu satış fiyatı: müşteri grubu / kanal / döviz bazlı liste. Stok
        // kartındaki SalePrice taban fiyat olarak kalır; bir belge bir fiyat
        // listesine bağlandığında o listede tanımlı ürünün fiyatı ön-doldurulur
        // (yoksa stok SalePrice'a düşülür). 'onmuhasebe' bayrağı altında görünür.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='PriceLists' and xtype='U')
            BEGIN
                CREATE TABLE PriceLists (
                    PriceListID INT IDENTITY(1,1) PRIMARY KEY,
                    Name NVARCHAR(150) NOT NULL,
                    Currency NVARCHAR(3) NOT NULL DEFAULT 'TRY',  -- liste para birimi
                    IsDefault BIT NOT NULL DEFAULT 0,             -- yeni belgelerde öneri
                    IsActive BIT NOT NULL DEFAULT 1,
                    Note NVARCHAR(500) NULL,
                    CreatedAt DATETIME DEFAULT GETDATE(),
                    UpdatedAt DATETIME NULL
                )
            END
        `);
        // Liste kalemleri — bir ürünün bir listedeki fiyatı. (Liste, Stok) tekil.
        // PriceListID -> CASCADE (liste silinince kalemleri de gider).
        // StockID     -> CASCADE (stok silinince o ürünün liste kalemleri gider).
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='PriceListItems' and xtype='U')
            BEGIN
                CREATE TABLE PriceListItems (
                    PriceListItemID INT IDENTITY(1,1) PRIMARY KEY,
                    PriceListID INT NOT NULL FOREIGN KEY REFERENCES PriceLists(PriceListID) ON DELETE CASCADE,
                    StockID INT NOT NULL FOREIGN KEY REFERENCES Stocks(StockID) ON DELETE CASCADE,
                    Price DECIMAL(14,2) NOT NULL DEFAULT 0,
                    UpdatedAt DATETIME NULL,
                    CONSTRAINT UQ_PriceListItems UNIQUE (PriceListID, StockID)
                )
            END
        `);
        // Cari başına varsayılan fiyat listesi (o cariye belge keserken otomatik seçilir).
        await db.request().query(`
            IF COL_LENGTH('CurrentAccounts', 'PriceListID') IS NULL
            BEGIN ALTER TABLE CurrentAccounts ADD PriceListID INT NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('CurrentAccounts', 'PriceListID') IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name='FK_CurrentAccounts_PriceList')
            BEGIN
                ALTER TABLE CurrentAccounts ADD CONSTRAINT FK_CurrentAccounts_PriceList
                FOREIGN KEY (PriceListID) REFERENCES PriceLists(PriceListID) ON DELETE SET NULL
            END
        `);

        // ─── Ön Muhasebe (Faz B) — Çoklu Depo ────────────────────────────────
        // Stocks.Quantity TOPLAM olarak otorite kalır (tüm eski okuma/rapor bozulmaz).
        // StockBalances yalnız VARSAYILAN-OLMAYAN depoların adetini tutar; varsayılan
        // depo adedi = Toplam − Σ(diğer depolar) olarak TÜRETİLİR. Böylece adjustStock'u
        // bypass eden akışlar bile otomatik varsayılan depoya akar (sapma olmaz).
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Warehouses' and xtype='U')
            BEGIN
                CREATE TABLE Warehouses (
                    WarehouseID INT IDENTITY(1,1) PRIMARY KEY,
                    Name NVARCHAR(120) NOT NULL,
                    Code NVARCHAR(20) NULL,
                    IsDefault BIT NOT NULL DEFAULT 0,
                    IsActive BIT NOT NULL DEFAULT 1,
                    Note NVARCHAR(500) NULL,
                    CreatedAt DATETIME DEFAULT GETDATE(),
                    UpdatedAt DATETIME NULL
                )
            END
        `);
        // Varsayılan depo tohumu (geriye uyum: mevcut tüm stok burada sayılır).
        await db.request().query(`
            IF EXISTS (SELECT * FROM sysobjects WHERE name='Warehouses' and xtype='U')
               AND NOT EXISTS (SELECT 1 FROM Warehouses)
            BEGIN
                INSERT INTO Warehouses (Name, Code, IsDefault, IsActive) VALUES (N'Ana Depo', N'ANA', 1, 1)
            END
        `);
        // Depo başına adet (yalnız varsayılan-olmayan depolar için satır taşır).
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='StockBalances' and xtype='U')
            BEGIN
                CREATE TABLE StockBalances (
                    StockBalanceID INT IDENTITY(1,1) PRIMARY KEY,
                    StockID INT NOT NULL FOREIGN KEY REFERENCES Stocks(StockID) ON DELETE CASCADE,
                    WarehouseID INT NOT NULL FOREIGN KEY REFERENCES Warehouses(WarehouseID) ON DELETE CASCADE,
                    Quantity DECIMAL(18,3) NOT NULL DEFAULT 0,
                    UpdatedAt DATETIME NULL,
                    CONSTRAINT UQ_StockBalances UNIQUE (StockID, WarehouseID)
                )
            END
        `);
        // Hareketin hangi depoya işlediği (NULL = varsayılan depo / eski kayıtlar).
        await db.request().query(`
            IF COL_LENGTH('StockMovements', 'WarehouseID') IS NULL
            BEGIN ALTER TABLE StockMovements ADD WarehouseID INT NULL END
        `);
        // Mal alım fişinin girdiği depo (NULL = varsayılan depo).
        await db.request().query(`
            IF COL_LENGTH('StockReceipts', 'WarehouseID') IS NULL
            BEGIN ALTER TABLE StockReceipts ADD WarehouseID INT NULL END
        `);
        // Döviz tedarikçi: fiş tedarikçinin para biriminde tutulur (fiyatlar o
        // birimde girilir, cariye bölünmeden yazılır). ExchangeRate = TCMB kuru
        // (TL karşılığı / stok maliyeti için). NULL/TRY = TL fiş (eski davranış).
        await db.request().query(`
            IF COL_LENGTH('StockReceipts', 'Currency') IS NULL
            BEGIN ALTER TABLE StockReceipts ADD Currency NVARCHAR(3) NULL END
        `);
        await db.request().query(`
            IF COL_LENGTH('StockReceipts', 'ExchangeRate') IS NULL
            BEGIN ALTER TABLE StockReceipts ADD ExchangeRate DECIMAL(18,6) NULL END
        `);
        // Belgenin (irsaliye/fatura) stok çıkışı yaptığı depo (NULL = varsayılan).
        await db.request().query(`
            IF COL_LENGTH('Documents', 'WarehouseID') IS NULL
            BEGIN ALTER TABLE Documents ADD WarehouseID INT NULL END
        `);

        // ─── Ön Muhasebe (Faz C) — Çek / Senet Portföyü ──────────────────────
        // Alınan (müşteri çeki = portföy varlığı) ve Verilen (kendi çekimiz = borç).
        // Alma/verme anında cari etkilenir (alacak/borç düşer); tahsil/ödeme anında
        // Kasa etkilenir. Karşılıksız/iade cari'yi geri açar. Ciro = alınan çeki
        // tedarikçiye devredip onun borcumuzu kapatma. AmountTRY kasa için saklanır.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='CekSenet' and xtype='U')
            BEGIN
                CREATE TABLE CekSenet (
                    NoteID INT IDENTITY(1,1) PRIMARY KEY,
                    Type NVARCHAR(10) NOT NULL,            -- 'Cek' | 'Senet'
                    Direction NVARCHAR(10) NOT NULL,       -- 'Alinan' | 'Verilen'
                    AccountID INT NULL FOREIGN KEY REFERENCES CurrentAccounts(AccountID) ON DELETE SET NULL,
                    Amount DECIMAL(14,2) NOT NULL,
                    Currency NVARCHAR(3) NOT NULL DEFAULT 'TRY',
                    ExchangeRate DECIMAL(18,6) NULL,
                    AmountTRY DECIMAL(14,2) NULL,           -- kasa için TL karşılığı
                    DueDate DATE NOT NULL,                  -- vade
                    BankName NVARCHAR(120) NULL,
                    CheckNo NVARCHAR(50) NULL,
                    Drawer NVARCHAR(150) NULL,              -- keşideci / borçlu
                    Status NVARCHAR(20) NOT NULL DEFAULT 'Portfoyde',
                    EndorsedToAccountID INT NULL,           -- ciro hedefi cari (FK yok: çoklu cascade yolu)
                    RelatedCashTxnID INT NULL,              -- tahsil/ödeme kasa hareketi
                    Note NVARCHAR(500) NULL,
                    CreatedBy NVARCHAR(100) NULL,
                    CreatedAt DATETIME DEFAULT GETDATE(),
                    UpdatedAt DATETIME NULL
                )
                CREATE INDEX IX_CekSenet_Status ON CekSenet(Direction, Status, DueDate)
            END
        `);

        // ─── Şema sürüm kaydı ────────────────────────────────────────────────
        // Göçler idempotent (yukarıdaki IF NOT EXISTS desenleri); bu tablo hangi
        // kurulumun hangi uygulama sürümünden geçtiğini saha desteğinde görünür
        // kılar ve ileride sürümlü migration zincirinin temelidir.
        await db.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='SchemaVersion' and xtype='U')
            BEGIN
                CREATE TABLE SchemaVersion (
                    Version NVARCHAR(20) NOT NULL PRIMARY KEY,
                    AppliedAt DATETIME NOT NULL DEFAULT GETDATE()
                )
            END
        `);
        try {
            const appVersion = String(require('../package.json').version || '').slice(0, 20);
            if (appVersion) {
                await db.request().input('v', appVersion).query(`
                    IF NOT EXISTS (SELECT 1 FROM SchemaVersion WHERE Version = @v)
                    BEGIN INSERT INTO SchemaVersion (Version) VALUES (@v) END
                `);
            }
        } catch { /* sürüm kaydı bilgi amaçlı — açılışı engellemesin */ }

        // İlk kurulumda otomatik admin OLUŞTURULMAZ — Kurulum Sihirbazı (Onboarding)
        // yöneticiyi kullanıcıdan alır. Yalnızca geliştirme/test için SEED_DEFAULT_ADMIN=1
        // verildiğinde varsayılan admin tohumlanır.
        if (process.env.SEED_DEFAULT_ADMIN === '1') {
            const adminCheck = await db.request()
                .input('username', 'admin')
                .query(`SELECT UserID FROM Users WHERE Username = @username`);

            if (adminCheck.recordset.length === 0) {
                const salt = await bcrypt.genSalt(10);
                const hash = await bcrypt.hash('admin123', salt);
                await db.request()
                    .input('username', 'admin')
                    .input('passwordHash', hash)
                    .input('fullName', 'Yönetici')
                    .input('role', 'Admin')
                    .query(`
                        INSERT INTO Users (Username, PasswordHash, FullName, Role)
                        VALUES (@username, @passwordHash, @fullName, @role)
                    `);
                console.log('Varsayılan admin: admin / admin123 (SEED_DEFAULT_ADMIN=1)');
            }
        }

        const { normalizePhone } = require('../utils/phone');
        const phones = await db.request().query(`SELECT CustomerID, Phone FROM Customers`);
        for (const row of phones.recordset) {
            const normalized = normalizePhone(row.Phone);
            if (normalized && normalized !== row.Phone) {
                await db.request()
                    .input('id', row.CustomerID)
                    .input('phone', normalized)
                    .query(`UPDATE Customers SET Phone = @phone WHERE CustomerID = @id`);
            }
        }

        console.log('Veritabanı şema kontrolü tamamlandı.');
    } catch (error) {
        console.error('Veritabanı başlatılırken hata:', error);
        throw error;
    }
};

/** Eski kod uyumluluğu: poolPromise bir Promise döner */
const poolPromise = {
    then: (resolve, reject) => getPool().then(resolve, reject),
};

module.exports = {
    sql,
    poolPromise,
    getPool,
    connectDatabase,
    initializeDatabase,
};
