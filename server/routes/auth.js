const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { poolPromise } = require('../config/db');
const { getJwtSecret } = require('../middleware/auth');
const { loginLimiter } = require('../middleware/rateLimit');
const { parsePermissions } = require('../utils/permissions');

const router = express.Router();

router.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Kullanıcı adı ve şifre gereklidir.' });
    }

    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('username', username)
            .query(`SELECT * FROM Users WHERE Username = @username`);

        if (result.recordset.length === 0) {
            return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
        }

        const user = result.recordset[0];
        const isMatch = await bcrypt.compare(password, user.PasswordHash);

        if (!isMatch) {
            return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
        }

        // Pasife alınmış hesap giriş yapamaz (soft-delete).
        if (user.IsActive === false || user.IsActive === 0) {
            return res.status(403).json({ error: 'Hesabınız pasife alınmış. Lütfen yöneticinize başvurun.' });
        }

        const permissions = parsePermissions(user.Permissions);

        const token = jwt.sign(
            { userId: user.UserID, username: user.Username, fullName: user.FullName, role: user.Role, permissions },
            getJwtSecret(),
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            token,
            user: {
                userId: user.UserID,
                username: user.Username,
                fullName: user.FullName,
                role: user.Role,
                permissions,
            }
        });
    } catch (error) {
        console.error('Login hatası:', error);
        res.status(500).json({ error: 'Giriş sırasında hata oluştu.' });
    }
});

// POST /api/auth/pin-login — ArcTeknik Şef dokunmatik PIN girişi.
// Kullanıcı adı seçtirmeden yalnızca PIN ile giriş. PIN'ler bcrypt hash'li tutulduğu
// için doğrudan sorgulanamaz → PIN tanımlı aktif kullanıcılar çekilir, tek tek karşılaştırılır
// (restoranda kullanıcı sayısı az → maliyet düşük). Eşleşen ilk kullanıcı ile giriş.
router.post('/pin-login', loginLimiter, async (req, res) => {
    const pin = String(req.body?.pin || '').trim();
    if (!/^\d{4,8}$/.test(pin)) {
        return res.status(400).json({ error: 'Geçerli bir PIN girin (en az 4 rakam).' });
    }

    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT * FROM Users WHERE IsActive = 1 AND Pin IS NOT NULL AND Pin <> ''
        `);

        let matched = null;
        for (const u of result.recordset) {
            // eslint-disable-next-line no-await-in-loop
            if (await bcrypt.compare(pin, u.Pin)) { matched = u; break; }
        }

        if (!matched) {
            return res.status(401).json({ error: 'PIN hatalı.' });
        }

        const permissions = parsePermissions(matched.Permissions);
        const token = jwt.sign(
            { userId: matched.UserID, username: matched.Username, fullName: matched.FullName, role: matched.Role, permissions },
            getJwtSecret(),
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            token,
            user: {
                userId: matched.UserID,
                username: matched.Username,
                fullName: matched.FullName,
                role: matched.Role,
                permissions,
            }
        });
    } catch (error) {
        console.error('PIN giriş hatası:', error);
        res.status(500).json({ error: 'Giriş sırasında hata oluştu.' });
    }
});

// GET /api/auth/users-list — giriş ekranı açılır listesi için aktif kullanıcılar.
// Kimlik doğrulama YOK (giriş öncesi). Yalnızca kullanıcı adı + ad soyad döner;
// şifre/yetki gibi hassas veri sızdırmaz.
router.get('/users-list', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT Username, FullName FROM Users WHERE IsActive = 1 ORDER BY FullName ASC
        `);
        res.json(result.recordset.map((u) => ({ username: u.Username, fullName: u.FullName })));
    } catch (error) {
        console.error('Kullanıcı listesi (giriş) hatası:', error);
        res.json([]); // hata → boş liste; giriş ekranı elle yazmaya düşer
    }
});

module.exports = router;
