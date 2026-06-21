const express = require('express');
const sql = require('mssql');
const { poolPromise } = require('../config/db');
const { authenticate, adminOnly } = require('../middleware/auth');
const { PERMISSIONS } = require('../utils/permissions');
const { normalizeUnit, normalizeQuantity } = require('../utils/units');
const { triggerWebSync } = require('../services/webSync');

const router = express.Router();

// Maliyet (PurchasePrice) yalnızca yetkili kullanıcıya gösterilir — rol esnekliği.
const canViewPricing = (user) => {
    if (!user) return false;
    if (user.role === 'Admin') return true;
    const list = Array.isArray(user.permissions) ? user.permissions : [];
    return list.includes(PERMISSIONS.VIEW_PRICING);
};

// Tek bir stok kaydını arayüz için normalize eder; maliyet gizliyse alanı hiç koymaz.
const shapeStock = (row, showCost) => {
    const out = {
        StockID: row.StockID,
        Name: row.Name,
        Barcode: row.Barcode,
        Quantity: row.Quantity,
        SalePrice: row.SalePrice,
        CriticalLevel: row.CriticalLevel,
        Unit: row.Unit || 'Adet',
        Currency: row.Currency || 'TRY',
        AlertEnabled: row.AlertEnabled !== false && row.AlertEnabled !== 0,
        IsCritical: row.AlertEnabled !== false && row.AlertEnabled !== 0 && row.Quantity <= row.CriticalLevel,
        ShowOnWeb: !!row.ShowOnWeb,
        WebDescription: row.WebDescription || '',
        CategoryID: row.CategoryID ?? null,
        BrandID: row.BrandID ?? null,
        CategoryName: row.CategoryName || '',
        BrandName: row.BrandName || '',
        // Oto yedek parça alanları (parts sektörü) — boşsa istemci göstermez.
        OemCode: row.OemCode || '',
        VehicleCompat: row.VehicleCompat || '',
        PartType: row.PartType || '',
        CreatedAt: row.CreatedAt,
        UpdatedAt: row.UpdatedAt,
    };
    if (showCost) out.PurchasePrice = row.PurchasePrice;
    return out;
};

// Ana stok kartını Kategori + Marka adlarıyla getiren ortak SELECT gövdesi.
const STOCK_SELECT = `
    SELECT s.*, c.Name AS CategoryName, b.Name AS BrandName
    FROM Stocks s
    LEFT JOIN Categories c ON s.CategoryID = c.CategoryID
    LEFT JOIN Brands b ON s.BrandID = b.BrandID
`;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Stok fiyatları bu para biriminde yorumlanır. Desteklenmeyen/boş → TRY.
const STOCK_CURRENCIES = ['TRY', 'USD', 'EUR', 'GBP'];
const normStockCurrency = (c) => {
    const v = String(c == null ? '' : c).trim().toUpperCase();
    return STOCK_CURRENCIES.includes(v) ? v : 'TRY';
};

const toDecimal = (v) => {
    if (v === undefined || v === null || v === '') return 0;
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    let s = String(v).trim().replace(/\s/g, '').replace(/[₺$€]/g, '');
    if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
    else if (s.includes(',')) s = s.replace(',', '.');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
};

const toQty = (v) => {
    const n = Math.round(toDecimal(v));
    return Number.isFinite(n) ? n : 0;
};

// İşlem (transaction) içinde Kategori/Marka bul ya da oluştur, id döndür.
// table/idCol kod tarafından sabittir (kullanıcı girdisi değil) → enjeksiyon riski yok.
const resolveLookupId = async (transaction, table, idCol, name) => {
    const trimmed = String(name == null ? '' : name).trim();
    if (!trimmed) return null;
    const found = await transaction.request()
        .input('n', sql.NVarChar(200), trimmed)
        .query(`SELECT ${idCol} AS id FROM ${table} WHERE Name = @n`);
    if (found.recordset.length > 0) return found.recordset[0].id;
    const ins = await transaction.request()
        .input('n', sql.NVarChar(200), trimmed)
        .query(`INSERT INTO ${table} (Name, CreatedAt) OUTPUT INSERTED.${idCol} AS id VALUES (@n, GETDATE())`);
    return ins.recordset[0].id;
};

