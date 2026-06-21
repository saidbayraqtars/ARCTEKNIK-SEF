const express = require('express');
const { poolPromise } = require('../config/db');
const { authenticate, adminOnly } = require('../middleware/auth');
const { getCachedStatus } = require('../services/license');
const { syncNow } = require('../services/webSync');
const { listSectors, getSector } = require('../utils/sectorProfiles');
const { seedTemplatesForSector } = require('../utils/templates');
const {
    FEATURE_KEYS, sectorDefaults, parseOverrides, effectiveFeatures, listFeatures,
} = require('../utils/featureProfiles');

const router = express.Router();

// GET /api/settings/sectors — firma tipi listesi (etiket/başlık).
router.get('/sectors', authenticate, (req, res) => {
    res.json({ sectors: listSectors() });
});

// Lisans modüllerini güvenli oku (özellik gating için).
const licenseModules = () => {
    try {
        const s = getCachedStatus();
        return (s && s.valid && Array.isArray(s.modules)) ? s.modules : [];
    } catch { return []; }
};

// Şirketin firma tipi + ham özellik override'ını oku.
const readCompanyFeatureRow = async () => {
    const pool = await poolPromise;
    const r = await pool.request()
        .query(`SELECT TOP 1 CompanyType, FeatureFlags FROM CompanySettings WHERE Id = 1`);
    const row = r.recordset[0] || {};
    return { companyType: getSector(row.CompanyType).id, featureFlags: row.FeatureFlags };
};

// GET /api/settings/features — efektif özellik haritası + katalog + override.
// Menü/route gating için TÜM oturum açmış kullanıcılar erişebilir (yazma admin).
router.get('/features', authenticate, async (req, res) => {
    try {
        const { companyType, featureFlags } = await readCompanyFeatureRow();
        const modules = licenseModules();
        const sec = getSector(companyType);
        res.json({
            companyType,
            // Sektör metadata'sı — istemci formu/stok kartını buna göre uyarlar (araç/parça modu).
            sector: { id: sec.id, label: sec.label, dev: sec.dev, vehicle: !!sec.vehicle, parts: !!sec.parts },
            catalog: listFeatures(modules),
            sectorDefaults: sectorDefaults(companyType),
            overrides: parseOverrides(featureFlags),
            effective: effectiveFeatures(companyType, featureFlags, modules),
        });
    } catch (error) {
        console.error('Özellik bayrakları alınamadı:', error);
        res.status(500).json({ error: 'Özellik ayarları alınamadı.' });
    }
});

// PUT /api/settings/features — özellik override'larını kaydet (yalnız yönetici).
// Gövde: { overrides: { featureKey: bool } }. Bilinmeyen anahtarlar yok sayılır;
// gönderilmeyen anahtar sektör varsayılanına döner (override silinir).
router.put('/features', authenticate, adminOnly, async (req, res) => {
    try {
        const clean = {};
        const incoming = (req.body && typeof req.body.overrides === 'object' && req.body.overrides) ? req.body.overrides : {};
        for (const key of FEATURE_KEYS) {
            if (key in incoming && incoming[key] !== null && incoming[key] !== undefined) {
                clean[key] = incoming[key] === true || incoming[key] === 1 || incoming[key] === '1';
            }
        }
        const json = Object.keys(clean).length ? JSON.stringify(clean) : null;
        const pool = await poolPromise;
        await pool.request()
            .input('flags', json)
            .query(`
                MERGE CompanySettings AS target
                USING (SELECT 1 AS Id) AS src ON target.Id = src.Id
                WHEN MATCHED THEN UPDATE SET FeatureFlags = @flags, UpdatedAt = GETDATE()
                WHEN NOT MATCHED THEN INSERT (Id, FeatureFlags) VALUES (1, @flags);
            `);
        const { companyType } = await readCompanyFeatureRow();
        res.json({
            success: true,
            overrides: clean,
            effective: effectiveFeatures(companyType, json, licenseModules()),
        });
    } catch (error) {
        console.error('Özellik bayrakları kaydedilemedi:', error);
        res.status(500).json({ error: 'Özellik ayarları kaydedilemedi.' });
    }
});

// B2B Web modülü lisansta aktif mi? (Köprü ayarları yalnızca o zaman yazılabilir.)
const hasB2BModule = () => {
    try {
        const s = getCachedStatus();
        return s.valid && Array.isArray(s.modules) && s.modules.includes('B2B');
    } catch { return false; }
};

const DEFAULTS = {
    Id: 1,
    CompanyName: '',
    LogoUrl: '',
    Phone: '',
    Address: '',
    Email: '',
    Website: '',
    LegalTerms: '',
};

// GET /api/settings — fiş yazdırma için herhangi bir oturum açmış kullanıcı erişebilir.
// Hassas B2B lisans anahtarı bu genel uç noktada DÖNDÜRÜLMEZ.
router.get('/', authenticate, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .query(`SELECT TOP 1 * FROM CompanySettings WHERE Id = 1`);
        const row = result.recordset[0] || DEFAULTS;
        delete row.B2BLicenseKey;
        delete row.B2BApiEndpoint;
        res.json(row);
    } catch (error) {
        console.error('Ayarlar alınamadı:', error);
        res.status(500).json({ error: 'Ayarlar alınamadı.' });
    }
});

// ─── B2B Web Entegrasyonu (yalnızca yönetici) ───────────────────────────────

