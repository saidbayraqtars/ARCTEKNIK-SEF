const express = require('express');
const sql = require('mssql');
const { poolPromise } = require('../config/db');
const { authenticate, adminOnly } = require('../middleware/auth');
const { applyMovement, round2 } = require('../services/currentAccount');
const { logMovement, adjustStock, getDefaultWarehouseId, applyBalance } = require('../services/stockLedger');
const { triggerWebSync } = require('../services/webSync');
const { logAudit } = require('../services/audit');
const { getRate, normCurrency, isSupported } = require('../services/fxRates');

const router = express.Router();

// ─── Masraf dağıtımı (landed cost) ───────────────────────────────────────────
// Ek masrafları (nakliye/gümrük/sigorta) fiş kalemlerine dağıt. Taban:
//   'tutar'   → kalem mal tutarına orantılı
//   'miktar'  → adete orantılı
//   'agirlik' → kalem ağırlığına orantılı (Weight girilmemişse güvenli düşer)
// Dönen dizi items ile paralel; her elemana düşen ek maliyet (₺, 2 hane).
// Son kaleme yuvarlama artığı verilir → dağıtılan toplam = extraTotal birebir.
function allocateExtraCosts(items, extraTotal, basis) {
    const n = items.length;
    const out = new Array(n).fill(0);
    if (!(extraTotal > 0) || n === 0) return out;
    const weightOf = (it, b) => {
        if (b === 'miktar') return Number(it.quantity) || 0;
        if (b === 'agirlik') return Number(it.weight) || 0;
        return round2((Number(it.unitPurchasePrice) || 0) * (Number(it.quantity) || 0)); // tutar
    };
    // Seçilen taban toplamı 0 ise güvenli düş: agirlik → tutar → miktar.
    let weights, sum;
    for (const b of [basis, 'tutar', 'miktar']) {
        weights = items.map((it) => weightOf(it, b));
        sum = weights.reduce((s, w) => s + w, 0);
        if (sum > 0) break;
    }
    if (!(sum > 0)) return out;
    let acc = 0;
    for (let i = 0; i < n; i++) {
        if (i === n - 1) { out[i] = round2(extraTotal - acc); }
        else { const v = round2((extraTotal * weights[i]) / sum); out[i] = v; acc = round2(acc + v); }
    }
    return out;
}

// ─── Fiş gövdesini doğrula + normalize et (POST ve PUT ortak) ────────────────
// Hata mesajı atar; çağıran route 400 ile döner.
function parseReceiptBody(body) {
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length === 0) throw new Error('Fişe en az bir kalem ekleyin.');

    const allowedBasis = ['tutar', 'miktar', 'agirlik'];
    const allocationBasis = allowedBasis.includes(body.allocationBasis) ? body.allocationBasis : 'tutar';
    const extraCharges = (Array.isArray(body.extraCharges) ? body.extraCharges : [])
        .map((c) => ({ desc: (c.desc || c.description || '').toString().trim().slice(0, 200), amount: round2(c.amount) }))
        .filter((c) => Number.isFinite(c.amount) && c.amount > 0);
    const extraTotal = round2(extraCharges.reduce((s, c) => s + c.amount, 0));

    const items = [];
    for (const it of rawItems) {
        const qty = parseInt(it.quantity, 10);
        const unit = round2(it.unitPurchasePrice);
        if (!(qty > 0)) throw new Error('Her kalemde geçerli bir adet olmalı.');
        if (!Number.isFinite(unit) || unit < 0) throw new Error('Geçersiz alış fiyatı.');
        const stockId = it.stockId ? parseInt(it.stockId, 10) : null;
        const name = (it.name || '').trim();
        if (!stockId && !name) throw new Error('Yeni ürün için ad zorunludur.');
        const w = it.weight === '' || it.weight == null ? null : Number(it.weight);
        items.push({
            stockId, name, quantity: qty, unitPurchasePrice: unit,
            weight: Number.isFinite(w) && w >= 0 ? w : null,
            updateSalePrice: it.updateSalePrice === true,
            salePrice: it.salePrice === '' || it.salePrice == null ? null : round2(it.salePrice),
        });
    }

    const supplierId = body.accountId ? parseInt(body.accountId, 10) : null;
    const note = body.note || null;
    const warehouseId = Number(body.warehouseId) > 0 ? Number(body.warehouseId) : null;
    // Fiş para birimi (çok-birimli cari): gövdede varsa onu, yoksa tedarikçi
    // birincil birimi kullanılır (createReceiptCore çözer). null → varsayılan.
    const currency = body.currency ? normCurrency(body.currency) : null;
    const allocations = allocateExtraCosts(items, extraTotal, allocationBasis);
    return { supplierId, note, warehouseId, currency, items, extraCharges, extraTotal, allocationBasis, allocations };
}