// Bir ürünün alt barkodlarını transaction içinde tam senkronlar (sil + yeniden ekle).
// Boşları, ana barkodu ve tekrarları ayıklar.
const syncBarcodes = async (transaction, stockId, barcodes, mainBarcode) => {
    if (!Array.isArray(barcodes)) return;
    const main = String(mainBarcode || '').trim();
    const clean = [];
    const seen = new Set();
    for (const b of barcodes) {
        const raw = (b && typeof b === 'object') ? (b.barcode ?? b.Barcode ?? '') : b;
        const code = String(raw == null ? '' : raw).trim();
        if (!code || code === main || seen.has(code)) continue;
        seen.add(code);
        clean.push(code);
    }

    await transaction.request()
        .input('sid', sql.Int, stockId)
        .query(`DELETE FROM ProductBarcodes WHERE StockID = @sid`);

    for (const code of clean) {
        await transaction.request()
            .input('sid', sql.Int, stockId)
            .input('code', sql.NVarChar(100), code)
            .query(`INSERT INTO ProductBarcodes (StockID, Barcode, CreatedAt) VALUES (@sid, @code, GETDATE())`);
    }
};

const isUniqueViolation = (err) => err && (err.number === 2627 || err.number === 2601);

// LISTE / ARAMA — tüm oturum açmış kullanıcılar (teknisyen parça seçebilsin).
// Arama hem ana barkodu hem de alt barkodları (ProductBarcodes) kapsar.
router.get('/', authenticate, async (req, res) => {
    const { search } = req.query;
    const showCost = canViewPricing(req.user);
    try {
        const pool = await poolPromise;
        const request = pool.request();
        let query = `${STOCK_SELECT} WHERE 1=1`;
        if (search) {
            query += ` AND (s.Name LIKE @search OR s.Barcode LIKE @search OR s.OemCode LIKE @search OR s.VehicleCompat LIKE @search
                OR EXISTS (SELECT 1 FROM ProductBarcodes pb WHERE pb.StockID = s.StockID AND pb.Barcode LIKE @search))`;
            request.input('search', `%${search}%`);
        }
        query += ` ORDER BY s.Name ASC`;
        const result = await request.query(query);
        res.json(result.recordset.map((r) => shapeStock(r, showCost)));
    } catch (error) {
        console.error('Stok listesi hatası:', error);
        res.status(500).json({ error: 'Stoklar alınamadı.' });
    }
});

// ─── Kategoriler ──────────────────────────────────────────────────────────────
router.get('/categories', authenticate, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`SELECT CategoryID, Name FROM Categories ORDER BY Name ASC`);
        res.json(result.recordset);
    } catch (error) {
        console.error('Kategori listesi hatası:', error);
        res.status(500).json({ error: 'Kategoriler alınamadı.' });
    }
});

router.post('/categories', authenticate, adminOnly, async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Kategori adı zorunludur.' });
    try {
        const pool = await poolPromise;
        // Idempotent: varsa mevcut kaydı döndür, yoksa oluştur.
        const existing = await pool.request()
            .input('n', sql.NVarChar(200), name)
            .query(`SELECT CategoryID, Name FROM Categories WHERE Name = @n`);
        if (existing.recordset.length > 0) return res.json(existing.recordset[0]);
        const result = await pool.request()
            .input('n', sql.NVarChar(200), name)
            .query(`INSERT INTO Categories (Name, CreatedAt) OUTPUT INSERTED.CategoryID, INSERTED.Name VALUES (@n, GETDATE())`);
        res.status(201).json(result.recordset[0]);
    } catch (error) {
        if (isUniqueViolation(error)) return res.status(409).json({ error: 'Bu kategori zaten mevcut.' });
        console.error('Kategori ekleme hatası:', error);
        res.status(500).json({ error: 'Kategori eklenemedi.' });
    }
});

