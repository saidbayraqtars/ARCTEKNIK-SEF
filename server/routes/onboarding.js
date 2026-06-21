'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { poolPromise } = require('../config/db');
const { getJwtSecret } = require('../middleware/auth');
const { listSectors, getSector } = require('../utils/sectorProfiles');
const { seedTemplatesForSector } = require('../utils/templates');

const router = express.Router();

// GET /api/onboarding/sectors — kurulum sihirbazı firma tipi listesi (oturumsuz).
router.get('/sectors', (req, res) => {
    res.json({ sectors: listSectors() });
});

// İlk kurulum gerekiyor mu? — Veritabanında hiç Admin kullanıcısı yoksa true.
async function isOnboardingNeeded(pool) {
    const result = await pool.request()
        .query(`SELECT TOP 1 UserID FROM Users WHERE Role = 'Admin'`);
    return result.recordset.length === 0;
}

// GET /api/onboarding/status — oturum gerektirmez (henüz kullanıcı yok).
router.get('/status', async (req, res) => {
    try {
        const pool = await poolPromise;
        const needed = await isOnboardingNeeded(pool);
        res.json({ needed });
    } catch (error) {
        console.error('Onboarding durum hatası:', error);
        // DB'ye ulaşılamıyorsa kurulumu zorlama — normal akışa izin ver.
        res.json({ needed: false });
    }
});

// POST /api/onboarding/complete — firma bilgisi + ilk yönetici hesabını oluşturur,
// otomatik giriş için token döner. Yalnızca hiç admin yokken çalışır.
router.post('/complete', async (req, res) => {
    const company = req.body?.company || {};
    const admin = req.body?.admin || {};

    const companyName = (company.companyName || '').trim();
    const taxOffice = (company.taxOffice || '').trim();
    const phone = (company.phone || '').trim();
    // Geçersiz/boş gelirse getSector varsayılana düşer.
    const companyType = getSector(company.companyType).id;

    const firstName = (admin.firstName || '').trim();
    const lastName = (admin.lastName || '').trim();
    const username = (admin.username || '').trim();
    const password = admin.password || '';

    if (!companyName) {
        return res.status(400).json({ error: 'Şirket adı gereklidir.' });
    }
    if (!firstName || !username) {
        return res.status(400).json({ error: 'Yönetici adı ve kullanıcı adı gereklidir.' });
    }
    if (!password || password.length < 6) {
        return res.status(400).json({ error: 'Şifre en az 6 karakter olmalıdır.' });
    }

    try {
        const pool = await poolPromise;

        // Tekrar çalıştırılmaya/suistimale karşı: zaten admin varsa reddet.
        if (!(await isOnboardingNeeded(pool))) {
            return res.status(409).json({ error: 'Kurulum zaten tamamlanmış.' });
        }

        // Aynı kullanıcı adı çakışmasını engelle.
        const dup = await pool.request()
            .input('username', username)
            .query(`SELECT TOP 1 UserID FROM Users WHERE Username = @username`);
        if (dup.recordset.length > 0) {
            return res.status(409).json({ error: 'Bu kullanıcı adı zaten kullanılıyor.' });
        }

        // 1) Firma bilgileri (tek satır, Id=1) upsert.
        await pool.request()
            .input('companyName', companyName)
            .input('taxOffice', taxOffice || null)
            .input('phone', phone || null)
            .input('companyType', companyType)
            .query(`
                MERGE CompanySettings AS target
                USING (SELECT 1 AS Id) AS src ON target.Id = src.Id
                WHEN MATCHED THEN
                    UPDATE SET CompanyName = @companyName, TaxOffice = @taxOffice,
                               Phone = @phone, CompanyType = @companyType, UpdatedAt = GETDATE()
                WHEN NOT MATCHED THEN
                    INSERT (Id, CompanyName, TaxOffice, Phone, CompanyType)
                    VALUES (1, @companyName, @taxOffice, @phone, @companyType);
            `);

        // Seçilen firma tipine göre hazır mesaj şablonlarını tohumla (ilk kurulum).
        try { seedTemplatesForSector(companyType, true); }
        catch (e) { console.error('Şablon tohumlama hatası:', e.message); }

        // 2) İlk yönetici hesabı.
        const fullName = `${firstName} ${lastName}`.trim();
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);

        const insert = await pool.request()
            .input('username', username)
            .input('passwordHash', hash)
            .input('fullName', fullName)
            .input('role', 'Admin')
            .query(`
                INSERT INTO Users (Username, PasswordHash, FullName, Role)
                OUTPUT INSERTED.UserID
                VALUES (@username, @passwordHash, @fullName, @role)
            `);

        const userId = insert.recordset[0].UserID;
        const permissions = [];

        // 3) Otomatik giriş için token üret (login ile aynı şekil).
        const token = jwt.sign(
            { userId, username, fullName, role: 'Admin', permissions },
            getJwtSecret(),
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            token,
            user: { userId, username, fullName, role: 'Admin', permissions },
        });
    } catch (error) {
        console.error('Onboarding tamamlama hatası:', error);
        res.status(500).json({ error: 'Kurulum tamamlanamadı.' });
    }
});

module.exports = router;