// ─── Fişi oluştur (stok artışı + landed maliyet + tedarikçi borcu) ───────────
// Verilen tx içinde çalışır. Döner: { receiptId, total, extraTotal, webDirty }.
async function createReceiptCore(tx, parsed, createdBy) {
    const { supplierId, note, warehouseId, currency, items, extraCharges, extraTotal, allocationBasis, allocations } = parsed;
    // Çoklu depo: fiş bir depoya girer. Varsayılan-OLMAYAN depoda StockBalances'a
    // da eklenir (varsayılan türetilir → satır tutulmaz).
    const whId = Number(warehouseId) > 0 ? Number(warehouseId) : null;
    const defWh = whId != null ? await getDefaultWarehouseId(tx) : null;

    const validCcy = (c) => c && (normCurrency(c) === 'TRY' || isSupported(normCurrency(c))) ? normCurrency(c) : null;
    let supCcy = null; // tedarikçinin birincil birimi (varsayılan)
    if (supplierId) {
        const sup = await tx.request().input('id', sql.Int, supplierId)
            .query(`SELECT AccountID, Currency FROM CurrentAccounts WHERE AccountID = @id`);
        if (sup.recordset.length === 0) throw new Error('Seçilen tedarikçi carisi bulunamadı.');
        supCcy = validCcy(sup.recordset[0].Currency);
    }
    // Çok-birimli cari: fiş para birimi serbest seçilir. Gövdede birim varsa onu,
    // yoksa tedarikçinin birincil birimini, o da yoksa TRY. Cari bu birimde
    // borçlandırılır (bölme YOK); stok maliyeti TCMB kuruyla TL'ye çevrilir.
    const recCcy = validCcy(currency) || supCcy || 'TRY';

    let rate = 1;
    if (recCcy !== 'TRY') {
        const fx = await getRate(recCcy, new Date());
        if (!fx || !fx.rate) throw new Error(`${recCcy} kuru bulunamadı; döviz fiş için kur gerekli.`);
        rate = fx.rate;
    }

    let total = 0;      // tedarikçi biriminde (cari borcu)
    let totalTRY = 0;   // TL karşılığı (yalnız mal; ek masraf hariç)
    let webDirty = false;
    const resolvedItems = [];

    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        let stockId = it.stockId;
        let itemName = it.name;
        const allocated = round2(allocations[i] || 0);               // ek masraf (TL)
        const lineGoods = round2(it.unitPurchasePrice * it.quantity); // tedarikçi biriminde
        const lineGoodsTRY = round2(lineGoods * rate);               // TL karşılığı
        // Landed birim maliyet (TL) = (mal TL + dağıtılan ek masraf TL) / adet.
        // Ek masraf yoksa = ham alış fiyatının TL karşılığı (TRY'de birebir).
        const landedUnit = round2((lineGoodsTRY + allocated) / it.quantity);

        let qtyAfter = it.quantity;
        if (stockId) {
            // Mevcut stok: kilitle, miktar + alış (landed) fiyatı güncelle.
            const st = await tx.request().input('id', sql.Int, stockId)
                .query(`SELECT StockID, Name, Quantity, ShowOnWeb FROM Stocks WITH (UPDLOCK, ROWLOCK) WHERE StockID = @id`);
            if (st.recordset.length === 0) throw new Error(`Ürün bulunamadı (ID: ${stockId}).`);
            itemName = st.recordset[0].Name;
            qtyAfter = (Number(st.recordset[0].Quantity) || 0) + it.quantity;
            if (st.recordset[0].ShowOnWeb) webDirty = true;

            const setSale = it.updateSalePrice && it.salePrice != null ? `, SalePrice = @salePrice` : '';
            const upd = tx.request()
                .input('id', sql.Int, stockId)
                .input('qty', sql.Int, it.quantity)
                .input('pp', sql.Decimal(10, 2), landedUnit);
            if (setSale) upd.input('salePrice', sql.Decimal(10, 2), it.salePrice);
            await upd.query(`
                UPDATE Stocks
                SET Quantity = Quantity + @qty, PurchasePrice = @pp${setSale}, UpdatedAt = GETDATE()
                WHERE StockID = @id
            `);
        } else {
            // Yeni stok kartı oluştur (landed maliyetle).
            const created = await tx.request()
                .input('name', sql.NVarChar(255), itemName)
                .input('qty', sql.Int, it.quantity)
                .input('pp', sql.Decimal(10, 2), landedUnit)
                .input('sp', sql.Decimal(10, 2), it.salePrice != null ? it.salePrice : null)
                .query(`
                    INSERT INTO Stocks (Name, Quantity, PurchasePrice, SalePrice)
                    OUTPUT INSERTED.StockID
                    VALUES (@name, @qty, @pp, @sp)
                `);
            stockId = created.recordset[0].StockID;
        }

        // Cari borç = yalnız mal tutarı (ek masraf çoğu kez farklı satıcıdan).
        total = round2(total + lineGoods);
        totalTRY = round2(totalTRY + lineGoodsTRY);
        resolvedItems.push({
            stockId, name: itemName, quantity: it.quantity, unit: it.unitPurchasePrice,
            lineTotal: lineGoods, qtyAfter, allocated, landedUnit, weight: it.weight,
        });
    }

    // Fiş başlığı.
    const head = await tx.request()
        .input('accountId', sql.Int, supplierId)
        .input('total', sql.Decimal(12, 2), total)
        .input('note', sql.NVarChar(500), note || null)
        .input('createdBy', sql.NVarChar(100), createdBy)
        .input('extra', sql.NVarChar(sql.MAX), extraTotal > 0 ? JSON.stringify(extraCharges) : null)
        .input('basis', sql.NVarChar(10), extraTotal > 0 ? allocationBasis : null)
        .input('extraTotal', sql.Decimal(12, 2), extraTotal > 0 ? extraTotal : null)
        .input('warehouseId', sql.Int, whId)
        .input('currency', sql.NVarChar(3), recCcy)
        .input('rate', sql.Decimal(18, 6), recCcy !== 'TRY' ? rate : null)
        .query(`
            INSERT INTO StockReceipts (AccountID, TotalAmount, Note, CreatedBy, ExtraCharges, AllocationBasis, ExtraTotal, WarehouseID, Currency, ExchangeRate)
            OUTPUT INSERTED.ReceiptID
            VALUES (@accountId, @total, @note, @createdBy, @extra, @basis, @extraTotal, @warehouseId, @currency, @rate)
        `);
    const receiptId = head.recordset[0].ReceiptID;

    // Fiş kalemleri (snapshot) + stok defteri.
    for (const it of resolvedItems) {
        await tx.request()
            .input('rid', sql.Int, receiptId)
            .input('sid', sql.Int, it.stockId)
            .input('name', sql.NVarChar(255), it.name)
            .input('qty', sql.Int, it.quantity)
            .input('unit', sql.Decimal(10, 2), it.unit)
            .input('lt', sql.Decimal(12, 2), it.lineTotal)
            .input('weight', sql.Decimal(12, 3), it.weight != null ? it.weight : null)
            .input('alloc', sql.Decimal(12, 2), it.allocated > 0 ? it.allocated : null)
            .input('landed', sql.Decimal(12, 2), it.allocated > 0 ? it.landedUnit : null)
            .query(`
                INSERT INTO StockReceiptItems (ReceiptID, StockID, Name, Quantity, UnitPurchasePrice, LineTotal, Weight, AllocatedCost, LandedUnitCost)
                VALUES (@rid, @sid, @name, @qty, @unit, @lt, @weight, @alloc, @landed)
            `);

        await logMovement(tx, {
            stockId: it.stockId, stockName: it.name, direction: 'Giris', reason: 'Mal Alımı',
            quantity: it.quantity, quantityAfter: it.qtyAfter, unitPrice: it.landedUnit,
            relatedReceiptId: receiptId, warehouseId: whId,
            note: it.allocated > 0 ? `Mal Alımı (Fiş #${receiptId}, +masraf ${it.allocated.toFixed(2)}₺)` : `Mal Alımı (Fiş #${receiptId})`,
            createdBy,
        });
        // Varsayılan-olmayan depo: depo bakiyesine de ekle (varsayılan türetilir).
        if (whId != null && defWh != null && whId !== defWh && it.stockId) {
            await applyBalance(tx, it.stockId, whId, it.quantity);
        }
    }

    // Tedarikçi carisine borç (Alacaklandır = bizim borcumuz).
    // Döviz tedarikçide fiyatlar tedarikçinin para biriminde girilir → cariye o
    // birimde yazılır (bölme YOK). Stok maliyeti TCMB kuruyla TL'ye çevrilir.
    if (supplierId && total > 0) {
        // Fiyatlar fiş biriminde girildi → cariye o birimde DİREKT yazılır (bölme
        // yok). TL karşılığı bilgi amaçlı saklanır.
        const exchangeRate = recCcy !== 'TRY' ? rate : null;
        const amountTRY = recCcy !== 'TRY' ? totalTRY : total;
        await applyMovement(tx, {
            accountId: supplierId,
            type: 'Alacaklandır',
            amount: total,
            currency: recCcy,
            description: `Mal Alımı (Fiş #${receiptId})${recCcy !== 'TRY' ? ` [${total} ${recCcy} × ${exchangeRate} = ₺${amountTRY}]` : ''}`,
            exchangeRate,
            amountTRY,
            relatedStockReceiptId: receiptId,
            createdBy,
        });
    }

    return { receiptId, total, currency: recCcy, extraTotal: extraTotal > 0 ? extraTotal : 0, webDirty };
}

