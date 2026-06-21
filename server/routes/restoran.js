'use strict';
// ─── ArcTeknik Şef — Restoran Otomasyon API (/api/restoran) ──────────────────
// Tamamen izole modül. Masa planı, adisyon (açık hesap), sipariş, masa taşıma,
// hesap bölme (split), mutfak (KDS) ve tahsilat. Tahsilat anında ortak Kasa
// (Transactions) tablosuna 'Gelir' yazar — POS ile aynı kasa entegrasyon kalıbı.
// Tüm yazma işlemleri ACID transaction içinde; masa/adisyon yarış koşullarına
// karşı UPDLOCK ile korunur.

const express = require('express');
const sql = require('mssql');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { poolPromise } = require('../config/db');
const { authenticate, adminOnly, getJwtSecret } = require('../middleware/auth');
const { requirePermission, PERMISSIONS } = require('../utils/permissions');
const { adjustStock } = require('../services/stockLedger');
const { logAudit } = require('../services/audit');
const { emitRestoran, sseHandler } = require('../services/events');

const router = express.Router();

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
// İptal/zayi nedenleri (mutfağa gönderilmiş kalem silinirken zorunlu).
const CANCEL_REASONS = ['Yanlış Giriş', 'Müşteri Vazgeçti', 'Döküldü/Zayi'];

// Yetkili (yönetici) şifresi doğrula: aktif Admin kullanıcıların PasswordHash'lerine
// karşı bcrypt.compare. Garson terminalinde yönetici şifresiyle iptal onayı için.
async function verifyManagerPassword(pool, password) {
    const pw = String(password || '');
    if (!pw) return false;
    const admins = await pool.request().query(`SELECT PasswordHash FROM Users WHERE Role = 'Admin' AND IsActive = 1`);
    for (const a of admins.recordset) {
        // eslint-disable-next-line no-await-in-loop
        if (a.PasswordHash && await bcrypt.compare(pw, a.PasswordHash)) return true;
    }
    return false;
}
const KITCHEN_STATES = ['Bekliyor', 'Hazırlanıyor', 'Hazır', 'İkram'];
const TABLE_STATES = ['Boş', 'Dolu', 'Rezerve'];
const ORDER_TYPES = ['Masa', 'Paket', 'Gel-Al', 'Self'];
const DELIVERY_STATES = ['Hazırlanıyor', 'Yolda', 'Teslim', 'İptal'];
const RESERVATION_STATES = ['Bekliyor', 'Geldi', 'İptal', 'No-Show'];

// ─── GET /events — gerçek-zamanlı SSE akışı ─────────────────────────────────
// EventSource header gönderemediği için token query'den doğrulanır; bu yüzden
// router.use(authenticate)'ten ÖNCE tanımlı. Geçerli oturum şart, rol fark etmez
// (masa planı + KDS + çağrı ekranı dinler). Olay gövdesi veri İÇERMEZ (yalnız
// "değişti" sinyali) → ekranlar kendi yetkili uçlarından tazeler.
router.get('/events', (req, res) => {
    try {
        const decoded = jwt.verify(String(req.query.token || ''), getJwtSecret());
        req.user = decoded;
    } catch {
        return res.status(401).json({ error: 'Oturum açmanız gerekiyor.' });
    }
    sseHandler(req, res);
});

// Tüm uçlar: geçerli oturum + USE_RESTAURANT yetkisi (Admin her zaman geçer).
router.use(authenticate);
router.use(requirePermission(PERMISSIONS.USE_RESTAURANT));

// Başarılı her YAZMA isteğinden sonra tüm ekranlara "değişti" sinyali (SSE).
// Tek boğum noktası: yeni uçlar dahil hiçbir mutasyon sinyalsiz kalmaz.
router.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    res.on('finish', () => {
        if (res.statusCode < 400) emitRestoran({ scope: 'restoran', path: req.path, method: req.method });
    });
    next();
});

// Adisyon toplamını yeniden hesapla: ödenmemiş + İkram olmayan kalemlerin tutarı.
async function recomputeOrderTotal(trx, orderId) {
    const r = await trx.request()
        .input('oid', sql.Int, orderId)
        .query(`
            SELECT ISNULL(SUM(UnitPrice * Quantity), 0) AS Total
            FROM RestoranOrderItems
            WHERE OrderID = @oid AND PaidAt IS NULL AND KitchenStatus <> N'İkram'
        `);
    const total = round2(r.recordset[0].Total);
    await trx.request()
        .input('oid', sql.Int, orderId)
        .input('total', sql.Decimal(10, 2), total)
        .query(`UPDATE RestoranOrders SET Total = @total WHERE OrderID = @oid`);
    return total;
}

// Restoran genel ayarları (kuver + happy hour). Tek satır (Id=1).
async function loadSettings(pool) {
    const r = await pool.request().query(`
        SELECT TOP 1 CoverCharge, HappyEnabled, HappyStart, HappyEnd, HappyPercent, LoyaltyPercent
        FROM RestoranSettings WHERE Id = 1
    `);
    return r.recordset[0] || { CoverCharge: 0, HappyEnabled: false, HappyStart: 0, HappyEnd: 0, HappyPercent: 0, LoyaltyPercent: 0 };
}

// ─── Restoran Özelleştirme (Şefim "Feature.*" sadeleştirilmiş karşılığı) ──────
// Sade key/value bayraklar. Varsayılanlar BURADA (tek doğru kaynak); tabloda
// yalnız değiştirilen anahtarlar tutulur. Yeni bayrak = bu haritaya satır ekle +
// ilgili davranışı/UI'ı bağla. Değerler string ('1' açık / '0' kapalı).
const RESTORAN_FEATURE_DEFAULTS = {
    // Ödeme yöntemleri (ödeme + hızlı ödeme ekranı butonları)
    payCash: '1',    // Nakit ödeme butonu görünür
    payCard: '1',    // Kredi kartı ödeme butonu görünür
    payTicket: '1',  // Yemek fişi ödeme butonu görünür
    // Masa ekranı göstergeleri / davranış
    showTableTimer: '1',   // Dolu masa kartında açık kalma süresi göster
    showTableTotal: '1',   // Dolu masa kartında adisyon tutarı göster
    showTableGuests: '0',  // Dolu masa kartında kişi sayısı göster (varsayılan kapalı)
    showTableWaiter: '0',  // Dolu masa kartında açan garson göster (varsayılan kapalı)
    askGuestCount: '1',    // Boş masa açılışında kişi sayısı sor (kapalı = direkt aç)
    // Görünüm (çok-değerli)
    buttonSize: 'md',     // Menü ürün butonu boyutu: 'sm' | 'md' | 'lg'
    // Tahsilat davranışı
    roundTotal: '0',      // Tam tek tahsilatta net tutarı en yakın tam TL'ye yuvarla (varsayılan KAPALI)
    // İptal/zayi davranışı
    askCancelReason: '1', // Mutfağa gitmiş kalem iptalinde neden SOR (kapalı = neden zorunlu değil; yönetici onayı yine geçerli)
};

async function loadFeatures(pool) {
    const out = { ...RESTORAN_FEATURE_DEFAULTS };
    try {
        const r = await pool.request().query(`SELECT Name, Value FROM RestoranFeatures`);
        for (const row of r.recordset) if (Object.prototype.hasOwnProperty.call(out, row.Name)) out[row.Name] = row.Value;
    } catch { /* tablo henüz yoksa varsayılanlar döner */ }
    return out;
}

// Yalnız bilinen anahtarları (whitelist) upsert eder → güvenli + sade.
async function saveFeatures(pool, obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
        if (!Object.prototype.hasOwnProperty.call(RESTORAN_FEATURE_DEFAULTS, k)) continue;
        const val = String(v === true ? '1' : v === false ? '0' : v).slice(0, 400);
        await pool.request()
            .input('n', sql.NVarChar(80), k)
            .input('v', sql.NVarChar(400), val)
            .query(`
                MERGE RestoranFeatures AS t USING (SELECT @n AS Name) AS s ON t.Name = s.Name
                WHEN MATCHED THEN UPDATE SET Value = @v
                WHEN NOT MATCHED THEN INSERT (Name, Value) VALUES (@n, @v);
            `);
    }
}

// Combo bileşenlerini çek. runner = pool veya trx (ikisinde de .request() var).
// Dönüş: Map(comboProductId → [{componentId, quantity, name, target}]).
async function fetchComboComponents(runner, comboIds) {
    const out = new Map();
    if (!comboIds || !comboIds.length) return out;
    const rq = runner.request();
    comboIds.forEach((id, i) => rq.input(`c${i}`, sql.Int, id));
    const r = await rq.query(`
        SELECT ci.ComboProductID, ci.ComponentProductID, ci.Quantity,
               p.Name, ISNULL(cat.PrinterTarget, N'Mutfak') AS Target
        FROM RestoranComboItems ci
        LEFT JOIN RestoranProducts p ON p.ProductID = ci.ComponentProductID
        LEFT JOIN RestoranCategories cat ON cat.CategoryID = p.CategoryID
        WHERE ci.ComboProductID IN (${comboIds.map((_, i) => `@c${i}`).join(',')})
    `);
    for (const row of r.recordset) {
        if (!out.has(row.ComboProductID)) out.set(row.ComboProductID, []);
        out.get(row.ComboProductID).push({
            componentId: row.ComponentProductID, quantity: Number(row.Quantity) || 1,
            name: row.Name || 'Ürün', target: row.Target || 'Mutfak',
        });
    }
    return out;
}

// Happy Hour: pencere içindeyse fiyatı yüzde indir. Pencere gece yarısını sarabilir.
function happyPrice(base, s) {
    const price = round2(base);
    if (!s || !s.HappyEnabled || !(Number(s.HappyPercent) > 0)) return { price, active: false };
    const h = new Date().getHours();
    const a = s.HappyStart, b = s.HappyEnd;
    const within = a === b ? false : (a < b ? (h >= a && h < b) : (h >= a || h < b));
    return within ? { price: round2(base * (1 - Number(s.HappyPercent) / 100)), active: true } : { price, active: false };
}

// İstek gövdesinden sipariş kalemlerini doğrula + normalize et. {items} döner veya
// { error } (400 mesajı). Hem masa hem paket sipariş yolları kullanır.
function parseItems(body) {
    const raw = Array.isArray(body.items) ? body.items : [body];
    const items = [];
    for (const it of raw) {
        // quantity verilmemişse 1; verilmişse SAYI ve >0 olmalı. (Eski `|| 1`
        // deseni 0'ı sessizce 1'e çeviriyordu — birim testi yakaladı.)
        const qty = it.quantity === undefined ? 1 : parseInt(it.quantity, 10);
        if (!Number.isFinite(qty) || qty <= 0) return { error: 'Geçersiz miktar.' };
        const note = (it.note != null ? String(it.note) : '').slice(0, 300);
        if (it.productId != null) {
            const pid = parseInt(it.productId, 10);
            if (!pid) return { error: 'Geçersiz ürün.' };
            const optionIds = Array.isArray(it.optionIds) ? it.optionIds.map((x) => parseInt(x, 10)).filter(Boolean) : [];
            items.push({ productId: pid, quantity: qty, note, optionIds });
        } else {
            const name = String(it.name || '').trim().slice(0, 200);
            const price = Number(it.unitPrice);
            if (!name || !Number.isFinite(price) || price < 0) return { error: 'Geçersiz açık kalem.' };
            items.push({ productId: null, name, unitPrice: round2(price), quantity: qty, note });
        }
    }
    if (items.length === 0) return { error: 'Sipariş boş.' };
    return { items };
}

// Doğrulanmış kalemleri açık bir adisyona ekle (ACID trx içinde). Ürün fiyatı +
// seçenekleri SUNUCUDAN okunur (fiyat güvenliği); happy hour + seçenek farkı uygulanır.
// Toplam yeniden hesaplama çağırana aittir.
async function insertOrderItems(trx, orderId, items, settings) {
    for (const it of items) {
        let name = it.name, unitPrice = it.unitPrice, optionsLabel = null;
        if (it.productId != null) {
            const p = await trx.request().input('pid', sql.Int, it.productId)
                .query(`SELECT Name, Price FROM RestoranProducts WHERE ProductID = @pid AND IsActive = 1`);
            if (p.recordset.length === 0) throw new Error('Menü ürünü bulunamadı veya pasif.');
            name = p.recordset[0].Name;
            const hp = happyPrice(p.recordset[0].Price, settings);
            unitPrice = hp.price;

            const grpRes = await trx.request().input('pid', sql.Int, it.productId).query(`
                SELECT g.GroupID, g.MinSelect, g.MaxSelect
                FROM RestoranProductOptionGroups l JOIN RestoranOptionGroups g ON g.GroupID = l.GroupID
                WHERE l.ProductID = @pid
            `);
            if (grpRes.recordset.length > 0) {
                let chosen = [];
                if (it.optionIds && it.optionIds.length) {
                    const optReq = trx.request();
                    it.optionIds.forEach((id, i) => optReq.input(`o${i}`, sql.Int, id));
                    const selRes = await optReq.query(`
                        SELECT OptionID, GroupID, Name, PriceDelta FROM RestoranOptions
                        WHERE OptionID IN (${it.optionIds.map((_, i) => `@o${i}`).join(',')})
                    `);
                    const productGroupIds = new Set(grpRes.recordset.map((g) => g.GroupID));
                    chosen = selRes.recordset.filter((o) => productGroupIds.has(o.GroupID));
                }
                const countByGroup = {};
                chosen.forEach((o) => { countByGroup[o.GroupID] = (countByGroup[o.GroupID] || 0) + 1; });
                for (const g of grpRes.recordset) {
                    const c = countByGroup[g.GroupID] || 0;
                    if (g.MinSelect > 0 && c < g.MinSelect) throw new Error('Zorunlu seçenek eksik.');
                    if (g.MaxSelect > 0 && c > g.MaxSelect) throw new Error('Çok fazla seçenek seçildi.');
                }
                const delta = chosen.reduce((s, o) => s + Number(o.PriceDelta), 0);
                unitPrice = round2(unitPrice + delta);
                optionsLabel = chosen.map((o) => o.Name).join(', ').slice(0, 500) || null;
            }
        }
        await trx.request()
            .input('oid', sql.Int, orderId)
            .input('pid', sql.Int, it.productId)
            .input('name', sql.NVarChar(200), name)
            .input('price', sql.Decimal(10, 2), unitPrice)
            .input('qty', sql.Int, it.quantity)
            .input('note', sql.NVarChar(300), it.note || null)
            .input('opts', sql.NVarChar(500), optionsLabel)
            .query(`
                INSERT INTO RestoranOrderItems (OrderID, ProductID, Name, UnitPrice, Quantity, Note, Options, KitchenStatus)
                VALUES (@oid, @pid, @name, @price, @qty, @note, @opts, N'Bekliyor')
            `);
    }
}

// ═══ MASA PLANI & MENÜ (okuma) ═══════════════════════════════════════════════

// GET /floor — bölümlere göre masalar + açık adisyon tutarları (ana ekran).
router.get('/floor', async (req, res) => {
    try {
        const pool = await poolPromise;
        const sections = await pool.request().query(`
            SELECT SectionID, Name, SortOrder FROM RestoranSections ORDER BY SortOrder, Name
        `);
        const tables = await pool.request().query(`
            SELECT t.TableID, t.SectionID, t.TableNo, t.Status, t.CurrentOrderID, t.SortOrder,
                   o.Total AS OrderTotal, o.OpenedAt, o.GuestCount, o.OpenedBy,
                   CASE WHEN o.OpenedAt IS NULL THEN NULL ELSE DATEDIFF(MINUTE, o.OpenedAt, GETDATE()) END AS OpenMinutes
            FROM RestoranTables t
            LEFT JOIN RestoranOrders o ON o.OrderID = t.CurrentOrderID AND o.Status = N'Açık'
            ORDER BY t.SortOrder, t.TableNo
        `);
        const bySection = new Map();
        for (const s of sections.recordset) bySection.set(s.SectionID, { ...s, tables: [] });
        const orphan = [];
        for (const t of tables.recordset) {
            const row = {
                tableId: t.TableID, tableNo: t.TableNo, status: t.Status,
                currentOrderId: t.CurrentOrderID,
                orderTotal: t.OrderTotal != null ? Number(t.OrderTotal) : 0,
                openedAt: t.OpenedAt || null,
                openMinutes: t.OpenMinutes != null ? Number(t.OpenMinutes) : null,
                guestCount: t.GuestCount || null,
                waiter: t.OpenedBy || null,
            };
            const sec = bySection.get(t.SectionID);
            if (sec) sec.tables.push(row); else orphan.push(row);
        }
        const result = sections.recordset.map((s) => bySection.get(s.SectionID));
        if (orphan.length) result.push({ SectionID: null, Name: 'Bölümsüz', tables: orphan });
        res.json(result.map((s) => ({ id: s.SectionID, name: s.Name, tables: s.tables })));
    } catch (err) {
        console.error('Restoran floor hatası:', err);
        res.status(500).json({ error: 'Masa planı alınamadı.' });
    }
});

// GET /menu — kategoriler + aktif ürünler (gruplu).
router.get('/menu', async (req, res) => {
    try {
        const pool = await poolPromise;
        const settings = await loadSettings(pool);
        const cats = await pool.request().query(`
            SELECT CategoryID, Name, SortOrder, PrinterTarget FROM RestoranCategories ORDER BY SortOrder, Name
        `);
        const prods = await pool.request().query(`
            SELECT ProductID, CategoryID, Name, Price, IsActive, SortOrder, IsCombo
            FROM RestoranProducts WHERE IsActive = 1 ORDER BY SortOrder, Name
        `);

        // Seçenek grupları + seçenekler + ürün bağları (modifier).
        const groupsRes = await pool.request().query(`SELECT GroupID, Name, MinSelect, MaxSelect FROM RestoranOptionGroups ORDER BY SortOrder, Name`);
        const optsRes = await pool.request().query(`SELECT OptionID, GroupID, Name, PriceDelta FROM RestoranOptions ORDER BY SortOrder, Name`);
        const linksRes = await pool.request().query(`SELECT ProductID, GroupID FROM RestoranProductOptionGroups`);
        const optsByGroup = new Map();
        for (const o of optsRes.recordset) {
            if (!optsByGroup.has(o.GroupID)) optsByGroup.set(o.GroupID, []);
            optsByGroup.get(o.GroupID).push({ id: o.OptionID, name: o.Name, priceDelta: Number(o.PriceDelta) });
        }
        const groupById = new Map();
        for (const g of groupsRes.recordset) {
            groupById.set(g.GroupID, { id: g.GroupID, name: g.Name, min: g.MinSelect, max: g.MaxSelect, options: optsByGroup.get(g.GroupID) || [] });
        }
        const groupsByProduct = new Map();
        for (const l of linksRes.recordset) {
            const g = groupById.get(l.GroupID);
            if (!g) continue;
            if (!groupsByProduct.has(l.ProductID)) groupsByProduct.set(l.ProductID, []);
            groupsByProduct.get(l.ProductID).push(g);
        }

        const byCat = new Map();
        for (const c of cats.recordset) byCat.set(c.CategoryID, { id: c.CategoryID, name: c.Name, printerTarget: c.PrinterTarget || null, products: [] });
        const noCat = { id: null, name: 'Diğer', printerTarget: 'Mutfak', products: [] };
        for (const p of prods.recordset) {
            const hp = happyPrice(p.Price, settings);
            const item = {
                id: p.ProductID, name: p.Name, price: hp.price, basePrice: Number(p.Price),
                happyActive: hp.active, optionGroups: groupsByProduct.get(p.ProductID) || [],
                isCombo: !!p.IsCombo,
            };
            const c = p.CategoryID != null ? byCat.get(p.CategoryID) : null;
            (c || noCat).products.push(item);
        }
        const out = cats.recordset.map((c) => byCat.get(c.CategoryID)).filter((c) => c.products.length);
        if (noCat.products.length) out.push(noCat);
        res.json({ categories: out, happyActive: happyPrice(100, settings).active, cover: Number(settings.CoverCharge), features: await loadFeatures(pool) });
    } catch (err) {
        console.error('Restoran menu hatası:', err);
        res.status(500).json({ error: 'Menü alınamadı.' });
    }
});