// ─── Markalar ─────────────────────────────────────────────────────────────────
router.get('/brands', authenticate, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`SELECT BrandID, Name FROM Brands ORDER BY Name ASC`);
        res.json(result.recordset);
    } catch (error) {
        console.error('Marka listesi hatası:', error);
        res.status(500).json({ error: 'Markalar alınamadı.' });
    }
});

router.post('/brands', authenticate, adminOnly, async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Marka adı zorunludur.' });
    try {
        const pool = await poolPromise;
        const existing = await pool.request()
            .input('n', sql.NVarChar(200), name)
            .query(`SELECT BrandID, Name FROM Brands WHERE Name = @n`);
        if (existing.recordset.length > 0) return res.json(existing.recordset[0]);
        const result = await pool.request()
            .input('n', sql.NVarChar(200), name)
            .query(`INSERT INTO Brands (Name, CreatedAt) OUTPUT INSERTED.BrandID, INSERTED.Name VALUES (@n, GETDATE())`);
        res.status(201).json(result.recordset[0]);
    } catch (error) {
        if (isUniqueViolation(error)) return res.status(409).json({ error: 'Bu marka zaten mevcut.' });
        console.error('Marka ekleme hatası:', error);
        res.status(500).json({ error: 'Marka eklenemedi.' });
    }
});

// BARKOD ile hızlı ürün getirme — genel arama + barkod okuyucu akışları için.
// (FastPOS için yazılmıştı; FastPOS askıda ama uç genel kullanımda — kalıyor.)
// Okutulan kod hem ana Stocks.Barcode hem de ProductBarcodes içinde aranır.
// '/:id' üstünde tanımlı; iki segmentli yol olduğundan onunla çakışmaz.
router.get('/barcode/:code', authenticate, async (req, res) => {
    const code = (req.params.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Barkod boş olamaz.' });
    const showCost = canViewPricing(req.user);
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('code', sql.NVarChar(100), code)
            .query(`
                ${STOCK_SELECT}
                WHERE s.Barcode = @code
                   OR s.StockID IN (SELECT StockID FROM ProductBarcodes WHERE Barcode = @code)
                ORDER BY s.StockID ASC
            `);
        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Bu barkoda ait ürün bulunamadı.' });
        }
        res.json(shapeStock(result.recordset[0], showCost));
    } catch (error) {
        console.error('Barkod sorgu hatası:', error);
        res.status(500).json({ error: 'Ürün sorgulanamadı.' });
    }
});

// TÜKENME TAHMİNİ — son 60 günün çıkış hızından "kaç gün sonra biter" projeksiyonu.
// dailyRate = 60 günlük toplam Çıkış / 60. daysLeft = mevcut / dailyRate.
// Yalnız tüketimi OLAN ve <= horizon gün içinde bitecek kalemler döner →
// "Bu hızla giderseniz X kalemi Perşembe bitiyor" uyarısının veri kaynağı.
router.get('/forecast', authenticate, async (req, res) => {
    const horizon = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
    try {
        const pool = await poolPromise;
        const r = await pool.request().query(`
            SELECT s.StockID, s.Name, s.Quantity, s.Unit,
                   ISNULL(m.OutQty, 0) AS OutQty60
            FROM Stocks s
            JOIN (
                SELECT StockID, SUM(Quantity) AS OutQty
                FROM StockMovements
                WHERE Direction = 'Cikis' AND CreatedAt >= DATEADD(day, -60, GETDATE())
                GROUP BY StockID
            ) m ON m.StockID = s.StockID
            WHERE ISNULL(m.OutQty, 0) > 0
        `);
        const items = r.recordset
            .map((x) => {
                const dailyRate = Number(x.OutQty60) / 60;
                const qty = Number(x.Quantity) || 0;
                const daysLeft = dailyRate > 0 ? qty / dailyRate : Infinity;
                return {
                    stockId: x.StockID, name: x.Name, quantity: qty, unit: x.Unit || 'Adet',
                    dailyRate: Math.round(dailyRate * 1000) / 1000,
                    daysLeft: Number.isFinite(daysLeft) ? Math.round(daysLeft * 10) / 10 : null,
                    runOutAt: Number.isFinite(daysLeft)
                        ? new Date(Date.now() + daysLeft * 86400000).toISOString().slice(0, 10)
                        : null,
                };
            })
            .filter((x) => x.daysLeft !== null && x.daysLeft <= horizon)
            .sort((a, b) => a.daysLeft - b.daysLeft);
        res.json({ horizonDays: horizon, items });
    } catch (error) {
        console.error('Stok tahmin hatası:', error);
        res.status(500).json({ error: 'Tükenme tahmini hesaplanamadı.' });
    }
});

