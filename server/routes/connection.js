const express = require('express');
const { authenticate, adminOnly } = require('../middleware/auth');
const { testSqlConnection, ensureDatabaseExists, setEnvVars, DB_NAME } = require('../config/bootstrapDb');
const { friendlySqlError } = require('../utils/sqlErrors');

const router = express.Router();

// Kurulum akışındaki gibi temiz çıkış (exit 0) → Electron ana süreci sunucuyu yeniden başlatır.
const scheduleRestart = () => {
    setTimeout(() => {
        console.log('[Bağlantı] Ayar değişti, uygulama yeniden başlatılıyor (exit 0)...');
        process.exit(0);
    }, 900);
};

// GET /api/connection — mevcut bağlantı yapılandırması (şifre döndürülmez).
router.get('/', authenticate, adminOnly, (req, res) => {
    res.json({
        role: process.env.APP_ROLE === 'client' ? 'client' : 'server',
        server: process.env.DB_SERVER || '',
        port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : null,
        user: process.env.DB_USER || 'sa',
        useWindowsAuth: process.env.DB_USE_WINDOWS_AUTH === 'true' || process.env.DB_USE_WINDOWS_AUTH === '1',
        dbName: DB_NAME,
    });
});

// POST /api/connection/test — verilen ayarlarla bağlantıyı dener (kaydetmez).
router.post('/test', authenticate, adminOnly, async (req, res) => {
    const { role, server, port, useWindowsAuth, user, password } = req.body;
    try {
        const result = await testSqlConnection({
            role: role || 'server',
            server: server || undefined,
            port: port || undefined,
            useWindowsAuth: role === 'client' ? false : useWindowsAuth !== false,
            user,
            password,
        });
        res.json({ success: true, message: 'Bağlantı başarılı!', server: result.server });
    } catch (err) {
        res.status(400).json({ success: false, error: friendlySqlError(err), technical: err.message });
    }
});

// POST /api/connection/save — ayarları .env'e yazar ve uygulamayı yeniden başlatır.
router.post('/save', authenticate, adminOnly, async (req, res) => {
    const { role, server, port, useWindowsAuth, user, password } = req.body;
    try {
        if (role === 'client') {
            if (!server) {
                return res.status(400).json({ success: false, error: 'İstemci modu için sunucu adresi (IP) gereklidir.' });
            }
            await testSqlConnection({ role: 'client', server, port, user, password });
            setEnvVars({
                APP_ROLE: 'client',
                DB_SERVER: server,
                DB_PORT: port || 1433,
                DB_USE_WINDOWS_AUTH: 'false',
                DB_USER: user || 'sa',
                DB_PASSWORD: password ?? '',
            });
        } else {
            const discovered = await ensureDatabaseExists({
                server: server || undefined,
                useWindowsAuth: useWindowsAuth !== false,
                user,
                password,
            });
            const winAuth = !!discovered.config.options?.trustedConnection;
            setEnvVars({
                APP_ROLE: 'server',
                DB_SERVER: discovered.server,
                DB_PORT: null, // sunucu modunda istemci portunu temizle
                DB_USE_WINDOWS_AUTH: winAuth ? 'true' : 'false',
                DB_USER: winAuth ? null : (user || 'sa'),
                DB_PASSWORD: winAuth ? null : (password ?? ''),
            });
        }

        res.json({
            success: true,
            message: 'Bağlantı ayarları kaydedildi. Uygulama yeniden başlatılıyor...',
            requiresRestart: true,
        });
        scheduleRestart();
    } catch (err) {
        res.status(400).json({ success: false, error: friendlySqlError(err), technical: err.message });
    }
});

module.exports = router;
