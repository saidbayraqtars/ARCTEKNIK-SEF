'use strict';
const sql = require('mssql');

// ─── Stok Hareket Defteri — paylaşılan ACID yardımcıları ──────────────────────
// Her stok giriş/çıkışı StockMovements tablosuna loglanır; böylece bir ürünün
// neden/ne zaman/kim tarafından arttığı-azaldığı tam izlenebilir.
// Fonksiyonlar HER ZAMAN dışarıdan verilen bir mssql transaction (tx) içinde
// çalışır → stok adedi ile hareket defteri asla uyuşmazlığa düşmez.

const GIRIS_REASONS = ['Mal Alımı', 'İade', 'Sayım Fazlası', 'Manuel Giriş'];
const CIKIS_REASONS = ['Satış', 'Fatura', 'İrsaliye', 'Servis', 'Fire', 'Sayım Eksiği', 'Manuel Çıkış'];

const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

// Tek bir hareket satırı ekler (stok adedini DEĞİŞTİRMEZ; sadece loglar).
// Stok adedini de değiştirmek için adjustStock kullanın.
async function logMovement(tx, opts) {
    const {
        stockId = null, stockName = null, direction, reason,
        quantity, quantityAfter = null, unitPrice = null,
        relatedDocumentId = null, relatedReceiptId = null, relatedServiceId = null,
        warehouseId = null, note = null, createdBy = null,
    } = opts;

    if (direction !== 'Giris' && direction !== 'Cikis') {
        throw new Error(`Geçersiz stok hareket yönü: ${direction}`);
    }
    const qty = round3(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error('Stok hareket miktarı pozitif olmalıdır.');
    }

    await tx.request()
        .input('stockId', sql.Int, stockId)
        .input('stockName', sql.NVarChar(255), stockName ? String(stockName).slice(0, 255) : null)
        .input('direction', sql.NVarChar(10), direction)
        .input('reason', sql.NVarChar(30), reason)
        .input('quantity', sql.Decimal(18, 3), qty)
        .input('quantityAfter', sql.Decimal(18, 3), quantityAfter)
        .input('unitPrice', sql.Decimal(14, 2), unitPrice)
        .input('relatedDocumentId', sql.Int, relatedDocumentId)
        .input('relatedReceiptId', sql.Int, relatedReceiptId)
        .input('relatedServiceId', sql.Int, relatedServiceId)
        .input('warehouseId', sql.Int, warehouseId != null ? Number(warehouseId) : null)
        .input('note', sql.NVarChar(500), note ? String(note).slice(0, 500) : null)
        .input('createdBy', sql.NVarChar(100), createdBy)
        .query(`
            INSERT INTO StockMovements
                (StockID, StockName, Direction, Reason, Quantity, QuantityAfter, UnitPrice,
                 RelatedDocumentID, RelatedReceiptID, RelatedServiceID, WarehouseID, Note, CreatedBy)
            VALUES
                (@stockId, @stockName, @direction, @reason, @quantity, @quantityAfter, @unitPrice,
                 @relatedDocumentId, @relatedReceiptId, @relatedServiceId, @warehouseId, @note, @createdBy)
        `);
}

// ─── Çoklu depo yardımcıları ─────────────────────────────────────────────────
// Varsayılan depo TÜRETİLİR (Toplam − Σ diğer depolar); StockBalances yalnız
// varsayılan-OLMAYAN depo satırlarını tutar. Bu sayede adjustStock'u bypass eden
// akışlar (ör. servis parça) otomatik varsayılan depoya akar; sapma olmaz.
async function getDefaultWarehouseId(tx) {
    const r = await tx.request().query(`SELECT TOP 1 WarehouseID FROM Warehouses WHERE IsDefault = 1 ORDER BY WarehouseID`);
    return r.recordset.length ? r.recordset[0].WarehouseID : null;
}

// Belirli bir stoğun bir depodaki mevcut adedi (varsayılan depo türetilir).
async function warehouseAvailable(tx, stockId, warehouseId, defWh, total) {
    if (defWh != null && Number(warehouseId) === Number(defWh)) {
        const oth = await tx.request().input('sid', sql.Int, stockId)
            .query(`SELECT ISNULL(SUM(Quantity), 0) AS Q FROM StockBalances WHERE StockID = @sid`);
        return round3(Number(total) - Number(oth.recordset[0].Q || 0));
    }
    const r = await tx.request().input('sid', sql.Int, stockId).input('wid', sql.Int, warehouseId)
        .query(`SELECT Quantity FROM StockBalances WHERE StockID = @sid AND WarehouseID = @wid`);
    return r.recordset.length ? round3(Number(r.recordset[0].Quantity) || 0) : 0;
}

// Bir depo satırına delta uygular (yalnız varsayılan-olmayan depo için anlamlı).
async function applyBalance(tx, stockId, warehouseId, delta) {
    await tx.request()
        .input('sid', sql.Int, stockId)
        .input('wid', sql.Int, warehouseId)
        .input('d', sql.Decimal(18, 3), round3(delta))
        .query(`
            MERGE StockBalances AS t
            USING (SELECT @sid AS StockID, @wid AS WarehouseID) AS s
            ON t.StockID = s.StockID AND t.WarehouseID = s.WarehouseID
            WHEN MATCHED THEN UPDATE SET Quantity = t.Quantity + @d, UpdatedAt = GETDATE()
            WHEN NOT MATCHED THEN INSERT (StockID, WarehouseID, Quantity) VALUES (@sid, @wid, @d);
        `);
}

