'use strict';
// ─── /api/restoran-webhooks/:provider — dış platform sipariş bildirimi ────────
// AÇIK uç (JWT YOK) — dış servis çağırır, sağlayıcı imzasıyla doğrulanır.
// Faz 3 iskeleti: sağlayıcı etkin değilse 503, imza geçersizse 401, adaptör
// henüz yazılmadıysa 501. API anahtarı gelince normalizeOrder doldurulur.
// NOT: HMAC imza ham gövde (raw body) gerektirebilir → o aşamada raw body capture eklenecek.
const express = require('express');
const integrations = require('../services/restaurantIntegrations');

const router = express.Router();

router.post('/:provider', async (req, res) => {
    const { provider } = req.params;
    if (!integrations.isKnown(provider)) {
        return res.status(404).json({ error: 'unknown provider' });
    }
    try {
        if (!(await integrations.isEnabled(provider))) {
            return res.status(503).json({ error: 'provider not enabled' });
        }
        let cfg = {};
        try { cfg = await integrations.getConfig(provider); } catch { cfg = {}; }
        if (!integrations.verifyWebhook(provider, req, cfg)) {
            return res.status(401).json({ error: 'signature verification failed' });
        }
        // İleride: const order = integrations.normalizeOrder(provider, req.body, cfg); → ACID kaydet.
        integrations.normalizeOrder(provider, req.body, cfg); // şu an NOT_IMPLEMENTED fırlatır
        return res.json({ accepted: true });
    } catch (e) {
        if (e.code === 'NOT_IMPLEMENTED') return res.status(501).json({ error: 'not implemented' });
        return res.status(500).json({ error: 'webhook error' });
    }
});

module.exports = router;
