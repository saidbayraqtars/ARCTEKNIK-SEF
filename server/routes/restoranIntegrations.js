'use strict';
// ─── /api/restoran/integrations — online sipariş sağlayıcı yapılandırması ─────
// Yalnızca yönetici. Gizli kimlikler şifreli saklanır, API'de maskelenir (Faz 3).
const express = require('express');
const { authenticate, adminOnly } = require('../middleware/auth');
const integrations = require('../services/restaurantIntegrations');

const router = express.Router();
router.use(authenticate);
router.use(adminOnly);

// Tüm sağlayıcıların durumu (enabled/configured + maskeli değerler).
router.get('/', async (req, res) => {
    try {
        res.json(await integrations.getStatus());
    } catch (e) {
        res.status(500).json({ error: 'Entegrasyon durumu okunamadı.' });
    }
});

// Bir sağlayıcıyı kaydet/güncelle. Body: { enabled, config:{...} }.
router.put('/:provider', async (req, res) => {
    const { provider } = req.params;
    if (!integrations.isKnown(provider)) {
        return res.status(404).json({ error: 'Bilinmeyen sağlayıcı.' });
    }
    try {
        const { enabled, config } = req.body || {};
        const status = await integrations.saveConfig(provider, { enabled: !!enabled, config: config || {} });
        res.json(status);
    } catch (e) {
        res.status(400).json({ error: e.message || 'Kaydedilemedi.' });
    }
});

module.exports = router;
