'use strict';
const { getCachedStatus } = require('../services/license');

// Otomatik test kaçışı: YALNIZCA üretim dışı (NODE_ENV !== 'production') ve açık
// istek (ARC_TEST_BYPASS_LICENSE=1) ile. Paketli masaüstü her zaman
// NODE_ENV=production ayarlar (main.js) → müşteri ortamında bu yol ölüdür.
const testBypass = () =>
    process.env.ARC_TEST_BYPASS_LICENSE === '1' && process.env.NODE_ENV !== 'production';

function licenseGuard(req, res, next) {
    if (testBypass()) return next();
    const status = getCachedStatus();
    if (status.valid) return next();

    return res.status(403).json({
        error: 'LICENSE_REQUIRED',
        reason: status.reason,
        detail: status.detail || null,
        customerName: status.customerName || null,
        expiresAt: status.expiresAt || null,
        daysExpired: status.daysExpired || null,
    });
}

// Modül kapısı: geçerli lisans + payload.modules içinde `moduleName` ŞART.
// UI gizlese bile API'yi kapatır (kurcalamaya karşı savunma; ticari modül kilidi).
// Offline anında: /license/activate invalidateCache çağırır → getCachedStatus tazelenir.
function requireModule(moduleName) {
    return function (req, res, next) {
        if (testBypass()) return next();
        const status = getCachedStatus();
        if (!status.valid) {
            return res.status(403).json({
                error: 'LICENSE_REQUIRED',
                reason: status.reason,
                detail: status.detail || null,
            });
        }
        const modules = Array.isArray(status.modules) ? status.modules : [];
        if (!modules.includes(moduleName)) {
            return res.status(403).json({
                error: 'MODULE_NOT_LICENSED',
                module: moduleName,
                detail: `Bu modül lisansınızda tanımlı değil: ${moduleName}.`,
            });
        }
        return next();
    };
}

module.exports = { licenseGuard, requireModule };