// GET /tables/:id/order — masanın açık adisyonu + kalemleri (yoksa null).
router.get('/tables/:id/order', async (req, res) => {
    const tableId = parseInt(req.params.id, 10);
    if (!tableId) return res.status(400).json({ error: 'Geçersiz masa.' });
    try {
        const pool = await poolPromise;
        const ord = await pool.request()
            .input('tid', sql.Int, tableId)
            .query(`
                SELECT TOP 1 OrderID, TableID, Status, Total, OpenedBy, OpenedAt, GuestCount, CustomerID, CustomerName
                FROM RestoranOrders WHERE TableID = @tid AND Status = N'Açık'
                ORDER BY OpenedAt DESC
            `);
        if (ord.recordset.length === 0) return res.json({ order: null });
        const order = ord.recordset[0];
        const items = await pool.request()
            .input('oid', sql.Int, order.OrderID)
            .query(`
                SELECT ItemID, ProductID, Name, UnitPrice, Quantity, Note, Options, KitchenStatus, PaidAt, SentToKitchenAt, CreatedAt
                FROM RestoranOrderItems WHERE OrderID = @oid ORDER BY CreatedAt, ItemID
            `);
        res.json({
            order: {
                orderId: order.OrderID, tableId: order.TableID, total: Number(order.Total),
                openedBy: order.OpenedBy, openedAt: order.OpenedAt, guestCount: order.GuestCount || null,
                customerId: order.CustomerID || null, customerName: order.CustomerName || '',
                items: items.recordset.map((i) => ({
                    itemId: i.ItemID, productId: i.ProductID, name: i.Name,
                    unitPrice: Number(i.UnitPrice), quantity: i.Quantity, note: i.Note || '',
                    options: i.Options || '',
                    kitchenStatus: i.KitchenStatus, paid: !!i.PaidAt, sent: !!i.SentToKitchenAt,
                })),
            },
        });
    } catch (err) {
        console.error('Adisyon okuma hatası:', err);
        res.status(500).json({ error: 'Adisyon alınamadı.' });
    }
});

// ═══ SİPARİŞ İŞLEMLERİ ════════════════════════════════════════════════════════