// ─── Fişi geri al (stok geri çıkış + tedarikçi borcu ters hareket) ───────────
// Satırı SİLMEZ; çağıran sonra DELETE eder (DELETE route) veya yeniden oluşturur
// (PUT route). Verilen tx içinde. Döner: { webDirty, total, accountId }.
async function reverseReceipt(tx, receiptId, createdBy) {
    const head = await tx.request().input('id', sql.Int, receiptId)
        .query(`SELECT ReceiptID, AccountID, TotalAmount, WarehouseID FROM StockReceipts WHERE ReceiptID = @id`);
    if (head.recordset.length === 0) throw new Error('Fiş bulunamadı.');
    const r = head.recordset[0];
    const items = await tx.request().input('id', sql.Int, receiptId)
        .query(`SELECT StockID, Name, Quantity FROM StockReceiptItems WHERE ReceiptID = @id`);

    let webDirty = false;
    // Stok geri çıkışı (giriş yapılan miktar düşülür). Stok satılmış olabilir →
    // allowNegative: iptal bloklanmasın (negatif kalırsa sayımla düzeltilir).
    for (const it of items.recordset) {
        if (!it.StockID) continue;
        const web = await tx.request().input('id', sql.Int, it.StockID)
            .query(`SELECT ShowOnWeb FROM Stocks WHERE StockID = @id`);
        if (web.recordset.length && web.recordset[0].ShowOnWeb) webDirty = true;
        await adjustStock(tx, {
            stockId: it.StockID, stockName: it.Name, direction: 'Cikis', reason: 'Manuel Çıkış',
            quantity: Number(it.Quantity), allowNegative: true, relatedReceiptId: receiptId,
            warehouseId: r.WarehouseID != null ? r.WarehouseID : null,
            note: `Mal Alımı İptal (Fiş #${receiptId})`, createdBy,
        });
    }

    // Tedarikçi borcunu geri al: orijinal Alacaklandır hareketini BİREBİR dengele
    // (aynı tutar + kur + TL karşılığı) → döviz cari doğru geri alınır.
    const total = round2(r.TotalAmount);
    if (r.AccountID) {
        const orig = await tx.request().input('id', sql.Int, receiptId)
            .query(`SELECT TOP 1 Amount, Currency, ExchangeRate, AmountTRY FROM AccountTransactions
                    WHERE RelatedStockReceiptID = @id AND Type = 'Alacaklandır' ORDER BY AccountTransactionID`);
        if (orig.recordset.length) {
            const o = orig.recordset[0];
            await applyMovement(tx, {
                accountId: r.AccountID, type: 'Borçlandır', amount: Number(o.Amount),
                currency: o.Currency || null, // aynı birimde geri al (çok-birimli cari)
                exchangeRate: o.ExchangeRate != null ? Number(o.ExchangeRate) : null,
                amountTRY: o.AmountTRY != null ? Number(o.AmountTRY) : null,
                description: `Mal Alımı İptal (Fiş #${receiptId})`,
                relatedStockReceiptId: receiptId, createdBy,
            });
        }
    }
    return { webDirty, total, accountId: r.AccountID };
}

