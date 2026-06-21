const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const dotenv = require('dotenv');
const { readSetupState, writeSetupState } = require('../config/setupState');
const { testSqlConnection, ensureDatabaseExists, writeEnvFromConfig, DB_NAME } = require('../config/bootstrapDb');
const { getEnvPath } = require('../config/paths');
const { connectDatabase, initializeDatabase } = require('../config/db');
const { friendlySqlError } = require('../utils/sqlErrors');
const { addLog, getLogs } = require('../services/setupLog');

// ── WhatsApp: ArcTeknik Şef'te YOK ────────────────────────────────────────────
// Şef bağımsız restoran ürünüdür; kurulumda WhatsApp adımı yoktur ve baileys
// bağımlılıkları pakete dahil edilmez. WhatsApp uçları no-op/404 döner.
const waModule = () => null;
const EMPTY_WA = { ready: false, initializing: false, hasQr: false, qr: null };
const getWaStatus = () => EMPTY_WA;

const router = express.Router();

const scheduleAppRestart = () => {
    setTimeout(() => {
        console.log('[Kurulum] Uygulama yeniden başlatılıyor (exit 0)...');
        process.exit(0);
    }, 900);
};

router.get('/status', (req, res) => {
    const state = readSetupState();
    const wa = getWaStatus();
    res.json({
        ...state,
        dbName: DB_NAME,
        edition: process.env.APP_EDITION || 'restaurant',
        whatsapp: wa,
        envPath: getEnvPath(),
    });
});

router.get('/logs', (req, res) => {
    res.json({ logs: getLogs() });
});

router.get('/sql/candidates', (req, res) => {
    const { getDiscoveryCandidates } = require('../config/bootstrapDb');
    const useWindowsAuth = req.query.useWindowsAuth !== 'false';
    const configs = getDiscoveryCandidates({ useWindowsAuth });
    res.json({
        candidates: configs.map((c) => c.server),
        hint: 'Boş bırakırsanız sırayla tüm adaylar denenir.',
    });
});

router.post('/sql/test', async (req, res) => {
    const { server, useWindowsAuth, user, password, role, port } = req.body;
    try {
        const result = await testSqlConnection({
            role: role || 'server',
            server: server || undefined,
            port: port || undefined,
            useWindowsAuth: role === 'client' ? false : useWindowsAuth !== false,
            user,
            password,
        });
        addLog('info', 'SQL bağlantı testi başarılı', result.server);
        res.json({
            success: true,
            message: 'Bağlantı başarılı!',
            server: result.server,
        });
    } catch (err) {
        const friendly = friendlySqlError(err);
        addLog('error', friendly, err.message);
        res.status(400).json({ success: false, error: friendly, technical: err.message });
    }
});

router.post('/sql/save', async (req, res) => {
    const { server, useWindowsAuth, user, password, role, port } = req.body;
    try {
        if (role === 'client') {
            // İstemci: uzak sunucudaki mevcut veritabanına bağlanılabildiğini doğrula, oluşturma yapma.
            await testSqlConnection({ role: 'client', server, port, user, password });
            writeEnvFromConfig({
                role: 'client',
                server,
                port: port || 1433,
                useWindowsAuth: false,
                user,
                password,
            });
        } else {
            const discovered = await ensureDatabaseExists({
                server: server || undefined,
                useWindowsAuth: useWindowsAuth !== false,
                user,
                password,
            });

            writeEnvFromConfig({
                role: 'server',
                server: discovered.server,
                useWindowsAuth: discovered.config.options?.trustedConnection,
                user,
                password,
            });
        }

        dotenv.config({ path: getEnvPath(), override: true });
        await connectDatabase();
        await initializeDatabase();

        writeSetupState({ sqlConfigured: true });
        addLog('info', `Veritabanı hazır: ${DB_NAME}`, `${process.env.DB_SERVER || server || ''} (${role === 'client' ? 'istemci' : 'sunucu'})`);

        res.json({
            success: true,
            message: 'Veritabanı ayarları kaydedildi.',
            requiresRestart: true,
            restartMessage: 'Ayarlar kaydedildi, uygulama yeniden başlatılıyor...',
        });
        scheduleAppRestart();
    } catch (err) {
        const friendly = friendlySqlError(err);
        addLog('error', friendly, err.message);
        res.status(400).json({ success: false, error: friendly, technical: err.message });
    }
});

router.get('/whatsapp', async (req, res) => {
    const m = waModule();
    if (!m) return res.status(404).json({ error: 'WhatsApp bu sürümde kullanılmıyor.' });
    const state = readSetupState();
    if (!state.sqlConfigured) {
        return res.status(400).json({ error: 'Önce veritabanı adımını tamamlayın.' });
    }

    if (!m.getStatus().initializing && !m.getStatus().ready && !m.getStatus().hasQr) {
        await m.initializeWhatsApp();
    }

    const status = m.getStatus();
    let qrImage = null;
    if (status.qr) {
        qrImage = await QRCode.toDataURL(status.qr, { margin: 2, width: 280 });
    }

    res.json({
        ...status,
        qrImage,
        canSkip: true,
    });
});

router.post('/whatsapp/refresh', async (req, res) => {
    const m = waModule();
    if (!m) return res.status(404).json({ error: 'WhatsApp bu sürümde kullanılmıyor.' });
    try {
        await m.refreshWhatsApp();
        addLog('info', 'WhatsApp QR yenilendi');
        res.json({ success: true });
    } catch (err) {
        addLog('error', 'QR yenilenemedi', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.post('/whatsapp/skip', (req, res) => {
    writeSetupState({ whatsappSkipped: true, whatsappConfigured: false });
    addLog('warn', 'WhatsApp adımı atlandı');
    res.json({ success: true, skipped: true });
});

router.post('/complete', async (req, res) => {
    const { windowsStartup } = req.body;
    const state = readSetupState();

    if (!state.sqlConfigured) {
        return res.status(400).json({ error: 'Veritabanı kurulumu tamamlanmamış.' });
    }

    const wa = getWaStatus();
    // ArcTeknik Şef'te WhatsApp adımı yoktur → asla zorunlu değil.
    const waRequired = false;
    if (waRequired && !wa.ready && !state.whatsappSkipped) {
        return res.status(400).json({ error: 'WhatsApp bağlantısı kurulmalı veya atlanmalı.' });
    }

    writeSetupState({
        complete: true,
        whatsappConfigured: wa.ready,
        windowsStartup: !!windowsStartup,
    });

    // .env içinde SETUP_COMPLETE güncelle
    const fs = require('fs');
    const envPath = getEnvPath();
    if (fs.existsSync(envPath)) {
        let content = fs.readFileSync(envPath, 'utf8');
        if (content.includes('SETUP_COMPLETE=')) {
            content = content.replace(/^SETUP_COMPLETE=.*/m, 'SETUP_COMPLETE=1');
        } else {
            content += '\nSETUP_COMPLETE=1\n';
        }
        fs.writeFileSync(envPath, content, 'utf8');
    }

    addLog('info', 'Kurulum tamamlandı');

    res.json({
        success: true,
        redirectTo: '/',
        restartMessage: 'Kurulum tamamlandı! Uygulama yeniden başlatılıyor...',
        requiresRestart: true,
        windowsStartup: !!windowsStartup,
    });
    scheduleAppRestart();
});

module.exports = router;