// POST /tables/:id/items — masaya sipariş ekle. Açık adisyon yoksa açılır,
// masa 'Dolu' olur. Tek ACID transaction; masa UPDLOCK ile kilitlenir.
router.post('/tables/:id/items', async (req, res) => {
    const tableId = parseInt(req.params.id, 10);
    if (!tableId) return res.status(400).json({ error: 'Geçersiz masa.' });

    const parsed = parseItems(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const items = parsed.items;

    try {
        const pool = await poolPromise;
        const settings = await loadSettings(pool);
        const trx = pool.transaction();
        await trx.begin();
        try {
            // Masayı kilitle.
            const tRes = await trx.request()
                .input('tid', sql.Int, tableId)
                .query(`SELECT TableID, Status, CurrentOrderID FROM RestoranTables WITH (UPDLOCK, ROWLOCK) WHERE TableID = @tid`);
            if (tRes.recordset.length === 0) throw new Error('Masa bulunamadı.');
            const table = tRes.recordset[0];

            // Açık adisyon var mı?
            let orderId = table.CurrentOrderID;
            if (orderId) {
                const chk = await trx.request().input('oid', sql.Int, orderId)
                    .query(`SELECT OrderID FROM RestoranOrders WHERE OrderID = @oid AND Status = N'Açık'`);
                if (chk.recordset.length === 0) orderId = null;
            }
            if (!orderId) {
                const guestCount = parseInt(req.body.guestCount, 10);
                const created = await trx.request()
                    .input('tid', sql.Int, tableId)
                    .input('by', sql.NVarChar(255), req.user.fullName || null)
                    .input('guests', sql.Int, guestCount > 0 ? guestCount : null)
                    .query(`
                        INSERT INTO RestoranOrders (TableID, Status, OpenedBy, GuestCount)
                        OUTPUT INSERTED.OrderID VALUES (@tid, N'Açık', @by, @guests)
                    `);
                orderId = created.recordset[0].OrderID;

                // Kuver: kişi sayısı + ayar varsa otomatik kuver kalemi (mutfağa gitmez).
                const cover = round2(settings.CoverCharge);
                if (guestCount > 0 && cover > 0) {
                    await trx.request()
                        .input('oid', sql.Int, orderId)
                        .input('cover', sql.Decimal(10, 2), cover)
                        .input('q', sql.Int, guestCount)
                        .query(`
                            INSERT INTO RestoranOrderItems (OrderID, ProductID, Name, UnitPrice, Quantity, KitchenStatus, SentToKitchenAt)
                            VALUES (@oid, NULL, N'Kuver', @cover, @q, N'Hazır', GETDATE())
                        `);
                }
            }

            // Ürün fiyatlarını + seçenekleri sunucudan oku (fiyat güvenliği).
            await insertOrderItems(trx, orderId, items, settings);

            // Masayı 'Dolu' + açık adisyona bağla.
            await trx.request()
                .input('tid', sql.Int, tableId)
                .input('oid', sql.Int, orderId)
                .query(`UPDATE RestoranTables SET Status = N'Dolu', CurrentOrderID = @oid WHERE TableID = @tid`);

            const total = await recomputeOrderTotal(trx, orderId);
            await trx.commit();
            res.json({ success: true, orderId, total });
        } catch (e) {
            await trx.rollback();
            throw e;
        }
    } catch (err) {
        console.error('Sipariş ekleme hatası:', err);
        res.status(400).json({ error: err.message || 'Sipariş eklenemedi.' });
    }
});

// POST /orders/:orderId/items — mevcut AÇIK adisyona kalem ekle (masa/paket farketmez).
// Paket siparişe sonradan kalem eklemek + masa adisyonuna eklemek için ortak yol.
router.post('/orders/:orderId/items', async (req, res) => {
    const orderId = parseInt(req.params.orderId, 10);
    if (!orderId) return res.status(400).json({ error: 'Geçersiz adisyon.' });
    const parsed = parseItems(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    try {
        const pool = await poolPromise;
        const settings = await loadSettings(pool);
        const trx = pool.transaction();
        await trx.begin();
        try {
            const ord = await trx.request().input('oid', sql.Int, orderId)
                .query(`SELECT Status FROM RestoranOrders WITH (UPDLOCK, ROWLOCK) WHERE OrderID = @oid`);
            if (ord.recordset.length === 0) throw new Error('Adisyon bulunamadı.');
            if (ord.recordset[0].Status !== 'Açık') throw new Error('Adisyon kapalı.');
            await insertOrderItems(trx, orderId, parsed.items, settings);
            const total = await recomputeOrderTotal(trx, orderId);
            await trx.commit();
            res.json({ success: true, orderId, total });
        } catch (e) {
            await trx.rollback();
            throw e;
        }
    } catch (err) {
        console.error('Adisyona kalem ekleme hatası:', err);
        res.status(400).json({ error: err.message || 'Kalem eklenemedi.' });
    }
});

// ═══ PAKET SERVİS & GEL-AL ════════════════════════════════════════════════════
// Masasız adisyon (TableID NULL). Müşteri/adres snapshot'lanır. Kurye atama +
// teslim durumu izlenir. Tahsilat masa adisyonu ile aynı checkout'tan geçer.

// POST /package-orders — yeni paket / gel-al siparişi (adisyon) oluştur + kalemler.
router.post('/package-orders', async (req, res) => {
    const orderType = ORDER_TYPES.includes(req.body.orderType) && req.body.orderType !== 'Masa'
        ? req.body.orderType : 'Paket';
    const parsed = parseItems(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const customerId = req.body.customerId != null ? parseInt(req.body.customerId, 10) || null : null;
    const addressId = req.body.addressId != null ? parseInt(req.body.addressId, 10) || null : null;
    // Snapshot alanları (istemci doğrudan da verebilir; müşteri seçiliyse DB'den okunur).
    let custName = String(req.body.customerName || '').trim().slice(0, 255) || null;
    let custPhone = String(req.body.customerPhone || '').trim().slice(0, 50) || null;
    let address = String(req.body.deliveryAddress || '').trim().slice(0, 500) || null;
    if (orderType === 'Paket' && !address && !addressId && !customerId) {
        return res.status(400).json({ error: 'Paket servis için adres gerekli.' });
    }

    try {
        const pool = await poolPromise;
        const settings = await loadSettings(pool);
        const trx = pool.transaction();
        await trx.begin();
        try {
            // Müşteri/adres seçiliyse snapshot'ı DB'den tamamla.
            if (customerId) {
                const c = await trx.request().input('cid', sql.Int, customerId)
                    .query(`SELECT Name, Phone FROM RestoranCustomers WHERE CustomerID = @cid`);
                if (c.recordset.length) {
                    custName = custName || c.recordset[0].Name;
                    custPhone = custPhone || c.recordset[0].Phone;
                }
            }
            if (addressId) {
                const a = await trx.request().input('aid', sql.Int, addressId)
                    .query(`SELECT Label, AddressText, Directions FROM RestoranAddresses WHERE AddressID = @aid`);
                if (a.recordset.length) {
                    const r = a.recordset[0];
                    address = [r.Label, r.AddressText, r.Directions].filter(Boolean).join(' — ').slice(0, 500);
                }
            }

            const created = await trx.request()
                .input('type', sql.NVarChar(20), orderType)
                .input('by', sql.NVarChar(255), req.user.fullName || null)
                .input('cid', sql.Int, customerId)
                .input('cname', sql.NVarChar(255), custName)
                .input('cphone', sql.NVarChar(50), custPhone)
                .input('addr', sql.NVarChar(500), address)
                .input('dstat', sql.NVarChar(20), orderType === 'Paket' ? 'Hazırlanıyor' : null)
                .query(`
                    INSERT INTO RestoranOrders
                        (TableID, Status, OrderType, OpenedBy, CustomerID, CustomerName, CustomerPhone, DeliveryAddress, DeliveryStatus)
                    OUTPUT INSERTED.OrderID
                    VALUES (NULL, N'Açık', @type, @by, @cid, @cname, @cphone, @addr, @dstat)
                `);
            const orderId = created.recordset[0].OrderID;

            await insertOrderItems(trx, orderId, parsed.items, settings);
            const total = await recomputeOrderTotal(trx, orderId);
            await trx.commit();
            res.json({ success: true, orderId, total });
        } catch (e) {
            await trx.rollback();
            throw e;
        }
    } catch (err) {
        console.error('Paket sipariş hatası:', err);
        res.status(400).json({ error: err.message || 'Paket sipariş oluşturulamadı.' });
    }
});

// GET /package-orders — aktif paket/gel-al adisyonları (açık). Teslim/kurye bilgisi.
router.get('/package-orders', async (req, res) => {
    try {
        const pool = await poolPromise;
        const r = await pool.request().query(`
            SELECT o.OrderID, o.OrderType, o.Total, o.OpenedAt, o.CustomerName, o.CustomerPhone,
                   o.DeliveryAddress, o.DeliveryStatus, o.CourierID, o.AssignedAt, c.Name AS CourierName
            FROM RestoranOrders o
            LEFT JOIN RestoranCouriers c ON c.CourierID = o.CourierID
            WHERE o.Status = N'Açık' AND o.OrderType IN (N'Paket', N'Gel-Al')
            ORDER BY o.OpenedAt DESC
        `);
        res.json(r.recordset.map((o) => ({
            orderId: o.OrderID, orderType: o.OrderType, total: Number(o.Total), openedAt: o.OpenedAt,
            customerName: o.CustomerName || '', customerPhone: o.CustomerPhone || '',
            deliveryAddress: o.DeliveryAddress || '', deliveryStatus: o.DeliveryStatus || '',
            courierId: o.CourierID || null, courierName: o.CourierName || '', assignedAt: o.AssignedAt || null,
        })));
    } catch (err) {
        console.error('Paket liste hatası:', err);
        res.status(500).json({ error: 'Paket siparişler alınamadı.' });
    }
});

// POST /orders/:orderId/assign-courier — paket siparişe kurye ata → 'Yolda'.
router.post('/orders/:orderId/assign-courier', async (req, res) => {
    const orderId = parseInt(req.params.orderId, 10);
    const courierId = parseInt(req.body.courierId, 10);
    if (!orderId || !courierId) return res.status(400).json({ error: 'Geçersiz sipariş/kurye.' });
    try {
        const pool = await poolPromise;
        const chk = await pool.request().input('cid', sql.Int, courierId)
            .query(`SELECT CourierID FROM RestoranCouriers WHERE CourierID = @cid AND IsActive = 1`);
        if (chk.recordset.length === 0) return res.status(400).json({ error: 'Kurye bulunamadı veya pasif.' });
        const r = await pool.request().input('oid', sql.Int, orderId).input('cid', sql.Int, courierId)
            .query(`
                UPDATE RestoranOrders
                SET CourierID = @cid, DeliveryStatus = N'Yolda', AssignedAt = GETDATE()
                WHERE OrderID = @oid AND Status = N'Açık' AND OrderType = N'Paket'
            `);
        if (r.rowsAffected[0] === 0) return res.status(400).json({ error: 'Sipariş paket değil veya kapalı.' });
        res.json({ success: true });
    } catch (err) {
        console.error('Kurye atama hatası:', err);
        res.status(500).json({ error: 'Kurye atanamadı.' });
    }
});

// PATCH /orders/:orderId/delivery — teslim durumu güncelle (Hazırlanıyor/Yolda/Teslim/İptal).
router.patch('/orders/:orderId/delivery', async (req, res) => {
    const orderId = parseInt(req.params.orderId, 10);
    if (!orderId) return res.status(400).json({ error: 'Geçersiz sipariş.' });
    if (!DELIVERY_STATES.includes(req.body.status)) return res.status(400).json({ error: 'Geçersiz teslim durumu.' });
    const status = req.body.status;
    try {
        const pool = await poolPromise;
        const r = await pool.request()
            .input('oid', sql.Int, orderId)
            .input('st', sql.NVarChar(20), status)
            .query(`
                UPDATE RestoranOrders
                SET DeliveryStatus = @st, DeliveredAt = CASE WHEN @st = N'Teslim' THEN GETDATE() ELSE DeliveredAt END
                WHERE OrderID = @oid AND OrderType IN (N'Paket', N'Gel-Al')
            `);
        if (r.rowsAffected[0] === 0) return res.status(400).json({ error: 'Paket sipariş bulunamadı.' });
        res.json({ success: true });
    } catch (err) {
        console.error('Teslim durumu hatası:', err);
        res.status(500).json({ error: 'Teslim durumu güncellenemedi.' });
    }
});

// PATCH /items/:itemId — kalem güncelle (miktar / not / mutfak durumu / ikram).
router.patch('/items/:itemId', async (req, res) => {
    const itemId = parseInt(req.params.itemId, 10);
    if (!itemId) return res.status(400).json({ error: 'Geçersiz kalem.' });
    const sets = [];
    const { quantity, note, kitchenStatus } = req.body;
    if (quantity != null) {
        const q = parseInt(quantity, 10);
        if (!(q > 0)) return res.status(400).json({ error: 'Miktar 0’dan büyük olmalı.' });
        sets.push({ col: 'Quantity', type: sql.Int, val: q });
    }
    if (note != null) sets.push({ col: 'Note', type: sql.NVarChar(300), val: String(note).slice(0, 300) || null });
    if (kitchenStatus != null) {
        if (!KITCHEN_STATES.includes(kitchenStatus)) return res.status(400).json({ error: 'Geçersiz mutfak durumu.' });
        sets.push({ col: 'KitchenStatus', type: sql.NVarChar(20), val: kitchenStatus });
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Güncellenecek alan yok.' });
    const reason = String(req.body?.reason || '').trim();
    const managerPassword = req.body?.managerPassword;

    try {
        const pool = await poolPromise;
        const askReason = (await loadFeatures(pool)).askCancelReason !== '0'; // iptal nedeni sorulsun mu
        const trx = pool.transaction();
        await trx.begin();
        try {
            const cur = await trx.request().input('iid', sql.Int, itemId)
                .query(`
                    SELECT i.OrderID, i.PaidAt, i.Name, i.Quantity, i.SentToKitchenAt, t.TableNo, o.Status AS OrderStatus
                    FROM RestoranOrderItems i
                    LEFT JOIN RestoranOrders o ON o.OrderID = i.OrderID
                    LEFT JOIN RestoranTables t ON t.TableID = o.TableID
                    WHERE i.ItemID = @iid
                `);
            if (cur.recordset.length === 0) throw new Error('Kalem bulunamadı.');
            const item = cur.recordset[0];
            // Ödenmiş kalemde PARAYI etkileyen alanlar (miktar/not/İkram) kilitli.
            // İSTİSNA: salt mutfak iş-akışı durumu (Bekliyor/Hazırlanıyor/Hazır) —
            // self-servis peşin öder, bölünmüş hesapta kalem erken ödenebilir;
            // mutfak yine de hazırlamaya devam eder (adisyon açıkken).
            if (item.PaidAt) {
                const onlyKitchenFlow = sets.length === 1 && sets[0].col === 'KitchenStatus'
                    && ['Bekliyor', 'Hazırlanıyor', 'Hazır'].includes(sets[0].val);
                if (!onlyKitchenFlow || item.OrderStatus !== 'Açık') {
                    throw new Error('Ödenmiş kalem değiştirilemez.');
                }
            }
            const orderId = item.OrderID;

            // Mutfağa gitmiş kalemde miktar AZALTMA = kısmi zayi → yetkili onayı + neden zorunlu.
            const newQty = quantity != null ? parseInt(quantity, 10) : null;
            const decreasing = newQty != null && newQty < item.Quantity;
            if (item.SentToKitchenAt && decreasing) {
                if (askReason && !CANCEL_REASONS.includes(reason)) {
                    await trx.rollback();
                    return res.status(400).json({ error: 'İptal nedeni seçin.', reason: 'CANCEL_REASON_REQUIRED', reasons: CANCEL_REASONS });
                }
                if (req.user?.role !== 'Admin') {
                    const ok = await verifyManagerPassword(pool, managerPassword);
                    if (!ok) {
                        await trx.rollback();
                        return res.status(403).json({ error: 'Yönetici şifresi hatalı.', reason: 'MANAGER_PASSWORD_REQUIRED' });
                    }
                }
            }

            const rq = trx.request().input('iid', sql.Int, itemId);
            const assigns = sets.map((s, i) => { rq.input(`p${i}`, s.type, s.val); return `${s.col} = @p${i}`; });
            await rq.query(`UPDATE RestoranOrderItems SET ${assigns.join(', ')} WHERE ItemID = @iid`);

            if (item.SentToKitchenAt && decreasing) {
                await logAudit(req, {
                    action: 'restoran.item.reduce', entity: 'RestoranOrderItem', entityId: itemId,
                    detail: `Masa ${item.TableNo || '?'} — ${item.Name} ${item.Quantity}→${newQty} azaltıldı · neden: ${reason || 'belirtilmedi'}`,
                }, trx);
            }

            const total = await recomputeOrderTotal(trx, orderId);
            await trx.commit();
            res.json({ success: true, total });
        } catch (e) {
            await trx.rollback();
            throw e;
        }
    } catch (err) {
        console.error('Kalem güncelleme hatası:', err);
        res.status(400).json({ error: err.message || 'Kalem güncellenemedi.' });
    }
});

// DELETE /items/:itemId — kalemi iptal et. Son kalem silinirse adisyon iptal olur,
// masa boşa düşer.
router.delete('/items/:itemId', async (req, res) => {
    const itemId = parseInt(req.params.itemId, 10);
    if (!itemId) return res.status(400).json({ error: 'Geçersiz kalem.' });
    const reason = String(req.body?.reason || '').trim();
    const managerPassword = req.body?.managerPassword;
    try {
        const pool = await poolPromise;
        const askReason = (await loadFeatures(pool)).askCancelReason !== '0'; // iptal nedeni sorulsun mu
        const trx = pool.transaction();
        await trx.begin();
        try {
            const cur = await trx.request().input('iid', sql.Int, itemId)
                .query(`
                    SELECT i.OrderID, i.PaidAt, i.Name, i.Quantity, i.SentToKitchenAt, t.TableNo
                    FROM RestoranOrderItems i
                    LEFT JOIN RestoranOrders o ON o.OrderID = i.OrderID
                    LEFT JOIN RestoranTables t ON t.TableID = o.TableID
                    WHERE i.ItemID = @iid
                `);
            if (cur.recordset.length === 0) throw new Error('Kalem bulunamadı.');
            const item = cur.recordset[0];
            if (item.PaidAt) throw new Error('Ödenmiş kalem silinemez.');
            const orderId = item.OrderID;

            // Mutfağa gönderilmiş kalem iptali = hırsızlık/zayi riski → yetkili onayı + neden zorunlu.
            if (item.SentToKitchenAt) {
                if (askReason && !CANCEL_REASONS.includes(reason)) {
                    await trx.rollback();
                    return res.status(400).json({ error: 'İptal nedeni seçin.', reason: 'CANCEL_REASON_REQUIRED', reasons: CANCEL_REASONS });
                }
                if (req.user?.role !== 'Admin') {
                    const ok = await verifyManagerPassword(pool, managerPassword);
                    if (!ok) {
                        await trx.rollback();
                        return res.status(403).json({ error: 'Yönetici şifresi hatalı.', reason: 'MANAGER_PASSWORD_REQUIRED' });
                    }
                }
            }

            await trx.request().input('iid', sql.Int, itemId)
                .query(`DELETE FROM RestoranOrderItems WHERE ItemID = @iid`);

            // Mutfağa gitmiş kalem iptali → AuditLog (Güvenlik Radarı) kaydı.
            if (item.SentToKitchenAt) {
                await logAudit(req, {
                    action: 'restoran.item.cancel', entity: 'RestoranOrderItem', entityId: itemId,
                    detail: `Masa ${item.TableNo || '?'} — ${item.Name} x${item.Quantity} İPTAL · neden: ${reason || 'belirtilmedi'}`,
                }, trx);
            }

            // Adisyonda hiç kalem kalmadıysa adisyonu iptal et + masayı boşalt.
            const left = await trx.request().input('oid', sql.Int, orderId)
                .query(`SELECT COUNT(*) AS c FROM RestoranOrderItems WHERE OrderID = @oid`);
            if (left.recordset[0].c === 0) {
                await trx.request().input('oid', sql.Int, orderId)
                    .query(`UPDATE RestoranOrders SET Status = N'İptal', ClosedAt = GETDATE(), Total = 0 WHERE OrderID = @oid`);
                await trx.request().input('oid', sql.Int, orderId)
                    .query(`UPDATE RestoranTables SET Status = N'Boş', CurrentOrderID = NULL WHERE CurrentOrderID = @oid`);
                await trx.commit();
                return res.json({ success: true, total: 0, orderClosed: true });
            }
            const total = await recomputeOrderTotal(trx, orderId);
            await trx.commit();
            res.json({ success: true, total });
        } catch (e) {
            await trx.rollback();
            throw e;
        }
    } catch (err) {
        console.error('Kalem silme hatası:', err);
        res.status(400).json({ error: err.message || 'Kalem silinemedi.' });
    }
});

// POST /orders/:orderId/transfer — adisyonu başka (boş) masaya taşı.
router.post('/orders/:orderId/transfer', async (req, res) => {
    const orderId = parseInt(req.params.orderId, 10);
    const targetTableId = parseInt(req.body.targetTableId, 10);
    if (!orderId || !targetTableId) return res.status(400).json({ error: 'Geçersiz taşıma isteği.' });
    try {
        const pool = await poolPromise;
        const trx = pool.transaction();
        await trx.begin();
        try {
            const ord = await trx.request().input('oid', sql.Int, orderId)
                .query(`SELECT OrderID, TableID, Status FROM RestoranOrders WHERE OrderID = @oid`);
            if (ord.recordset.length === 0) throw new Error('Adisyon bulunamadı.');
            if (ord.recordset[0].Status !== 'Açık') throw new Error('Yalnızca açık adisyon taşınabilir.');
            const sourceTableId = ord.recordset[0].TableID;
            if (sourceTableId === targetTableId) throw new Error('Hedef masa kaynak ile aynı.');

            const tgt = await trx.request().input('tid', sql.Int, targetTableId)
                .query(`SELECT Status, CurrentOrderID FROM RestoranTables WITH (UPDLOCK, ROWLOCK) WHERE TableID = @tid`);
            if (tgt.recordset.length === 0) throw new Error('Hedef masa bulunamadı.');
            if (tgt.recordset[0].CurrentOrderID || tgt.recordset[0].Status === 'Dolu') {
                throw new Error('Hedef masa dolu. Boş bir masa seçin.');
            }

            // Kaynak masa boş, hedef masa dolu; adisyon hedefe bağlanır.
            await trx.request().input('tid', sql.Int, sourceTableId)
                .query(`UPDATE RestoranTables SET Status = N'Boş', CurrentOrderID = NULL WHERE TableID = @tid`);
            await trx.request().input('tid', sql.Int, targetTableId).input('oid', sql.Int, orderId)
                .query(`UPDATE RestoranTables SET Status = N'Dolu', CurrentOrderID = @oid WHERE TableID = @tid`);
            await trx.request().input('oid', sql.Int, orderId).input('tid', sql.Int, targetTableId)
                .query(`UPDATE RestoranOrders SET TableID = @tid WHERE OrderID = @oid`);

            await trx.commit();
            res.json({ success: true });
        } catch (e) {
            await trx.rollback();
            throw e;
        }
    } catch (err) {
        console.error('Masa taşıma hatası:', err);
        res.status(400).json({ error: err.message || 'Masa taşınamadı.' });
    }
});

// POST /orders/:orderId/merge { targetTableId } — masa birleştir. Hedef BOŞ ise = taşıma;
// hedef DOLU ise kaynak kalemleri hedef adisyona aktarılır, kaynak adisyon iptal, masa boşalır.
router.post('/orders/:orderId/merge', async (req, res) => {
    const orderId = parseInt(req.params.orderId, 10);
    const targetTableId = parseInt(req.body.targetTableId, 10);
    if (!orderId || !targetTableId) return res.status(400).json({ error: 'Geçersiz birleştirme isteği.' });
    try {
        const pool = await poolPromise;
        const trx = pool.transaction();
        await trx.begin();
        try {
            const ord = await trx.request().input('oid', sql.Int, orderId)
                .query(`SELECT OrderID, TableID, Status FROM RestoranOrders WHERE OrderID = @oid`);
            if (ord.recordset.length === 0) throw new Error('Adisyon bulunamadı.');
            if (ord.recordset[0].Status !== 'Açık') throw new Error('Yalnızca açık adisyon birleştirilebilir.');
            const sourceTableId = ord.recordset[0].TableID;
            if (sourceTableId === targetTableId) throw new Error('Hedef masa kaynak ile aynı.');

            const tgt = await trx.request().input('tid', sql.Int, targetTableId)
                .query(`SELECT Status, CurrentOrderID FROM RestoranTables WITH (UPDLOCK, ROWLOCK) WHERE TableID = @tid`);
            if (tgt.recordset.length === 0) throw new Error('Hedef masa bulunamadı.');
            let targetOrderId = tgt.recordset[0].CurrentOrderID;
            // Hedefin açık adisyonu gerçekten açık mı (eski/kapalı referans temizliği).
            if (targetOrderId) {
                const chk = await trx.request().input('oid', sql.Int, targetOrderId)
                    .query(`SELECT OrderID FROM RestoranOrders WHERE OrderID = @oid AND Status = N'Açık'`);
                if (chk.recordset.length === 0) targetOrderId = null;
            }

            if (!targetOrderId) {
                // Hedef boş → taşı.
                await trx.request().input('tid', sql.Int, sourceTableId).query(`UPDATE RestoranTables SET Status=N'Boş', CurrentOrderID=NULL WHERE TableID=@tid`);
                await trx.request().input('tid', sql.Int, targetTableId).input('oid', sql.Int, orderId).query(`UPDATE RestoranTables SET Status=N'Dolu', CurrentOrderID=@oid WHERE TableID=@tid`);
                await trx.request().input('oid', sql.Int, orderId).input('tid', sql.Int, targetTableId).query(`UPDATE RestoranOrders SET TableID=@tid WHERE OrderID=@oid`);
                await trx.commit();
                return res.json({ success: true, merged: false, moved: true });
            }

            // Hedef dolu → kalemleri taşı, kaynak adisyonu iptal et, kaynak masayı boşalt.
            await trx.request().input('src', sql.Int, orderId).input('dst', sql.Int, targetOrderId)
                .query(`UPDATE RestoranOrderItems SET OrderID = @dst WHERE OrderID = @src`);
            await trx.request().input('src', sql.Int, orderId)
                .query(`UPDATE RestoranOrders SET Status=N'İptal', ClosedAt=GETDATE(), Total=0 WHERE OrderID=@src`);
            await trx.request().input('tid', sql.Int, sourceTableId)
                .query(`UPDATE RestoranTables SET Status=N'Boş', CurrentOrderID=NULL WHERE TableID=@tid`);
            const total = await recomputeOrderTotal(trx, targetOrderId);
            await logAudit(req, { action: 'restoran.table.merge', entity: 'RestoranOrder', entityId: orderId, detail: `Adisyon #${orderId} → masa #${targetTableId} (birleştirildi)` }, trx);
            await trx.commit();
            res.json({ success: true, merged: true, targetOrderId, total });
        } catch (e) { await trx.rollback(); throw e; }
    } catch (err) {
        console.error('Masa birleştirme hatası:', err);
        res.status(400).json({ error: err.message || 'Birleştirilemedi.' });
    }
});

// POST /orders/:orderId/move-items { targetTableId, itemIds } — seçili kalemleri hedef masaya
// taşı. Hedef boşsa yeni adisyon açılır. Kaynakta kalem kalmazsa adisyon iptal + masa boşalır.
router.post('/orders/:orderId/move-items', async (req, res) => {
    const orderId = parseInt(req.params.orderId, 10);
    const targetTableId = parseInt(req.body.targetTableId, 10);
    const itemIds = Array.isArray(req.body.itemIds) ? req.body.itemIds.map((x) => parseInt(x, 10)).filter(Boolean) : [];
    if (!orderId || !targetTableId || itemIds.length === 0) return res.status(400).json({ error: 'Geçersiz taşıma isteği.' });
    try {
        const pool = await poolPromise;
        const trx = pool.transaction();
        await trx.begin();
        try {
            const ord = await trx.request().input('oid', sql.Int, orderId)
                .query(`SELECT TableID, Status FROM RestoranOrders WHERE OrderID = @oid`);
            if (ord.recordset.length === 0) throw new Error('Adisyon bulunamadı.');
            if (ord.recordset[0].Status !== 'Açık') throw new Error('Yalnızca açık adisyondan taşınır.');
            const sourceTableId = ord.recordset[0].TableID;
            if (sourceTableId === targetTableId) throw new Error('Hedef masa kaynak ile aynı.');

            const tgt = await trx.request().input('tid', sql.Int, targetTableId)
                .query(`SELECT Status, CurrentOrderID FROM RestoranTables WITH (UPDLOCK, ROWLOCK) WHERE TableID = @tid`);
            if (tgt.recordset.length === 0) throw new Error('Hedef masa bulunamadı.');
            let targetOrderId = tgt.recordset[0].CurrentOrderID;
            if (targetOrderId) {
                const chk = await trx.request().input('oid', sql.Int, targetOrderId)
                    .query(`SELECT OrderID FROM RestoranOrders WHERE OrderID = @oid AND Status = N'Açık'`);
                if (chk.recordset.length === 0) targetOrderId = null;
            }
            if (!targetOrderId) {
                const ins = await trx.request().input('tid', sql.Int, targetTableId).input('by', sql.NVarChar(255), req.user?.fullName || null)
                    .query(`INSERT INTO RestoranOrders (TableID, Status, OpenedBy) OUTPUT INSERTED.OrderID VALUES (@tid, N'Açık', @by)`);
                targetOrderId = ins.recordset[0].OrderID;
                await trx.request().input('tid', sql.Int, targetTableId).input('oid', sql.Int, targetOrderId)
                    .query(`UPDATE RestoranTables SET Status=N'Dolu', CurrentOrderID=@oid WHERE TableID=@tid`);
            }

            // Yalnız seçili + ödenmemiş + bu adisyona ait kalemler taşınır.
            const mv = trx.request().input('src', sql.Int, orderId).input('dst', sql.Int, targetOrderId);
            itemIds.forEach((id, i) => mv.input(`it${i}`, sql.Int, id));
            const upd = await mv.query(`UPDATE RestoranOrderItems SET OrderID = @dst WHERE OrderID = @src AND PaidAt IS NULL AND ItemID IN (${itemIds.map((_, i) => `@it${i}`).join(',')})`);
            if ((upd.rowsAffected[0] || 0) === 0) throw new Error('Taşınacak uygun kalem yok.');

            // Kaynakta kalem kalmadıysa adisyonu iptal et + masayı boşalt.
            const left = await trx.request().input('oid', sql.Int, orderId)
                .query(`SELECT COUNT(*) AS c FROM RestoranOrderItems WHERE OrderID = @oid`);
            let sourceClosed = false;
            if (left.recordset[0].c === 0) {
                await trx.request().input('oid', sql.Int, orderId)
                    .query(`UPDATE RestoranOrders SET Status=N'İptal', ClosedAt=GETDATE(), Total=0 WHERE OrderID=@oid`);
                await trx.request().input('tid', sql.Int, sourceTableId)
                    .query(`UPDATE RestoranTables SET Status=N'Boş', CurrentOrderID=NULL WHERE TableID=@tid`);
                sourceClosed = true;
            } else {
                await recomputeOrderTotal(trx, orderId);
            }
            await recomputeOrderTotal(trx, targetOrderId);
            await trx.commit();
            res.json({ success: true, targetOrderId, sourceClosed });
        } catch (e) { await trx.rollback(); throw e; }
    } catch (err) {
        console.error('Ürün taşıma hatası:', err);
        res.status(400).json({ error: err.message || 'Taşınamadı.' });
    }
});

// POST /orders/:orderId/checkout — hesap kapat (tahsilat). itemIds verilirse
// SADECE o kalemler ödenir (hesap bölme / split); kalan kalem yoksa adisyon
// kapanır ve masa boşalır. Kasa ödemeleri ortak Transactions'a 'Gelir' yazılır.
// 'Açık Hesap' (veresiye) Kasa'ya YAZILMAZ → CurrentAccounts'a Borçlandır (köprü).
// İkram kalemleri tahsilata dahil edilmez.
const VALID_METHODS = ['Nakit', 'Kredi Kartı', 'Yemek Fişi'];   // Kasa'ya yazan yöntemler
const ACCOUNT_METHOD = 'Açık Hesap';                            // Kasa yerine cariye borç
const ALL_METHODS = [...VALID_METHODS, ACCOUNT_METHOD];

router.post('/orders/:orderId/checkout', async (req, res) => {
    const orderId = parseInt(req.params.orderId, 10);
    if (!orderId) return res.status(400).json({ error: 'Geçersiz adisyon.' });
    const singleMethod = ALL_METHODS.includes(req.body.paymentMethod) ? req.body.paymentMethod : 'Nakit';
    const singleAccountId = req.body.accountId != null ? parseInt(req.body.accountId, 10) || null : null;
    // Çoklu ödeme: payments=[{method, amount, accountId?}] (kısmen nakit + kısmen kart/fiş/veresiye).
    // Verilmezse tek ödeme (singleMethod) ile tüm tutar.
    let payments = null;
    if (Array.isArray(req.body.payments) && req.body.payments.length) {
        payments = req.body.payments
            .map((p) => ({
                method: ALL_METHODS.includes(p.method) ? p.method : 'Nakit',
                amount: round2(p.amount),
                accountId: p.accountId != null ? parseInt(p.accountId, 10) || null : null,
            }))
            .filter((p) => p.amount > 0);
    }
    const itemIds = Array.isArray(req.body.itemIds)
        ? req.body.itemIds.map((x) => parseInt(x, 10)).filter(Boolean)
        : null;
    // İndirim (iskonto) — yalnızca tüm hesabı kapatırken (bölünmüş tahsilatta değil).
    let discount = round2(req.body.discount);
    if (!Number.isFinite(discount) || discount < 0) discount = 0;
    // Bedelsiz kapanış: Ödenmez (patron) / İkram / Personel. Kasaya ciro YAZMAZ ama
    // reçete stoğu düşer + Z raporunda ayrı görünür. Tüm hesaba uygulanır (split değil).
    const COMP_TYPES = ['Ödenmez', 'İkram', 'Personel'];
    const compType = COMP_TYPES.includes(req.body.compType) ? req.body.compType : null;

    try {
        const pool = await poolPromise;
        const roundTotal = (await loadFeatures(pool)).roundTotal === '1'; // tahsilat yuvarlama bayrağı
        const trx = pool.transaction();
        await trx.begin();
        try {
            const ord = await trx.request().input('oid', sql.Int, orderId)
                .query(`SELECT OrderID, TableID, Status, OrderType, OrderNo, CustomerName, CustomerID FROM RestoranOrders WITH (UPDLOCK, ROWLOCK) WHERE OrderID = @oid`);
            if (ord.recordset.length === 0) throw new Error('Adisyon bulunamadı.');
            if (ord.recordset[0].Status !== 'Açık') throw new Error('Adisyon zaten kapalı.');
            const tableId = ord.recordset[0].TableID;
            const orderType = ord.recordset[0].OrderType || 'Masa';
            const orderNo = ord.recordset[0].OrderNo || null;
            const custName = ord.recordset[0].CustomerName || '';
            const customerId = ord.recordset[0].CustomerID || null;

            // Ödenecek kalemleri seç (split → sadece itemIds; aksi halde tüm ödenmemiş).
            const itemsRes = await trx.request().input('oid', sql.Int, orderId)
                .query(`
                    SELECT ItemID, ProductID, Name, UnitPrice, Quantity, KitchenStatus
                    FROM RestoranOrderItems WHERE OrderID = @oid AND PaidAt IS NULL
                `);
            let toPay = itemsRes.recordset;
            if (itemIds) {
                const set = new Set(itemIds);
                toPay = toPay.filter((i) => set.has(i.ItemID));
            }
            if (toPay.length === 0) throw new Error('Ödenebilir kalem yok.');
            // İkram kalemler tahsilat dışı ama 'ödendi' işaretlenir (kapanış için).
            const chargeable = toPay.filter((i) => i.KitchenStatus !== 'İkram');
            const amount = round2(chargeable.reduce((s, i) => s + Number(i.UnitPrice) * i.Quantity, 0));
            // İndirim uygula (bölünmüş tahsilatta yasak). payable = tahsil edilecek net.
            if (discount > 0 && itemIds) throw new Error('İndirim bölünmüş tahsilatta uygulanamaz.');
            if (discount > amount) discount = amount;

            // Sadakat puanı kullanımı (1 puan = 1 TL). Yalnız tam tahsilat + müşterili
            // sipariş. Müşteri satırı UPDLOCK ile kilitlenir → puan bakiyesi tutarlı.
            let redeem = round2(req.body.redeemPoints);
            if (!Number.isFinite(redeem) || redeem < 0) redeem = 0;
            let custPoints = 0;
            if (customerId) {
                const cp = await trx.request().input('cid', sql.Int, customerId)
                    .query(`SELECT Points FROM RestoranCustomers WITH (UPDLOCK, ROWLOCK) WHERE CustomerID = @cid`);
                custPoints = cp.recordset.length ? Number(cp.recordset[0].Points) || 0 : 0;
            }
            if (redeem > 0) {
                if (itemIds) throw new Error('Puan bölünmüş tahsilatta kullanılamaz.');
                if (!customerId) throw new Error('Puan kullanımı için siparişe müşteri bağlı olmalı.');
                if (redeem > custPoints) redeem = custPoints;
                const maxRedeem = round2(amount - discount);
                if (redeem > maxRedeem) redeem = maxRedeem;
            }
            // Bedelsiz kapanış: tahsilat 0, indirim/puan yok; bedelsiz tutar Z için saklanır.
            let compAmount = 0;
            let payable;
            if (compType) {
                if (itemIds) throw new Error('Bedelsiz kapanış bölünmüş tahsilatta uygulanamaz.');
                discount = 0; redeem = 0;
                compAmount = amount;
                payable = 0;
            } else {
                payable = round2(amount - discount - redeem);
                // Yuvarlama (opt-in): yalnız tam tek tahsilat (bölünmüş/çoklu/bedelsiz değil).
                // Net tutar en yakın tam TL'ye yuvarlanır; fark iskontoya yansıtılır →
                // amount - discount - redeem == payable kimliği korunur (kasa + sadakat tutarlı).
                if (roundTotal && !itemIds && !payments && payable > 0) {
                    const rounded = Math.round(payable);
                    if (rounded !== payable && rounded >= 0) {
                        payable = rounded;
                        discount = round2(amount - redeem - payable);
                    }
                }
            }

            // Seçili kalemleri ödendi işaretle (dinamik IN listesi — parametre bağlı).
            const ids = toPay.map((i) => i.ItemID);
            const payReq = trx.request();
            ids.forEach((id, i) => payReq.input(`id${i}`, sql.Int, id));
            await payReq.query(`
                UPDATE RestoranOrderItems SET PaidAt = GETDATE()
                WHERE ItemID IN (${ids.map((_, i) => `@id${i}`).join(',')})
            `);

            // Reçete → hammadde sarfiyatı (opt-in): reçetesi tanımlı ürünlerin
            // hammaddesini ERP stoğundan düş. İKRAM dahil tüm servis edilen kalem
            // hammadde tüketir (ikram da pişer). Her kalem yalnız bir kez ödenir
            // (PaidAt) → tam-bir-kez sarfiyat. allowNegative: stok eksiyse satışı
            // ENGELLEME, negatife düşür + defterle (restoranda satış durdurulmaz).
            const consumeItems = toPay.filter((i) => i.ProductID != null);
            if (consumeItems.length) {
                // Combo kalemleri bileşenlerine genişlet → stok bileşen reçetesinden düşer.
                const directPids = [...new Set(consumeItems.map((i) => i.ProductID))];
                const cfReq = trx.request();
                directPids.forEach((id, i) => cfReq.input(`cf${i}`, sql.Int, id));
                const cfRes = await cfReq.query(`SELECT ProductID FROM RestoranProducts WHERE IsCombo = 1 AND ProductID IN (${directPids.map((_, i) => `@cf${i}`).join(',')})`);
                const comboSet = new Set(cfRes.recordset.map((r) => r.ProductID));
                const comboMap = await fetchComboComponents(trx, [...comboSet]);
                const effective = [];
                for (const it of consumeItems) {
                    if (comboSet.has(it.ProductID) && comboMap.has(it.ProductID)) {
                        for (const comp of comboMap.get(it.ProductID)) {
                            effective.push({ productId: comp.componentId, quantity: comp.quantity * it.Quantity, name: `${it.Name} › ${comp.name}` });
                        }
                    } else {
                        effective.push({ productId: it.ProductID, quantity: it.Quantity, name: it.Name });
                    }
                }

                const pids = [...new Set(effective.map((e) => e.productId))];
                const recReq = trx.request();
                pids.forEach((id, i) => recReq.input(`rp${i}`, sql.Int, id));
                const recRes = await recReq.query(`
                    SELECT ProductID, StockID, Quantity FROM RestoranRecipes
                    WHERE ProductID IN (${pids.map((_, i) => `@rp${i}`).join(',')})
                `);
                if (recRes.recordset.length) {
                    const byProduct = new Map();
                    for (const r of recRes.recordset) {
                        if (!byProduct.has(r.ProductID)) byProduct.set(r.ProductID, []);
                        byProduct.get(r.ProductID).push({ stockId: r.StockID, quantity: Number(r.Quantity) });
                    }
                    for (const it of effective) {
                        const recipe = byProduct.get(it.productId);
                        if (!recipe) continue;
                        for (const ing of recipe) {
                            const need = ing.quantity * it.quantity;
                            if (!(need > 0)) continue;
                            await adjustStock(trx, {
                                stockId: ing.stockId, direction: 'Cikis', quantity: need,
                                reason: 'Satış', allowNegative: true,
                                note: `ArcTeknik Şef reçete — ${it.name}`.slice(0, 500),
                                createdBy: req.user?.fullName || null,
                            });
                        }
                    }
                }
            }

            // Ödeme planını belirle. Çoklu ödeme verildiyse toplamı tahsil edilebilir
            // tutara eşit olmalı; aksi halde tek ödeme (singleMethod) ile tüm tutar.
            let plan;
            if (payments) {
                const sum = round2(payments.reduce((s, p) => s + p.amount, 0));
                if (Math.abs(sum - payable) > 0.01) {
                    throw new Error(`Ödeme toplamı (${sum.toFixed(2)}) tutar ile uyuşmuyor (${payable.toFixed(2)}).`);
                }
                plan = payments;
            } else {
                plan = payable > 0 ? [{ method: singleMethod, amount: payable, accountId: singleAccountId }] : [];
            }
            const orderMethod = compType || (plan.length > 1 ? 'Karma' : (plan[0]?.method || 'İkram'));

            // Her ödeme satırını işle: Kasa yöntemi → Transactions 'Gelir';
            // 'Açık Hesap' → CurrentAccounts'a Borçlandır (veresiye). Rapor kırılımı korunur.
            let transactionId = null;
            if (payable > 0) {
                const summary = chargeable.map((i) => `${i.Name} x${i.Quantity}`).join(', ');
                let label;
                if (orderType === 'Masa') {
                    const tableNoRes = await trx.request().input('tid', sql.Int, tableId)
                        .query(`SELECT TableNo FROM RestoranTables WHERE TableID = @tid`);
                    label = `Masa ${tableNoRes.recordset[0]?.TableNo || tableId}`;
                } else if (orderType === 'Self') {
                    label = `Self-Servis #${orderNo || orderId}`;
                } else {
                    label = `${orderType}${custName ? ' ' + custName : ''}`;
                }
                const splitTag = itemIds ? ' (Bölünmüş)' : '';
                const discTag = discount > 0 ? ` (İnd: ${discount.toFixed(2)})` : '';
                for (const p of plan) {
                    const description = `ArcTeknik Şef ${p.method} — ${label}${splitTag}${discTag} — ${summary}`.slice(0, 500);
                    if (p.method === ACCOUNT_METHOD) {
                        // Veresiye: cari hesabı kilitle, bakiyeyi borçlandır, ekstre satırı yaz.
                        if (!p.accountId) throw new Error('Açık hesap için cari seçilmedi.');
                        const accRes = await trx.request().input('aid', sql.Int, p.accountId)
                            .query(`SELECT Balance FROM CurrentAccounts WITH (UPDLOCK, ROWLOCK) WHERE AccountID = @aid`);
                        if (accRes.recordset.length === 0) throw new Error('Cari hesap bulunamadı.');
                        const newBal = round2(Number(accRes.recordset[0].Balance) + p.amount);
                        await trx.request().input('aid', sql.Int, p.accountId).input('bal', sql.Decimal(12, 2), newBal)
                            .query(`UPDATE CurrentAccounts SET Balance = @bal, UpdatedAt = GETDATE() WHERE AccountID = @aid`);
                        await trx.request()
                            .input('aid', sql.Int, p.accountId)
                            .input('amt', sql.Decimal(12, 2), p.amount)
                            .input('desc', sql.NVarChar(500), description)
                            .input('bal', sql.Decimal(12, 2), newBal)
                            .input('by', sql.NVarChar(100), req.user.fullName || null)
                            .query(`
                                INSERT INTO AccountTransactions (AccountID, Type, Amount, Description, BalanceAfter, PaymentMethod, CreatedBy)
                                VALUES (@aid, N'Borçlandır', @amt, @desc, @bal, N'Açık Hesap', @by)
                            `);
                    } else {
                        const tx = await trx.request()
                            .input('amount', sql.Decimal(10, 2), p.amount)
                            .input('type', sql.NVarChar(20), 'Gelir')
                            .input('description', sql.NVarChar(500), description)
                            .input('method', sql.NVarChar(50), p.method)
                            .query(`
                                INSERT INTO Transactions (ServiceID, Amount, Type, Description, PaymentMethod)
                                OUTPUT INSERTED.TransactionID VALUES (NULL, @amount, @type, @description, @method)
                            `);
                        if (transactionId == null) transactionId = tx.recordset[0].TransactionID;
                    }
                }
            }

            // Adisyonda ödenmemiş kalem kaldı mı?
            const leftRes = await trx.request().input('oid', sql.Int, orderId)
                .query(`SELECT COUNT(*) AS c FROM RestoranOrderItems WHERE OrderID = @oid AND PaidAt IS NULL`);
            const remaining = leftRes.recordset[0].c;

            let orderClosed = false;
            if (remaining === 0 && orderType === 'Self') {
                // Self-servis: ödeme bitti ama sipariş TESLİME kadar açık kalır —
                // mutfak (KDS) hazırlar, çağrı ekranı numarayı anons eder,
                // personel "Teslim" deyince kapanır (POST /orders/:id/deliver).
                await trx.request()
                    .input('oid', sql.Int, orderId)
                    .input('method', sql.NVarChar(50), orderMethod)
                    .input('txid', sql.Int, transactionId)
                    .input('comp', sql.Decimal(10, 2), compType ? compAmount : null)
                    .query(`
                        UPDATE RestoranOrders
                        SET PaymentMethod = @method, TransactionID = ISNULL(TransactionID, @txid),
                            Total = 0, CompAmount = @comp
                        WHERE OrderID = @oid
                    `);
            } else if (remaining === 0) {
                // Tüm hesap ödendi → adisyon kapat, masa boşalt.
                await trx.request()
                    .input('oid', sql.Int, orderId)
                    .input('method', sql.NVarChar(50), orderMethod)
                    .input('txid', sql.Int, transactionId)
                    .input('comp', sql.Decimal(10, 2), compType ? compAmount : null)
                    .query(`
                        UPDATE RestoranOrders
                        SET Status = N'Kapandı', ClosedAt = GETDATE(), PaymentMethod = @method,
                            TransactionID = ISNULL(TransactionID, @txid), Total = 0, CompAmount = @comp
                        WHERE OrderID = @oid
                    `);
                await trx.request().input('oid', sql.Int, orderId)
                    .query(`UPDATE RestoranTables SET Status = N'Boş', CurrentOrderID = NULL WHERE CurrentOrderID = @oid`);
                orderClosed = true;
                // Bedelsiz kapanış → Güvenlik Radarı (kim, ne kadar, hangi tür).
                if (compType) {
                    await logAudit(req, {
                        action: 'restoran.order.comp', entity: 'RestoranOrder', entityId: orderId,
                        detail: `${compType} kapanış — ${compAmount.toFixed(2)}₺ (ciroya yazılmadı)`,
                    }, trx);
                }
            } else {
                // Kısmi (split) tahsilat → adisyon açık kalır, kalan toplam güncellenir.
                await recomputeOrderTotal(trx, orderId);
            }

            // ── Sadakat: puan harca (kullanıldıysa) + kazan (orana göre) ──────
            let pointsEarned = 0, pointsRedeemed = 0, pointsBalance = null;
            if (customerId) {
                if (redeem > 0) {
                    await trx.request().input('cid', sql.Int, customerId).input('pts', sql.Decimal(12, 2), redeem)
                        .query(`UPDATE RestoranCustomers SET Points = Points - @pts WHERE CustomerID = @cid`);
                    await trx.request().input('cid', sql.Int, customerId).input('pts', sql.Decimal(12, 2), redeem).input('oid', sql.Int, orderId)
                        .query(`INSERT INTO RestoranLoyaltyTransactions (CustomerID, Type, Points, OrderID) VALUES (@cid, N'Harcama', @pts, @oid)`);
                    pointsRedeemed = redeem;
                }
                const settingsRes = await trx.request().query(`SELECT TOP 1 LoyaltyPercent FROM RestoranSettings WHERE Id = 1`);
                const loyaltyPct = settingsRes.recordset.length ? Number(settingsRes.recordset[0].LoyaltyPercent) || 0 : 0;
                if (loyaltyPct > 0 && payable > 0) {
                    pointsEarned = round2(payable * loyaltyPct / 100);
                    if (pointsEarned > 0) {
                        await trx.request().input('cid', sql.Int, customerId).input('pts', sql.Decimal(12, 2), pointsEarned)
                            .query(`UPDATE RestoranCustomers SET Points = Points + @pts WHERE CustomerID = @cid`);
                        await trx.request().input('cid', sql.Int, customerId).input('pts', sql.Decimal(12, 2), pointsEarned).input('oid', sql.Int, orderId)
                            .query(`INSERT INTO RestoranLoyaltyTransactions (CustomerID, Type, Points, OrderID) VALUES (@cid, N'Kazanç', @pts, @oid)`);
                    }
                }
                const balRes = await trx.request().input('cid', sql.Int, customerId)
                    .query(`SELECT Points FROM RestoranCustomers WHERE CustomerID = @cid`);
                pointsBalance = balRes.recordset.length ? Number(balRes.recordset[0].Points) : null;
            }

            // Para üstü: yalnızca tek nakit ödemede anlamlı.
            const rec = Number(req.body.received);
            const isSingleCash = orderMethod === 'Nakit';
            const received = isSingleCash && Number.isFinite(rec) ? round2(rec) : null;
            const change = received != null ? round2(Math.max(0, received - payable)) : null;

            await trx.commit();
            res.json({
                success: true, orderClosed, subtotal: amount, discount, paidAmount: payable,
                paymentMethod: orderMethod, transactionId, received, change, remainingItems: remaining,
                pointsEarned, pointsRedeemed, pointsBalance,
                compType, compAmount: compType ? compAmount : 0,
                orderType, orderNo,
            });
        } catch (e) {
            await trx.rollback();
            throw e;
        }
    } catch (err) {
        console.error('Restoran tahsilat hatası:', err);
        res.status(400).json({ error: err.message || 'Tahsilat tamamlanamadı.' });
    }
});

// PATCH /orders/:orderId — adisyon kişi sayısı güncelle.
router.patch('/orders/:orderId', async (req, res) => {
    const orderId = parseInt(req.params.orderId, 10);
    if (!orderId) return res.status(400).json({ error: 'Geçersiz adisyon.' });
    if (req.body.guestCount === undefined) return res.status(400).json({ error: 'Güncellenecek alan yok.' });
    const g = parseInt(req.body.guestCount, 10);
    try {
        const pool = await poolPromise;
        await pool.request()
            .input('oid', sql.Int, orderId)
            .input('g', sql.Int, g > 0 ? g : null)
            .query(`UPDATE RestoranOrders SET GuestCount = @g WHERE OrderID = @oid AND Status = N'Açık'`);
        res.json({ success: true });
    } catch (err) {
        console.error('Kişi sayısı güncelleme hatası:', err);
        res.status(500).json({ error: 'Güncellenemedi.' });
    }
});

// POST /orders/:orderId/send-kitchen — gönderilmemiş kalemleri mutfağa "gönder"
// (SentToKitchenAt damgala) ve yazıcı hedefine (Mutfak/Bar/Kasa) göre gruplu döndür.
// İstemci her grubu ilgili yazıcıya basar. Yalnızca YENİ kalemler döner.
router.post('/orders/:orderId/send-kitchen', async (req, res) => {
    const orderId = parseInt(req.params.orderId, 10);
    if (!orderId) return res.status(400).json({ error: 'Geçersiz adisyon.' });
    try {
        const pool = await poolPromise;
        const trx = pool.transaction();
        await trx.begin();
        try {
            const ord = await trx.request().input('oid', sql.Int, orderId)
                .query(`
                    SELECT o.Status, o.GuestCount, o.OrderType, o.OrderNo, o.CustomerName, t.TableNo
                    FROM RestoranOrders o LEFT JOIN RestoranTables t ON t.TableID = o.TableID
                    WHERE o.OrderID = @oid
                `);
            if (ord.recordset.length === 0) throw new Error('Adisyon bulunamadı.');
            if (ord.recordset[0].Status !== 'Açık') throw new Error('Adisyon kapalı.');
            const tableNo = ord.recordset[0].TableNo;
            const guestCount = ord.recordset[0].GuestCount || null;
            // Mutfak fişi başlığı: masalıda "MASA X", self-serviste "SİPARİŞ #42",
            // pakette müşteri adıyla — şef tek bakışta işin nereye ait olduğunu görür.
            const ot = ord.recordset[0].OrderType || 'Masa';
            const label = tableNo != null ? `MASA ${tableNo}`
                : ot === 'Self' ? `SİPARİŞ #${ord.recordset[0].OrderNo || orderId}`
                : `${ot.toUpperCase()}${ord.recordset[0].CustomerName ? ' — ' + ord.recordset[0].CustomerName : ''}`;

            const newItems = await trx.request().input('oid', sql.Int, orderId)
                .query(`
                    SELECT i.ItemID, i.ProductID, i.Name, i.Quantity, i.Note, i.Options,
                           ISNULL(c.PrinterTarget, N'Mutfak') AS Target, ISNULL(p.IsCombo, 0) AS IsCombo
                    FROM RestoranOrderItems i
                    LEFT JOIN RestoranProducts p ON p.ProductID = i.ProductID
                    LEFT JOIN RestoranCategories c ON c.CategoryID = p.CategoryID
                    WHERE i.OrderID = @oid AND i.SentToKitchenAt IS NULL
                    ORDER BY i.CreatedAt, i.ItemID
                `);

            if (newItems.recordset.length === 0) {
                await trx.commit();
                return res.json({ success: true, tableNo, label, guestCount, groups: [], at: new Date() });
            }

            await trx.request().input('oid', sql.Int, orderId)
                .query(`UPDATE RestoranOrderItems SET SentToKitchenAt = GETDATE() WHERE OrderID = @oid AND SentToKitchenAt IS NULL`);

            // Combo bileşenlerini önceden çek → mutfağa gönderince parçalanır
            // (Pide → Mutfak yazıcısı, Kola → Bar yazıcısı vb.).
            const comboIds = [...new Set(newItems.recordset.filter((i) => i.IsCombo && i.ProductID).map((i) => i.ProductID))];
            const comboMap = await fetchComboComponents(trx, comboIds);

            const groupMap = new Map();
            // Hedef 'Kasa;Pide' ise her yazıcıya AYRI grup → ikisine de fiş gider.
            const pushTo = (t, entry) => {
                for (const name of routeTargets(t)) {
                    if (!groupMap.has(name)) groupMap.set(name, []);
                    groupMap.get(name).push(entry);
                }
            };
            for (const i of newItems.recordset) {
                if (i.IsCombo && comboMap.has(i.ProductID)) {
                    for (const comp of comboMap.get(i.ProductID)) {
                        pushTo(comp.target || 'Mutfak', { name: `${i.Name} › ${comp.name}`, quantity: comp.quantity * i.Quantity, note: i.Note || '', options: '' });
                    }
                } else {
                    pushTo(i.Target || 'Mutfak', { name: i.Name, quantity: i.Quantity, note: i.Note || '', options: i.Options || '' });
                }
            }
            const groups = [...groupMap.entries()].map(([target, items]) => ({ target, items }));

            await trx.commit();
            res.json({ success: true, tableNo, label, guestCount, groups, at: new Date() });
        } catch (e) {
            await trx.rollback();
            throw e;
        }
    } catch (err) {
        console.error('Mutfağa gönderme hatası:', err);
        res.status(400).json({ error: err.message || 'Mutfağa gönderilemedi.' });
    }
});

// GET /summary?date=YYYY-MM-DD — Gün Sonu (Z) raporu (restoran).
router.get('/summary', async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
    try {
        const pool = await poolPromise;
        const rq = pool.request();
        const dateFilter = date
            ? (rq.input('date', sql.VarChar(10), date), `CONVERT(date, t.CreatedAt) = CONVERT(date, @date)`)
            : `CONVERT(date, t.CreatedAt) = CONVERT(date, GETDATE())`;
        const where = `t.Type = 'Gelir' AND t.ServiceID IS NULL AND t.Description LIKE 'ArcTeknik Şef%' AND ${dateFilter}`;

        const totals = await rq.query(`
            SELECT
                COUNT(*) AS Cnt,
                ISNULL(SUM(t.Amount), 0) AS Total,
                ISNULL(SUM(CASE WHEN t.PaymentMethod = 'Nakit' THEN t.Amount ELSE 0 END), 0) AS Cash,
                ISNULL(SUM(CASE WHEN t.PaymentMethod = 'Kredi Kartı' THEN t.Amount ELSE 0 END), 0) AS Card,
                ISNULL(SUM(CASE WHEN t.PaymentMethod = 'Yemek Fişi' THEN t.Amount ELSE 0 END), 0) AS Ticket
            FROM Transactions t WHERE ${where}
        `);

        const oRq = pool.request();
        const oFilter = date
            ? (oRq.input('date', sql.VarChar(10), date), `CONVERT(date, ClosedAt) = CONVERT(date, @date)`)
            : `CONVERT(date, ClosedAt) = CONVERT(date, GETDATE())`;
        const orderStats = await oRq.query(`
            SELECT COUNT(*) AS Orders, ISNULL(SUM(GuestCount), 0) AS Guests
            FROM RestoranOrders WHERE Status = N'Kapandı' AND ${oFilter}
        `);

        // Bedelsiz (Ödenmez/İkram/Personel) kapanışlar — ciro DEĞİL, ayrı gösterilir.
        const cRq = pool.request();
        const cFilter = date
            ? (cRq.input('date', sql.VarChar(10), date), `CONVERT(date, ClosedAt) = CONVERT(date, @date)`)
            : `CONVERT(date, ClosedAt) = CONVERT(date, GETDATE())`;
        const compStats = await cRq.query(`
            SELECT
                ISNULL(SUM(CASE WHEN PaymentMethod = N'Ödenmez' THEN CompAmount ELSE 0 END), 0) AS Unpaid,
                ISNULL(SUM(CASE WHEN PaymentMethod = N'İkram' THEN CompAmount ELSE 0 END), 0) AS Treat,
                ISNULL(SUM(CASE WHEN PaymentMethod = N'Personel' THEN CompAmount ELSE 0 END), 0) AS Staff,
                ISNULL(SUM(CASE WHEN PaymentMethod IN (N'Ödenmez', N'İkram', N'Personel') THEN CompAmount ELSE 0 END), 0) AS CompTotal,
                SUM(CASE WHEN PaymentMethod IN (N'Ödenmez', N'İkram', N'Personel') THEN 1 ELSE 0 END) AS CompCount
            FROM RestoranOrders WHERE Status = N'Kapandı' AND CompAmount IS NOT NULL AND ${cFilter}
        `);

        const r = totals.recordset[0];
        const o = orderStats.recordset[0];
        const c = compStats.recordset[0];
        res.json({
            date: date || new Date().toISOString().slice(0, 10),
            paymentCount: r.Cnt,
            total: Number(r.Total),
            cash: Number(r.Cash),
            card: Number(r.Card),
            ticket: Number(r.Ticket),
            orders: o.Orders,
            guests: o.Guests,
            compUnpaid: Number(c.Unpaid),
            compTreat: Number(c.Treat),
            compStaff: Number(c.Staff),
            compTotal: Number(c.CompTotal),
            compCount: Number(c.CompCount),
        });
    } catch (err) {
        console.error('Restoran gün sonu hatası:', err);
        res.status(500).json({ error: 'Gün sonu raporu alınamadı.' });
    }
});

// GET /orders?date=YYYY-MM-DD — kapanan adisyonlar (eski pusulalar).
router.get('/orders', async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
    try {
        const pool = await poolPromise;
        const rq = pool.request();
        const filter = date
            ? (rq.input('date', sql.VarChar(10), date), `CONVERT(date, o.ClosedAt) = CONVERT(date, @date)`)
            : `CONVERT(date, o.ClosedAt) = CONVERT(date, GETDATE())`;
        const r = await rq.query(`
            SELECT TOP 200 o.OrderID, t.TableNo, o.OrderType, o.CustomerName, o.PaymentMethod, o.OpenedAt, o.ClosedAt, o.GuestCount,
                   (SELECT ISNULL(SUM(x.UnitPrice * x.Quantity), 0) FROM RestoranOrderItems x
                    WHERE x.OrderID = o.OrderID AND x.PaidAt IS NOT NULL AND x.KitchenStatus <> N'İkram') AS Paid
            FROM RestoranOrders o LEFT JOIN RestoranTables t ON t.TableID = o.TableID
            WHERE o.Status = N'Kapandı' AND ${filter}
            ORDER BY o.ClosedAt DESC
        `);
        res.json(r.recordset.map((x) => ({
            orderId: x.OrderID, tableNo: x.TableNo || null, orderType: x.OrderType || 'Masa',
            customerName: x.CustomerName || '', paymentMethod: x.PaymentMethod || '',
            openedAt: x.OpenedAt, closedAt: x.ClosedAt, guestCount: x.GuestCount || null,
            total: Number(x.Paid),
        })));
    } catch (err) {
        console.error('Adisyon geçmişi hatası:', err);
        res.status(500).json({ error: 'Geçmiş alınamadı.' });
    }
});

// GET /orders/:id — kapalı/açık adisyon detayı (salt-okunur, yeniden yazdırma için).
router.get('/orders/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Geçersiz adisyon.' });
    try {
        const pool = await poolPromise;
        const ord = await pool.request().input('oid', sql.Int, id)
            .query(`
                SELECT o.OrderID, t.TableNo, o.Status, o.OrderType, o.PaymentMethod, o.OpenedAt, o.ClosedAt, o.GuestCount,
                       o.CustomerID, o.CustomerName, o.CustomerPhone, o.DeliveryAddress, o.DeliveryStatus,
                       o.CourierID, o.AssignedAt, o.DeliveredAt, cr.Name AS CourierName
                FROM RestoranOrders o
                LEFT JOIN RestoranTables t ON t.TableID = o.TableID
                LEFT JOIN RestoranCouriers cr ON cr.CourierID = o.CourierID
                WHERE o.OrderID = @oid
            `);
        if (ord.recordset.length === 0) return res.status(404).json({ error: 'Adisyon bulunamadı.' });
        const items = await pool.request().input('oid', sql.Int, id)
            .query(`
                SELECT ItemID, ProductID, Name, UnitPrice, Quantity, Note, Options, KitchenStatus, PaidAt, SentToKitchenAt
                FROM RestoranOrderItems WHERE OrderID = @oid ORDER BY CreatedAt, ItemID
            `);
        const o = ord.recordset[0];
        const lines = items.recordset.map((i) => ({
            itemId: i.ItemID, productId: i.ProductID, name: i.Name, unitPrice: Number(i.UnitPrice), quantity: i.Quantity,
            note: i.Note || '', options: i.Options || '', kitchenStatus: i.KitchenStatus,
            treat: i.KitchenStatus === 'İkram', paid: !!i.PaidAt, sent: !!i.SentToKitchenAt,
        }));
        // total = ödenen (yeniden yazdırma için). liveTotal = ödenmemiş + İkram olmayan (açık paket adisyonu).
        const total = round2(lines.filter((l) => l.paid && !l.treat).reduce((s, l) => s + l.unitPrice * l.quantity, 0));
        const liveTotal = round2(lines.filter((l) => !l.paid && !l.treat).reduce((s, l) => s + l.unitPrice * l.quantity, 0));
        res.json({
            orderId: o.OrderID, tableNo: o.TableNo || null, status: o.Status, orderType: o.OrderType || 'Masa',
            paymentMethod: o.PaymentMethod || '', openedAt: o.OpenedAt, closedAt: o.ClosedAt, guestCount: o.GuestCount || null,
            customerId: o.CustomerID || null, customerName: o.CustomerName || '', customerPhone: o.CustomerPhone || '',
            deliveryAddress: o.DeliveryAddress || '', deliveryStatus: o.DeliveryStatus || '',
            courierId: o.CourierID || null, courierName: o.CourierName || '',
            assignedAt: o.AssignedAt || null, deliveredAt: o.DeliveredAt || null,
            total, liveTotal, items: lines,
        });
    } catch (err) {
        console.error('Adisyon detay hatası:', err);
        res.status(500).json({ error: 'Adisyon alınamadı.' });
    }
});