// TOPLU İÇE AKTARIM — Excel/CSV'den gelen normalize satırlar (tek ACID transaction).
// Beklenen satır biçimi: { barcode, name, category, brand, price, quantity }
// Barkod sistemde varsa (ana veya alt) miktar ÜZERİNE EKLENİR ve fiyat güncellenir
// (kümülatif upsert). Kategori/Marka yoksa otomatik oluşturulup bağlanır.
router.post('/bulk-import', authenticate, adminOnly, async (req, res) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : null;
    if (!rows || rows.length === 0) {
        return res.status(400).json({ error: 'İçe aktarılacak veri bulunamadı.' });
    }
    if (rows.length > 50000) {
        return res.status(400).json({ error: 'Tek seferde en fazla 50.000 satır aktarılabilir.' });
    }

    const summary = { total: rows.length, inserted: 0, updated: 0, skipped: 0, errors: [] };

    try {
        const pool = await poolPromise;
        const transaction = pool.transaction();
        await transaction.begin();
        try {
            // Kategori/Marka adlarını transaction içinde tek sefer çözüp önbelleğe al.
            const catCache = new Map();
            const brandCache = new Map();
            const resolveCached = async (cache, table, idCol, name) => {
                const key = String(name == null ? '' : name).trim().toLocaleLowerCase('tr');
                if (!key) return null;
                if (cache.has(key)) return cache.get(key);
                const id = await resolveLookupId(transaction, table, idCol, name);
                cache.set(key, id);
                return id;
            };

            for (let i = 0; i < rows.length; i++) {
                const row = rows[i] || {};
                const name = String(row.name == null ? '' : row.name).trim();
                const barcode = String(row.barcode == null ? '' : row.barcode).trim();
                const price = round2(toDecimal(row.price));
                const qty = toQty(row.quantity);
                const hasCurrency = row.currency != null && String(row.currency).trim() !== '';
                const rowCurrency = normStockCurrency(row.currency);

                // Geçerli satır için en az ad veya barkod gerekir.
                if (!name && !barcode) {
                    summary.skipped++;
                    summary.errors.push({ row: i + 2, error: 'Ad ve barkod boş' });
                    continue;
                }

                const categoryId = await resolveCached(catCache, 'Categories', 'CategoryID', row.category);
                const brandId = await resolveCached(brandCache, 'Brands', 'BrandID', row.brand);

                let existingId = null;
                if (barcode) {
                    const found = await transaction.request()
                        .input('code', sql.NVarChar(100), barcode)
                        .query(`
                            SELECT TOP 1 id FROM (
                                SELECT StockID AS id FROM Stocks WHERE Barcode = @code
                                UNION
                                SELECT StockID AS id FROM ProductBarcodes WHERE Barcode = @code
                            ) t
                        `);
                    if (found.recordset.length > 0) existingId = found.recordset[0].id;
                }

                if (existingId) {
                    // Kümülatif upsert: miktarı ekle, fiyatı/adı/kategori/markayı güncelle.
                    await transaction.request()
                        .input('id', sql.Int, existingId)
                        .input('qty', sql.Int, qty)
                        .input('price', sql.Decimal(10, 2), price)
                        .input('name', sql.NVarChar(255), name)
                        .input('categoryId', sql.Int, categoryId)
                        .input('brandId', sql.Int, brandId)
                        .input('hasCurrency', sql.Bit, hasCurrency)
                        .input('currency', sql.NVarChar(5), rowCurrency)
                        .query(`
                            UPDATE Stocks SET
                                Quantity = Quantity + @qty,
                                SalePrice = CASE WHEN @price > 0 THEN @price ELSE SalePrice END,
                                Name = CASE WHEN LEN(@name) > 0 THEN @name ELSE Name END,
                                CategoryID = COALESCE(@categoryId, CategoryID),
                                BrandID = COALESCE(@brandId, BrandID),
                                Currency = CASE WHEN @hasCurrency = 1 THEN @currency ELSE Currency END,
                                UpdatedAt = GETDATE()
                            WHERE StockID = @id
                        `);
                    summary.updated++;
                } else {
                    await transaction.request()
                        .input('name', sql.NVarChar(255), name || barcode)
                        .input('barcode', sql.NVarChar(100), barcode || null)
                        .input('qty', sql.Int, qty)
                        .input('price', sql.Decimal(10, 2), price)
                        .input('categoryId', sql.Int, categoryId)
                        .input('brandId', sql.Int, brandId)
                        .input('currency', sql.NVarChar(5), rowCurrency)
                        .query(`
                            INSERT INTO Stocks (Name, Barcode, Quantity, Currency, SalePrice, CriticalLevel, CategoryID, BrandID, CreatedAt)
                            VALUES (@name, @barcode, @qty, @currency, @price, 0, @categoryId, @brandId, GETDATE())
                        `);
                    summary.inserted++;
                }
            }

            await transaction.commit();
        } catch (txError) {
            try { await transaction.rollback(); } catch { /* zaten kapandıysa yoksay */ }
            throw txError;
        }

        // Stok değişti — web mağazasını arka planda güncelle (fire-and-forget).
        triggerWebSync();
        res.json({ success: true, ...summary });
    } catch (error) {
        console.error('Stok toplu içe aktarım hatası:', error);
        res.status(500).json({ error: error.message || 'Toplu içe aktarım başarısız.' });
    }
});