// ─── Mal Alım Fişi listesi ───────────────────────────────────────────────────
router.get('/', authenticate, adminOnly, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT TOP 200 r.ReceiptID, r.AccountID, r.TotalAmount, r.Currency, r.ExchangeRate, r.Note, r.CreatedBy, r.CreatedAt,
                   a.Name AS AccountName
            FROM StockReceipts r
            LEFT JOIN CurrentAccounts a ON r.AccountID = a.AccountID
            ORDER BY r.CreatedAt DESC
        `);
        res.json(result.recordset);
    } catch (error) {
        console.error('Mal alım listesi hatası:', error);
        res.status(500).json({ error: 'Fişler alınamadı.' });
    }
});

// ─── Mal Alım Fişi detayı (kalemler) ─────────────────────────────────────────
router.get('/:id', authenticate, adminOnly, async (req, res) => {
    try {
        const pool = await poolPromise;
        const head = await pool.request().input('id', sql.Int, req.params.id)
            .query(`
                SELECT r.*, a.Name AS AccountName FROM StockReceipts r
                LEFT JOIN CurrentAccounts a ON r.AccountID = a.AccountID
                WHERE r.ReceiptID = @id`);
        if (head.recordset.length === 0) return res.status(404).json({ error: 'Fiş bulunamadı.' });
        const items = await pool.request().input('id', sql.Int, req.params.id)
            .query(`SELECT * FROM StockReceiptItems WHERE ReceiptID = @id ORDER BY ItemID ASC`);
        res.json({ receipt: head.recordset[0], items: items.recordset });
    } catch (error) {
        console.error('Mal alım detay hatası:', error);
        res.status(500).json({ error: 'Fiş alınamadı.' });
    }
});

// ─── Yeni Mal Alım Fişi ───────────────────────────────────────────────────────
// body: { accountId?, note?, items: [{ stockId? , name?, quantity, unitPurchasePrice, updateSalePrice?, salePrice? }] }
//  - stockId verilirse: mevcut stok kilitlenir, miktar artar, alış fiyatı güncellenir.
//  - stockId yoksa name ile YENİ stok kartı açılır.
//  - accountId (Satıcı) verilirse toplam tutar o carinin kartına 'Alacaklandır'
//    (= bizim borcumuz) olarak işlenir. Hepsi tek ACID transaction içinde.
router.post('/', authenticate, adminOnly, async (req, res) => {
    let parsed;
    try { parsed = parseReceiptBody(req.body); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    try {
        const pool = await poolPromise;
        const transaction = pool.transaction();
        await transaction.begin();
        try {
            const out = await createReceiptCore(transaction, parsed, req.user.fullName);
            await transaction.commit();
            if (out.webDirty) triggerWebSync();
            await logAudit(req, { action: 'stockReceipt.create', entity: 'StockReceipt', entityId: out.receiptId,
                detail: `Mal Alımı #${out.receiptId}: ${fmtMoney(out.total)}${out.extraTotal ? ` (+masraf ${fmtMoney(out.extraTotal)})` : ''}` });
            res.json({ success: true, ...out });
        } catch (error) { await transaction.rollback(); throw error; }
    } catch (error) {
        console.error('Mal alım fişi hatası:', error);
        res.status(400).json({ error: error.message || 'Mal alımı kaydedilemedi.' });
    }
});