// PATCH /orders/:id/customer — açık adisyona müşteri bağla/çöz (sadakat için).
// Salon (masa) adisyonunda da müşteri tanımlanabilsin → checkout puan kazandırır.
// customerId null/0 → bağı çöz. Ad/telefon snapshot'ı müşteri kaydından alınır.
router.patch('/orders/:id/customer', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Geçersiz adisyon.' });
    const customerId = parseInt(req.body.customerId, 10) || null;
    try {
        const pool = await poolPromise;
        const ord = await pool.request().input('oid', sql.Int, id)
            .query(`SELECT Status FROM RestoranOrders WHERE OrderID = @oid`);
        if (ord.recordset.length === 0) return res.status(404).json({ error: 'Adisyon bulunamadı.' });
        if (ord.recordset[0].Status !== 'Açık') return res.status(400).json({ error: 'Yalnızca açık adisyona müşteri bağlanabilir.' });

        let cname = null, cphone = null;
        if (customerId) {
            const c = await pool.request().input('cid', sql.Int, customerId)
                .query(`SELECT Name, Phone FROM RestoranCustomers WHERE CustomerID = @cid`);
            if (c.recordset.length === 0) return res.status(404).json({ error: 'Müşteri bulunamadı.' });
            cname = c.recordset[0].Name;
            cphone = c.recordset[0].Phone || null;
        }
        await pool.request()
            .input('oid', sql.Int, id)
            .input('cid', sql.Int, customerId)
            .input('cname', sql.NVarChar(255), cname)
            .input('cphone', sql.NVarChar(50), cphone)
            .query(`UPDATE RestoranOrders SET CustomerID = @cid, CustomerName = @cname, CustomerPhone = @cphone WHERE OrderID = @oid`);
        res.json({ success: true, customerId, customerName: cname || '', customerPhone: cphone || '' });
    } catch (err) {
        console.error('Adisyon müşteri bağlama hatası:', err);
        res.status(500).json({ error: 'Müşteri bağlanamadı.' });
    }
});

