'use strict';
// ─── /api/maintenance — bakım uçları (yalnız yönetici) ───────────────────────
// Otomatik yedekleme durumu/ayarı/elle tetikleme. Hem Suite hem Şef'te mount
// edilir (paylaşılan altyapı). İstemci modunda durum 'clientMode' döner.

const express = require('express');
const { authenticate, adminOnly } = require('../middleware/auth');
const { runBackupNow, getBackupStatus, updateBackupConfig } = require('../services/autoBackup');

const router = express.Router();
router.use(authenticate);
router.use(adminOnly);

// Durum: ayarlar + son yedek zamanı (msdb gerçeği) + son çalışma sonucu.
router.get('/backup', async (req, res) => {
    try {
        res.json(await getBackupStatus());
    } catch (e) {
        res.status(500).json({ error: 'Yedekleme durumu okunamadı.' });
    }
});

// Ayar güncelle: { enabled, hour, minute, keep, dir }
router.put('/backup', async (req, res) => {
    try {
        const cfg = updateBackupConfig(req.body || {});
        res.json({ success: true, config: cfg });
    } catch (e) {
        res.status(500).json({ error: 'Yedekleme ayarı kaydedilemedi.' });
    }
});

// Şimdi yedek al (elle). Sonuç: { ok, file?, dir?, error? }
router.post('/backup/run', async (req, res) => {
    try {
        const result = await runBackupNow();
        if (result.ok) res.json(result);
        else res.status(400).json(result);
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message || 'Yedek alınamadı.' });
    }
});

module.exports = router;