// TEK STOK (alt barkodlar dahil).
router.get('/:id', authenticate, async (req, res) => {
    const showCost = canViewPricing(req.user);
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('id', sql.Int, req.params.id)
            .query(`${STOCK_SELECT} WHERE s.StockID = @id`);
        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Stok bulunamadı.' });
        }
        const barcodes = await pool.request()
            .input('id', sql.Int, req.params.id)
            .query(`SELECT BarcodeID, Barcode FROM ProductBarcodes WHERE StockID = @id ORDER BY BarcodeID ASC`);
        const shaped = shapeStock(result.recordset[0], showCost);
        shaped.Barcodes = barcodes.recordset;
        res.json(shaped);
    } catch (error) {
        console.error('Stok detay hatası:', error);
        res.status(500).json({ error: 'Stok alınamadı.' });
    }
});

// EKLE — yalnızca yönetici (stok yönetimi). Alt barkodlar dahil, ACID.
router.post('/', authenticate, adminOnly, async (req, res) => {
    const {
        name, barcode, quantity, purchasePrice, salePrice, criticalLevel,
        showOnWeb, webDescription, categoryId, brandId, barcodes, unit, currency, alertEnabled,
        oemCode, vehicleCompat, partType,
    } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Parça adı zorunludur.' });
    }
    const onWeb = showOnWeb === true || showOnWeb === 1 || showOnWeb === '1';
    // Uyarı bayrağı yokluğunda varsayılan AÇIK (geriye dönük uyumluluk).
    const alertOn = alertEnabled === undefined ? true : !(alertEnabled === false || alertEnabled === 0 || alertEnabled === '0');
    const safeUnit = normalizeUnit(unit);
    const safeCurrency = normStockCurrency(currency);
    try {
        const pool = await poolPromise;
        const transaction = pool.transaction();
        await transaction.begin();
        try {
            const result = await transaction.request()
                .input('name', sql.NVarChar(255), name.trim())
                .input('barcode', sql.NVarChar(100), barcode || null)
                .input('quantity', sql.Decimal(18, 3), normalizeQuantity(quantity, safeUnit))
                .input('unit', sql.NVarChar(20), safeUnit)
                .input('currency', sql.NVarChar(5), safeCurrency)
                .input('purchasePrice', sql.Decimal(10, 2), purchasePrice === '' || purchasePrice == null ? null : Number(purchasePrice))
                .input('salePrice', sql.Decimal(10, 2), salePrice === '' || salePrice == null ? null : Number(salePrice))
                .input('criticalLevel', sql.Int, Number(criticalLevel) || 0)
                .input('alertEnabled', sql.Bit, alertOn)
                .input('showOnWeb', sql.Bit, onWeb)
                .input('webDescription', sql.NVarChar(sql.MAX), webDescription || null)
                .input('categoryId', sql.Int, categoryId ? Number(categoryId) : null)
                .input('brandId', sql.Int, brandId ? Number(brandId) : null)
                .input('oemCode', sql.NVarChar(60), oemCode?.trim() || null)
                .input('vehicleCompat', sql.NVarChar(500), vehicleCompat?.trim() || null)
                .input('partType', sql.NVarChar(20), partType?.trim() || null)
                .query(`
                    INSERT INTO Stocks (Name, Barcode, Quantity, Unit, Currency, PurchasePrice, SalePrice, CriticalLevel, AlertEnabled, ShowOnWeb, WebDescription, CategoryID, BrandID, OemCode, VehicleCompat, PartType)
                    OUTPUT INSERTED.StockID
                    VALUES (@name, @barcode, @quantity, @unit, @currency, @purchasePrice, @salePrice, @criticalLevel, @alertEnabled, @showOnWeb, @webDescription, @categoryId, @brandId, @oemCode, @vehicleCompat, @partType)
                `);
            const stockId = result.recordset[0].StockID;

            await syncBarcodes(transaction, stockId, barcodes, barcode);

            await transaction.commit();
            // Web'de gösterilecekse web mağazasını arka planda güncelle (fire-and-forget).
            if (onWeb) triggerWebSync();
            res.json({ success: true, stockId });
        } catch (txError) {
            try { await transaction.rollback(); } catch { /* yoksay */ }
            throw txError;
        }
    } catch (error) {
        if (isUniqueViolation(error)) return res.status(409).json({ error: 'Bu barkod başka bir üründe kayıtlı.' });
        console.error('Stok ekleme hatası:', error);
        res.status(500).json({ error: 'Stok eklenemedi.' });
    }
});