// ═══ SELF-SERVİS (masa bypass — fast-food / kahveci / büfe) ══════════════════
// Akış: boş self sipariş aç (gün içi sıra numarası üretilir) → kalemler MEVCUT
// /orders/:id/items ucuyla eklenir (fiyat/seçenek/combo aynı yol) → send-kitchen
// → checkout (peşin). Sipariş teslime kadar AÇIK kalır; çağrı ekranı numarayı
// anons eder, personel teslimde kapatır. Para yolu %100 mevcut checkout'tur.

// POST /self-orders — yeni self-servis siparişi (boş). Gün içi numara: her gün
// 1'den başlar. HOLDLOCK aralık kilidi → iki kasa aynı anda açsa bile numara çakışmaz.
router.post('/self-orders', async (req, res) => {
    try {
        const pool = await poolPromise;
        const trx = pool.transaction();
        await trx.begin();
        try {
            const numRes = await trx.request().query(`
                SELECT ISNULL(MAX(OrderNo), 0) + 1 AS NextNo
                FROM RestoranOrders WITH (UPDLOCK, HOLDLOCK)
                WHERE OrderType = N'Self' AND CAST(OpenedAt AS DATE) = CAST(GETDATE() AS DATE)
            `);
            const orderNo = numRes.recordset[0].NextNo;
            const ins = await trx.request()
                .input('no', sql.Int, orderNo)
                .input('by', sql.NVarChar(255), req.user?.fullName || null)
                .query(`
                    INSERT INTO RestoranOrders (TableID, Status, OrderType, OrderNo, OpenedBy)
                    OUTPUT INSERTED.OrderID VALUES (NULL, N'Açık', N'Self', @no, @by)
                `);
            await trx.commit();
            res.json({ success: true, orderId: ins.recordset[0].OrderID, orderNo });
        } catch (e) {
            await trx.rollback();
            throw e;
        }
    } catch (err) {
        console.error('Self sipariş açma hatası:', err);
        res.status(500).json({ error: 'Sipariş açılamadı.' });
    }
});

// GET /self-orders/board — çağrı ekranı panosu. Bugünün ödenmiş self siparişleri:
// hazırlanıyor (mutfakta bekleyen kalem var) / hazır (tüm kalemler 'Hazır').
router.get('/self-orders/board', async (req, res) => {
    try {
        const pool = await poolPromise;
        const r = await pool.request().query(`
            SELECT o.OrderID, o.OrderNo, o.OpenedAt,
                   SUM(CASE WHEN i.KitchenStatus IN (N'Bekliyor', N'Hazırlanıyor') THEN 1 ELSE 0 END) AS Pending,
                   COUNT(i.ItemID) AS ItemCount
            FROM RestoranOrders o
            JOIN RestoranOrderItems i ON i.OrderID = o.OrderID
            WHERE o.OrderType = N'Self' AND o.Status = N'Açık' AND o.PaymentMethod IS NOT NULL
              AND CAST(o.OpenedAt AS DATE) = CAST(GETDATE() AS DATE)
            GROUP BY o.OrderID, o.OrderNo, o.OpenedAt
            ORDER BY o.OrderNo
        `);
        const rows = r.recordset.map((x) => ({
            orderId: x.OrderID, orderNo: x.OrderNo,
            ready: Number(x.Pending) === 0 && Number(x.ItemCount) > 0,
            openedAt: x.OpenedAt,
        }));
        res.json({
            preparing: rows.filter((x) => !x.ready),
            ready: rows.filter((x) => x.ready),
        });
    } catch (err) {
        console.error('Çağrı panosu hatası:', err);
        res.status(500).json({ error: 'Pano alınamadı.' });
    }
});

// POST /orders/:orderId/deliver — self sipariş teslim edildi → kapat.
// Yalnız ödenmiş self siparişlere izin (para yolu atlanamaz).
router.post('/orders/:orderId/deliver', async (req, res) => {
    const orderId = parseInt(req.params.orderId, 10);
    if (!orderId) return res.status(400).json({ error: 'Geçersiz sipariş.' });
    try {
        const pool = await poolPromise;
        const r = await pool.request().input('oid', sql.Int, orderId).query(`
            UPDATE RestoranOrders
            SET Status = N'Kapandı', ClosedAt = GETDATE(), DeliveredAt = GETDATE()
            WHERE OrderID = @oid AND OrderType = N'Self' AND Status = N'Açık' AND PaymentMethod IS NOT NULL
        `);
        if (!r.rowsAffected[0]) return res.status(400).json({ error: 'Sipariş teslim edilemedi (ödenmemiş veya kapalı).' });
        res.json({ success: true });
    } catch (err) {
        console.error('Self teslim hatası:', err);
        res.status(500).json({ error: 'Teslim işlenemedi.' });
    }
});

// ═══ MUTFAK (KDS) ════════════════════════════════════════════════════════════
// Mutfak ekranı altyapısı. Açık adisyonların hazırlanmamış kalemleri, masa bilgisi
// ile birlikte. İleride ayrı bir mutfak ekranı bu uca bağlanabilir.
router.get('/kitchen', async (req, res) => {
    const status = KITCHEN_STATES.includes(req.query.status) ? req.query.status : null;
    try {
        const pool = await poolPromise;
        const rq = pool.request();
        // Self-servis kalemleri PEŞİN ödendiği için (PaidAt dolu) ayrıca dahil edilir;
        // masasız siparişler (Self/Paket/Gel-Al) için LEFT JOIN → KDS'de #No ile görünür.
        let where = `o.Status = N'Açık' AND (i.PaidAt IS NULL OR o.OrderType = N'Self')`;
        if (status) { rq.input('st', sql.NVarChar(20), status); where += ` AND i.KitchenStatus = @st`; }
        else where += ` AND i.KitchenStatus IN (N'Bekliyor', N'Hazırlanıyor')`;
        const r = await rq.query(`
            SELECT i.ItemID, i.OrderID, i.Name, i.Quantity, i.Note, i.Options, i.KitchenStatus, i.CreatedAt,
                   DATEDIFF(MINUTE, COALESCE(i.SentToKitchenAt, i.CreatedAt), GETDATE()) AS WaitMinutes,
                   t.TableNo, s.Name AS SectionName, o.OrderType, o.OrderNo
            FROM RestoranOrderItems i
            JOIN RestoranOrders o ON o.OrderID = i.OrderID
            LEFT JOIN RestoranTables t ON t.TableID = o.TableID
            LEFT JOIN RestoranSections s ON s.SectionID = t.SectionID
            WHERE ${where}
            ORDER BY i.CreatedAt
        `);
        res.json(r.recordset.map((i) => ({
            itemId: i.ItemID, orderId: i.OrderID, name: i.Name, quantity: i.Quantity,
            note: i.Note || '', options: i.Options || '', kitchenStatus: i.KitchenStatus, createdAt: i.CreatedAt,
            waitMinutes: i.WaitMinutes != null ? Number(i.WaitMinutes) : 0,
            tableNo: i.TableNo, section: i.SectionName || '',
            orderType: i.OrderType || 'Masa', orderNo: i.OrderNo || null,
        })));
    } catch (err) {
        console.error('KDS hatası:', err);
        res.status(500).json({ error: 'Mutfak siparişleri alınamadı.' });
    }
});

// ═══ KURULUM / YÖNETİM (Admin) ════════════════════════════════════════════════
// Bölüm, masa ve menü tanımları. Yalnızca Admin.

router.post('/sections', adminOnly, async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 100);
    if (!name) return res.status(400).json({ error: 'Bölüm adı gerekli.' });
    try {
        const pool = await poolPromise;
        const r = await pool.request()
            .input('name', sql.NVarChar(100), name)
            .input('sort', sql.Int, parseInt(req.body.sortOrder, 10) || 0)
            .query(`INSERT INTO RestoranSections (Name, SortOrder) OUTPUT INSERTED.SectionID VALUES (@name, @sort)`);
        res.json({ success: true, id: r.recordset[0].SectionID });
    } catch (err) {
        console.error('Bölüm ekleme hatası:', err);
        res.status(500).json({ error: 'Bölüm eklenemedi.' });
    }
});

router.delete('/sections/:id', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Geçersiz bölüm.' });
    try {
        const pool = await poolPromise;
        const used = await pool.request().input('sid', sql.Int, id)
            .query(`SELECT COUNT(*) AS c FROM RestoranTables WHERE SectionID = @sid`);
        if (used.recordset[0].c > 0) return res.status(400).json({ error: 'Bölümde masa var. Önce masaları silin/taşıyın.' });
        await pool.request().input('sid', sql.Int, id).query(`DELETE FROM RestoranSections WHERE SectionID = @sid`);
        res.json({ success: true });
    } catch (err) {
        console.error('Bölüm silme hatası:', err);
        res.status(500).json({ error: 'Bölüm silinemedi.' });
    }
});

router.post('/tables', adminOnly, async (req, res) => {
    const tableNo = String(req.body.tableNo || '').trim().slice(0, 20);
    const sectionId = req.body.sectionId != null ? parseInt(req.body.sectionId, 10) : null;
    if (!tableNo) return res.status(400).json({ error: 'Masa no gerekli.' });
    try {
        const pool = await poolPromise;
        const r = await pool.request()
            .input('sid', sql.Int, sectionId)
            .input('no', sql.NVarChar(20), tableNo)
            .input('sort', sql.Int, parseInt(req.body.sortOrder, 10) || 0)
            .query(`INSERT INTO RestoranTables (SectionID, TableNo, Status, SortOrder)
                    OUTPUT INSERTED.TableID VALUES (@sid, @no, N'Boş', @sort)`);
        res.json({ success: true, id: r.recordset[0].TableID });
    } catch (err) {
        console.error('Masa ekleme hatası:', err);
        res.status(500).json({ error: 'Masa eklenemedi.' });
    }
});

router.delete('/tables/:id', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Geçersiz masa.' });
    try {
        const pool = await poolPromise;
        const t = await pool.request().input('tid', sql.Int, id)
            .query(`SELECT Status FROM RestoranTables WHERE TableID = @tid`);
        if (t.recordset.length === 0) return res.status(404).json({ error: 'Masa bulunamadı.' });
        if (t.recordset[0].Status === 'Dolu') return res.status(400).json({ error: 'Dolu masa silinemez.' });
        await pool.request().input('tid', sql.Int, id).query(`DELETE FROM RestoranTables WHERE TableID = @tid`);
        res.json({ success: true });
    } catch (err) {
        console.error('Masa silme hatası:', err);
        res.status(500).json({ error: 'Masa silinemedi.' });
    }
});

const PRINTER_TARGETS = ['Mutfak', 'Bar', 'Kasa'];
// Yazıcı hedefi artık serbest isim (çoklu yazıcı: Fırın, Ocakbaşı, Bar…). Kırp+40 char.
// Boş → 'Mutfak' (geriye uyum / güvenli varsayılan).
function sanitizeTarget(name) {
    const n = String(name == null ? '' : name).trim().slice(0, 40);
    return n || 'Mutfak';
}
// Çoklu yazıcı hedefi: 'Kasa;Pide' → ['Kasa','Pide']. Bir kategori birden fazla
// yazıcıya yönlenebilir; gönderince her birine ayrı fiş çıkar (Şefim ";" davranışı).
// TAM (exact) liste döndürür — boş/null ise BOŞ dizi. Eskiden boşu 'Mutfak'a
// çeviriyordu; bu yüzden "Mutfak" adlı yazıcıdan kategori çıkarılamıyordu (kaydet
// dese de boşalınca yine Mutfak'a düşüyordu). Routing fallback'i print/SQL tarafında
// (ISNULL → 'Mutfak') ayrıca yapılır, bkz. routeTargets().
function targetsOf(s) {
    const l = String(s == null ? '' : s).split(';').map((x) => x.trim()).filter(Boolean);
    return [...new Set(l)];
}
// Yazdırma (send-kitchen) için hedef listesi — atanmamış kategori güvenli şekilde
// 'Mutfak'a yönlenir (sipariş kaybolmasın). Üyelik/eşleme için targetsOf kullanılır.
function routeTargets(s) {
    const l = targetsOf(s);
    return l.length ? l : ['Mutfak'];
}
// Liste → kolon değeri. Boş → null (atama yok). 40 char kırp.
function joinTargets(arr) {
    const u = [...new Set((arr || []).map((x) => String(x).trim()).filter(Boolean))];
    return u.length ? u.join(';').slice(0, 40) : null;
}

router.post('/categories', adminOnly, async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 100);
    if (!name) return res.status(400).json({ error: 'Kategori adı gerekli.' });
    const target = sanitizeTarget(req.body.printerTarget);
    try {
        const pool = await poolPromise;
        const r = await pool.request()
            .input('name', sql.NVarChar(100), name)
            .input('sort', sql.Int, parseInt(req.body.sortOrder, 10) || 0)
            .input('pt', sql.NVarChar(40), target)
            .query(`INSERT INTO RestoranCategories (Name, SortOrder, PrinterTarget) OUTPUT INSERTED.CategoryID VALUES (@name, @sort, @pt)`);
        res.json({ success: true, id: r.recordset[0].CategoryID });
    } catch (err) {
        console.error('Kategori ekleme hatası:', err);
        res.status(500).json({ error: 'Kategori eklenemedi.' });
    }
});

// PATCH /categories/:id — kategori adı / yazıcı hedefi güncelle.
router.patch('/categories/:id', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Geçersiz kategori.' });
    const sets = [];
    if (req.body.name != null) {
        const n = String(req.body.name).trim().slice(0, 100);
        if (!n) return res.status(400).json({ error: 'Kategori adı boş olamaz.' });
        sets.push({ col: 'Name', type: sql.NVarChar(100), val: n });
    }
    if (req.body.printerTarget != null) {
        sets.push({ col: 'PrinterTarget', type: sql.NVarChar(40), val: sanitizeTarget(req.body.printerTarget) });
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Güncellenecek alan yok.' });
    try {
        const pool = await poolPromise;
        const rq = pool.request().input('id', sql.Int, id);
        const assigns = sets.map((s, i) => { rq.input(`p${i}`, s.type, s.val); return `${s.col} = @p${i}`; });
        await rq.query(`UPDATE RestoranCategories SET ${assigns.join(', ')} WHERE CategoryID = @id`);
        res.json({ success: true });
    } catch (err) {
        console.error('Kategori güncelleme hatası:', err);
        res.status(500).json({ error: 'Kategori güncellenemedi.' });
    }
});

router.post('/products', adminOnly, async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 200);
    const price = Number(req.body.price);
    const categoryId = req.body.categoryId != null ? parseInt(req.body.categoryId, 10) : null;
    if (!name) return res.status(400).json({ error: 'Ürün adı gerekli.' });
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Geçersiz fiyat.' });
    try {
        const pool = await poolPromise;
        const r = await pool.request()
            .input('cid', sql.Int, categoryId)
            .input('name', sql.NVarChar(200), name)
            .input('price', sql.Decimal(10, 2), round2(price))
            .input('sort', sql.Int, parseInt(req.body.sortOrder, 10) || 0)
            .query(`INSERT INTO RestoranProducts (CategoryID, Name, Price, SortOrder)
                    OUTPUT INSERTED.ProductID VALUES (@cid, @name, @price, @sort)`);
        res.json({ success: true, id: r.recordset[0].ProductID });
    } catch (err) {
        console.error('Ürün ekleme hatası:', err);
        res.status(500).json({ error: 'Ürün eklenemedi.' });
    }
});

