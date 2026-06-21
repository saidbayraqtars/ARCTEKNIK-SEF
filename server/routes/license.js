'use strict';
const express = require('express');
const router = express.Router();
const {
    validateLicense,
    getCachedStatus,
    invalidateCache,
    getHardwareId,
    saveLicense,
    removeStoredLicense,
    verifySignature,
} = require('../services/license');

// GET /api/license/status
// Returns current license status (always accessible, no auth required)
router.get('/status', (req, res) => {
    const status = getCachedStatus();
    const hardwareId = status.hardwareId || getHardwareId();
    // Don't expose internal details in production, only what UI needs
    if (status.valid) {
        return res.json({
            valid: true,
            trial: status.trial || false,
            customerName: status.customerName,
            customerEmail: status.customerEmail,
            hardwareId,
            modules: status.modules || [],
            maxUsers: status.maxUsers ?? null,
            issuedAt: status.issuedAt,
            expiresAt: status.expiresAt,
            daysLeft: status.daysLeft,
        });
    }
    return res.json({
        valid: false,
        trial: status.trial || false,
        reason: status.reason,
        detail: status.detail || null,
        hardwareId,
        customerName: status.customerName || null,
        expiresAt: status.expiresAt || null,
        daysExpired: status.daysExpired || null,
    });
});

// GET /api/license/hardware-id — bu bilgisayarın donanım kimliği (her zaman erişilebilir).
router.get('/hardware-id', (req, res) => {
    res.json({ hardwareId: getHardwareId() });
});

// POST /api/license/activate
// Accepts license file content (JSON string), validates and saves it
router.post('/activate', (req, res) => {
    const { content } = req.body;
    if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'Lisans içeriği gerekli.' });
    }

    // Parse and do a full validation before saving
    let parsed;
    try {
        parsed = JSON.parse(content.trim());
    } catch {
        return res.status(400).json({ error: 'Geçersiz lisans formatı. JSON bekleniyor.' });
    }

    if (!parsed.payload || !parsed.signature) {
        return res.status(400).json({ error: 'Eksik lisans alanları (payload / signature).' });
    }

    const hardwareId = getHardwareId();

    // Yazmadan önce ön doğrulamalar — kullanıcıya net hata mesajı için.
    if (!verifySignature(parsed.payload, parsed.signature)) {
        return res.status(400).json({
            error: 'Lisans imzası geçersiz. Bu lisans bu yazılım için üretilmemiş.',
            reason: 'LICENSE_INVALID',
        });
    }
    // ZORUNLU donanım bağlama: lisans bu bilgisayar için üretilmiş olmalı.
    if (parsed.payload.hardwareId !== hardwareId) {
        return res.status(400).json({
            error: 'Bu lisans bu bilgisayar için üretilmemiş. Lütfen aşağıdaki Donanım Kimliği ile lisansınızı yeniden talep edin.',
            reason: 'LICENSE_HARDWARE_MISMATCH',
            hardwareId,
        });
    }

    // Şifreli + gizli dosyaya yaz, sonra tekrar doğrula.
    try {
        saveLicense(parsed);
    } catch (err) {
        return res.status(500).json({ error: `Lisans kaydedilemedi: ${err.message}` });
    }

    invalidateCache();
    const result = validateLicense();

    if (!result.valid) {
        // Geçersiz lisansı sakla bırakma — eski (lisanssız) duruma dön.
        removeStoredLicense();
        invalidateCache();
        const msgs = {
            LICENSE_INVALID: 'Lisans imzası geçersiz. Bu lisans bu yazılım için üretilmemiş.',
            LICENSE_HARDWARE_MISMATCH: result.detail || 'Bu lisans bu bilgisayar için üretilmemiş.',
            LICENSE_EXPIRED: 'Lisans süresi dolmuş.',
            LICENSE_NOT_YET_VALID: 'Lisans henüz geçerli değil.',
            CLOCK_TAMPERED: result.detail || 'Sistem saati geçersiz.',
        };
        return res.status(400).json({
            error: msgs[result.reason] || 'Lisans doğrulanamadı.',
            reason: result.reason,
            hardwareId,
        });
    }

    return res.json({
        success: true,
        customerName: result.customerName,
        daysLeft: result.daysLeft,
        expiresAt: result.expiresAt,
    });
});

module.exports = router;