// GÜNCELLE — yalnızca yönetici. Alt barkodlar dahil, ACID.
router.put('/:id', authenticate, adminOnly, async (req, res) => {
    const {
        name, barcode, quantity, purchasePrice, salePrice, criticalLevel,
        showOnWeb, webDescription, categoryId, brandId, barcodes, unit, currency, alertEnabled,
        oemCode, vehicleCompat, partType,
    } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Parça adı zorunludur.' });
    }
    const onWeb = showOnWeb === true || showOnWeb === 1 || showOnWeb === '1';
    // Uyarı bayrağı yokluğunda varsayılan AÇIK (geriye dönük uyumluluk).
    const alertOn = alertEnabled === undefined ? true : !(alertEnabled === false || alertEnabled === 0 || alertEnabled === '0');
    const safeUnit = normalizeUnit(unit);
    const safeCurrency = normStockCurrency(currency);
    try {
        const pool = await poolPromise;
        const transaction = pool.transaction();
        await transaction.begin();
        try {
            const result = await transaction.request()
                .input('id', sql.Int, req.params.id)
                .input('name', sql.NVarChar(255), name.trim())
                .input('barcode', sql.NVarChar(100), barcode || null)
                .input('quantity', sql.Decimal(18, 3), normalizeQuantity(quantity, safeUnit))
                .input('unit', sql.NVarChar(20), safeUnit)
                .input('currency', sql.NVarChar(5), safeCurrency)
                .input('purchasePrice', sql.Decimal(10, 2), purchasePrice === '' || purchasePrice == null ? null : Number(purchasePrice))
                .input('salePrice', sql.Decimal(10, 2), salePrice === '' || salePrice == null ? null : Number(salePrice))
                .input('criticalLevel', sql.Int, Number(criticalLevel) || 0)
                .input('alertEnabled', sql.Bit, alertOn)
                .input('showOnWeb', sql.Bit, onWeb)
                .input('webDescription', sql.NVarChar(sql.MAX), webDescription || null)
                .input('categoryId', sql.Int, categoryId ? Number(categoryId) : null)
                .input('brandId', sql.Int, brandId ? Number(brandId) : null)
                .input('oemCode', sql.NVarChar(60), oemCode?.trim() || null)
                .input('vehicleCompat', sql.NVarChar(500), vehicleCompat?.trim() || null)
                .input('partType', sql.NVarChar(20), partType?.trim() || null)
                .query(`
                    UPDATE Stocks
                    SET Name = @name, Barcode = @barcode, Quantity = @quantity, Unit = @unit,
                        Currency = @currency, PurchasePrice = @purchasePrice, SalePrice = @salePrice,
                        CriticalLevel = @criticalLevel, AlertEnabled = @alertEnabled, ShowOnWeb = @showOnWeb,
                        WebDescription = @webDescription, CategoryID = @categoryId,
                        BrandID = @brandId, OemCode = @oemCode, VehicleCompat = @vehicleCompat, PartType = @partType,
                        UpdatedAt = GETDATE()
                    WHERE StockID = @id
                `);
            if (result.rowsAffected[0] === 0) {
                await transaction.rollback();
                return res.status(404).json({ error: 'Stok bulunamadı.' });
            }

            // barcodes alanı gönderildiyse alt barkodları yeniden senkronla.
            if (barcodes !== undefined) {
                await syncBarcodes(transaction, Number(req.params.id), barcodes, barcode);
            }

            await transaction.commit();
            // Güncelleme web listesini etkileyebilir (toggle açıldı/kapandı, detay değişti).
            triggerWebSync();
            res.json({ success: true });
        } catch (txError) {
            try { await transaction.rollback(); } catch { /* yoksay */ }
            throw txError;
        }
    } catch (error) {
        if (isUniqueViolation(error)) return res.status(409).json({ error: 'Bu barkod başka bir üründe kayıtlı.' });
        console.error('Stok güncelleme hatası:', error);
        res.status(500).json({ error: 'Stok güncellenemedi.' });
    }
});

// SİL — yalnızca yönetici. (Geçmiş servis parça kayıtları StockID=NULL olur, snapshot korunur.)
// Alt barkodlar ProductBarcodes FK ON DELETE CASCADE ile otomatik temizlenir.
router.delete('/:id', authenticate, adminOnly, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('id', sql.Int, req.params.id)
            .query(`DELETE FROM Stocks WHERE StockID = @id`);
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({ error: 'Stok bulunamadı.' });
        }
        // Web'de gösterilen bir ürün silinmiş olabilir — listeyi güncelle.
        triggerWebSync();
        res.json({ success: true });
    } catch (error) {
        console.error('Stok silme hatası:', error);
        res.status(500).json({ error: 'Stok silinemedi.' });
    }
});

module.exports = router;
