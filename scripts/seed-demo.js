#!/usr/bin/env node
'use strict';
// ─── TANITIM VİDEOSU DEMO VERİSİ ─────────────────────────────────────────────
// TEKNIKDB'yi gerçekçi teknik servis verisiyle doldurur (yalnız EKLER, silmez).
// Çalıştır: node scripts/seed-demo.js
// Enum değerleri UI/route kodundan birebir alındı (Services.Status,
// AccountTransactions.Type, StockMovements Reason, Documents DocType/Status…).
const path = require('path');
const sql = require(path.join(__dirname, '../server/node_modules/mssql'));
const bcrypt = require(path.join(__dirname, '../server/node_modules/bcryptjs'));

// Bağlantı bilgileri ORTAMDAN okunur — repoya/gite ASLA gömülmez.
// server/.env yüklenir; şifre orada şifreliyse düz metni SEED_DB_PASSWORD ile ver:
//   SEED_DB_PASSWORD=... node scripts/seed-demo.js
try { require(path.join(__dirname, '../server/node_modules/dotenv')).config({ path: path.join(__dirname, '../server/.env') }); } catch { /* dotenv yoksa yalnız process.env */ }

const CFG = {
    server: process.env.SEED_DB_SERVER || process.env.DB_SERVER || 'localhost',
    user: process.env.SEED_DB_USER || process.env.DB_USER || 'sa',
    password: process.env.SEED_DB_PASSWORD || process.env.DB_PASSWORD || '',
    database: process.env.SEED_DB_NAME || process.env.DB_NAME || 'TEKNIKDB',
    options: { trustServerCertificate: true, encrypt: false },
};
if (!CFG.password) {
    console.error('HATA: DB şifresi yok. SEED_DB_PASSWORD ile verin (server/.env DB_PASSWORD şifreliyse düz metin gerekir).');
    process.exit(1);
}