// ─── Mal Alım Fişi düzenle (atomik: eskisini geri al + yeniden oluştur) ──────
// Yeni ReceiptID üretilir; ekstrede iptal (Borçlandır) + yeni (Alacaklandır)
// hareketleri görünür (düzeltme izi). Tek ACID transaction.
router.put('/:id', authenticate, adminOnly, async (req, res) => {
    const oldId = parseInt(req.params.id, 10);
    let parsed;
    try { parsed = parseReceiptBody(req.body); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    try {
        const pool = await poolPromise;
        const transaction = pool.transaction();
        await transaction.begin();
        try {
            const rev = await reverseReceipt(transaction, oldId, req.user.fullName);
            await transaction.request().input('id', sql.Int, oldId)
                .query(`DELETE FROM StockReceipts WHERE ReceiptID = @id`); // kalemler CASCADE
            const out = await createReceiptCore(transaction, parsed, req.user.fullName);
            await transaction.commit();
            if (rev.webDirty || out.webDirty) triggerWebSync();
            await logAudit(req, { action: 'stockReceipt.update', entity: 'StockReceipt', entityId: out.receiptId,
                detail: `Mal Alımı düzenlendi: #${oldId} → #${out.receiptId} (${fmtMoney(out.total)})` });
            res.json({ success: true, ...out, replacedId: oldId });
        } catch (error) { await transaction.rollback(); throw error; }
    } catch (error) {
        console.error('Mal alım fişi düzenleme hatası:', error);
        res.status(400).json({ error: error.message || 'Fiş düzenlenemedi.' });
    }
});

// ─── Mal Alım Fişi sil (stok geri çıkış + tedarikçi borcu ters hareket) ──────
// Stok adedi azaltılır, tedarikçi borcu Borçlandır ile dengelenir, fiş silinir.
// Not: stok kartının PurchasePrice'ı (son alış fiyatı) geri alınmaz (tarihsel
// değil, "son" referans fiyat). Tek ACID transaction.
router.delete('/:id', authenticate, adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
        const pool = await poolPromise;
        const transaction = pool.transaction();
        await transaction.begin();
        try {
            const rev = await reverseReceipt(transaction, id, req.user.fullName);
            await transaction.request().input('id', sql.Int, id)
                .query(`DELETE FROM StockReceipts WHERE ReceiptID = @id`); // kalemler CASCADE
            await transaction.commit();
            if (rev.webDirty) triggerWebSync();
            await logAudit(req, { action: 'stockReceipt.delete', entity: 'StockReceipt', entityId: id,
                detail: `Mal Alımı #${id} silindi (stok geri çıkış${rev.total > 0 ? `, ${fmtMoney(rev.total)} borç iptal` : ''})` });
            res.json({ success: true });
        } catch (error) { await transaction.rollback(); throw error; }
    } catch (error) {
        console.error('Mal alım fişi silme hatası:', error);
        res.status(400).json({ error: error.message || 'Fiş silinemedi.' });
    }
});

const fmtMoney = (v) => `₺${(Number(v) || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

module.exports = router;
module.exports.allocateExtraCosts = allocateExtraCosts; // birim test için
