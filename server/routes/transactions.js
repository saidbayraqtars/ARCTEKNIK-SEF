const express = require('express');
const { poolPromise } = require('../config/db');
const { authenticate, adminOnly } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticate, adminOnly, async (req, res) => {
    const { month, year } = req.query;

    try {
        const pool = await poolPromise;
        let query = `SELECT * FROM Transactions WHERE 1=1`;
        const request = pool.request();

        if (month && year) {
            query += ` AND MONTH(CreatedAt) = @month AND YEAR(CreatedAt) = @year`;
            request.input('month', parseInt(month, 10));
            request.input('year', parseInt(year, 10));
        }

        query += ` ORDER BY CreatedAt DESC`;

        const result = await request.query(query);
        res.json(result.recordset);
    } catch (error) {
        console.error('Kasa işlemleri hatası:', error);
        res.status(500).json({ error: 'Kayıtlar alınamadı' });
    }
});

router.post('/', authenticate, adminOnly, async (req, res) => {
    const { amount, type, description, method, serviceId } = req.body;
    if (!amount || !type) {
        return res.status(400).json({ error: 'Tutar ve Tip zorunludur.' });
    }
    if (!['Gelir', 'Gider'].includes(type)) {
        return res.status(400).json({ error: 'Geçersiz işlem tipi.' });
    }
    // Tutar pozitif, sonlu bir sayı olmalı (negatif/metin ile kasa bozulmasın).
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ error: 'Geçerli (pozitif) bir tutar giriniz.' });
    }
    const svcId = serviceId ? parseInt(serviceId, 10) : null;
    if (serviceId && Number.isNaN(svcId)) {
        return res.status(400).json({ error: 'Geçersiz servis numarası.' });
    }

    try {
        const pool = await poolPromise;
        await pool.request()
            .input('amount', amt)
            .input('type', type)
            .input('description', description || null)
            .input('method', method || 'Nakit')
            .input('serviceId', svcId)
            .query(`
                INSERT INTO Transactions (Amount, Type, Description, PaymentMethod, ServiceID)
                VALUES (@amount, @type, @description, @method, @serviceId)
            `);
        res.json({ success: true });
    } catch (error) {
        console.error('Manuel işlem hatası:', error);
        res.status(500).json({ error: 'İşlem eklenemedi' });
    }
});

// GET /api/transactions/daily-summary?date=YYYY-MM-DD — Gün Sonu (Z Raporu).
// Seçili günün kasasını ödeme yöntemine + gelir kaynağına göre döker ve nakit
// mutabakatı için "kasada olması gereken nakit"i hesaplar. Salt-okunur.
router.get('/daily-summary', authenticate, adminOnly, async (req, res) => {
    const { date } = req.query;
    // Geçerli ISO tarih (YYYY-MM-DD) yoksa bugün — SQL'e ham string GİTMEZ, parametre.
    const day = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : new Date().toISOString().slice(0, 10);

    try {
        const pool = await poolPromise;

        const [methodRes, sourceRes] = await Promise.all([
            pool.request().input('day', day).query(`
                SELECT ISNULL(PaymentMethod, 'Nakit') AS Method, Type,
                       COUNT(*) AS Cnt, SUM(Amount) AS Total
                FROM Transactions
                WHERE CAST(CreatedAt AS DATE) = @day
                GROUP BY ISNULL(PaymentMethod, 'Nakit'), Type
            `),
            pool.request().input('day', day).query(`
                SELECT
                    ISNULL(SUM(CASE WHEN Type='Gelir' AND ServiceID IS NULL AND DocumentID IS NULL THEN Amount ELSE 0 END), 0) AS PosRevenue,
                    ISNULL(SUM(CASE WHEN Type='Gelir' AND ServiceID IS NOT NULL THEN Amount ELSE 0 END), 0) AS ServiceRevenue,
                    ISNULL(SUM(CASE WHEN Type='Gelir' AND DocumentID IS NOT NULL THEN Amount ELSE 0 END), 0) AS DocumentRevenue
                FROM Transactions
                WHERE CAST(CreatedAt AS DATE) = @day
            `),
        ]);

        const methods = {};
        let income = 0, expense = 0, count = 0, cashIncome = 0, cashExpense = 0;
        for (const r of methodRes.recordset) {
            const m = r.Method;
            const total = Number(r.Total) || 0;
            methods[m] = methods[m] || { method: m, income: 0, expense: 0, count: 0 };
            if (r.Type === 'Gelir') { methods[m].income += total; income += total; }
            else { methods[m].expense += total; expense += total; }
            methods[m].count += Number(r.Cnt) || 0;
            count += Number(r.Cnt) || 0;
            if (m === 'Nakit') { if (r.Type === 'Gelir') cashIncome += total; else cashExpense += total; }
        }

        const src = sourceRes.recordset[0];
        res.json({
            date: day,
            byMethod: Object.values(methods).map((x) => ({ ...x, net: x.income - x.expense })),
            totals: { income, expense, net: income - expense, count },
            bySource: {
                pos: Number(src.PosRevenue) || 0,
                service: Number(src.ServiceRevenue) || 0,
                document: Number(src.DocumentRevenue) || 0,
            },
            cashExpected: cashIncome - cashExpense, // gün sonu kasada olması gereken nakit
        });
    } catch (error) {
        console.error('Gün sonu (Z) raporu hatası:', error);
        res.status(500).json({ error: 'Gün sonu raporu alınamadı' });
    }
});

router.delete('/:id', authenticate, adminOnly, async (req, res) => {
    const { id } = req.params;

    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('id', id)
            .query(`DELETE FROM Transactions WHERE TransactionID = @id`);

        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({ error: 'İşlem bulunamadı.' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('İşlem silme hatası:', error);
        res.status(500).json({ error: 'İşlem silinemedi' });
    }
});

module.exports = router;