// Bir stok kartının adedini değiştirir (kilitler), sonra hareketi loglar.
// delta yönü 'direction' ile belirlenir: Giris → +qty, Cikis → -qty.
// allowNegative=false ise çıkışta yetersiz stok hatası verir.
// Stok kartı yoksa (stockId null) sadece loglar (serbest metin kalemi gibi).
async function adjustStock(tx, opts) {
    const { stockId, direction, quantity, allowNegative = false } = opts;
    const qty = round3(quantity);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('Geçersiz miktar.');

    if (!stockId) {
        // Stok kartına bağlı değil → adet değişmez, yalnızca defter kaydı.
        await logMovement(tx, { ...opts, quantityAfter: null });
        return { quantityAfter: null, stockName: opts.stockName || null };
    }

    const cur = await tx.request()
        .input('id', sql.Int, stockId)
        .query(`SELECT StockID, Name, Quantity FROM Stocks WITH (UPDLOCK, ROWLOCK) WHERE StockID = @id`);
    if (cur.recordset.length === 0) throw new Error(`Ürün bulunamadı (ID: ${stockId}).`);

    const name = cur.recordset[0].Name;
    const before = Number(cur.recordset[0].Quantity) || 0;
    const signed = direction === 'Giris' ? qty : -qty;
    const after = before + signed;

    if (direction === 'Cikis' && !allowNegative && after < 0) {
        throw new Error(`Yetersiz stok: ${name} (mevcut ${before}, istenen ${qty}).`);
    }

    // Çoklu depo: belirli bir depo verildiyse o deponun adedi de güncellenir.
    // Varsayılan depo türetilir → satır tutulmaz; yalnız varsayılan-OLMAYAN depo
    // için StockBalances'a delta uygulanır (çıkışta depo yeterlilik kontrolü).
    const whId = opts.warehouseId != null ? Number(opts.warehouseId) : null;
    let defWh = null;
    if (whId != null) {
        defWh = await getDefaultWarehouseId(tx);
        if (defWh != null && whId !== defWh && direction === 'Cikis' && !allowNegative) {
            const avail = await warehouseAvailable(tx, stockId, whId, defWh, before);
            if (avail < qty) throw new Error(`Yetersiz depo stoğu: ${name} (depoda ${avail}, istenen ${qty}).`);
        }
    }

    // Stocks.Quantity DECIMAL(18,3); küsurat KORUNUR (kg/metre/litre). Kayan
    // nokta artıklarını engellemek için 3 haneye normalize edilir.
    const afterQty = round3(after);
    await tx.request()
        .input('id', sql.Int, stockId)
        .input('q', sql.Decimal(18, 3), afterQty)
        .query(`UPDATE Stocks SET Quantity = @q, UpdatedAt = GETDATE() WHERE StockID = @id`);

    if (whId != null && defWh != null && whId !== defWh) {
        await applyBalance(tx, stockId, whId, signed);
    }

    await logMovement(tx, { ...opts, stockName: opts.stockName || name, quantityAfter: afterQty });
    return { quantityAfter: afterQty, stockName: name };
}

// Depolar arası transfer: TOPLAM adet değişmez (Stocks.Quantity yazılmaz), yalnız
// depo dağılımı değişir. Varsayılan depodan/ya çıkış/giriş türetilir (yalnız
// varsayılan-olmayan tarafa StockBalances delta uygulanır). İki hareket loglanır.
async function transferStock(tx, opts) {
    const { stockId, fromWarehouseId, toWarehouseId, quantity, note = null, createdBy = null } = opts;
    const qty = round3(quantity);
    const fromId = Number(fromWarehouseId);
    const toId = Number(toWarehouseId);
    if (!stockId) throw new Error('Transfer için ürün gerekli.');
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('Geçersiz miktar.');
    if (!fromId || !toId || fromId === toId) throw new Error('Farklı kaynak ve hedef depo seçin.');

    const defWh = await getDefaultWarehouseId(tx);
    const cur = await tx.request().input('id', sql.Int, stockId)
        .query(`SELECT Name, Quantity FROM Stocks WITH (UPDLOCK, ROWLOCK) WHERE StockID = @id`);
    if (cur.recordset.length === 0) throw new Error(`Ürün bulunamadı (ID: ${stockId}).`);
    const name = cur.recordset[0].Name;
    const total = round3(Number(cur.recordset[0].Quantity) || 0);

    const avail = await warehouseAvailable(tx, stockId, fromId, defWh, total);
    if (avail < qty) throw new Error(`Yetersiz depo stoğu: ${name} (kaynak depoda ${avail}, istenen ${qty}).`);

    // Varsayılan tarafa dokunma (türetilir); yalnız varsayılan-olmayan tarafa uygula.
    if (defWh == null || fromId !== defWh) await applyBalance(tx, stockId, fromId, -qty);
    if (defWh == null || toId !== defWh) await applyBalance(tx, stockId, toId, +qty);

    await logMovement(tx, { stockId, stockName: name, direction: 'Cikis', reason: 'Transfer', quantity: qty, quantityAfter: total, warehouseId: fromId, note, createdBy });
    await logMovement(tx, { stockId, stockName: name, direction: 'Giris', reason: 'Transfer', quantity: qty, quantityAfter: total, warehouseId: toId, note, createdBy });
    return { ok: true, stockName: name };
}

module.exports = {
    logMovement, adjustStock, transferStock,
    getDefaultWarehouseId, warehouseAvailable, applyBalance,
    round3, GIRIS_REASONS, CIKIS_REASONS,
};
