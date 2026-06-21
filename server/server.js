// ── Loglama: önce yüklenmeli (electron-log orijinal console'u burada yakalar) ──
const log = require('./utils/logger');
// Mevcut tüm console.* çağrılarını (27 dosya, ~136 çağrı) dosyaya da yönlendir.
// Tek tek dosya düzenlemeden kurumsal loglama: ACID/SQL/e-Fatura hataları (console.error)
// otomatik 'error' seviyesinde server.log'a yazılır. Özyineleme yok (bkz. utils/logger.js).
console.log = (...args) => log.info(...args);
console.info = (...args) => log.info(...args);
console.warn = (...args) => log.warn(...args);
console.error = (...args) => log.error(...args);
console.debug = (...args) => log.debug(...args);

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const { connectDatabase, initializeDatabase } = require('./config/db');
const { getEnvPath, getUploadsDir } = require('./config/paths');
const { needsSetupWizard, readSetupState } = require('./config/setupState');
const { ensureDesktopEnv } = require('./config/bootstrapDb');
const { authenticate } = require('./middleware/auth');
const { blockApiUnlessSetup } = require('./middleware/setupGuard');
const { licenseGuard, requireModule } = require('./middleware/licenseGuard');
const { updateSentinels } = require('./services/license');
// NOT: reminders + whatsapp servisleri TOP-LEVEL require EDİLMEZ. Her ikisi de
// baileys/WhatsApp bağımlılıklarını çeker; bunlar yalnız Suite'te yüklenmeli.
// ArcTeknik Şef (restaurant) bu modülleri HİÇ require etmez → baileys paketi
// Şef installer'ından çıkarılabilir (bkz. startNormalServer + electron-builder-restaurant).

const loadEnv = () => {
    if (process.env.DESKTOP_MODE === '1') {
        ensureDesktopEnv();
    }
    dotenv.config({ path: getEnvPath() });
};

const attachStatic = (app) => {
    const uploadsDir = getUploadsDir();
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    app.use('/uploads', express.static(uploadsDir));

    const clientDist = path.join(__dirname, '../client/dist');
    if (fs.existsSync(clientDist)) {
        app.use(express.static(clientDist));
        app.get('*', (req, res, next) => {
            if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) {
                return next();
            }
            res.sendFile(path.join(clientDist, 'index.html'));
        });
    }
};

const createBaseApp = () => {
    const app = express();
    // CSP: SPA tek origin'den servis edilir (LAN istemcileri dahil — origin görelidir).
    // 'unsafe-inline' yalnız style'da: React inline style attribute'ları için gerekli.
    // data:/blob: → QR kod görselleri (data URL) + kamera/barkod akışları.
    app.use(helmet({
        contentSecurityPolicy: {
            useDefaults: false,
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", 'data:', 'blob:'],
                fontSrc: ["'self'", 'data:'],
                connectSrc: ["'self'"],
                mediaSrc: ["'self'", 'blob:'],
                workerSrc: ["'self'", 'blob:'],
                objectSrc: ["'none'"],
                frameAncestors: ["'self'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
            },
        },
    }));
    // Toplu içe aktarım (Excel/CSV → JSON satırlar) büyük gövde gönderebilir.
    app.use(express.json({ limit: '25mb' }));
    return app;
};

const createSetupApp = () => {
    const app = createBaseApp();
    const setupRoutes = require('./routes/setup');

    app.get('/api/health', (req, res) => {
        res.json({ status: 'OK', setupMode: true, state: readSetupState() });
    });

    app.use('/api/setup', setupRoutes);

    app.use('/api', blockApiUnlessSetup);

    attachStatic(app);

    app.use((err, req, res, next) => {
        console.error('Setup sunucu hatası:', err);
        res.status(500).json({ error: err.message || 'Sunucu hatası' });
    });

    return app;
};

