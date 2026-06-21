const express = require('express');
const sql = require('mssql');
const { poolPromise } = require('../config/db');
const { authenticate, adminOnly } = require('../middleware/auth');
const { adjustStock, GIRIS_REASONS, CIKIS_REASONS } = require('../services/stockLedger');

const router = express.Router();

// ─── Hareket defteri (filtre: ?stockId, ?direction, ?reason, ?search, ?from, ?to) ─
router.get('/', authenticate, adminOnly, async (req, res) => {
    const { stockId, direction, reason, search, from, to } = req.query;
    try {
        const pool = await poolPromise;
        const request = pool.request();
        let q = `
            SELECT TOP 500 m.MovementID, m.StockID, m.StockName, m.Direction, m.Reason,
                   m.Quantity, m.QuantityAfter, m.UnitPrice, m.RelatedDocumentID, m.RelatedReceiptID,
                   m.RelatedServiceID, m.Note, m.CreatedBy, m.CreatedAt,
                   s.Name AS CurrentName
            FROM StockMovements m
            LEFT JOIN Stocks s ON m.StockID = s.StockID
            WHERE 1=1`;
        if (stockId) { q += ` AND m.StockID = @stockId`; request.input('stockId', sql.Int, parseInt(stockId, 10)); }
        if (direction) { q += ` AND m.Direction = @direction`; request.input('direction', sql.NVarChar(10), direction); }
        if (reason) { q += ` AND m.Reason = @reason`; request.input('reason', sql.NVarChar(30), reason); }
        if (search) { q += ` AND (m.StockName LIKE @s OR m.Note LIKE @s)`; request.input('s', sql.NVarChar(255), `%${search}%`); }
        if (from) { q += ` AND m.CreatedAt >= @from`; request.input('from', sql.DateTime, new Date(from)); }
        if (to) { q += ` AND m.CreatedAt < @to`; request.input('to', sql.DateTime, new Date(to)); }
        q += ` ORDER BY m.CreatedAt DESC, m.MovementID DESC`;
        const result = await request.query(q);
        res.json(result.recordset);
    } catch (error) {
        console.error('Stok hareket listesi hatası:', error);
        res.status(500).json({ error: 'Hareketler alınamadı.' });
    }
});

// ─── Manuel stok giriş/çıkış (sayım, fire, iade, düzeltme) ───────────────────
// body: { stockId, direction: 'Giris'|'Cikis', quantity, reason, unitPrice?, note? }
router.post('/', authenticate, adminOnly, async (req, res) => {
    const { stockId, direction, quantity, reason, unitPrice, note, warehouseId } = req.body;
    const sid = parseInt(stockId, 10);
    const whId = Number(warehouseId) > 0 ? Number(warehouseId) : null;
    const qty = Number(quantity);
    if (!sid) return res.status(400).json({ error: 'Ürün seçiniz.' });
    if (direction !== 'Giris' && direction !== 'Cikis') return res.status(400).json({ error: 'Geçersiz yön.' });
    if (!(qty > 0)) return res.status(400).json({ error: 'Miktar pozitif olmalı.' });
    const validReasons = direction === 'Giris' ? GIRIS_REASONS : CIKIS_REASONS;
    const reasonVal = validReasons.includes(reason) ? reason : (direction === 'Giris' ? 'Manuel Giriş' : 'Manuel Çıkış');

    try {
        const pool = await poolPromise;
        const transaction = pool.transaction();
        await transaction.begin();
        try {
            const r = await adjustStock(transaction, {
                stockId: sid,
                direction,
                quantity: qty,
                reason: reasonVal,
                unitPrice: unitPrice != null && unitPrice !== '' ? Number(unitPrice) : null,
                warehouseId: whId,
                note: note || null,
                createdBy: req.user.fullName,
            });
            await transaction.commit();
            res.json({ success: true, quantityAfter: r.quantityAfter });
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    } catch (error) {
        console.error('Manuel stok hareketi hatası:', error);
        res.status(400).json({ error: error.message || 'Hareket kaydedilemedi.' });
    }
});

module.exports = router;
