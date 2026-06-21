const express = require('express');
const { authenticate } = require('../middleware/auth');
const { SUPPORTED, ALL_CURRENCIES, RATE_SOURCE, getRates, getRate, normCurrency } = require('../services/fxRates');

const router = express.Router();

// ─── Döviz Kurları (TCMB) ─────────────────────────────────────────────────────
// Arayüz, belge/stok dövizli girilirken o günün TCMB Döviz Alış kurunu buradan
// çeker (canlı gösterim + TL karşılığı önizleme). Backend belge oluştururken kuru
// kendisi de doğrular/çeker; bu uçlar yalnız gösterim içindir.

// GET /api/fx/currencies → desteklenen para birimleri
router.get('/currencies', authenticate, (req, res) => {
    res.json({ currencies: ALL_CURRENCIES, foreign: SUPPORTED, source: RATE_SOURCE });
});

// GET /api/fx/rates?date=YYYY-MM-DD → tüm desteklenen kurlar (gün için)
router.get('/rates', authenticate, async (req, res) => {
    try {
        const data = await getRates(req.query.date);
        if (!data) return res.status(503).json({ error: 'Kur bilgisi alınamadı (internet/önbellek yok).' });
        res.json(data);
    } catch (error) {
        console.error('Kur listesi hatası:', error);
        res.status(500).json({ error: 'Kurlar alınamadı.' });
    }
});

// GET /api/fx/rate?currency=USD&date=YYYY-MM-DD → tek para biriminin TL karşılığı
router.get('/rate', authenticate, async (req, res) => {
    const currency = normCurrency(req.query.currency);
    if (!ALL_CURRENCIES.includes(currency)) {
        return res.status(400).json({ error: 'Desteklenmeyen para birimi.' });
    }
    try {
        const fx = await getRate(currency, req.query.date);
        if (!fx) return res.status(503).json({ error: `${currency} için kur alınamadı. Lütfen elle girin.` });
        res.json({ currency, ...fx });
    } catch (error) {
        console.error('Kur sorgu hatası:', error);
        res.status(500).json({ error: 'Kur alınamadı.' });
    }
});

module.exports = router;
