'use strict';
const sql = require('mssql');
const { normCurrency, isSupported } = require('./fxRates');

// Para birimi normalize: TRY veya desteklenen döviz; geçersiz → TRY.
const normCcy = (c) => { const x = normCurrency(c); return x === 'TRY' || isSupported(x) ? x : 'TRY'; };

// ─── Gelişmiş Cari (Açık Hesap) — paylaşılan ACID yardımcıları ────────────────
// Bu modüldeki fonksiyonlar HER ZAMAN dışarıdan verilen bir mssql transaction
// (tx) içinde çalışır; böylece Kasa (Transactions) ile Cari bakiyesi asla
// uyuşmazlığa düşmez — ya hepsi commit olur ya hepsi rollback.
//
// Balance işareti: carinin BİZE olan net borcu.
//   Balance > 0 → cari bize borçlu (alacağımız)   — ör. müşteri veresiyesi
//   Balance < 0 → biz cariye borçluyuz (borcumuz)  — ör. toptancı mal borcu

const MOVEMENT_TYPES = ['Borçlandır', 'Alacaklandır', 'Tahsilat', 'Ödeme'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Hareketin bakiyeye etkisi (yukarıdaki işaret kuralına göre).
function balanceDelta(type, amount) {
    const a = round2(amount);
    switch (type) {
        case 'Borçlandır': return a;    // cari bize borçlandı
        case 'Ödeme': return a;         // toptancıya ödedik → borcumuz azalır (negatife doğru +)
        case 'Alacaklandır': return -a; // biz cariye borçlandık
        case 'Tahsilat': return -a;     // müşteriden tahsil ettik → alacağımız azalır
        default: throw new Error(`Geçersiz cari hareket tipi: ${type}`);
    }
}

// Bir cari hesaba hareket işler: satırı kilitler, bakiyeyi günceller, ekstreye
// BalanceAfter snapshot'ı ile satır ekler. Verilen tx içinde çağrılmalıdır.
async function applyMovement(tx, opts) {
    const {
        accountId, type, amount, currency = null, // currency: hareket birimi (null → carinin birincil birimi)
        description = null, paymentMethod = null,
        relatedServiceId = null, relatedStockReceiptId = null, relatedCashTxnId = null,
        relatedDocumentId = null,
        exchangeRate = null, amountTRY = null, // döviz cari: kullanılan kur + TL karşılığı
        createdBy = null,
    } = opts;

    if (!MOVEMENT_TYPES.includes(type)) {
        throw new Error(`Geçersiz cari hareket tipi: ${type}`);
    }
    const amt = round2(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
        throw new Error('Cari hareket tutarı pozitif olmalıdır.');
    }

    // Cari kartını kilitle + birincil (kart) birimini oku.
    const cur = await tx.request()
        .input('id', sql.Int, accountId)
        .query(`SELECT AccountID, Currency FROM CurrentAccounts WITH (UPDLOCK, ROWLOCK) WHERE AccountID = @id`);
    if (cur.recordset.length === 0) throw new Error('Cari hesap bulunamadı.');
    const primaryCcy = normCcy(cur.recordset[0].Currency);
    const movCcy = currency ? normCcy(currency) : primaryCcy;

    // Hareket biriminin bakiye satırını garanti et + kilitle (yarış önlenir).
    await tx.request()
        .input('aid', sql.Int, accountId)
        .input('c', sql.NVarChar(5), movCcy)
        .query(`IF NOT EXISTS (SELECT 1 FROM AccountBalances WHERE AccountID = @aid AND Currency = @c)
                INSERT INTO AccountBalances (AccountID, Currency, Balance) VALUES (@aid, @c, 0)`);
    const balRow = await tx.request()
        .input('aid', sql.Int, accountId)
        .input('c', sql.NVarChar(5), movCcy)
        .query(`SELECT Balance FROM AccountBalances WITH (UPDLOCK, ROWLOCK) WHERE AccountID = @aid AND Currency = @c`);
    const before = Number(balRow.recordset[0].Balance) || 0;
    const balanceAfter = round2(before + balanceDelta(type, amt));

    const ins = await tx.request()
        .input('accountId', sql.Int, accountId)
        .input('type', sql.NVarChar(20), type)
        .input('amount', sql.Decimal(12, 2), amt)
        .input('currency', sql.NVarChar(5), movCcy)
        .input('description', sql.NVarChar(500), description ? String(description).slice(0, 500) : null)
        .input('balanceAfter', sql.Decimal(12, 2), balanceAfter)
        .input('paymentMethod', sql.NVarChar(50), paymentMethod)
        .input('relatedServiceId', sql.Int, relatedServiceId)
        .input('relatedStockReceiptId', sql.Int, relatedStockReceiptId)
        .input('relatedCashTxnId', sql.Int, relatedCashTxnId)
        .input('relatedDocumentId', sql.Int, relatedDocumentId)
        .input('exchangeRate', sql.Decimal(18, 6), exchangeRate != null ? exchangeRate : null)
        .input('amountTRY', sql.Decimal(14, 2), amountTRY != null ? round2(amountTRY) : null)
        .input('createdBy', sql.NVarChar(100), createdBy)
        .query(`
            INSERT INTO AccountTransactions
                (AccountID, Type, Amount, Currency, Description, BalanceAfter, PaymentMethod,
                 RelatedServiceID, RelatedStockReceiptID, RelatedCashTxnID, RelatedDocumentID, ExchangeRate, AmountTRY, CreatedBy)
            OUTPUT INSERTED.AccountTransactionID, INSERTED.CreatedAt
            VALUES
                (@accountId, @type, @amount, @currency, @description, @balanceAfter, @paymentMethod,
                 @relatedServiceId, @relatedStockReceiptId, @relatedCashTxnId, @relatedDocumentId, @exchangeRate, @amountTRY, @createdBy)
        `);

    // Birim bakiyesini güncelle (otorite).
    await tx.request()
        .input('aid', sql.Int, accountId)
        .input('c', sql.NVarChar(5), movCcy)
        .input('bal', sql.Decimal(14, 2), balanceAfter)
        .query(`UPDATE AccountBalances SET Balance = @bal, UpdatedAt = GETDATE() WHERE AccountID = @aid AND Currency = @c`);

    // Birincil birim aynası: CurrentAccounts.Balance yalnız kart birimini yansıtır.
    if (movCcy === primaryCcy) {
        await tx.request()
            .input('id', sql.Int, accountId)
            .input('balance', sql.Decimal(12, 2), balanceAfter)
            .query(`UPDATE CurrentAccounts SET Balance = @balance, UpdatedAt = GETDATE() WHERE AccountID = @id`);
    } else {
        await tx.request().input('id', sql.Int, accountId)
            .query(`UPDATE CurrentAccounts SET UpdatedAt = GETDATE() WHERE AccountID = @id`);
    }

    return {
        accountTransactionId: ins.recordset[0].AccountTransactionID,
        at: ins.recordset[0].CreatedAt,
        balanceAfter,
        currency: movCcy,
    };
}

// Bir müşteriye bağlı 'Alıcı' carisini bulur; yoksa oluşturur (lazy). tx içinde.
// Veresiye satışlarında müşteriyi cari sisteme otomatik dahil etmek için.
async function ensureAccountForCustomer(tx, customerId) {
    const cid = parseInt(customerId, 10);
    if (!cid) throw new Error('Geçersiz müşteri.');

    const existing = await tx.request()
        .input('cid', sql.Int, cid)
        .query(`SELECT TOP 1 AccountID FROM CurrentAccounts WHERE CustomerID = @cid ORDER BY AccountID ASC`);
    if (existing.recordset.length > 0) return existing.recordset[0].AccountID;

    const cust = await tx.request()
        .input('cid', sql.Int, cid)
        .query(`SELECT FullName, Phone, TaxOffice, TaxNumber FROM Customers WHERE CustomerID = @cid`);
    if (cust.recordset.length === 0) throw new Error('Müşteri bulunamadı.');
    const c = cust.recordset[0];

    const created = await tx.request()
        .input('name', sql.NVarChar(255), c.FullName)
        .input('phone', sql.NVarChar(50), c.Phone || null)
        .input('taxOffice', sql.NVarChar(150), c.TaxOffice || null)
        .input('taxNumber', sql.NVarChar(50), c.TaxNumber || null)
        .input('cid', sql.Int, cid)
        .query(`
            INSERT INTO CurrentAccounts (Name, Type, Phone, TaxOffice, TaxNumber, CustomerID)
            OUTPUT INSERTED.AccountID
            VALUES (@name, 'Alıcı', @phone, @taxOffice, @taxNumber, @cid)
        `);
    return created.recordset[0].AccountID;
}

module.exports = { applyMovement, ensureAccountForCustomer, balanceDelta, round2, MOVEMENT_TYPES };