router.patch('/products/:id', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Geçersiz ürün.' });
    const sets = [];
    if (req.body.name != null) {
        const n = String(req.body.name).trim().slice(0, 200);
        if (!n) return res.status(400).json({ error: 'Ürün adı boş olamaz.' });
        sets.push({ col: 'Name', type: sql.NVarChar(200), val: n });
    }
    if (req.body.price != null) {
        const p = Number(req.body.price);
        if (!Number.isFinite(p) || p < 0) return res.status(400).json({ error: 'Geçersiz fiyat.' });
        sets.push({ col: 'Price', type: sql.Decimal(10, 2), val: round2(p) });
    }
    if (req.body.categoryId !== undefined) {
        sets.push({ col: 'CategoryID', type: sql.Int, val: req.body.categoryId != null ? parseInt(req.body.categoryId, 10) : null });
    }
    if (req.body.isActive != null) sets.push({ col: 'IsActive', type: sql.Bit, val: req.body.isActive ? 1 : 0 });
    if (sets.length === 0) return res.status(400).json({ error: 'Güncellenecek alan yok.' });
    try {
        const pool = await poolPromise;
        const rq = pool.request().input('id', sql.Int, id);
        const assigns = sets.map((s, i) => { rq.input(`p${i}`, s.type, s.val); return `${s.col} = @p${i}`; });
        await rq.query(`UPDATE RestoranProducts SET ${assigns.join(', ')} WHERE ProductID = @id`);
        res.json({ success: true });
    } catch (err) {
        console.error('Ürün güncelleme hatası:', err);
        res.status(500).json({ error: 'Ürün güncellenemedi.' });
    }
});

router.delete('/products/:id', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Geçersiz ürün.' });
    try {
        const pool = await poolPromise;
        // Geçmiş adisyon kalemleri ProductID tutar (FK yok) → ürünü pasifleştir,
        // raporlar bozulmasın diye sert silme yerine IsActive = 0.
        await pool.request().input('id', sql.Int, id)
            .query(`UPDATE RestoranProducts SET IsActive = 0 WHERE ProductID = @id`);
        res.json({ success: true });
    } catch (err) {
        console.error('Ürün silme hatası:', err);
        res.status(500).json({ error: 'Ürün silinemedi.' });
    }
});

// ═══ MENÜ KATALOĞU + YAZICI YÖNLENDİRME — Admin ══════════════════════════════

// GET /catalog — TÜM kategoriler (boş olanlar dahil) + ürünler + yazıcı defteri.
// Yönetim ekranı için (müşteri menüsünden farklı: boş kategori de görünür, sıralama).
router.get('/catalog', adminOnly, async (req, res) => {
    try {
        const pool = await poolPromise;
        const cats = await pool.request().query(`
            SELECT CategoryID, Name, SortOrder, PrinterTarget FROM RestoranCategories ORDER BY SortOrder, Name
        `);
        const prods = await pool.request().query(`
            SELECT ProductID, CategoryID, Name, Price, IsActive, SortOrder, IsCombo
            FROM RestoranProducts WHERE IsActive = 1 ORDER BY SortOrder, Name
        `);
        const printers = await pool.request().query(`
            SELECT PrinterID, Name, SortOrder FROM RestoranPrinters ORDER BY SortOrder, Name
        `);
        const byCat = new Map();
        for (const c of cats.recordset) {
            byCat.set(c.CategoryID, { id: c.CategoryID, name: c.Name, sortOrder: c.SortOrder, printerTarget: c.PrinterTarget || null, products: [] });
        }
        for (const p of prods.recordset) {
            const c = p.CategoryID != null ? byCat.get(p.CategoryID) : null;
            if (c) c.products.push({ id: p.ProductID, name: p.Name, price: Number(p.Price), sortOrder: p.SortOrder, isCombo: !!p.IsCombo });
        }
        res.json({
            categories: [...byCat.values()],
            printers: printers.recordset.map((p) => ({ id: p.PrinterID, name: p.Name, sortOrder: p.SortOrder })),
        });
    } catch (err) {
        console.error('Katalog hatası:', err);
        res.status(500).json({ error: 'Katalog alınamadı.' });
    }
});

// GET /printers — yazıcı defteri + her yazıcıya bağlı kategori ID'leri.
router.get('/printers', adminOnly, async (req, res) => {
    try {
        const pool = await poolPromise;
        const printers = await pool.request().query(`SELECT PrinterID, Name, SortOrder FROM RestoranPrinters ORDER BY SortOrder, Name`);
        const cats = await pool.request().query(`SELECT CategoryID, Name, PrinterTarget FROM RestoranCategories ORDER BY SortOrder, Name`);
        const out = printers.recordset.map((p) => ({
            id: p.PrinterID, name: p.Name, sortOrder: p.SortOrder,
            categoryIds: cats.recordset.filter((c) => targetsOf(c.PrinterTarget).includes(p.Name)).map((c) => c.CategoryID),
        }));
        res.json({ printers: out, categories: cats.recordset.map((c) => ({ id: c.CategoryID, name: c.Name, printerTarget: c.PrinterTarget || null })) });
    } catch (err) {
        console.error('Yazıcı listesi hatası:', err);
        res.status(500).json({ error: 'Yazıcılar alınamadı.' });
    }
});

router.post('/printers', adminOnly, async (req, res) => {
    const name = sanitizeTarget(req.body.name);
    try {
        const pool = await poolPromise;
        const r = await pool.request()
            .input('name', sql.NVarChar(40), name)
            .input('sort', sql.Int, parseInt(req.body.sortOrder, 10) || 0)
            .query(`INSERT INTO RestoranPrinters (Name, SortOrder) OUTPUT INSERTED.PrinterID VALUES (@name, @sort)`);
        res.json({ success: true, id: r.recordset[0].PrinterID });
    } catch (err) {
        if (err.number === 2627 || err.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Bu yazıcı adı zaten var.' });
        console.error('Yazıcı ekleme hatası:', err);
        res.status(500).json({ error: 'Yazıcı eklenemedi.' });
    }
});

// PATCH /printers/:id — yeniden adlandır (kategori hedef adlarını da güncelle).
router.patch('/printers/:id', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Geçersiz yazıcı.' });
    const name = sanitizeTarget(req.body.name);
    try {
        const pool = await poolPromise;
        const trx = pool.transaction();
        await trx.begin();
        try {
            const cur = await trx.request().input('id', sql.Int, id).query(`SELECT Name FROM RestoranPrinters WHERE PrinterID = @id`);
            if (cur.recordset.length === 0) throw new Error('Yazıcı bulunamadı.');
            const oldName = cur.recordset[0].Name;
            await trx.request().input('id', sql.Int, id).input('name', sql.NVarChar(40), name)
                .query(`UPDATE RestoranPrinters SET Name = @name WHERE PrinterID = @id`);
            // Bu yazıcının adını TÜM kategori hedef listelerinde yeni ada taşı (çoklu hedef korunur).
            if (name !== oldName) {
                const all = await trx.request().query(`SELECT CategoryID, PrinterTarget FROM RestoranCategories`);
                for (const c of all.recordset) {
                    const list = targetsOf(c.PrinterTarget);
                    if (!list.includes(oldName)) continue;
                    const next = list.map((x) => (x === oldName ? name : x));
                    // eslint-disable-next-line no-await-in-loop
                    await trx.request().input('cid', sql.Int, c.CategoryID).input('nm', sql.NVarChar(40), joinTargets(next))
                        .query(`UPDATE RestoranCategories SET PrinterTarget = @nm WHERE CategoryID = @cid`);
                }
            }
            await trx.commit();
            res.json({ success: true });
        } catch (e) { await trx.rollback(); throw e; }
    } catch (err) {
        if (err.number === 2627 || err.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Bu yazıcı adı zaten var.' });
        console.error('Yazıcı güncelleme hatası:', err);
        res.status(400).json({ error: err.message || 'Yazıcı güncellenemedi.' });
    }
});

router.delete('/printers/:id', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Geçersiz yazıcı.' });
    try {
        const pool = await poolPromise;
        const trx = pool.transaction();
        await trx.begin();
        try {
            const cur = await trx.request().input('id', sql.Int, id).query(`SELECT Name FROM RestoranPrinters WHERE PrinterID = @id`);
            if (cur.recordset.length === 0) throw new Error('Yazıcı bulunamadı.');
            const nm = cur.recordset[0].Name;
            await trx.request().input('id', sql.Int, id).query(`DELETE FROM RestoranPrinters WHERE PrinterID = @id`);
            // Bu yazıcının adını kategori hedef listelerinden çıkar (liste boşalırsa 'Mutfak').
            const all = await trx.request().query(`SELECT CategoryID, PrinterTarget FROM RestoranCategories`);
            for (const c of all.recordset) {
                const list = targetsOf(c.PrinterTarget);
                if (!list.includes(nm)) continue;
                // eslint-disable-next-line no-await-in-loop
                await trx.request().input('cid', sql.Int, c.CategoryID).input('nm', sql.NVarChar(40), joinTargets(list.filter((x) => x !== nm)))
                    .query(`UPDATE RestoranCategories SET PrinterTarget = @nm WHERE CategoryID = @cid`);
            }
            await trx.commit();
            res.json({ success: true });
        } catch (e) { await trx.rollback(); throw e; }
    } catch (err) {
        console.error('Yazıcı silme hatası:', err);
        res.status(400).json({ error: err.message || 'Yazıcı silinemedi.' });
    }
});

// POST /printers/:id/categories { categoryIds:[...] } — bu yazıcıya kategori(ler) bağla.
// EKLEMELİ (additive): yalnız BU yazıcının adı kategorilerin hedef listesine eklenir/çıkarılır;
// diğer yazıcılara bağlılık korunur → bir kategori birden fazla yazıcıya yönlenebilir (Kasa;Pide).
router.post('/printers/:id/categories', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Geçersiz yazıcı.' });
    const want = new Set(Array.isArray(req.body.categoryIds) ? req.body.categoryIds.map((x) => parseInt(x, 10)).filter(Number.isInteger) : []);
    try {
        const pool = await poolPromise;
        const cur = await pool.request().input('id', sql.Int, id).query(`SELECT Name FROM RestoranPrinters WHERE PrinterID = @id`);
        if (cur.recordset.length === 0) return res.status(404).json({ error: 'Yazıcı bulunamadı.' });
        const nm = cur.recordset[0].Name;
        const trx = pool.transaction();
        await trx.begin();
        try {
            const all = await trx.request().query(`SELECT CategoryID, PrinterTarget FROM RestoranCategories`);
            for (const c of all.recordset) {
                const list = targetsOf(c.PrinterTarget);
                const has = list.includes(nm);
                const should = want.has(c.CategoryID);
                if (has === should) continue; // değişiklik yok
                const next = should ? [...list, nm] : list.filter((x) => x !== nm);
                // eslint-disable-next-line no-await-in-loop
                await trx.request().input('cid', sql.Int, c.CategoryID).input('nm', sql.NVarChar(40), joinTargets(next))
                    .query(`UPDATE RestoranCategories SET PrinterTarget = @nm WHERE CategoryID = @cid`);
            }
            await trx.commit();
            res.json({ success: true });
        } catch (e) { await trx.rollback(); throw e; }
    } catch (err) {
        console.error('Yazıcı-kategori eşleme hatası:', err);
        res.status(500).json({ error: 'Eşleme kaydedilemedi.' });
    }
});

// POST /products/reorder { orderedIds:[...] } — sürükle-bırak sırasını kaydet (SortOrder = index).
router.post('/products/reorder', adminOnly, async (req, res) => {
    const ids = Array.isArray(req.body.orderedIds) ? req.body.orderedIds.map((x) => parseInt(x, 10)).filter(Number.isInteger) : [];
    if (ids.length === 0) return res.json({ success: true });
    try {
        const pool = await poolPromise;
        const trx = pool.transaction();
        await trx.begin();
        try {
            for (let i = 0; i < ids.length; i++) {
                // eslint-disable-next-line no-await-in-loop
                await trx.request().input('id', sql.Int, ids[i]).input('sort', sql.Int, i)
                    .query(`UPDATE RestoranProducts SET SortOrder = @sort WHERE ProductID = @id`);
            }
            await trx.commit();
            res.json({ success: true });
        } catch (e) { await trx.rollback(); throw e; }
    } catch (err) {
        console.error('Ürün sıralama hatası:', err);
        res.status(500).json({ error: 'Sıralama kaydedilemedi.' });
    }
});

// POST /categories/reorder { orderedIds:[...] } — kategori sırası.
router.post('/categories/reorder', adminOnly, async (req, res) => {
    const ids = Array.isArray(req.body.orderedIds) ? req.body.orderedIds.map((x) => parseInt(x, 10)).filter(Number.isInteger) : [];
    if (ids.length === 0) return res.json({ success: true });
    try {
        const pool = await poolPromise;
        const trx = pool.transaction();
        await trx.begin();
        try {
            for (let i = 0; i < ids.length; i++) {
                // eslint-disable-next-line no-await-in-loop
                await trx.request().input('id', sql.Int, ids[i]).input('sort', sql.Int, i)
                    .query(`UPDATE RestoranCategories SET SortOrder = @sort WHERE CategoryID = @id`);
            }
            await trx.commit();
            res.json({ success: true });
        } catch (e) { await trx.rollback(); throw e; }
    } catch (err) {
        console.error('Kategori sıralama hatası:', err);
        res.status(500).json({ error: 'Sıralama kaydedilemedi.' });
    }
});

// ═══ COMBO / KAMPANYA MENÜ — Admin ═══════════════════════════════════════════

// GET /combos — combo ürünleri + bileşenleri.
router.get('/combos', adminOnly, async (req, res) => {
    try {
        const pool = await poolPromise;
        const combos = await pool.request().query(`
            SELECT ProductID, CategoryID, Name, Price FROM RestoranProducts
            WHERE IsCombo = 1 AND IsActive = 1 ORDER BY SortOrder, Name
        `);
        const items = await pool.request().query(`
            SELECT ci.ComboProductID, ci.ComponentProductID, ci.Quantity, p.Name
            FROM RestoranComboItems ci LEFT JOIN RestoranProducts p ON p.ProductID = ci.ComponentProductID
        `);
        const byCombo = new Map();
        for (const it of items.recordset) {
            if (!byCombo.has(it.ComboProductID)) byCombo.set(it.ComboProductID, []);
            byCombo.get(it.ComboProductID).push({ productId: it.ComponentProductID, name: it.Name || 'Ürün', quantity: Number(it.Quantity) || 1 });
        }
        res.json(combos.recordset.map((c) => ({
            id: c.ProductID, name: c.Name, price: Number(c.Price), categoryId: c.CategoryID,
            components: byCombo.get(c.ProductID) || [],
        })));
    } catch (err) {
        console.error('Combo listesi hatası:', err);
        res.status(500).json({ error: 'Combo listesi alınamadı.' });
    }
});

function parseComboComponents(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((c) => ({ productId: parseInt(c.productId, 10), quantity: Math.max(1, parseInt(c.quantity, 10) || 1) }))
        .filter((c) => Number.isInteger(c.productId));
}

router.post('/combos', adminOnly, async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 200);
    const price = Number(req.body.price);
    const categoryId = req.body.categoryId != null ? parseInt(req.body.categoryId, 10) : null;
    const comps = parseComboComponents(req.body.components);
    if (!name) return res.status(400).json({ error: 'Combo adı gerekli.' });
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Geçersiz fiyat.' });
    if (comps.length < 2) return res.status(400).json({ error: 'Combo en az 2 bileşen içermeli.' });
    try {
        const pool = await poolPromise;
        const trx = pool.transaction();
        await trx.begin();
        try {
            const r = await trx.request()
                .input('cid', sql.Int, categoryId)
                .input('name', sql.NVarChar(200), name)
                .input('price', sql.Decimal(10, 2), round2(price))
                .query(`INSERT INTO RestoranProducts (CategoryID, Name, Price, IsCombo) OUTPUT INSERTED.ProductID VALUES (@cid, @name, @price, 1)`);
            const comboId = r.recordset[0].ProductID;
            for (const c of comps) {
                // eslint-disable-next-line no-await-in-loop
                await trx.request().input('combo', sql.Int, comboId).input('comp', sql.Int, c.productId).input('q', sql.Int, c.quantity)
                    .query(`INSERT INTO RestoranComboItems (ComboProductID, ComponentProductID, Quantity) VALUES (@combo, @comp, @q)`);
            }
            await trx.commit();
            res.json({ success: true, id: comboId });
        } catch (e) { await trx.rollback(); throw e; }
    } catch (err) {
        console.error('Combo ekleme hatası:', err);
        res.status(500).json({ error: 'Combo eklenemedi.' });
    }
});

router.patch('/combos/:id', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Geçersiz combo.' });
    try {
        const pool = await poolPromise;
        const trx = pool.transaction();
        await trx.begin();
        try {
            const sets = [];
            const rq = trx.request().input('id', sql.Int, id);
            if (req.body.name != null) { const n = String(req.body.name).trim().slice(0, 200); if (!n) throw new Error('Combo adı boş olamaz.'); rq.input('name', sql.NVarChar(200), n); sets.push('Name = @name'); }
            if (req.body.price != null) { const p = Number(req.body.price); if (!Number.isFinite(p) || p < 0) throw new Error('Geçersiz fiyat.'); rq.input('price', sql.Decimal(10, 2), round2(p)); sets.push('Price = @price'); }
            if (req.body.categoryId !== undefined) { rq.input('cid', sql.Int, req.body.categoryId != null ? parseInt(req.body.categoryId, 10) : null); sets.push('CategoryID = @cid'); }
            if (sets.length) await rq.query(`UPDATE RestoranProducts SET ${sets.join(', ')} WHERE ProductID = @id AND IsCombo = 1`);
            if (req.body.components !== undefined) {
                const comps = parseComboComponents(req.body.components);
                if (comps.length < 2) throw new Error('Combo en az 2 bileşen içermeli.');
                await trx.request().input('id', sql.Int, id).query(`DELETE FROM RestoranComboItems WHERE ComboProductID = @id`);
                for (const c of comps) {
                    // eslint-disable-next-line no-await-in-loop
                    await trx.request().input('combo', sql.Int, id).input('comp', sql.Int, c.productId).input('q', sql.Int, c.quantity)
                        .query(`INSERT INTO RestoranComboItems (ComboProductID, ComponentProductID, Quantity) VALUES (@combo, @comp, @q)`);
                }
            }
            await trx.commit();
            res.json({ success: true });
        } catch (e) { await trx.rollback(); throw e; }
    } catch (err) {
        console.error('Combo güncelleme hatası:', err);
        res.status(400).json({ error: err.message || 'Combo güncellenemedi.' });
    }
});

router.delete('/combos/:id', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Geçersiz combo.' });
    try {
        const pool = await poolPromise;
        await pool.request().input('id', sql.Int, id).query(`UPDATE RestoranProducts SET IsActive = 0 WHERE ProductID = @id AND IsCombo = 1`);
        res.json({ success: true });
    } catch (err) {
        console.error('Combo silme hatası:', err);
        res.status(500).json({ error: 'Combo silinemedi.' });
    }
});

// ═══ SEÇENEK (MODIFIER) YÖNETİMİ — Admin ═════════════════════════════════════

// GET /option-groups — gruplar + seçenekleri (yönetim ekranı).
router.get('/option-groups', adminOnly, async (req, res) => {
    try {
        const pool = await poolPromise;
        const groups = await pool.request().query(`SELECT GroupID, Name, MinSelect, MaxSelect, SortOrder FROM RestoranOptionGroups ORDER BY SortOrder, Name`);
        const opts = await pool.request().query(`SELECT OptionID, GroupID, Name, PriceDelta, SortOrder FROM RestoranOptions ORDER BY SortOrder, Name`);
        const byGroup = new Map();
        for (const o of opts.recordset) {
            if (!byGroup.has(o.GroupID)) byGroup.set(o.GroupID, []);
            byGroup.get(o.GroupID).push({ id: o.OptionID, name: o.Name, priceDelta: Number(o.PriceDelta) });
        }
        res.json(groups.recordset.map((g) => ({
            id: g.GroupID, name: g.Name, min: g.MinSelect, max: g.MaxSelect, options: byGroup.get(g.GroupID) || [],
        })));
    } catch (err) {
        console.error('Seçenek grupları hatası:', err);
        res.status(500).json({ error: 'Seçenek grupları alınamadı.' });
    }
});

router.post('/option-groups', adminOnly, async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 100);
    if (!name) return res.status(400).json({ error: 'Grup adı gerekli.' });
    const min = parseInt(req.body.minSelect, 10) || 0;
    const max = parseInt(req.body.maxSelect, 10) || 0;
    try {
        const pool = await poolPromise;
        const r = await pool.request()
            .input('name', sql.NVarChar(100), name)
            .input('min', sql.Int, min < 0 ? 0 : min)
            .input('max', sql.Int, max < 0 ? 0 : max)
            .query(`INSERT INTO RestoranOptionGroups (Name, MinSelect, MaxSelect) OUTPUT INSERTED.GroupID VALUES (@name, @min, @max)`);
        res.json({ success: true, id: r.recordset[0].GroupID });
    } catch (err) {
        console.error('Grup ekleme hatası:', err);
        res.status(500).json({ error: 'Grup eklenemedi.' });
    }
});