// GET /api/settings/b2b — köprü ayarlarını ve modül durumunu döner.
router.get('/b2b', authenticate, adminOnly, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .query(`SELECT TOP 1 B2BApiEndpoint, B2BLicenseKey FROM CompanySettings WHERE Id = 1`);
        const row = result.recordset[0] || {};
        res.json({
            moduleActive: hasB2BModule(),
            b2bApiEndpoint: row.B2BApiEndpoint || '',
            b2bLicenseKey: row.B2BLicenseKey || '',
        });
    } catch (error) {
        console.error('B2B ayarları alınamadı:', error);
        res.status(500).json({ error: 'B2B ayarları alınamadı.' });
    }
});

// PUT /api/settings/b2b — köprü ayarlarını kaydeder (modül gerektirir).
router.put('/b2b', authenticate, adminOnly, async (req, res) => {
    if (!hasB2BModule()) {
        return res.status(403).json({ error: 'B2B Web modülü lisansınızda aktif değil.' });
    }
    const { b2bApiEndpoint, b2bLicenseKey } = req.body;
    try {
        const pool = await poolPromise;
        await pool.request()
            .input('endpoint', b2bApiEndpoint ?? null)
            .input('key', b2bLicenseKey ?? null)
            .query(`
                MERGE CompanySettings AS target
                USING (SELECT 1 AS Id) AS src ON target.Id = src.Id
                WHEN MATCHED THEN
                    UPDATE SET B2BApiEndpoint = @endpoint, B2BLicenseKey = @key, UpdatedAt = GETDATE()
                WHEN NOT MATCHED THEN
                    INSERT (Id, B2BApiEndpoint, B2BLicenseKey) VALUES (1, @endpoint, @key);
            `);
        res.json({ success: true, message: 'B2B ayarları kaydedildi.' });
    } catch (error) {
        console.error('B2B ayarları kaydedilemedi:', error);
        res.status(500).json({ error: 'B2B ayarları kaydedilemedi.' });
    }
});

// POST /api/settings/b2b/sync — test amaçlı anında senkronizasyon.
router.post('/b2b/sync', authenticate, adminOnly, async (req, res) => {
    if (!hasB2BModule()) {
        return res.status(403).json({ error: 'B2B Web modülü lisansınızda aktif değil.' });
    }
    const result = await syncNow();
    if (result.ok) {
        return res.json({ success: true, count: result.count, message: `${result.count} ürün senkronize edildi.` });
    }
    res.status(400).json({ success: false, error: result.error || 'Senkronizasyon başarısız.' });
});

// PUT /api/settings — sadece yönetici güncelleyebilir. Tek satır (Id=1) upsert edilir.
router.put('/', authenticate, adminOnly, async (req, res) => {
    const { companyName, logoUrl, phone, address, email, website, legalTerms, taxOffice, taxNumber, iban, companyType } = req.body;
    // companyType verilirse geçerli sektöre normalize et; verilmezse mevcut korunur.
    const normalizedType = companyType != null ? getSector(companyType).id : null;
    try {
        const pool = await poolPromise;
        await pool.request()
            .input('companyName', companyName ?? null)
            .input('logoUrl', logoUrl ?? null)
            .input('phone', phone ?? null)
            .input('address', address ?? null)
            .input('email', email ?? null)
            .input('website', website ?? null)
            .input('legalTerms', legalTerms ?? null)
            .input('taxOffice', taxOffice ?? null)
            .input('taxNumber', taxNumber ?? null)
            .input('iban', iban ?? null)
            .input('companyType', normalizedType)
            .query(`
                MERGE CompanySettings AS target
                USING (SELECT 1 AS Id) AS src ON target.Id = src.Id
                WHEN MATCHED THEN
                    UPDATE SET CompanyName = @companyName, LogoUrl = @logoUrl, Phone = @phone,
                               Address = @address, Email = @email, Website = @website,
                               LegalTerms = @legalTerms, TaxOffice = @taxOffice,
                               TaxNumber = @taxNumber, IBAN = @iban,
                               CompanyType = COALESCE(@companyType, CompanyType), UpdatedAt = GETDATE()
                WHEN NOT MATCHED THEN
                    INSERT (Id, CompanyName, LogoUrl, Phone, Address, Email, Website, LegalTerms, TaxOffice, TaxNumber, IBAN, CompanyType)
                    VALUES (1, @companyName, @logoUrl, @phone, @address, @email, @website, @legalTerms, @taxOffice, @taxNumber, @iban, COALESCE(@companyType, 'teknik_servis'));
            `);
        res.json({ success: true, message: 'Ayarlar kaydedildi.' });
    } catch (error) {
        console.error('Ayarlar kaydedilemedi:', error);
        res.status(500).json({ error: 'Ayarlar kaydedilemedi.' });
    }
});

// POST /api/settings/company-type — firma tipini değiştir + isteğe bağlı olarak
// o sektörün hazır mesajlarını ZORLA yeniden tohumla (mevcut düzenlemelerin
// üzerine yazar). reseed=false ise yalnız tip değişir, metinler korunur.
router.post('/company-type', authenticate, adminOnly, async (req, res) => {
    const sectorId = getSector(req.body?.companyType).id;
    const reseed = req.body?.reseed === true;
    try {
        const pool = await poolPromise;
        await pool.request()
            .input('companyType', sectorId)
            .query(`
                MERGE CompanySettings AS target
                USING (SELECT 1 AS Id) AS src ON target.Id = src.Id
                WHEN MATCHED THEN UPDATE SET CompanyType = @companyType, UpdatedAt = GETDATE()
                WHEN NOT MATCHED THEN INSERT (Id, CompanyType) VALUES (1, @companyType);
            `);
        if (reseed) seedTemplatesForSector(sectorId, true);
        res.json({ success: true, companyType: sectorId, reseeded: reseed });
    } catch (error) {
        console.error('Firma tipi güncellenemedi:', error);
        res.status(500).json({ error: 'Firma tipi güncellenemedi.' });
    }
});

module.exports = router;