const createNormalApp = () => {
    const app = createBaseApp();
    const NODE_ENV = process.env.NODE_ENV || 'development';
    const isDesktop = process.env.DESKTOP_MODE === '1';

    if (!isDesktop) {
        const allowedOrigins = process.env.ALLOWED_ORIGINS
            ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
            : ['http://localhost:3000', 'http://127.0.0.1:3000'];
        app.use(cors({
            origin: (origin, callback) => {
                if (!origin || allowedOrigins.includes(origin) || NODE_ENV !== 'production') {
                    callback(null, true);
                } else {
                    callback(new Error('CORS politikası bu kaynağa izin vermiyor.'));
                }
            },
            methods: ['GET', 'POST', 'PUT', 'DELETE'],
            allowedHeaders: ['Content-Type', 'Authorization'],
        }));
    }

    attachStatic(app);

    app.get('/api/health', (req, res) => {
        res.json({ status: 'OK', setupMode: false, env: NODE_ENV, desktop: isDesktop });
    });

    // Defensive: SetupGate polls this on every page load.
    // edition ZORUNLU: istemci (App.jsx) bunu okuyup restoran/suite route ağacını seçer.
    // Eksikse Şef sürümü 'suite' sanılır → teknik rota ağacı / "Panele Dön" geri gelir.
    app.get('/api/setup/status', (req, res) => {
        res.json({ complete: true, edition: process.env.APP_EDITION || 'suite' });
    });

    // Telefon/tabletten bağlanmak için ağ adreslerini döner (hassas veri içermez).
    app.get('/api/network-info', (req, res) => {
        const port = parseInt(process.env.PORT || '5000', 10);
        res.json({ port, urls: getLanUrls(port) });
    });

    // License endpoints are always accessible (no licenseGuard here)
    app.use('/api/license', require('./routes/license'));

    // All other API routes require a valid license
    app.use('/api', licenseGuard);

    // ─── API rotaları (ArcTeknik Şef — bağımsız restoran ürünü) ─────────────
    // Teknik servis/ERP uçları bu kod tabanında YOK (ayrı klasör/repo: ArcTeknik
    // ERP). Yalnız restoran çekirdeği + paylaşılan altyapı (kasa, stok-reçete,
    // kullanıcı/seat, ayar, denetim, yedek).
    app.use('/api/onboarding', require('./routes/onboarding'));
    app.use('/api/auth', require('./routes/auth'));
    app.use('/api/public', require('./routes/public'));
    app.use('/api/transactions', require('./routes/transactions'));        // kasa
    app.use('/api/stocks', require('./routes/stocks'));                    // reçete → stok sarfiyatı
    app.use('/api/fx', require('./routes/fx'));                            // TCMB döviz kurları
    app.use('/api/stock-receipts', require('./routes/stockReceipts'));
    app.use('/api/stock-movements', require('./routes/stockMovements'));
    app.use('/api/users', require('./routes/users'));                      // RBAC / seat
    app.use('/api/settings', require('./routes/settings'));
    app.use('/api/connection', require('./routes/connection'));
    app.use('/api/audit', require('./routes/audit'));                      // denetim izi
    app.use('/api/maintenance', require('./routes/maintenance'));         // otomatik yedek (admin)

    // Restoran çekirdeği. Online sipariş (Faz 3) daha özgül yol, restoran'dan
    // ÖNCE mount edilir. Hepsi RESTAURANT modülü ile gate edilir.
    app.use('/api/restoran/integrations', requireModule('RESTAURANT'), require('./routes/restoranIntegrations'));
    app.use('/api/restoran-webhooks', requireModule('RESTAURANT'), require('./routes/restoranWebhooks'));
    app.use('/api/restoran', requireModule('RESTAURANT'), require('./routes/restoran'));

    app.use((err, req, res, next) => {
        if (err.message?.includes('CORS')) {
            return res.status(403).json({ error: err.message });
        }
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'Dosya boyutu çok büyük (max 50MB).' });
        }
        res.status(500).json({ error: err.message || 'Sunucu hatası.' });
    });

    return app;
};

const getLanUrls = (port) => {
    const os = require('os');
    const urls = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const net of ifaces[name] || []) {
            if (net.family === 'IPv4' && !net.internal) {
                urls.push(`http://${net.address}:${port}`);
            }
        }
    }
    return urls;
};

const listen = (app, host, port) => new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
        // Electron ana süreci bu satırı yakalayıp portu algılıyor — bu format korunmalı.
        console.log(`Sunucu http://127.0.0.1:${port}`);
        if (host === '0.0.0.0') {
            for (const url of getLanUrls(port)) {
                console.log(`Ağ erişimi (telefon/tablet): ${url}`);
            }
        }
        resolve({ port, host, server });
    });
    server.on('error', reject);
});

const startSetupServer = async () => {
    loadEnv();
    const PORT = parseInt(process.env.PORT || '51234', 10);
    const state = readSetupState();

    if (state.sqlConfigured) {
        try {
            dotenv.config({ path: getEnvPath(), override: true });
            await connectDatabase();
            await initializeDatabase();
        } catch (err) {
            console.error('Kurulum modunda DB bağlantısı başarısız:', err.message);
        }
    }

    const app = createSetupApp();
    return listen(app, '127.0.0.1', PORT);
};

const startNormalServer = async () => {
    loadEnv();

    const PORT = parseInt(process.env.PORT || '5000', 10);
    const NODE_ENV = process.env.NODE_ENV || 'development';
    const isDesktop = process.env.DESKTOP_MODE === '1';

    if (NODE_ENV === 'production' && !isDesktop
        && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'fallback-secret-key-dev-only')) {
        throw new Error('Production ortamında JWT_SECRET tanımlanmalıdır.');
    }

    await connectDatabase();
    await initializeDatabase();

    // ArcTeknik Şef: teknik servis bildirimleri (hatırlatma/WhatsApp/cari oto-mesaj)
    // YÜKLENMEZ → baileys/WhatsApp bağımlılıkları Şef paketinden çıkarılır.

    // Keep sentinel timestamps current while the server runs (every 10 min)
    setInterval(updateSentinels, 10 * 60 * 1000).unref();

    // Gece otomatik veritabanı yedeği (istemci modunda kendiliğinden devre dışı).
    require('./services/autoBackup').startAutoBackup();

    const app = createNormalApp();
    // Aynı ağdaki telefon/tabletlerden erişilebilmesi için tüm arayüzlerde dinle.
    // (Masaüstü penceresi yine http://127.0.0.1 üzerinden yüklenir.)
    return listen(app, '0.0.0.0', PORT);
};

const startServer = async () => {
    loadEnv();
    if (needsSetupWizard()) {
        console.log('>>> Kurulum sihirbazı modu');
        return startSetupServer();
    }
    console.log('>>> Normal çalışma modu');
    return startNormalServer();
};

if (require.main === module) {
    startServer().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { startServer, startSetupServer, startNormalServer };