router.delete('/option-groups/:gid', adminOnly, async (req, res) => {
    const gid = parseInt(req.params.gid, 10);
    if (!gid) return res.status(400).json({ error: 'Geçersiz grup.' });
    try {
        const pool = await poolPromise;
        await pool.request().input('gid', sql.Int, gid).query(`DELETE FROM RestoranProductOptionGroups WHERE GroupID = @gid`);
        await pool.request().input('gid', sql.Int, gid).query(`DELETE FROM RestoranOptions WHERE GroupID = @gid`);
        await pool.request().input('gid', sql.Int, gid).query(`DELETE FROM RestoranOptionGroups WHERE GroupID = @gid`);
        res.json({ success: true });
    } catch (err) {
        console.error('Grup silme hatası:', err);
        res.status(500).json({ error: 'Grup silinemedi.' });
    }
});

router.post('/option-groups/:gid/options', adminOnly, async (req, res) => {
    const gid = parseInt(req.params.gid, 10);
    const name = String(req.body.name || '').trim().slice(0, 100);
    const delta = round2(req.body.priceDelta);
    if (!gid) return res.status(400).json({ error: 'Geçersiz grup.' });
    if (!name) return res.status(400).json({ error: 'Seçenek adı gerekli.' });
    try {
        const pool = await poolPromise;
        const r = await pool.request()
            .input('gid', sql.Int, gid)
            .input('name', sql.NVarChar(100), name)
            .input('delta', sql.Decimal(10, 2), Number.isFinite(delta) ? delta : 0)
            .query(`INSERT INTO RestoranOptions (GroupID, Name, PriceDelta) OUTPUT INSERTED.OptionID VALUES (@gid, @name, @delta)`);
        res.json({ success: true, id: r.recordset[0].OptionID });
    } catch (err) {
        console.error('Seçenek ekleme hatası:', err);
        res.status(500).json({ error: 'Seçenek eklenemedi.' });
    }
});

router.delete('/options/:oid', adminOnly, async (req, res) => {
    const oid = parseInt(req.params.oid, 10);
    if (!oid) return res.status(400).json({ error: 'Geçersiz seçenek.' });
    try {
        const pool = await poolPromise;
        await pool.request().input('oid', sql.Int, oid).query(`DELETE FROM RestoranOptions WHERE OptionID = @oid`);
        res.json({ success: true });
    } catch (err) {
        console.error('Seçenek silme hatası:', err);
        res.status(500).json({ error: 'Seçenek silinemedi.' });
    }
});

// Ürüne seçenek grubu ata / kaldır.
router.post('/products/:pid/option-groups', adminOnly, async (req, res) => {
    const pid = parseInt(req.params.pid, 10);
    const gid = parseInt(req.body.groupId, 10);
    if (!pid || !gid) return res.status(400).json({ error: 'Geçersiz ürün/grup.' });
    try {
        const pool = await poolPromise;
        await pool.request().input('pid', sql.Int, pid).input('gid', sql.Int, gid).query(`
            IF NOT EXISTS (SELECT 1 FROM RestoranProductOptionGroups WHERE ProductID = @pid AND GroupID = @gid)
            INSERT INTO RestoranProductOptionGroups (ProductID, GroupID) VALUES (@pid, @gid)
        `);
        res.json({ success: true });
    } catch (err) {
        console.error('Grup atama hatası:', err);
        res.status(500).json({ error: 'Grup atanamadı.' });
    }
});

router.delete('/products/:pid/option-groups/:gid', adminOnly, async (req, res) => {
    const pid = parseInt(req.params.pid, 10);
    const gid = parseInt(req.params.gid, 10);
    if (!pid || !gid) return res.status(400).json({ error: 'Geçersiz ürün/grup.' });
    try {
        const pool = await poolPromise;
        await pool.request().input('pid', sql.Int, pid).input('gid', sql.Int, gid)
            .query(`DELETE FROM RestoranProductOptionGroups WHERE ProductID = @pid AND GroupID = @gid`);
        res.json({ success: true });
    } catch (err) {
        console.error('Grup kaldırma hatası:', err);
        res.status(500).json({ error: 'Grup kaldırılamadı.' });
    }
});

// ═══ RESTORAN AYARLARI (kuver + happy hour) — Admin ══════════════════════════
router.get('/settings', adminOnly, async (req, res) => {
    try {
        const pool = await poolPromise;
        const s = await loadSettings(pool);
        res.json({
            coverCharge: Number(s.CoverCharge),
            happyEnabled: !!s.HappyEnabled,
            happyStart: s.HappyStart, happyEnd: s.HappyEnd,
            happyPercent: Number(s.HappyPercent),
            loyaltyPercent: Number(s.LoyaltyPercent || 0),
            features: await loadFeatures(pool),
        });
    } catch (err) {
        console.error('Ayar okuma hatası:', err);
        res.status(500).json({ error: 'Ayarlar alınamadı.' });
    }
});

router.patch('/settings', adminOnly, async (req, res) => {
    const cover = round2(req.body.coverCharge);
    const enabled = req.body.happyEnabled ? 1 : 0;
    const start = Math.min(23, Math.max(0, parseInt(req.body.happyStart, 10) || 0));
    const end = Math.min(23, Math.max(0, parseInt(req.body.happyEnd, 10) || 0));
    let percent = round2(req.body.happyPercent);
    if (!Number.isFinite(percent) || percent < 0) percent = 0;
    if (percent > 90) percent = 90;
    let loyalty = round2(req.body.loyaltyPercent);
    if (!Number.isFinite(loyalty) || loyalty < 0) loyalty = 0;
    if (loyalty > 50) loyalty = 50;
    try {
        const pool = await poolPromise;
        await pool.request()
            .input('cover', sql.Decimal(10, 2), Number.isFinite(cover) && cover >= 0 ? cover : 0)
            .input('en', sql.Bit, enabled)
            .input('s', sql.Int, start)
            .input('e', sql.Int, end)
            .input('p', sql.Decimal(5, 2), percent)
            .input('loy', sql.Decimal(5, 2), loyalty)
            .query(`UPDATE RestoranSettings SET CoverCharge = @cover, HappyEnabled = @en, HappyStart = @s, HappyEnd = @e, HappyPercent = @p, LoyaltyPercent = @loy WHERE Id = 1`);
        if (req.body.features) await saveFeatures(pool, req.body.features);
        res.json({ success: true });
    } catch (err) {
        console.error('Ayar güncelleme hatası:', err);
        res.status(500).json({ error: 'Ayarlar güncellenemedi.' });
    }
});

// ═══ MÜŞTERİ REHBERİ (paket servis / caller-id) ══════════════════════════════
// Garson/kasiyer kullanır (admin değil). Telefonla hızlı arama = caller-id karşılığı.

// GET /customers?q= — ad/telefon ile ara (ilk 20). q boşsa son eklenenler.
router.get('/customers', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 50);
    try {
        const pool = await poolPromise;
        const rq = pool.request();
        let where = '';
        if (q) { rq.input('q', sql.NVarChar(52), `%${q}%`); where = `WHERE c.Name LIKE @q OR c.Phone LIKE @q`; }
        const r = await rq.query(`
            SELECT TOP 20 c.CustomerID, c.Name, c.Phone, c.Note, c.AccountID, c.Points,
                   (SELECT TOP 1 AddressText FROM RestoranAddresses a WHERE a.CustomerID = c.CustomerID ORDER BY a.AddressID DESC) AS LastAddress
            FROM RestoranCustomers c ${where}
            ORDER BY c.CreatedAt DESC
        `);
        res.json(r.recordset.map((c) => ({
            customerId: c.CustomerID, name: c.Name, phone: c.Phone || '', note: c.Note || '',
            accountId: c.AccountID || null, lastAddress: c.LastAddress || '', points: Number(c.Points || 0),
        })));
    } catch (err) {
        console.error('Müşteri arama hatası:', err);
        res.status(500).json({ error: 'Müşteriler alınamadı.' });
    }
});

// GET /customers/:id — müşteri + adresleri + son paket siparişleri.
router.get('/customers/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Geçersiz müşteri.' });
    try {
        const pool = await poolPromise;
        const c = await pool.request().input('id', sql.Int, id)
            .query(`SELECT CustomerID, Name, Phone, Note, AccountID, Points FROM RestoranCustomers WHERE CustomerID = @id`);
        if (c.recordset.length === 0) return res.status(404).json({ error: 'Müşteri bulunamadı.' });
        const addr = await pool.request().input('id', sql.Int, id)
            .query(`SELECT AddressID, Label, AddressText, Directions FROM RestoranAddresses WHERE CustomerID = @id ORDER BY AddressID DESC`);
        const hist = await pool.request().input('id', sql.Int, id)
            .query(`SELECT TOP 10 OrderID, OrderType, OpenedAt, Status FROM RestoranOrders WHERE CustomerID = @id ORDER BY OpenedAt DESC`);
        const loy = await pool.request().input('id', sql.Int, id)
            .query(`SELECT TOP 15 Type, Points, OrderID, CreatedAt FROM RestoranLoyaltyTransactions WHERE CustomerID = @id ORDER BY LoyaltyTxID DESC`);
        const x = c.recordset[0];
        res.json({
            customerId: x.CustomerID, name: x.Name, phone: x.Phone || '', note: x.Note || '', accountId: x.AccountID || null,
            points: Number(x.Points || 0),
            addresses: addr.recordset.map((a) => ({ addressId: a.AddressID, label: a.Label || '', addressText: a.AddressText, directions: a.Directions || '' })),
            history: hist.recordset.map((h) => ({ orderId: h.OrderID, orderType: h.OrderType, openedAt: h.OpenedAt, status: h.Status })),
            loyalty: loy.recordset.map((l) => ({ type: l.Type, points: Number(l.Points), orderId: l.OrderID || null, createdAt: l.CreatedAt })),
        });
    } catch (err) {
        console.error('Müşteri detay hatası:', err);
        res.status(500).json({ error: 'Müşteri alınamadı.' });
    }
});

router.post('/customers', async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 255);
    const phone = String(req.body.phone || '').trim().slice(0, 50) || null;
    const note = String(req.body.note || '').trim().slice(0, 500) || null;
    if (!name) return res.status(400).json({ error: 'Müşteri adı gerekli.' });
    try {
        const pool = await poolPromise;
        const r = await pool.request()
            .input('name', sql.NVarChar(255), name)
            .input('phone', sql.NVarChar(50), phone)
            .input('note', sql.NVarChar(500), note)
            .query(`INSERT INTO RestoranCustomers (Name, Phone, Note) OUTPUT INSERTED.CustomerID VALUES (@name, @phone, @note)`);
        // İlk adres verildiyse ekle.
        const addressText = String(req.body.addressText || '').trim().slice(0, 500);
        if (addressText) {
            await pool.request()
                .input('cid', sql.Int, r.recordset[0].CustomerID)
                .input('label', sql.NVarChar(50), String(req.body.label || '').trim().slice(0, 50) || null)
                .input('addr', sql.NVarChar(500), addressText)
                .input('dir', sql.NVarChar(300), String(req.body.directions || '').trim().slice(0, 300) || null)
                .query(`INSERT INTO RestoranAddresses (CustomerID, Label, AddressText, Directions) VALUES (@cid, @label, @addr, @dir)`);
        }
        res.json({ success: true, id: r.recordset[0].CustomerID });
    } catch (err) {
        console.error('Müşteri ekleme hatası:', err);
        res.status(500).json({ error: 'Müşteri eklenemedi.' });
    }
});

router.patch('/customers/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Geçersiz müşteri.' });
    const sets = [];
    if (req.body.name != null) {
        const n = String(req.body.name).trim().slice(0, 255);
        if (!n) return res.status(400).json({ error: 'Müşteri adı boş olamaz.' });
        sets.push({ col: 'Name', type: sql.NVarChar(255), val: n });
    }
    if (req.body.phone != null) sets.push({ col: 'Phone', type: sql.NVarChar(50), val: String(req.body.phone).trim().slice(0, 50) || null });
    if (req.body.note != null) sets.push({ col: 'Note', type: sql.NVarChar(500), val: String(req.body.note).trim().slice(0, 500) || null });
    if (req.body.accountId !== undefined) sets.push({ col: 'AccountID', type: sql.Int, val: req.body.accountId != null ? parseInt(req.body.accountId, 10) || null : null });
    if (sets.length === 0) return res.status(400).json({ error: 'Güncellenecek alan yok.' });
    try {
        const pool = await poolPromise;
        const rq = pool.request().input('id', sql.Int, id);
        const assigns = sets.map((s, i) => { rq.input(`p${i}`, s.type, s.val); return `${s.col} = @p${i}`; });
        await rq.query(`UPDATE RestoranCustomers SET ${assigns.join(', ')} WHERE CustomerID = @id`);
        res.json({ success: true });
    } catch (err) {
        console.error('Müşteri güncelleme hatası:', err);
        res.status(500).json({ error: 'Müşteri güncellenemedi.' });
    }
});

router.delete('/customers/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Geçersiz müşteri.' });
    try {
        const pool = await poolPromise;
        // Adresler ON DELETE CASCADE ile düşer; geçmiş siparişler snapshot tutar (CustomerID NULL'a düşmez ama veri korunur).
        await pool.request().input('id', sql.Int, id).query(`DELETE FROM RestoranCustomers WHERE CustomerID = @id`);
        res.json({ success: true });
    } catch (err) {
        console.error('Müşteri silme hatası:', err);
        res.status(500).json({ error: 'Müşteri silinemedi. Geçmiş siparişi olabilir.' });
    }
});

// POST /customers/:id/anonymize — KVKK silme/anonimleştirme talebi (yalnız yönetici).
// Kişisel veri (ad, telefon, not, adresler + geçmiş sipariş snapshot'ları) geri
// dönüşsüz temizlenir; FİNANSAL kayıtlar (tutar, tarih, kasa) bozulmadan kalır.
router.post('/customers/:id/anonymize', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Geçersiz müşteri.' });
    try {
        const pool = await poolPromise;
        const trx = pool.transaction();
        await trx.begin();
        try {
            const cur = await trx.request().input('id', sql.Int, id)
                .query(`SELECT CustomerID FROM RestoranCustomers WITH (UPDLOCK, ROWLOCK) WHERE CustomerID = @id`);
            if (cur.recordset.length === 0) throw new Error('Müşteri bulunamadı.');
            await trx.request().input('id', sql.Int, id).query(`
                UPDATE RestoranCustomers
                SET Name = N'SİLİNMİŞ MÜŞTERİ #' + CAST(@id AS NVARCHAR(20)), Phone = NULL, Note = NULL
                WHERE CustomerID = @id
            `);
            await trx.request().input('id', sql.Int, id)
                .query(`DELETE FROM RestoranAddresses WHERE CustomerID = @id`);
            // Geçmiş sipariş snapshot'larındaki kişisel alanlar da KVKK kapsamında.
            await trx.request().input('id', sql.Int, id).query(`
                UPDATE RestoranOrders
                SET CustomerName = NULL, CustomerPhone = NULL, DeliveryAddress = NULL
                WHERE CustomerID = @id
            `);
            await logAudit(req, {
                action: 'restoran.customer.anonymize', entity: 'RestoranCustomer', entityId: id,
                detail: `KVKK anonimleştirme — müşteri #${id} kişisel verileri silindi`,
            }, trx);
            await trx.commit();
            res.json({ success: true });
        } catch (e) {
            await trx.rollback();
            throw e;
        }
    } catch (err) {
        console.error('KVKK anonimleştirme hatası:', err);
        res.status(400).json({ error: err.message || 'Anonimleştirilemedi.' });
    }
});

router.post('/customers/:id/addresses', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const addressText = String(req.body.addressText || '').trim().slice(0, 500);
    if (!id) return res.status(400).json({ error: 'Geçersiz müşteri.' });
    if (!addressText) return res.status(400).json({ error: 'Adres gerekli.' });
    try {
        const pool = await poolPromise;
        const r = await pool.request()
            .input('cid', sql.Int, id)
            .input('label', sql.NVarChar(50), String(req.body.label || '').trim().slice(0, 50) || null)
            .input('addr', sql.NVarChar(500), addressText)
            .input('dir', sql.NVarChar(300), String(req.body.directions || '').trim().slice(0, 300) || null)
            .query(`INSERT INTO RestoranAddresses (CustomerID, Label, AddressText, Directions) OUTPUT INSERTED.AddressID VALUES (@cid, @label, @addr, @dir)`);
        res.json({ success: true, id: r.recordset[0].AddressID });
    } catch (err) {
        console.error('Adres ekleme hatası:', err);
        res.status(500).json({ error: 'Adres eklenemedi.' });
    }
});

router.delete('/addresses/:aid', async (req, res) => {
    const aid = parseInt(req.params.aid, 10);
    if (!aid) return res.status(400).json({ error: 'Geçersiz adres.' });
    try {
        const pool = await poolPromise;
        await pool.request().input('aid', sql.Int, aid).query(`DELETE FROM RestoranAddresses WHERE AddressID = @aid`);
        res.json({ success: true });
    } catch (err) {
        console.error('Adres silme hatası:', err);
        res.status(500).json({ error: 'Adres silinemedi.' });
    }
});

// GET /accounts?q= — açık hesap (veresiye) için cari ara. USE_RESTAURANT seviyesi
// (kasiyer, cari modülü yetkisi olmadan veresiye yazabilsin). Ortak CurrentAccounts.
router.get('/accounts', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 50);
    try {
        const pool = await poolPromise;
        const rq = pool.request();
        let where = '';
        if (q) { rq.input('q', sql.NVarChar(52), `%${q}%`); where = `WHERE Name LIKE @q OR Phone LIKE @q`; }
        const r = await rq.query(`
            SELECT TOP 20 AccountID, Name, Phone, Balance FROM CurrentAccounts ${where} ORDER BY Name
        `);
        res.json(r.recordset.map((a) => ({ accountId: a.AccountID, name: a.Name, phone: a.Phone || '', balance: Number(a.Balance) })));
    } catch (err) {
        console.error('Cari arama hatası:', err);
        res.status(500).json({ error: 'Cariler alınamadı.' });
    }
});

// POST /accounts — veresiye için hızlı cari oluştur (kasiyer). Ortak CurrentAccounts.
router.post('/accounts', async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 255);
    const phone = String(req.body.phone || '').trim().slice(0, 50) || null;
    if (!name) return res.status(400).json({ error: 'Cari adı gerekli.' });
    try {
        const pool = await poolPromise;
        const r = await pool.request()
            .input('name', sql.NVarChar(255), name)
            .input('phone', sql.NVarChar(50), phone)
            .query(`INSERT INTO CurrentAccounts (Name, Type, Phone) OUTPUT INSERTED.AccountID VALUES (@name, N'Alıcı', @phone)`);
        res.json({ success: true, accountId: r.recordset[0].AccountID });
    } catch (err) {
        console.error('Cari ekleme hatası:', err);
        res.status(500).json({ error: 'Cari eklenemedi.' });
    }
});

// ═══ KURYELER ═════════════════════════════════════════════════════════════════
// Liste herkese (atama için); ekle/düzenle/sil yalnız Admin.

// GET /couriers/report?date= — kurye dağıtım raporu (teslim eden + tutar). Admin.
router.get('/couriers/report', adminOnly, async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
    try {
        const pool = await poolPromise;
        const rq = pool.request();
        const filter = date
            ? (rq.input('date', sql.VarChar(10), date), `CONVERT(date, o.DeliveredAt) = CONVERT(date, @date)`)
            : `CONVERT(date, o.DeliveredAt) = CONVERT(date, GETDATE())`;
        const r = await rq.query(`
            SELECT c.CourierID, c.Name,
                   COUNT(o.OrderID) AS Delivered,
                   ISNULL(SUM((SELECT ISNULL(SUM(x.UnitPrice * x.Quantity), 0) FROM RestoranOrderItems x
                               WHERE x.OrderID = o.OrderID AND x.PaidAt IS NOT NULL AND x.KitchenStatus <> N'İkram')), 0) AS Collected
            FROM RestoranCouriers c
            LEFT JOIN RestoranOrders o ON o.CourierID = c.CourierID AND o.DeliveryStatus = N'Teslim' AND ${filter}
            GROUP BY c.CourierID, c.Name
            ORDER BY Delivered DESC, c.Name
        `);
        res.json({
            date: date || new Date().toISOString().slice(0, 10),
            couriers: r.recordset.map((x) => ({ courierId: x.CourierID, name: x.Name, delivered: x.Delivered, collected: Number(x.Collected) })),
        });
    } catch (err) {
        console.error('Kurye rapor hatası:', err);
        res.status(500).json({ error: 'Kurye raporu alınamadı.' });
    }
});

router.get('/couriers', async (req, res) => {
    try {
        const pool = await poolPromise;
        const r = await pool.request().query(`SELECT CourierID, Name, Phone, IsActive FROM RestoranCouriers ORDER BY IsActive DESC, Name`);
        res.json(r.recordset.map((c) => ({ courierId: c.CourierID, name: c.Name, phone: c.Phone || '', isActive: !!c.IsActive })));
    } catch (err) {
        console.error('Kurye liste hatası:', err);
        res.status(500).json({ error: 'Kuryeler alınamadı.' });
    }
});