// Gün geriye git + saat ayarla → SQL'in dil-bağımsız kabul ettiği ISO literal.
const d = (daysAgo, hour = 10, min = 0) => {
    const t = new Date();
    t.setDate(t.getDate() - daysAgo);
    t.setHours(hour, min, 0, 0);
    const p = (n) => String(n).padStart(2, '0');
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}:00`;
};
// Deterministik sözde-rastgele (her çalıştırmada aynı dağılım).
let seedState = 42;
const rnd = () => { seedState = (seedState * 1103515245 + 12345) % 2147483648; return seedState / 2147483648; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const ri = (min, max) => Math.floor(rnd() * (max - min + 1)) + min;

(async () => {
    const pool = await sql.connect(CFG);
    const q = (text) => pool.request().query(text);
    const ins = async (text) => (await q(text)).recordset?.[0];

    console.log('— Demo veri yükleniyor (yalnız ekleme, silme yok) —');

    // ── 0) Firma bilgisi (yalnız boş alanları doldur) ────────────────────────
    await q(`UPDATE CompanySettings SET
        CompanyName = COALESCE(NULLIF(LTRIM(RTRIM(CompanyName)), ''), N'ArcTeknik Bilişim Teknolojileri'),
        Phone   = COALESCE(NULLIF(LTRIM(RTRIM(Phone)), ''), N'0 (212) 555 28 47'),
        Email   = COALESCE(NULLIF(LTRIM(RTRIM(Email)), ''), N'info@arcteknik.com.tr'),
        Address = COALESCE(NULLIF(LTRIM(RTRIM(Address)), ''), N'Mecidiyeköy Mah. Teknoloji Cad. No:14/B Şişli / İstanbul'),
        Website = COALESCE(NULLIF(LTRIM(RTRIM(Website)), ''), N'www.arcteknik.com.tr'),
        TaxOffice = COALESCE(NULLIF(LTRIM(RTRIM(TaxOffice)), ''), N'Şişli'),
        TaxNumber = COALESCE(NULLIF(LTRIM(RTRIM(TaxNumber)), ''), N'1234567890'),
        UpdatedAt = GETDATE()
        WHERE Id = (SELECT MIN(Id) FROM CompanySettings)`);

    // ── 1) Personel ──────────────────────────────────────────────────────────
    const hash = await bcrypt.hash('demo123', 10);
    const TECH_PERMS = JSON.stringify(['add_customer']);
    const CASHIER_PERMS = JSON.stringify(['add_customer', 'manage_accounts', 'view_pricing']);
    const users = [
        ['murat', 'Murat Demir', 'Teknisyen', TECH_PERMS],
        ['emre', 'Emre Kaya', 'Teknisyen', TECH_PERMS],
        ['zeynep', 'Zeynep Arslan', 'Teknisyen', CASHIER_PERMS],
    ];
    const techIds = [];
    for (const [u, full, role, perms] of users) {
        const r = await ins(`
            IF NOT EXISTS (SELECT 1 FROM Users WHERE Username = N'${u}')
                INSERT INTO Users (Username, PasswordHash, FullName, Role, Permissions, IsActive)
                OUTPUT INSERTED.UserID VALUES (N'${u}', N'${hash}', N'${full}', N'${role}', N'${perms.replace(/'/g, "''")}', 1)
            ELSE SELECT UserID FROM Users WHERE Username = N'${u}'`);
        techIds.push(r.UserID);
    }
    console.log(`✓ Personel: ${techIds.length} (şifre: demo123)`);

    // ── 2) Kategori + Marka ──────────────────────────────────────────────────
    const catNames = ['Ekran', 'Batarya', 'Şarj Soketi & Flex', 'Kablo & Adaptör', 'Kılıf & Aksesuar', 'Anakart & Entegre'];
    const brandNames = ['Apple', 'Samsung', 'Xiaomi', 'Huawei', 'Lenovo', 'HP', 'Asus', 'Genel'];
    const catIds = {}, brandIds = {};
    for (const n of catNames) {
        const r = await ins(`INSERT INTO Categories (Name) OUTPUT INSERTED.CategoryID VALUES (N'${n}')`);
        catIds[n] = r.CategoryID;
    }
    for (const n of brandNames) {
        const r = await ins(`INSERT INTO Brands (Name) OUTPUT INSERTED.BrandID VALUES (N'${n}')`);
        brandIds[n] = r.BrandID;
    }

    // ── 3) Stok (36 ürün, 5'i kritik altı) ───────────────────────────────────
    // [ad, kategori, marka, alış, satış, adet, kritik]
    const stocks = [
        ['iPhone 13 Ekran (OLED Servis)', 'Ekran', 'Apple', 2400, 3650, 7, 3],
        ['iPhone 12 Ekran (OLED Servis)', 'Ekran', 'Apple', 2100, 3250, 4, 3],
        ['iPhone 11 Ekran (LCD A+)', 'Ekran', 'Apple', 950, 1650, 12, 4],
        ['iPhone X Ekran (OLED)', 'Ekran', 'Apple', 850, 1450, 2, 3],
        ['Samsung S22 Ekran (Servis)', 'Ekran', 'Samsung', 2900, 4250, 5, 2],
        ['Samsung A54 Ekran', 'Ekran', 'Samsung', 1100, 1850, 9, 3],
        ['Samsung A34 Ekran', 'Ekran', 'Samsung', 950, 1600, 6, 3],
        ['Xiaomi Redmi Note 12 Ekran', 'Ekran', 'Xiaomi', 700, 1250, 11, 4],
        ['Xiaomi Mi 11 Ekran (AMOLED)', 'Ekran', 'Xiaomi', 1350, 2150, 3, 3],
        ['Huawei P30 Lite Ekran', 'Ekran', 'Huawei', 650, 1150, 5, 2],
        ['iPhone 13 Batarya (Orijinal Kalite)', 'Batarya', 'Apple', 480, 950, 14, 5],
        ['iPhone 12 Batarya', 'Batarya', 'Apple', 430, 880, 10, 5],
        ['iPhone 11 Batarya', 'Batarya', 'Apple', 380, 780, 16, 5],
        ['Samsung S21 Batarya', 'Batarya', 'Samsung', 350, 720, 8, 4],
        ['Samsung A52 Batarya', 'Batarya', 'Samsung', 290, 620, 12, 4],
        ['Xiaomi BN59 Batarya (Redmi Note 9/10)', 'Batarya', 'Xiaomi', 240, 540, 18, 6],
        ['Lenovo ThinkPad T14 Batarya', 'Batarya', 'Lenovo', 850, 1480, 4, 2],
        ['HP Pavilion 15 Batarya', 'Batarya', 'HP', 720, 1280, 3, 2],
        ['iPhone Lightning Şarj Soketi Flex', 'Şarj Soketi & Flex', 'Apple', 180, 420, 22, 8],
        ['Samsung Type-C Şarj Soketi Flex', 'Şarj Soketi & Flex', 'Samsung', 140, 360, 19, 8],
        ['Xiaomi Type-C Şarj Soket Bordu', 'Şarj Soketi & Flex', 'Xiaomi', 120, 320, 15, 6],
        ['iPhone Arka Kamera Flex (11/12)', 'Şarj Soketi & Flex', 'Apple', 260, 580, 6, 3],
        ['Proximity/Sensör Flex (iPhone)', 'Şarj Soketi & Flex', 'Apple', 90, 240, 9, 4],
        ['20W USB-C Hızlı Şarj Adaptörü', 'Kablo & Adaptör', 'Genel', 95, 240, 35, 10],
        ['Type-C to Lightning Kablo (1m)', 'Kablo & Adaptör', 'Genel', 45, 140, 48, 15],
        ['Type-C Örgülü Kablo (2m)', 'Kablo & Adaptör', 'Genel', 38, 120, 41, 15],
        ['65W Laptop Adaptörü (Universal)', 'Kablo & Adaptör', 'Genel', 280, 520, 7, 3],
        ['Araç İçi Şarj Başlığı (Çift USB)', 'Kablo & Adaptör', 'Genel', 60, 160, 24, 8],
        ['iPhone 13 Kılıf (Silikon, Lansman)', 'Kılıf & Aksesuar', 'Genel', 35, 130, 52, 12],
        ['Samsung A54 Kılıf (Şeffaf Airbag)', 'Kılıf & Aksesuar', 'Genel', 28, 110, 38, 12],
        ['9D Temperli Cam (iPhone 11-13)', 'Kılıf & Aksesuar', 'Genel', 12, 60, 120, 30],
        ['9D Temperli Cam (Samsung A Serisi)', 'Kılıf & Aksesuar', 'Genel', 12, 60, 95, 30],
        ['Kablosuz Şarj Standı 15W', 'Kılıf & Aksesuar', 'Genel', 145, 320, 11, 4],
        ['iPhone 11 Şarj Entegresi (1610A3)', 'Anakart & Entegre', 'Apple', 160, 450, 8, 4],
        ['Tristar U2 Entegre (iPhone)', 'Anakart & Entegre', 'Apple', 130, 380, 5, 3],
        ['Wifi/Bluetooth Entegre (Samsung)', 'Anakart & Entegre', 'Samsung', 190, 480, 2, 3],
    ];
    const stockIds = [];
    let bc = 8690000000001;
    for (const [name, cat, brand, buy, sell, qty, crit] of stocks) {
        const r = await ins(`INSERT INTO Stocks
            (Name, Barcode, Quantity, PurchasePrice, SalePrice, CriticalLevel, CategoryID, BrandID, VatRate, Unit, CreatedAt)
            OUTPUT INSERTED.StockID
            VALUES (N'${name}', N'${bc++}', ${qty}, ${buy}, ${sell}, ${crit}, ${catIds[cat]}, ${brandIds[brand]}, 20, N'Adet', '${d(ri(40, 75))}')`);
        stockIds.push({ id: r.StockID, name, buy, sell });
    }
    // Birkaç ürüne ikinci barkod (çoklu barkod özelliği görünsün)
    for (let i = 0; i < 8; i++) {
        await q(`INSERT INTO ProductBarcodes (StockID, Barcode) VALUES (${stockIds[i].id}, N'${bc++}')`);
    }
    console.log(`✓ Stok: ${stockIds.length} ürün + çoklu barkod`);

    // ── 4) Müşteriler + Cihazlar ─────────────────────────────────────────────
    const firstNames = ['Mehmet', 'Ayşe', 'Mustafa', 'Fatma', 'Ahmet', 'Emine', 'Ali', 'Hatice', 'Hüseyin', 'Zeynep', 'Hasan', 'Elif', 'İbrahim', 'Meryem', 'Osman', 'Selin', 'Yusuf', 'Derya', 'Ömer', 'Büşra', 'Murat', 'Esra', 'Kemal', 'Gamze', 'Serkan', 'Tuğba', 'Volkan'];
    const lastNames = ['Yılmaz', 'Kaya', 'Demir', 'Çelik', 'Şahin', 'Öztürk', 'Aydın', 'Arslan', 'Doğan', 'Kılıç', 'Aslan', 'Çetin', 'Koç', 'Kurt', 'Özdemir', 'Polat', 'Erdoğan', 'Yıldız', 'Güneş', 'Bulut'];
    const devicePool = [
        ['Apple', 'iPhone 13', ['Ekran kırık, dokunmatik çalışıyor', 'Batarya çok hızlı bitiyor, şişme var', 'Şarj soketi temassız, kablo oynatınca şarj alıyor']],
        ['Apple', 'iPhone 12', ['Ekran görüntü yok, ses geliyor', 'Arka kamera odaklamıyor', 'Batarya sağlığı %71, değişim isteniyor']],
        ['Apple', 'iPhone 11', ['Düşme sonrası ekran çizgili', 'Şarj olmuyor, entegre şüphesi', 'Hoparlör cızırtılı']],
        ['Samsung', 'Galaxy S22', ['Ekran komple siyah, titreşim var', 'Hızlı şarj çalışmıyor']],
        ['Samsung', 'Galaxy A54', ['Ekran camı kırık, görüntü sağlam', 'Mikrofon karşı tarafa ses gitmiyor']],
        ['Samsung', 'Galaxy A34', ['Batarya şişmiş, kasa ayrılmış', 'Wifi sürekli kopuyor']],
        ['Xiaomi', 'Redmi Note 12', ['Ekran kırık + arka cam çatlak', 'Şarj soketi gevşek']],
        ['Xiaomi', 'Mi 11', ['Ekranda mor leke, dokunmatik bozuk']],
        ['Huawei', 'P30 Lite', ['Açılmıyor, şarj göstergesi yanıp sönüyor']],
        ['Lenovo', 'ThinkPad T14', ['Batarya 10 dakikada bitiyor', 'Klavyede birkaç tuş çalışmıyor', 'Fan sesi aşırı, ısınma var']],
        ['HP', 'Pavilion 15', ['Şarj adaptör ucu kırılmış, soket hasarlı', 'Açılışta mavi ekran']],
        ['Asus', 'VivoBook 15', ['Ekran menteşesi kırık', 'Format + temizlik isteniyor']],
    ];
    const customers = [];
    for (let i = 0; i < 28; i++) {
        const name = `${firstNames[i % firstNames.length]} ${pick(lastNames)}`;
        const corporate = i % 10 === 9;
        const fullName = corporate ? `${pick(['Yıldız', 'Anadolu', 'Marmara'])} ${pick(['Lojistik', 'İnşaat', 'Gıda'])} Ltd. Şti.` : name;
        const phone = `05${ri(30, 55)} ${ri(100, 999)} ${String(ri(10, 99))} ${String(ri(10, 99))}`;
        const r = await ins(`INSERT INTO Customers (FullName, Phone, Address, CustomerType, CreatedAt)
            OUTPUT INSERTED.CustomerID
            VALUES (N'${fullName}', N'${phone}', N'${pick(['Şişli', 'Beşiktaş', 'Kağıthane', 'Sarıyer', 'Beyoğlu'])} / İstanbul', N'${corporate ? 'Kurumsal' : 'Bireysel'}', '${d(ri(5, 70))}')`);
        customers.push({ id: r.CustomerID, name: fullName, phone });
    }
    console.log(`✓ Müşteri: ${customers.length}`);

    // ── 5) Servisler (48 adet, 7 durum, 60 güne yayılı) ──────────────────────
    // [durum, adet] — Teslim Edildi çoğunlukta (geçmiş işler), bugüne yakınlar açık.
    const plan = [
        ['Teslim Edildi', 20], ['Tamir Edildi', 6], ['İşleme Alındı', 8],
        ['Onay Bekliyor', 5], ['Onaylandı - Parça Bekleniyor', 4], ['Teslim Alındı', 4], ['İade İstendi', 1],
    ];
    const statusFlow = {
        'Teslim Alındı': ['Teslim Alındı'],
        'Onay Bekliyor': ['Teslim Alındı', 'Onay Bekliyor'],
        'Onaylandı - Parça Bekleniyor': ['Teslim Alındı', 'Onay Bekliyor', 'Onaylandı - Parça Bekleniyor'],
        'İşleme Alındı': ['Teslim Alındı', 'Onay Bekliyor', 'İşleme Alındı'],
        'İade İstendi': ['Teslim Alındı', 'Onay Bekliyor', 'İade İstendi'],
        'Tamir Edildi': ['Teslim Alındı', 'Onay Bekliyor', 'İşleme Alındı', 'Tamir Edildi'],
        'Teslim Edildi': ['Teslim Alındı', 'Onay Bekliyor', 'İşleme Alındı', 'Tamir Edildi', 'Teslim Edildi'],
    };
    const serviceIds = [];
    let svcNo = 0;
    for (const [status, count] of plan) {
        for (let k = 0; k < count; k++) {
            svcNo++;
            const cust = customers[svcNo % customers.length];
            const [brand, model, faults] = pick(devicePool);
            const fault = pick(faults);
            // Açık işler son 0-8 gün, kapalılar 3-60 gün geriden başlasın
            const closed = status === 'Teslim Edildi' || status === 'Tamir Edildi';
            const entryDays = closed ? ri(3, 60) : ri(0, 8);
            const dev = await ins(`INSERT INTO Devices (CustomerID, Brand, Model, SerialNumber, CreatedAt)
                OUTPUT INSERTED.DeviceID
                VALUES (${cust.id}, N'${brand}', N'${model}', N'SN${ri(100000, 999999)}${ri(100, 999)}', '${d(entryDays)}')`);
            const price = ri(7, 90) * 50;            // 350-4500 TL
            const cost = Math.round(price * (0.35 + rnd() * 0.25));
            const tech = techIds[svcNo % techIds.length];
            const warranty = status === 'Teslim Edildi' && k % 3 === 0 ? 6 : 'NULL';
            const exitDate = status === 'Teslim Edildi' ? `'${d(Math.max(0, entryDays - ri(1, 3)), 17)}'` : 'NULL';
            const readyAt = closed ? `'${d(Math.max(0, entryDays - ri(1, 2)), 15)}'` : 'NULL';
            const r = await ins(`INSERT INTO Services
                (DeviceID, FaultDescription, Status, EstimatedPrice, CostPrice, EntryDate, ExitDate, ReadyAt,
                 AssignedTechnicianID, TechnicianNotes, WarrantyMonths, WarrantyUntil)
                OUTPUT INSERTED.ServiceID
                VALUES (${dev.DeviceID}, N'${fault}', N'${status}', ${price}, ${cost}, '${d(entryDays, ri(9, 18))}', ${exitDate}, ${readyAt},
                        ${tech}, ${status === 'Teslim Alındı' ? 'NULL' : `N'${pick(['Parça değişimi yapıldı, test edildi.', 'Ultrasonik temizlik + test.', 'Müşteri arandı, fiyat onayı alındı.', 'Yedek parça stoktan kullanıldı.'])}'`},
                        ${warranty}, ${warranty === 6 ? `'${d(entryDays - 180 < 0 ? 0 : entryDays, 17)}'` : 'NULL'})`);
            serviceIds.push({ id: r.ServiceID, status, price, cost, entryDays, custName: cust.name });
            // Durum geçmişi
            const flow = statusFlow[status];
            for (let f = 0; f < flow.length; f++) {
                await q(`INSERT INTO ServiceHistory (ServiceID, OldStatus, NewStatus, ChangedBy, ChangedAt)
                    VALUES (${r.ServiceID}, ${f === 0 ? 'NULL' : `N'${flow[f - 1]}'`}, N'${flow[f]}', N'${f === 0 ? 'admin' : pick(['admin', 'murat', 'emre'])}', '${d(Math.max(0, entryDays - f), 9 + f)}')`);
            }
        }
    }
    console.log(`✓ Servis: ${serviceIds.length} (+ durum geçmişi)`);

    // ── 6) Servis parçaları (tamir edilen/teslim edilenlere) ────────────────
    let partCount = 0;
    for (const s of serviceIds.filter((x) => x.status === 'Teslim Edildi' || x.status === 'Tamir Edildi')) {
        const n = ri(1, 2);
        for (let i = 0; i < n; i++) {
            const st = pick(stockIds);
            await q(`INSERT INTO ServiceParts (ServiceID, StockID, PartName, Quantity, UnitPurchasePrice, UnitSalePrice, CreatedBy, CreatedAt)
                VALUES (${s.id}, ${st.id}, N'${st.name}', 1, ${st.buy}, ${st.sell}, N'${pick(['murat', 'emre'])}', '${d(Math.max(0, s.entryDays - 1), 14)}')`);
            await q(`INSERT INTO StockMovements (StockID, StockName, Direction, Reason, Quantity, QuantityAfter, UnitPrice, RelatedServiceID, CreatedBy, CreatedAt)
                VALUES (${st.id}, N'${st.name}', N'Çıkış', N'Servis', 1, ${ri(2, 20)}, ${st.sell}, ${s.id}, N'${pick(['murat', 'emre'])}', '${d(Math.max(0, s.entryDays - 1), 14)}')`);
            partCount++;
        }
    }
    console.log(`✓ Servis parçası: ${partCount} (+ stok çıkış hareketleri)`);

    // ── 7) Kasa: tahsilatlar + giderler ──────────────────────────────────────
    let txCount = 0;
    for (const s of serviceIds.filter((x) => x.status === 'Teslim Edildi')) {
        await q(`INSERT INTO Transactions (ServiceID, Amount, Type, Description, PaymentMethod, CreatedAt)
            VALUES (${s.id}, ${s.price}, N'Gelir', N'Servis tahsilatı — ${s.custName.replace(/'/g, '')}', N'${pick(['Nakit', 'Kredi Kartı', 'Nakit', 'Havale'])}', '${d(Math.max(0, s.entryDays - ri(1, 3)), 17)}')`);
        txCount++;
    }
    // BUGÜN: video çekerken "Bugünkü ciro" dolu görünsün
    const today = [
        ['Gelir', 1650, 'Servis tahsilatı — iPhone 11 ekran değişimi', 'Nakit', 10],
        ['Gelir', 950, 'Servis tahsilatı — iPhone 13 batarya', 'Kredi Kartı', 11],
        ['Gelir', 2350, 'Servis tahsilatı — Samsung S22 ekran', 'Kredi Kartı', 13],
        ['Gelir', 240, 'Aksesuar satışı — şarj adaptörü + kablo', 'Nakit', 14],
        ['Gider', 850, 'Toptancıya parça ödemesi', 'Havale', 9],
    ];
    for (const [type, amt, desc, pm, hr] of today) {
        await q(`INSERT INTO Transactions (Amount, Type, Description, PaymentMethod, CreatedAt)
            VALUES (${amt}, N'${type}', N'${desc}', N'${pm}', '${d(0, hr)}')`);
        txCount++;
    }
    // Düzenli giderler (45 güne yayılı)
    const expenses = [
        [45, 18500, 'Dükkân kirası — geçen ay'], [15, 18500, 'Dükkân kirası'],
        [38, 2340, 'Elektrik faturası'], [8, 2580, 'Elektrik faturası'],
        [33, 420, 'Su faturası'], [29, 750, 'İnternet + sabit hat'],
        [42, 12400, 'Toptancı parça alımı — Teknopar Elektronik'],
        [24, 8650, 'Toptancı parça alımı — Mobil Dünya Toptan'],
        [11, 9800, 'Toptancı parça alımı — Teknopar Elektronik'],
        [30, 4500, 'Muhasebeci ücreti'], [19, 1250, 'Temizlik + sarf malzeme'],
        [6, 680, 'Kargo giderleri (haftalık)'], [27, 540, 'Yemek (personel)'],
    ];
    for (const [days, amt, desc] of expenses) {
        await q(`INSERT INTO Transactions (Amount, Type, Description, PaymentMethod, CreatedAt)
            VALUES (${amt}, N'Gider', N'${desc}', N'${pick(['Nakit', 'Havale'])}', '${d(days, ri(9, 18))}')`);
        txCount++;
    }
    console.log(`✓ Kasa hareketi: ${txCount}`);

    // ── 8) Cari hesaplar (veresiye müşteriler + tedarikçiler) ────────────────
    // İşaret kuralı: Balance > 0 = bize borçlu; < 0 = biz borçluyuz.
    const cariPlan = [
        // [ad, tip, hareketler[ [Type, Amount, açıklama, günÖnce] ]]
        ['Yıldız Lojistik Ltd. Şti.', 'Alıcı', [['Borçlandır', 4800, 'Filo telefon bakımı — 3 cihaz', 21], ['Tahsilat', 2000, 'Kısmi tahsilat', 12]]],
        ['Kemal Polat (Polat Market)', 'Alıcı', [['Borçlandır', 1650, 'iPhone 11 ekran değişimi — veresiye', 9]]],
        ['Serkan Bulut (Bulut Kafe)', 'Alıcı', [['Borçlandır', 2870, 'Kasa POS cihazı tamiri + yedek parça', 16], ['Tahsilat', 1000, 'Kısmi tahsilat', 5]]],
        ['Teknopar Elektronik San. Tic.', 'Satıcı', [['Alacaklandır', 24500, 'Mal alımı — ekran/batarya partisi', 26], ['Ödeme', 12400, 'Havale ödemesi', 18]]],
        ['Mobil Dünya Toptan', 'Satıcı', [['Alacaklandır', 8650, 'Mal alımı — aksesuar + flex', 24], ['Ödeme', 8650, 'Tam ödeme', 10]]],
        ['Global Parça İthalat', 'Satıcı', [['Alacaklandır', 15300, 'Mal alımı — OLED ekran partisi', 13]]],
    ];
    const cariIds = {}; // ad → AccountID (çek/senet + sonraki bölümler için)
    for (const [name, type, moves] of cariPlan) {
        const r = await ins(`INSERT INTO CurrentAccounts (Name, Type, Phone, Balance, Currency, CreatedAt)
            OUTPUT INSERTED.AccountID
            VALUES (N'${name}', N'${type}', N'05${ri(30, 55)} ${ri(100, 999)} ${ri(10, 99)} ${ri(10, 99)}', 0, N'TRY', '${d(ri(30, 70))}')`);
        cariIds[name] = r.AccountID;
        let bal = 0;
        for (const [mtype, amt, desc, days] of moves) {
            bal += (mtype === 'Borçlandır' || mtype === 'Ödeme') ? amt : -amt;
            await q(`INSERT INTO AccountTransactions (AccountID, Type, Amount, Currency, Description, BalanceAfter, PaymentMethod, CreatedBy, CreatedAt)
                VALUES (${r.AccountID}, N'${mtype}', ${amt}, N'TRY', N'${desc}', ${bal}, ${mtype === 'Tahsilat' || mtype === 'Ödeme' ? `N'${pick(['Nakit', 'Havale'])}'` : 'NULL'}, N'admin', '${d(days, ri(10, 17))}')`);
        }
        await q(`UPDATE CurrentAccounts SET Balance = ${bal} WHERE AccountID = ${r.AccountID}`);
        // ÇOK-BİRİMLİ AYNA: özet kartları (Toplam Alacak/Borç) AccountBalances'tan
        // okur. Ham SQL applyMovement'ı atladığı için bu tabloyu elle güncelle —
        // yoksa liste bakiyeleri dolu ama özet kartları ₺0,00 görünür.
        await q(`MERGE AccountBalances WITH (HOLDLOCK) AS t
            USING (SELECT ${r.AccountID} AS aid, N'TRY' AS cur) AS s
                ON t.AccountID = s.aid AND t.Currency = s.cur
            WHEN MATCHED THEN UPDATE SET Balance = ${bal}, UpdatedAt = GETDATE()
            WHEN NOT MATCHED THEN INSERT (AccountID, Currency, Balance, UpdatedAt)
                VALUES (${r.AccountID}, N'TRY', ${bal}, GETDATE());`);
    }
    console.log(`✓ Cari: ${cariPlan.length} hesap + ekstre + bakiye aynası (AccountBalances)`);

    // ── 8b) Çek / Senet (portföy + tahsil/ödeme örnekleri) ───────────────────
    // İşaret notu: demo için CekSenet kayıtları DOĞRUDAN yazılır; alma/verme'nin
    // cari etkisi (Tahsilat/Ödeme) burada tekrar uygulanmaz — yukarıdaki cari
    // bakiyeleri zaten kasıtlı kurgulandı, çift sayımı önlemek için.
    // [Type, Direction, cariAd, Amount, vadeGünSonra, banka, çekNo, keşideci, Status]
    const notesPlan = [
        ['Cek',   'Alinan',  'Kemal Polat (Polat Market)',   1650,  18, 'Ziraat Bankası',  '0042817', 'Kemal Polat',        'Portfoyde'],
        ['Cek',   'Alinan',  'Serkan Bulut (Bulut Kafe)',    1870,  35, 'İş Bankası',       '0091355', 'Serkan Bulut',       'Portfoyde'],
        ['Senet', 'Alinan',  'Yıldız Lojistik Ltd. Şti.',    2800,  60, null,               null,      'Yıldız Lojistik',    'Portfoyde'],
        ['Cek',   'Verilen', 'Teknopar Elektronik San. Tic.', 6000, 25, 'Garanti BBVA',     '0117204', 'ArcTeknik',          'Portfoyde'],
        ['Cek',   'Verilen', 'Global Parça İthalat',          5000, -3, 'Akbank',           '0203918', 'ArcTeknik',          'Portfoyde'],
        ['Cek',   'Alinan',  'Serkan Bulut (Bulut Kafe)',     1200, -8, 'İş Bankası',       '0077120', 'Serkan Bulut',       'Tahsil Edildi'],
    ];
    let noteCount = 0;
    for (const [type, dir, cariName, amt, dueDays, bank, checkNo, drawer, status] of notesPlan) {
        const aid = cariIds[cariName];
        if (!aid) continue;
        const due = d(dueDays < 0 ? Math.abs(dueDays) : -dueDays, 0); // dueDays>0 → ileri vade
        await q(`INSERT INTO CekSenet
            (Type, Direction, AccountID, Amount, Currency, ExchangeRate, AmountTRY, DueDate, BankName, CheckNo, Drawer, Status, CreatedBy, CreatedAt)
            VALUES (N'${type}', N'${dir}', ${aid}, ${amt}, N'TRY', 1, ${amt}, '${due.slice(0, 10)}',
                    ${bank ? `N'${bank}'` : 'NULL'}, ${checkNo ? `N'${checkNo}'` : 'NULL'}, ${drawer ? `N'${drawer}'` : 'NULL'},
                    N'${status}', N'admin', '${d(ri(5, 20), 11)}')`);
        noteCount++;
    }
    console.log(`✓ Çek/Senet: ${noteCount} kayıt (portföy + tahsil + geçmiş vade)`);

    // ── 9) Mal alımı irsaliyeleri (StockReceipts) + stok giriş hareketleri ───
    const teknopar = await ins(`SELECT AccountID FROM CurrentAccounts WHERE Name LIKE N'Teknopar%'`);
    for (const [days, note] of [[26, 'Ekran/batarya partisi'], [24, 'Aksesuar + flex alımı'], [13, 'OLED ekran partisi']]) {
        const items = [pick(stockIds), pick(stockIds), pick(stockIds)];
        let total = 0;
        const rec = await ins(`INSERT INTO StockReceipts (AccountID, TotalAmount, Note, CreatedBy, CreatedAt)
            OUTPUT INSERTED.ReceiptID VALUES (${teknopar.AccountID}, 0, N'${note}', N'admin', '${d(days, 11)}')`);
        for (const st of items) {
            const qty = ri(3, 10);
            total += qty * st.buy;
            await q(`INSERT INTO StockReceiptItems (ReceiptID, StockID, Name, Quantity, UnitPurchasePrice, LineTotal)
                VALUES (${rec.ReceiptID}, ${st.id}, N'${st.name}', ${qty}, ${st.buy}, ${qty * st.buy})`);
            await q(`INSERT INTO StockMovements (StockID, StockName, Direction, Reason, Quantity, QuantityAfter, UnitPrice, RelatedReceiptID, CreatedBy, CreatedAt)
                VALUES (${st.id}, N'${st.name}', N'Giriş', N'Mal Alımı', ${qty}, ${ri(10, 40)}, ${st.buy}, ${rec.ReceiptID}, N'admin', '${d(days, 11)}')`);
        }
        await q(`UPDATE StockReceipts SET TotalAmount = ${total} WHERE ReceiptID = ${rec.ReceiptID}`);
    }
    console.log('✓ Mal alımı: 3 irsaliye + stok giriş hareketleri');

    // ── 10) Belge zinciri (Teklif/Sipariş/İrsaliye/Fatura) ───────────────────
    const year = new Date().getFullYear();
    const docPlan = [
        ['Teklif', 'TEK', 'Gönderildi', 19, 'Yıldız Lojistik Ltd. Şti.', 3],
        ['Teklif', 'TEK', 'Onaylandı', 14, 'Bulut Kafe', 2],
        ['Teklif', 'TEK', 'Taslak', 1, 'Polat Market', 2],
        ['Siparis', 'SIP', 'Açık', 12, 'Yıldız Lojistik Ltd. Şti.', 3],
        ['Siparis', 'SIP', 'Açık', 4, 'Anadolu Gıda Ltd. Şti.', 2],
        ['Irsaliye', 'IRS', 'Sevk Edildi', 8, 'Yıldız Lojistik Ltd. Şti.', 3],
        ['Irsaliye', 'IRS', 'Teslim Edildi', 6, 'Bulut Kafe', 2],
        ['Fatura', 'FAT', 'Kesildi', 5, 'Yıldız Lojistik Ltd. Şti.', 3],
        ['Fatura', 'FAT', 'Ödendi', 11, 'Bulut Kafe', 2],
        ['Fatura', 'FAT', 'Kesildi', 2, 'Marmara İnşaat Ltd. Şti.', 4],
    ];
    const counters = {};
    for (const [docType, prefix, status, days, party, itemCount] of docPlan) {
        counters[prefix] = (counters[prefix] || 0) + 1;
        const docNo = `${prefix}${year}${String(counters[prefix]).padStart(9, '0')}`;
        let sub = 0, vat = 0;
        const lines = [];
        for (let i = 0; i < itemCount; i++) {
            const st = pick(stockIds);
            const qty = ri(1, 5);
            const net = qty * st.sell;
            const lineVat = Math.round(net * 0.2 * 100) / 100;
            sub += net; vat += lineVat;
            lines.push({ st, qty, net, lineVat });
        }
        const doc = await ins(`INSERT INTO Documents
            (DocType, DocNo, Series, Direction, PartyName, Status, IssueDate, Currency,
             SubTotal, DiscountTotal, VatTotal, GrandTotal, StockApplied, CariApplied, CreatedBy, CreatedAt)
            OUTPUT INSERTED.DocumentID
            VALUES (N'${docType}', N'${docNo}', N'${prefix}', N'Satis', N'${party}', N'${status}', '${d(days, 11)}', N'TRY',
                    ${sub}, 0, ${vat}, ${sub + vat}, ${docType === 'Fatura' || docType === 'Irsaliye' ? 1 : 0}, 0, N'admin', '${d(days, 11)}')`);
        let sort = 0;
        for (const L of lines) {
            await q(`INSERT INTO DocumentItems (DocumentID, StockID, Name, Quantity, Unit, UnitPrice, DiscountRate, VatRate, LineNet, LineVat, LineTotal, SortOrder)
                VALUES (${doc.DocumentID}, ${L.st.id}, N'${L.st.name}', ${L.qty}, N'Adet', ${L.st.sell}, 0, 20, ${L.net}, ${L.lineVat}, ${L.net + L.lineVat}, ${sort++})`);
        }
    }
    for (const [prefix, lastNo] of Object.entries(counters)) {
        await q(`MERGE DocumentCounters WITH (HOLDLOCK) AS t
            USING (SELECT N'${prefix}-${year}' AS k) AS s ON t.CounterKey = s.k
            WHEN MATCHED THEN UPDATE SET LastNo = ${lastNo}
            WHEN NOT MATCHED THEN INSERT (CounterKey, LastNo) VALUES (N'${prefix}-${year}', ${lastNo});`);
    }
    console.log(`✓ Belge: ${docPlan.length} (teklif→fatura zinciri) + kalemler`);

    // ── 11) Denetim izi (Güvenlik Radarı dolu görünsün) ──────────────────────
    const audits = [
        ['admin', 'auth.login', 'User', 'Başarılı giriş', 0, 8],
        ['murat', 'auth.login', 'User', 'Başarılı giriş', 0, 9],
        ['admin', 'service.delete', 'Service', 'Mükerrer kayıt silindi (müşteri talebi)', 2, 16],
        ['admin', 'document.cancel', 'Document', `Teklif iptal edildi — müşteri vazgeçti`, 4, 11],
        ['admin', 'user.deactivate', 'User', 'Eski stajyer hesabı pasife alındı', 7, 10],
        ['admin', 'service.transfer', 'Service', 'İş Murat → Emre devredildi (izin)', 1, 9],
        ['emre', 'auth.login', 'User', 'Başarılı giriş', 1, 8],
        ['admin', 'stock.bulk-import', 'Stock', 'Excel ile 24 ürün içe aktarıldı', 9, 15],
        ['zeynep', 'auth.login', 'User', 'Başarılı giriş', 0, 10],
        ['admin', 'settings.update', 'Settings', 'Firma bilgileri güncellendi', 12, 14],
    ];
    for (const [user, action, entity, detail, days, hr] of audits) {
        await q(`INSERT INTO AuditLog (Username, Action, Entity, Detail, CreatedAt)
            VALUES (N'${user}', N'${action}', N'${entity}', N'${detail}', '${d(days, hr)}')`);
    }
    console.log(`✓ Denetim izi: ${audits.length}`);

    // ── Özet ─────────────────────────────────────────────────────────────────
    const counts = await q(`
        SELECT t.name, SUM(p.rows) AS rows FROM sys.tables t
        JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)
        WHERE t.name IN ('Customers','Devices','Services','Stocks','Transactions','CurrentAccounts',
                         'AccountTransactions','Documents','DocumentItems','StockMovements','ServiceParts',
                         'ServiceHistory','AuditLog','Users','StockReceipts')
        GROUP BY t.name ORDER BY t.name`);
    console.log('\n=== SONUÇ ===');
    for (const c of counts.recordset) console.log(`${c.name}: ${c.rows}`);
    await pool.close();
    console.log('\n✓ Demo veri yüklendi. Video çekimine hazır.');
})().catch((e) => { console.error('HATA:', e.message); process.exit(1); });