router.post('/couriers', adminOnly, async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 150);
    const phone = String(req.body.phone || '').trim().slice(0, 50) || null;
    if (!name) return res.status(400).json({ error: 'Kurye adı gerekli.' });
    try {
        const pool = await poolPromise;
        const r = await pool.request()
            .input('name', sql.NVarChar(150), name)
            .input('phone', sql.NVarChar(50), phone)
            .query(`INSERT INTO RestoranCouriers (Name, Phone) OUTPUT INSERTED.CourierID VALUES (@name, @phone)`);
        res.json({ success: true, id: r.recordset[0].CourierID });
    } catch (err) {
        console.error('Kurye ekleme hatası:', err);
        res.status(500).json({ error: 'Kurye eklenemedi.' });
    }
});

router.patch('/couriers/:id', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Geçersiz kurye.' });
    const sets = [];
    if (req.body.name != null) {
        const n = String(req.body.name).trim().slice(0, 150);
        if (!n) return res.status(400).json({ error: 'Kurye adı boş olamaz.' });
        sets.push({ col: 'Name', type: sql.NVarChar(150), val: n });
    }
    if (req.body.phone != null) sets.push({ col: 'Phone', type: sql.NVarChar(50), val: String(req.body.phone).trim().slice(0, 50) || null });
    if (req.body.isActive != null) sets.push({ col: 'IsActive', type: sql.Bit, val: req.body.isActive ? 1 : 0 });
    if (sets.length === 0) return res.status(400).json({ error: 'Güncellenecek alan yok.' });
    try {
        const pool = await poolPromise;
        const rq = pool.request().input('id', sql.Int, id);
        const assigns = sets.map((s, i) => { rq.input(`p${i}`, s.type, s.val); return `${s.col} = @p${i}`; });
        await rq.query(`UPDATE RestoranCouriers SET ${assigns.join(', ')} WHERE CourierID = @id`);
        res.json({ success: true });
    } catch (err) {
        console.error('Kurye güncelleme hatası:', err);
        res.status(500).json({ error: 'Kurye güncellenemedi.' });
    }
});

router.delete('/couriers/:id', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Geçersiz kurye.' });
    try {
        const pool = await poolPromise;
        // Geçmiş siparişler CourierID tutar → sert silme yerine pasifleştir.
        await pool.request().input('id', sql.Int, id).query(`UPDATE RestoranCouriers SET IsActive = 0 WHERE CourierID = @id`);
        res.json({ success: true });
    } catch (err) {
        console.error('Kurye silme hatası:', err);
        res.status(500).json({ error: 'Kurye silinemedi.' });
    }
});

// ─── Reçete (Faz 5) — menü ürünü ↔ ERP hammadde (opt-in stok kuplajı) ────────
// ERP stok arama: reçeteye hammadde eklerken seçici (admin).
router.get('/stocks-search', adminOnly, async (req, res) => {
    const q = `%${String(req.query.q || '').trim()}%`;
    try {
        const pool = await poolPromise;
        const r = await pool.request().input('q', sql.NVarChar(255), q).query(`
            SELECT TOP 25 StockID, Name, Unit, Quantity, PurchasePrice
            FROM Stocks WHERE Name LIKE @q ORDER BY Name
        `);
        res.json(r.recordset.map((s) => ({
            stockId: s.StockID, name: s.Name, unit: s.Unit || 'Adet',
            quantity: Number(s.Quantity), purchasePrice: s.PurchasePrice != null ? Number(s.PurchasePrice) : null,
        })));
    } catch (err) {
        console.error('Stok arama hatası:', err);
        res.status(500).json({ error: 'Stoklar aranamadı.' });
    }
});

// Bir ürünün reçetesi (hammadde satırları + güncel stok + birim maliyet).
router.get('/products/:pid/recipe', adminOnly, async (req, res) => {
    const pid = parseInt(req.params.pid, 10);
    if (!pid) return res.status(400).json({ error: 'Geçersiz ürün.' });
    try {
        const pool = await poolPromise;
        const r = await pool.request().input('pid', sql.Int, pid).query(`
            SELECT r.RecipeID, r.StockID, r.Quantity, s.Name, s.Unit, s.Quantity AS StockQty, s.PurchasePrice
            FROM RestoranRecipes r LEFT JOIN Stocks s ON s.StockID = r.StockID
            WHERE r.ProductID = @pid ORDER BY s.Name
        `);
        res.json(r.recordset.map((x) => ({
            recipeId: x.RecipeID, stockId: x.StockID, stockName: x.Name || '(silinmiş stok)',
            unit: x.Unit || 'Adet', quantity: Number(x.Quantity),
            stockQty: x.StockQty != null ? Number(x.StockQty) : null,
            purchasePrice: x.PurchasePrice != null ? Number(x.PurchasePrice) : null,
            lineCost: x.PurchasePrice != null ? round2(Number(x.Quantity) * Number(x.PurchasePrice)) : null,
        })));
    } catch (err) {
        console.error('Reçete liste hatası:', err);
        res.status(500).json({ error: 'Reçete alınamadı.' });
    }
});

// Reçete satırı ekle/güncelle (upsert; ürün başına aynı hammadde tek satır).
router.post('/products/:pid/recipe', adminOnly, async (req, res) => {
    const pid = parseInt(req.params.pid, 10);
    const stockId = parseInt(req.body.stockId, 10);
    const quantity = Number(req.body.quantity);
    if (!pid) return res.status(400).json({ error: 'Geçersiz ürün.' });
    if (!stockId) return res.status(400).json({ error: 'Geçersiz hammadde.' });
    if (!Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: 'Miktar pozitif olmalı.' });
    try {
        const pool = await poolPromise;
        const prod = await pool.request().input('pid', sql.Int, pid).query(`SELECT ProductID FROM RestoranProducts WHERE ProductID = @pid`);
        if (prod.recordset.length === 0) return res.status(404).json({ error: 'Ürün bulunamadı.' });
        const stk = await pool.request().input('sid', sql.Int, stockId).query(`SELECT StockID FROM Stocks WHERE StockID = @sid`);
        if (stk.recordset.length === 0) return res.status(404).json({ error: 'Hammadde (stok) bulunamadı.' });
        await pool.request()
            .input('pid', sql.Int, pid)
            .input('sid', sql.Int, stockId)
            .input('qty', sql.Decimal(18, 3), quantity)
            .query(`
                UPDATE RestoranRecipes SET Quantity = @qty WHERE ProductID = @pid AND StockID = @sid;
                IF @@ROWCOUNT = 0
                    INSERT INTO RestoranRecipes (ProductID, StockID, Quantity) VALUES (@pid, @sid, @qty);
            `);
        res.json({ success: true });
    } catch (err) {
        console.error('Reçete ekleme hatası:', err);
        res.status(500).json({ error: 'Reçete kaydedilemedi.' });
    }
});

router.delete('/recipe/:rid', adminOnly, async (req, res) => {
    const rid = parseInt(req.params.rid, 10);
    if (!rid) return res.status(400).json({ error: 'Geçersiz satır.' });
    try {
        const pool = await poolPromise;
        await pool.request().input('rid', sql.Int, rid).query(`DELETE FROM RestoranRecipes WHERE RecipeID = @rid`);
        res.json({ success: true });
    } catch (err) {
        console.error('Reçete silme hatası:', err);
        res.status(500).json({ error: 'Reçete silinemedi.' });
    }
});

// ─── Raporlar (Faz 5) ────────────────────────────────────────────────────────
// Tarih aralığı analizi (adminOnly). Ciro/ödeme kırılımı Transactions'tan (Z ile
// tutarlı, açık hesap=alacak hariç). Ürün/garson/saatlik kırılım RestoranOrderItems
// (brüt, İkram hariç) ve OpenedBy üzerinden. Salt-okunur, tek uçtan tüm paneller.
router.get('/reports', adminOnly, async (req, res) => {
    const valid = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
    let from = valid(req.query.from) ? req.query.from : null;
    let to = valid(req.query.to) ? req.query.to : null;
    if (!from && !to) { from = to = new Date().toISOString().slice(0, 10); }
    else if (from && !to) to = from;
    else if (to && !from) from = to;
    if (from > to) { const tmp = from; from = to; to = tmp; }

    try {
        const pool = await poolPromise;
        const mkReq = () => pool.request().input('from', sql.VarChar(10), from).input('to', sql.VarChar(10), to);
        const txWhere = `Type = 'Gelir' AND ServiceID IS NULL AND Description LIKE 'ArcTeknik Şef%' AND CONVERT(date, CreatedAt) BETWEEN @from AND @to`;

        const [totalsR, ordersR, dailyR, hourlyR, productsR, waiterR, costR] = await Promise.all([
            mkReq().query(`
                SELECT COUNT(*) AS Cnt, ISNULL(SUM(Amount), 0) AS Total,
                    ISNULL(SUM(CASE WHEN PaymentMethod = 'Nakit' THEN Amount ELSE 0 END), 0) AS Cash,
                    ISNULL(SUM(CASE WHEN PaymentMethod = 'Kredi Kartı' THEN Amount ELSE 0 END), 0) AS Card,
                    ISNULL(SUM(CASE WHEN PaymentMethod = 'Yemek Fişi' THEN Amount ELSE 0 END), 0) AS Ticket
                FROM Transactions WHERE ${txWhere}
            `),
            mkReq().query(`
                SELECT COUNT(*) AS Orders, ISNULL(SUM(GuestCount), 0) AS Guests
                FROM RestoranOrders WHERE Status = N'Kapandı' AND CONVERT(date, ClosedAt) BETWEEN @from AND @to
            `),
            mkReq().query(`
                SELECT CONVERT(date, CreatedAt) AS D, ISNULL(SUM(Amount), 0) AS Rev, COUNT(*) AS Cnt
                FROM Transactions WHERE ${txWhere}
                GROUP BY CONVERT(date, CreatedAt) ORDER BY D
            `),
            mkReq().query(`
                SELECT DATEPART(hour, CreatedAt) AS H, ISNULL(SUM(Amount), 0) AS Rev, COUNT(*) AS Cnt
                FROM Transactions WHERE ${txWhere}
                GROUP BY DATEPART(hour, CreatedAt) ORDER BY H
            `),
            mkReq().query(`
                SELECT TOP 25 i.Name, SUM(i.Quantity) AS Qty, ISNULL(SUM(i.UnitPrice * i.Quantity), 0) AS Rev
                FROM RestoranOrderItems i JOIN RestoranOrders o ON o.OrderID = i.OrderID
                WHERE o.Status = N'Kapandı' AND i.KitchenStatus <> N'İkram' AND i.PaidAt IS NOT NULL
                    AND CONVERT(date, o.ClosedAt) BETWEEN @from AND @to
                GROUP BY i.Name ORDER BY Qty DESC
            `),
            // OpenedBy kullanıcının TAM ADI olarak saklanır (NVARCHAR) — Users.UserID'ye
            // join edilirse SQL örtük INT dönüşümünde patlar. Doğrudan adı raporla.
            mkReq().query(`
                SELECT ISNULL(NULLIF(LTRIM(RTRIM(o.OpenedBy)), N''), N'(bilinmiyor)') AS Waiter,
                    COUNT(DISTINCT o.OrderID) AS Orders,
                    ISNULL(SUM(i.UnitPrice * i.Quantity), 0) AS Rev
                FROM RestoranOrders o
                LEFT JOIN RestoranOrderItems i ON i.OrderID = o.OrderID AND i.KitchenStatus <> N'İkram' AND i.PaidAt IS NOT NULL
                WHERE o.Status = N'Kapandı' AND CONVERT(date, o.ClosedAt) BETWEEN @from AND @to
                GROUP BY ISNULL(NULLIF(LTRIM(RTRIM(o.OpenedBy)), N''), N'(bilinmiyor)') ORDER BY Rev DESC
            `),
            // Reçete maliyeti (COGS): satılan (İkram hariç, ödenmiş) kalemlerin
            // hammadde alış maliyeti. Yalnız reçetesi olan ürünler katkı verir.
            mkReq().query(`
                SELECT ISNULL(SUM(rec.Quantity * i.Quantity * ISNULL(s.PurchasePrice, 0)), 0) AS Cost
                FROM RestoranOrderItems i
                JOIN RestoranOrders o ON o.OrderID = i.OrderID
                JOIN RestoranRecipes rec ON rec.ProductID = i.ProductID
                LEFT JOIN Stocks s ON s.StockID = rec.StockID
                WHERE o.Status = N'Kapandı' AND i.PaidAt IS NOT NULL AND i.KitchenStatus <> N'İkram'
                    AND CONVERT(date, o.ClosedAt) BETWEEN @from AND @to
            `),
        ]);

        const t = totalsR.recordset[0];
        const o = ordersR.recordset[0];
        const total = Number(t.Total);
        const cost = round2(Number(costR.recordset[0].Cost));
        res.json({
            from, to,
            totals: {
                revenue: total,
                paymentCount: t.Cnt,
                cash: Number(t.Cash),
                card: Number(t.Card),
                ticket: Number(t.Ticket),
                orders: o.Orders,
                guests: o.Guests,
                avgTicket: o.Orders > 0 ? round2(total / o.Orders) : 0,
                avgPerGuest: o.Guests > 0 ? round2(total / o.Guests) : 0,
                cost,                                   // reçete COGS (tahmini)
                grossProfit: round2(total - cost),      // ciro − reçete maliyeti
            },
            daily: dailyR.recordset.map((x) => ({ date: x.D, revenue: Number(x.Rev), orders: x.Cnt })),
            hourly: hourlyR.recordset.map((x) => ({ hour: x.H, revenue: Number(x.Rev), count: x.Cnt })),
            topProducts: productsR.recordset.map((x) => ({ name: x.Name, qty: Number(x.Qty), revenue: Number(x.Rev) })),
            byWaiter: waiterR.recordset.map((x) => ({ name: x.Waiter, orders: x.Orders, revenue: Number(x.Rev) })),
        });
    } catch (err) {
        console.error('Restoran rapor hatası:', err);
        res.status(500).json({ error: 'Rapor alınamadı.' });
    }
});

// ─── Rezervasyon (Faz 5) ─────────────────────────────────────────────────────
// Operasyonel katman: ön büro/garson rezervasyon alır (adminOnly DEĞİL). Masa
// planından AYRI — masanın anlık durumunu değiştirmez, yalnız planlama tutar.

// Bir güne ait rezervasyonlar (date=YYYY-MM-DD; yoksa bugün). Saate göre sıralı.
router.get('/reservations', async (req, res) => {
    try {
        const pool = await poolPromise;
        const rq = pool.request();
        const date = String(req.query.date || '').trim();
        let where = 'CAST(r.ReservedAt AS DATE) = CAST(GETDATE() AS DATE)';
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            rq.input('date', sql.Date, date);
            where = 'CAST(r.ReservedAt AS DATE) = @date';
        }
        const r = await rq.query(`
            SELECT r.ReservationID, r.TableID, r.CustomerName, r.CustomerPhone, r.GuestCount,
                   r.ReservedAt, r.DurationMin, r.Status, r.Note, t.TableNo, t.SectionID, s.Name AS SectionName
            FROM RestoranReservations r
            LEFT JOIN RestoranTables t ON t.TableID = r.TableID
            LEFT JOIN RestoranSections s ON s.SectionID = t.SectionID
            WHERE ${where}
            ORDER BY r.ReservedAt ASC
        `);
        res.json(r.recordset.map((x) => ({
            reservationId: x.ReservationID,
            tableId: x.TableID,
            tableNo: x.TableNo || null,
            sectionName: x.SectionName || null,
            customerName: x.CustomerName,
            customerPhone: x.CustomerPhone || '',
            guestCount: x.GuestCount,
            reservedAt: x.ReservedAt,
            durationMin: x.DurationMin,
            status: x.Status,
            note: x.Note || '',
        })));
    } catch (err) {
        console.error('Rezervasyon liste hatası:', err);
        res.status(500).json({ error: 'Rezervasyonlar alınamadı.' });
    }
});

router.post('/reservations', async (req, res) => {
    const name = String(req.body.customerName || '').trim().slice(0, 255);
    const phone = String(req.body.customerPhone || '').trim().slice(0, 50) || null;
    const guests = parseInt(req.body.guestCount, 10) || 2;
    const duration = parseInt(req.body.durationMin, 10) || 120;
    const note = String(req.body.note || '').trim().slice(0, 500) || null;
    const tableId = req.body.tableId != null ? parseInt(req.body.tableId, 10) || null : null;
    const reservedAt = new Date(req.body.reservedAt);
    if (!name) return res.status(400).json({ error: 'Müşteri adı gerekli.' });
    if (isNaN(reservedAt.getTime())) return res.status(400).json({ error: 'Geçersiz rezervasyon zamanı.' });
    if (guests <= 0) return res.status(400).json({ error: 'Geçersiz kişi sayısı.' });
    try {
        const pool = await poolPromise;
        const r = await pool.request()
            .input('tableId', sql.Int, tableId)
            .input('name', sql.NVarChar(255), name)
            .input('phone', sql.NVarChar(50), phone)
            .input('guests', sql.Int, guests)
            .input('reservedAt', sql.DateTime, reservedAt)
            .input('duration', sql.Int, duration)
            .input('note', sql.NVarChar(500), note)
            .input('createdBy', sql.Int, req.user?.userId || null)
            .query(`
                INSERT INTO RestoranReservations (TableID, CustomerName, CustomerPhone, GuestCount, ReservedAt, DurationMin, Note, CreatedBy)
                OUTPUT INSERTED.ReservationID
                VALUES (@tableId, @name, @phone, @guests, @reservedAt, @duration, @note, @createdBy)
            `);
        res.json({ success: true, id: r.recordset[0].ReservationID });
    } catch (err) {
        console.error('Rezervasyon ekleme hatası:', err);
        res.status(500).json({ error: 'Rezervasyon eklenemedi.' });
    }
});

router.patch('/reservations/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Geçersiz rezervasyon.' });
    const sets = [];
    if (req.body.status != null) {
        const st = String(req.body.status);
        if (!RESERVATION_STATES.includes(st)) return res.status(400).json({ error: 'Geçersiz durum.' });
        sets.push({ col: 'Status', type: sql.NVarChar(20), val: st });
    }
    if (req.body.customerName != null) {
        const n = String(req.body.customerName).trim().slice(0, 255);
        if (!n) return res.status(400).json({ error: 'Müşteri adı boş olamaz.' });
        sets.push({ col: 'CustomerName', type: sql.NVarChar(255), val: n });
    }
    if (req.body.customerPhone != null) sets.push({ col: 'CustomerPhone', type: sql.NVarChar(50), val: String(req.body.customerPhone).trim().slice(0, 50) || null });
    if (req.body.guestCount != null) {
        const g = parseInt(req.body.guestCount, 10);
        if (!g || g <= 0) return res.status(400).json({ error: 'Geçersiz kişi sayısı.' });
        sets.push({ col: 'GuestCount', type: sql.Int, val: g });
    }
    if (req.body.tableId !== undefined) sets.push({ col: 'TableID', type: sql.Int, val: req.body.tableId != null ? parseInt(req.body.tableId, 10) || null : null });
    if (req.body.durationMin != null) sets.push({ col: 'DurationMin', type: sql.Int, val: parseInt(req.body.durationMin, 10) || 120 });
    if (req.body.note != null) sets.push({ col: 'Note', type: sql.NVarChar(500), val: String(req.body.note).trim().slice(0, 500) || null });
    if (req.body.reservedAt != null) {
        const d = new Date(req.body.reservedAt);
        if (isNaN(d.getTime())) return res.status(400).json({ error: 'Geçersiz zaman.' });
        sets.push({ col: 'ReservedAt', type: sql.DateTime, val: d });
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Güncellenecek alan yok.' });
    try {
        const pool = await poolPromise;
        const rq = pool.request().input('id', sql.Int, id);
        const assigns = sets.map((s, i) => { rq.input(`p${i}`, s.type, s.val); return `${s.col} = @p${i}`; });
        await rq.query(`UPDATE RestoranReservations SET ${assigns.join(', ')} WHERE ReservationID = @id`);
        res.json({ success: true });
    } catch (err) {
        console.error('Rezervasyon güncelleme hatası:', err);
        res.status(500).json({ error: 'Rezervasyon güncellenemedi.' });
    }
});

router.delete('/reservations/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Geçersiz rezervasyon.' });
    try {
        const pool = await poolPromise;
        await pool.request().input('id', sql.Int, id).query(`DELETE FROM RestoranReservations WHERE ReservationID = @id`);
        res.json({ success: true });
    } catch (err) {
        console.error('Rezervasyon silme hatası:', err);
        res.status(500).json({ error: 'Rezervasyon silinemedi.' });
    }
});

module.exports = router;
// Saf yardımcılar birim testi için dışa açılır (router bir fonksiyon — property
// eklemek Express davranışını değiştirmez).
module.exports.parseItems = parseItems;
module.exports.sanitizeTarget = sanitizeTarget;
module.exports.round2 = round2;
