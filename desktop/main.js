const { app, BrowserWindow, dialog, nativeImage, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const log = require('electron-log/main');
const { autoUpdater } = require('electron-updater');

// ─── Kurumsal Loglama (electron-log) ─────────────────────────────────────────
// Ana süreç logları kullanıcı veri klasöründe rotasyonlu + tarih damgalı tutulur:
//   AppData/Roaming/Bayraktar Yazilim Suite/logs/desktop.log
// (Sunucu süreci ayrıca kendi server.log'una yazar — bkz. server/utils/logger.js.)
log.transports.file.resolvePathFn = () => path.join(app.getPath('userData'), 'logs', 'desktop.log');
log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB → rotasyon
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
log.transports.console.level = 'info';
log.errorHandler.startCatching({ showDialog: false }); // yakalanmamış ana süreç hataları → dosya

// ─── Bayraktar Yazılım Suite — Çift Mod Masaüstü ─────────────────────────────
// TEK Electron süreci, TEK yerel Node.js sunucusu (server.js); başlangıç
// argümanına göre farklı pencere açar:
//   --mode=service  → ArcTeknik ERP   (standart pencere, sidebar'lı, '/')
//   --backup-mode   → ARC Yedekleme Merkezi (sunucu forklamaz)
// NOT: --mode=pos (FastPOS) askıya alındı — bkz. .archive/fastpos/README.md.
// İki kısayol iki kez tıklansa bile single-instance kilidi sayesinde İKİNCİ
// süreç açılmaz; birincil sürece argüman iletilir → o, istenen modda pencere açar.
// Böylece iki pencere de AYNI sunucuya bağlanır, port çakışması olmaz.

const windows = { service: null, restaurant: null, kitchen: null, control: null, selfservice: null, cagri: null, backup: null };
let serverProcess = null;
let currentPort = null;
let isRestarting = false;
let backupReady = false;
let splashWindow = null;
// Çökme sonrası otomatik kurtarma: arka arkaya en çok 3 deneme (artan bekleme).
// Başarılı 10 dk kesintisiz çalışma sayacı sıfırlar — gün içi tekil çökmelerde
// restoran kasası kendi kendine ayağa kalkar, kullanıcıya pencere kapatılmaz.
let crashRestarts = 0;
let stableTimer = null;

const isPackaged = app.isPackaged;

// ─── Ürün: ArcTeknik Şef (bağımsız restoran otomasyonu) ──────────────────────
// Bu launcher YALNIZCA ArcTeknik Şef açar (kendi DB'si: ARCSEFDB, kendi userData
// klasörü, kendi SEF-releases oto-güncellemesi). Teknik servis/ERP modu YOK —
// ERP ayrı klasör/repo'ya taşındı.
const EDITION = 'restaurant';
const isRestaurantEdition = true;

// Bağımsız Şef: kendi userData klasörü (%APPDATA%\ArcTeknik Sef) → .env / setup.json /
// lisans / loglar + TEKİL-SÜREÇ KİLİDİ Suite'ten TAM İZOLE. Aksi halde paketteki
// name='teknik-servis-desktop' yüzünden Suite ile aynı klasörü paylaşıp onun kurulumunu
// (setup.json complete) ve DB kimliğini (.env) miras alıyordu → sihirbaz hiç açılmıyordu.
// app.setPath, single-instance kilidinden ÖNCE çağrılmalı.
if (isRestaurantEdition) {
    try {
        app.setName('ArcTeknik Sef');
        app.setPath('userData', path.join(app.getPath('appData'), 'ArcTeknik Sef'));
    } catch (e) {
        log.warn('Şef userData izolasyonu ayarlanamadı:', e?.message || e);
    }
}

const parseMode = (argv) => {
    if (argv.includes('--backup-mode')) return 'backup';
    const flag = argv.find((a) => a.startsWith('--mode='));
    const value = flag ? flag.split('=')[1] : '';
    if (isRestaurantEdition) {
        // ArcTeknik Şef bağımsız ürün: ERP (service) modu bu üründe YOK.
        // Bayrak yoksa/tanınmıyorsa satış terminali açılır.
        if (value === 'kitchen') return 'kitchen';
        if (value === 'control') return 'control'; // ArcTeknik Şef Yönetim (kontrol paneli)
        if (value === 'selfservice') return 'selfservice'; // Self-servis kiosk (masa bypass)
        if (value === 'cagri') return 'cagri'; // Müşteri çağrı/numaratör ekranı (tavan TV)
        return 'restaurant';
    }
    // Suite/ERP: restoran modları bu üründe YOK — bağımsız ürün ArcTeknik Şef'e
    // taşındı. Eski kısayoldan --mode=restaurant gelse bile ERP açılır.
    return 'service';
};

if (process.platform === 'win32') {
    app.setAppUserModelId('com.bayraktar.suite');
}

// ─── Tekil süreç kilidi — iki kısayol tek süreçte buluşur ────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (_event, argv) => {
        const mode = parseMode(argv);
        if (mode === 'backup') return openBackup();
        if (currentPort) createAppWindow(mode, currentPort);
        // Sunucu henüz hazır değilse birincil başlatma kendi modunu açar.
    });

    // Uygulama içinden (Ayarlar → Yedekleme Merkezi) ayrı yedekleme penceresini aç.
    ipcMain.on('open-backup-center', () => openBackup());

    // Ayarlar → "Güncellemeleri denetle": elle kontrol, sonucu pencereye döner.
    ipcMain.handle('check-for-updates', () => checkForUpdatesManually());

    // ArcTeknik Şef — sessiz termal yazdırma köprüsü.
    // Yazıcı listesi (eşleme ekranı için): çağıran pencerenin webContents'i üzerinden.
    ipcMain.handle('list-printers', async (event) => {
        try { return await event.sender.getPrintersAsync(); } catch { return []; }
    });
    // Tek fiş bas: gizli pencerede HTML yükle → Windows diyaloğu OLMADAN bas.
    ipcMain.handle('silent-print', (_event, payload) => silentPrint(payload || {}));

    // ArcTeknik Şef — dokunmatik kiosk güvenli kapatma (React onayından sonra).
    ipcMain.handle('quit-app', () => { app.quit(); return true; });

    // Destek paketi: logları + sürüm bilgisini Masaüstü'ne tek klasörde topla.
    // Esnaf "çalışmıyor" dediğinde telefonla log tarif ettirmek yerine bu klasörü
    // WhatsApp/e-posta ile gönderir. Kişisel veri içermez (yalnız log + sürüm).
    ipcMain.handle('create-support-bundle', () => createSupportBundle());

    app.whenReady().then(() => {
        const mode = parseMode(process.argv);
        if (mode === 'backup') openBackup();
        else startApplication(mode);
    });
}

// ─── Ortak yardımcılar ───────────────────────────────────────────────────────
const getIconPath = (ext = 'ico') => {
    const fileName = `icon.${ext}`;
    const dev = path.join(__dirname, 'assets', fileName);
    if (fs.existsSync(dev)) return dev;
    const packaged = path.join(process.resourcesPath || __dirname, 'assets', fileName);
    return fs.existsSync(packaged) ? packaged : null;
};

const loadIcon = () => {
    const icoPath = getIconPath('ico');
    const pngPath = getIconPath('png');
    if (process.platform === 'win32' && icoPath) return nativeImage.createFromPath(icoPath);
    if (pngPath) return nativeImage.createFromPath(pngPath);
    return null;
};

const getAppRoot = () => (
    isPackaged
        ? path.join(process.resourcesPath, 'app')
        : path.join(__dirname, '..')
);

const setupEnvironment = () => {
    process.env.TEKNIK_DATA_DIR = app.getPath('userData');
    process.env.DESKTOP_MODE = '1';
    process.env.NODE_ENV = 'production';
    // Installer SQL'i sessiz kurunca 'sa' şifresini $INSTDIR\.dbinit'e yazar.
    // Paketli modda kurulum kökü = resources'ın bir üstü. Server ilk açılışta
    // bu dosyayı .env'e şifreli aktarır (bootstrapDb.importDbInit). Dev'de yok.
    if (isPackaged) {
        process.env.DB_INIT_FILE = path.join(path.dirname(process.resourcesPath), '.dbinit');
    }
    // Ürün sürümünü server'a (ve oradan istemciye) bildir → kurulum sihirbazı
    // Şef'te WhatsApp adımını gizler, restoran diline/markaya geçer.
    process.env.APP_EDITION = EDITION;
    // Bağımsız Şef ürünü kendi veritabanına bağlanır (ERP'nin TEKNIKDB'sine DEĞİL).
    // userData klasörü de productName ("ArcTeknik Sef") gereği ayrı → .env izole.
    // DB_NAME zaten set ise (ileride kurulum sihirbazı) ona dokunma.
    if (isRestaurantEdition && !process.env.DB_NAME) {
        process.env.DB_NAME = 'ARCSEFDB';
    }
};

const readSetupState = () => {
    const setupFile = path.join(app.getPath('userData'), 'setup.json');
    if (!fs.existsSync(setupFile)) return null;
    try {
        return JSON.parse(fs.readFileSync(setupFile, 'utf8'));
    } catch {
        return null;
    }
};

const applyWindowsStartup = () => {
    const state = readSetupState();
    const enabled = !!state?.windowsStartup;
    app.setLoginItemSettings({
        openAtLogin: enabled,
        path: process.execPath,
        args: [],
    });
};

const modePath = (mode) => (
    mode === 'restaurant' ? '/restoran'
        : mode === 'kitchen' ? '/restoran/mutfak'
        : mode === 'control' ? '/restoran/yonetim'
        : mode === 'selfservice' ? '/restoran/self'
        : mode === 'cagri' ? '/restoran/cagri'
        : '/'
);
const modeUrl = (port, mode) => `http://127.0.0.1:${port}${modePath(mode)}`;

const focusIfOpen = (mode) => {
    const w = windows[mode];
    if (w && !w.isDestroyed()) {
        if (w.isMinimized()) w.restore();
        w.focus();
        return true;
    }
    return false;
};

// ─── Açılış (splash) penceresi ───────────────────────────────────────────────
// Sunucu fork edilip hazır olana kadar (saniyeler sürebilir) hiçbir pencere
// görünmüyordu → kullanıcı "açılmıyor mu?" diye düşünüyordu. Bu çerçevesiz,
// markalı splash TIKLAR TIKLAMAZ açılır; ana pencere yüklenince kapanır.
function createSplash() {
    if (splashWindow && !splashWindow.isDestroyed()) return splashWindow;
    const icon = loadIcon();
    const win = new BrowserWindow({
        width: 460,
        height: 360,
        frame: false,
        resizable: false,
        movable: true,
        center: true,
        show: false,
        alwaysOnTop: true,
        skipTaskbar: false,
        title: 'ArcTeknik başlatılıyor…',
        backgroundColor: '#0f172a',
        icon: icon || undefined,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    const ver = encodeURIComponent(app.getVersion());
    win.loadFile(path.join(__dirname, 'splash.html'), { search: `v=${ver}` });
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
    splashWindow = win;
    return win;
}

function closeSplash() {
    if (splashWindow && !splashWindow.isDestroyed()) {
        try { splashWindow.close(); } catch { /* ignore */ }
    }
    splashWindow = null;
}

// ─── Sessiz termal yazdırma (ArcTeknik Şef) ──────────────────────────────────
// Renderer her fiş için tam bir HTML belgesi yollar. Burada GİZLİ, çerçevesiz
// bir pencerede yüklenir ve webContents.print({ silent:true, deviceName }) ile
// Windows yazdırma diyaloğu ÇIKMADAN tanımlı yazıcıya basılır. Mutfak işi birden
// çok hedefe (Mutfak/Bar) gidebildiği için renderer her bölümü ayrı ayrı yollar.
function silentPrint({ html, deviceName }) {
    return new Promise((resolve) => {
        if (!html) return resolve({ ok: false, error: 'no-html' });
        let done = false;
        const worker = new BrowserWindow({
            show: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true, javascript: false },
        });
        const finish = (ok, error) => {
            if (done) return;
            done = true;
            try { if (!worker.isDestroyed()) worker.close(); } catch { /* ignore */ }
            resolve({ ok, error });
        };
        worker.webContents.once('did-finish-load', () => {
            try {
                worker.webContents.print(
                    {
                        silent: true,
                        deviceName: deviceName || '',
                        printBackground: true,
                        margins: { marginType: 'none' },
                    },
                    (success, failureReason) => {
                        if (success) finish(true);
                        else { log.error('Sessiz yazdırma başarısız:', failureReason); finish(false, failureReason || 'print-failed'); }
                    }
                );
            } catch (err) {
                log.error('Sessiz yazdırma hatası:', err);
                finish(false, err?.message || String(err));
            }
        });
        worker.webContents.on('did-fail-load', (_e, _code, desc) => finish(false, desc || 'load-failed'));
        // Güvenlik ağı: basım geri çağrısı hiç gelmezse pencere asılı kalmasın.
        setTimeout(() => finish(false, 'timeout'), 20000);
        worker.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    });
}

// ─── Destek paketi (log + sürüm bilgisi → Masaüstü klasörü) ──────────────────
function createSupportBundle() {
    try {
        const p = (n) => String(n).padStart(2, '0');
        const d = new Date();
        const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
        const dest = path.join(app.getPath('desktop'), `ArcTeknik-Destek-${stamp}`);
        fs.mkdirSync(dest, { recursive: true });

        const logDir = path.join(app.getPath('userData'), 'logs');
        if (fs.existsSync(logDir)) {
            for (const f of fs.readdirSync(logDir)) {
                if (!f.toLowerCase().endsWith('.log')) continue;
                try { fs.copyFileSync(path.join(logDir, f), path.join(dest, f)); } catch { /* kilitliyse atla */ }
            }
        }
        const info = [
            `Ürün     : ${isRestaurantEdition ? 'ArcTeknik Şef' : 'Bayraktar Yazılım Suite'}`,
            `Sürüm    : ${app.getVersion()}`,
            `Edition  : ${EDITION}`,
            `Electron : ${process.versions.electron} / Node ${process.versions.node}`,
            `İşletim  : ${process.platform} ${require('os').release()}`,
            `Veri yolu: ${app.getPath('userData')}`,
            `Tarih    : ${d.toLocaleString('tr-TR')}`,
        ].join('\r\n');
        fs.writeFileSync(path.join(dest, 'bilgi.txt'), info, 'utf8');
        log.info('Destek paketi oluşturuldu:', dest);
        return { ok: true, path: dest };
    } catch (err) {
        log.error('Destek paketi oluşturulamadı:', err);
        return { ok: false, error: err?.message || String(err) };
    }
}

// ─── ERP / Şef pencere oluşturma ─────────────────────────────────────────────
function createAppWindow(mode, port) {
    if (focusIfOpen(mode)) return windows[mode];

    const icon = loadIcon();
    const isRestaurant = mode === 'restaurant';
    const isKitchen = mode === 'kitchen';
    const isControl = mode === 'control';
    const isSelf = mode === 'selfservice';
    const isCagri = mode === 'cagri';
    const isKiosk = isRestaurant || isKitchen || isSelf || isCagri; // dokunmatik tam ekran terminaller (kontrol paneli HARİÇ)
    const title = isRestaurant ? 'ArcTeknik Şef'
        : isKitchen ? 'ArcTeknik Mutfak'
        : isControl ? 'ArcTeknik Şef Yönetim'
        : isSelf ? 'ArcTeknik Self-Servis'
        : isCagri ? 'ArcTeknik Çağrı Ekranı'
        : 'ArcTeknik ERP';

    const win = new BrowserWindow({
        width: isKiosk ? 1280 : 1360,
        height: isKiosk ? 800 : 860,
        minWidth: 1024,
        minHeight: 700,
        fullscreen: isKiosk,               // ArcTeknik Şef terminalleri: tam ekran dokunmatik
        title,
        icon: icon || undefined,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'erp-preload.js'), // Yedekleme Merkezi köprüsü
        },
    });

    if (icon && !icon.isEmpty()) {
        try { win.setIcon(icon); } catch { /* ignore */ }
    }

    // Dış bağlantılar (wa.me hatırlatma, http(s)) SİSTEM tarayıcısında açılır;
    // uygulama penceresi asla harici siteye gitmesin (güvenlik + doğru UX).
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) { shell.openExternal(url).catch(() => {}); return { action: 'deny' }; }
        return { action: 'allow' };
    });

    // Kiosk (tam ekran) terminallerde Görev Yöneticisi gerektirmeden çıkış:
    // Ctrl+Shift+Q. before-input-event yalnızca pencere odaktayken çalışır →
    // yanlışlıkla değil, bilinçli çıkış. (input.code → klavye düzeninden bağımsız.)
    if (isKiosk) {
        win.webContents.on('before-input-event', (event, input) => {
            if (input.type === 'keyDown' && input.control && input.shift && input.code === 'KeyQ') {
                event.preventDefault();
                try { win.close(); } catch { /* ignore */ }
            }
        });
    }

    win.loadURL(modeUrl(port, mode));
    win.on('closed', () => { windows[mode] = null; });
    windows[mode] = win;
    return win;
}

// ─── Yerel sunucu (server.js) — yalnızca BİR kez forklanır ───────────────────
const forkServer = () => new Promise((resolve, reject) => {
    setupEnvironment();

    const serverEntry = path.join(getAppRoot(), 'server', 'server.js');
    const serverCwd = path.join(getAppRoot(), 'server');

    if (serverProcess) {
        serverProcess.removeAllListeners();
        try { serverProcess.kill(); } catch { /* ignore */ }
    }

    serverProcess = fork(serverEntry, [], {
        env: { ...process.env },
        cwd: serverCwd,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    let resolved = false;
    const timeout = setTimeout(() => {
        if (!resolved) reject(new Error('Sunucu başlatma zaman aşımına uğradı.'));
    }, 90000);

    const onStdout = (data) => {
        const text = data.toString();
        log.info('[server]', text.replace(/\s+$/, '')); // desktop.log'a da düşür
        const match = text.match(/Sunucu http:\/\/127\.0\.0\.1:(\d+)/);
        if (match && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            // 10 dk kesintisiz çalışırsa çökme sayacını sıfırla (gün içi tekil
            // çökmeler birikip "3 deneme doldu" kilidine dönüşmesin).
            if (stableTimer) clearTimeout(stableTimer);
            stableTimer = setTimeout(() => { crashRestarts = 0; }, 10 * 60 * 1000);
            resolve(parseInt(match[1], 10));
        }
    };

    serverProcess.stdout.on('data', onStdout);
    serverProcess.stderr.on('data', (data) => {
        log.error('[server]', data.toString().replace(/\s+$/, ''));
    });

    serverProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
    });

    serverProcess.on('exit', (code) => {
        if (isRestarting) return;
        const relaunch = (delayMs) => {
            isRestarting = true;
            setTimeout(() => {
                forkServer()
                    .then((port) => {
                        isRestarting = false;
                        currentPort = port;
                        reloadOpenWindows(port);
                    })
                    .catch((err) => {
                        isRestarting = false;
                        dialog.showErrorBox('Yeniden başlatma hatası', err.message);
                        app.quit();
                    });
            }, delayMs);
        };
        if (code === 0) {
            // Planlı yeniden başlatma (kurulum sihirbazı / ayar değişikliği).
            relaunch(600);
        } else if (code !== null) {
            // ÇÖKME: restoran kasası rush saatinde kapanıp kalmasın — artan
            // beklemeyle (2s/4s/6s) en çok 3 kez kendiliğinden ayağa kaldır.
            // Üst üste 3 çökme = kalıcı sorun → kullanıcıya bildir ve çık.
            crashRestarts += 1;
            if (crashRestarts <= 3) {
                log.error(`Sunucu çöktü (kod: ${code}) — otomatik yeniden başlatma ${crashRestarts}/3...`);
                relaunch(crashRestarts * 2000);
            } else {
                dialog.showErrorBox(
                    'Sunucu durdu',
                    `Sunucu art arda çöktü (kod: ${code}) ve otomatik kurtarma başarısız oldu.\n\n` +
                    `Lütfen uygulamayı yeniden başlatın. Sorun sürerse log dosyasını destek ekibine iletin:\n` +
                    `${path.join(app.getPath('userData'), 'logs')}`
                );
                app.quit();
            }
        }
    });
});

// Sunucu yeniden başladığında açık olan pencereleri yeni porta yönlendir.
const reloadOpenWindows = (port) => {
    let any = false;
    for (const mode of ['service', 'restaurant', 'kitchen', 'control', 'selfservice', 'cagri']) {
        const w = windows[mode];
        if (w && !w.isDestroyed()) {
            w.loadURL(modeUrl(port, mode));
            any = true;
        }
    }
    if (!any) createAppWindow('service', port);
};

// ─── Otomatik Güncelleme (electron-updater) ──────────────────────────────────
// Açılışta arka planda yeni sürüm aranır; indirilince esnafa native dialog ile
// "şimdi yeniden başlat / sonra" sorulur. Yalnızca paketlenmiş .exe'de çalışır.
// Ayrıca Ayarlar → "Güncellemeleri denetle" ile elle de tetiklenebilir.
let updateInitialized = false;
let updaterListenersBound = false;
autoUpdater.logger = log;
autoUpdater.autoDownload = true;            // bulununca arka planda indir
autoUpdater.autoInstallOnAppQuit = true;    // kullanıcı "sonra" derse çıkışta kur

// "1.8.4" > "1.8.3" mü? (3 parçalı semver; harici bağımlılık yok)
function isNewerVersion(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0)) return true;
        if ((pa[i] || 0) < (pb[i] || 0)) return false;
    }
    return false;
}

// Olay dinleyicileri yalnızca BİR kez bağlanır (hem açılış hem elle kontrol kullanır).
function bindUpdaterListeners() {
    if (updaterListenersBound) return;
    updaterListenersBound = true;

    autoUpdater.on('checking-for-update', () => log.info('Güncelleme aranıyor...'));
    autoUpdater.on('update-available', (info) => log.info('Güncelleme bulundu:', info?.version));
    autoUpdater.on('update-not-available', () => log.info('En son sürüm kullanılıyor.'));
    autoUpdater.on('download-progress', (p) => log.info(`İndiriliyor: %${Math.round(p?.percent || 0)}`));
    autoUpdater.on('error', (err) => log.error('Güncelleme hatası:', err));

    autoUpdater.on('update-downloaded', (info) => {
        log.info('Güncelleme indirildi:', info?.version);
        const choice = dialog.showMessageBoxSync({
            type: 'info',
            buttons: ['Şimdi yeniden başlat', 'Sonra'],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
            title: 'Güncelleme hazır',
            message: 'Yeni bir güncelleme hazır.',
            detail: `Sürüm ${info?.version || ''} indirildi. Şimdi yeniden başlatıp kurmak ister misiniz?`,
        });
        if (choice === 0) {
            // before-quit sunucuyu güvenle kapatır; ardından kurulum çalışır.
            setImmediate(() => autoUpdater.quitAndInstall());
        }
    });
}

function initAutoUpdate() {
    if (updateInitialized) return;          // single-instance: bir kez yeter
    if (!app.isPackaged) {
        log.info('Güncelleme kontrolü atlandı (geliştirme modu).');
        return;
    }
    updateInitialized = true;
    bindUpdaterListeners();
    autoUpdater.checkForUpdates().catch((err) => log.error('checkForUpdates başarısız:', err));
}

// Elle güncelleme kontrolü (Ayarlar butonu). Sonucu renderer'a döner; güncelleme
// varsa autoDownload arka planda indirir ve hazır olunca yukarıdaki dialog çıkar.
async function checkForUpdatesManually() {
    if (!app.isPackaged) return { status: 'dev' };
    try {
        bindUpdaterListeners();
        const result = await autoUpdater.checkForUpdates();
        const current = app.getVersion();
        const latest = result?.updateInfo?.version || current;
        const available = result?.isUpdateAvailable ?? isNewerVersion(latest, current);
        return available
            ? { status: 'available', version: latest }
            : { status: 'uptodate', version: current };
    } catch (err) {
        log.error('Elle güncelleme kontrolü başarısız:', err);
        return { status: 'error', message: err?.message || String(err) };
    }
}

const startApplication = async (initialMode) => {
    applyWindowsStartup();
    // Tıklar tıklamaz markalı açılış ekranını göster (sunucu hazır olana kadar).
    createSplash();
    try {
        const port = await forkServer();
        currentPort = port;
        const win = createAppWindow(initialMode, port);
        // Ana pencere içerik yüklenince splash'ı kapat — boş/beyaz ekran görünmesin.
        if (win && win.webContents) {
            win.webContents.once('did-finish-load', closeSplash);
            // Güvenlik ağı: yükleme takılırsa splash sonsuza dek kalmasın.
            setTimeout(closeSplash, 15000);
        } else {
            closeSplash();
        }
        initAutoUpdate(); // pencere açıldıktan sonra arka planda güncelleme kontrolü
    } catch (error) {
        closeSplash();
        log.error('Başlatma hatası:', error);
        dialog.showErrorBox(
            'Bayraktar Yazılım Suite başlatılamadı',
            [
                error.message || String(error),
                '',
                'Kontrol listesi:',
                '• SQL Server Express kurulu mu?',
                '• Kurulum sihirbazında veritabanı adımını tamamladınız mı?',
                `• Ayar dosyası: ${path.join(app.getPath('userData'), '.env')}`,
            ].join('\n')
        );
        app.quit();
    }
};

// ─── Yedekleme Merkezi penceresi (sunucu forklamaz) ──────────────────────────
const createBackupWindow = () => {
    const icon = loadIcon();
    const win = new BrowserWindow({
        width: 1080,
        height: 780,
        minWidth: 900,
        minHeight: 640,
        title: 'ARC Yedekleme Merkezi',
        icon: icon || undefined,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'backup', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    if (icon && !icon.isEmpty()) {
        try { win.setIcon(icon); } catch { /* ignore */ }
    }

    win.loadFile(path.join(__dirname, 'backup', 'index.html'));
    return win;
};

function openBackup() {
    if (focusIfOpen('backup')) return;
    setupEnvironment();
    if (!backupReady) {
        const { registerIpc } = require('./backup-handlers');
        registerIpc(ipcMain, dialog, app);
        backupReady = true;
    }
    const win = createBackupWindow();
    win.on('closed', () => { windows.backup = null; });
    windows.backup = win;
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    if (serverProcess) {
        try { serverProcess.kill(); } catch { /* ignore */ }
    }
});

app.on('activate', () => {
    // Tüm pencereler kapandıysa sunucu hâlâ açıkken ERP penceresini geri aç.
    const noneOpen = !['service', 'restaurant', 'kitchen', 'control', 'selfservice', 'cagri', 'backup'].some((m) => windows[m] && !windows[m].isDestroyed());
    if (noneOpen && currentPort) createAppWindow(isRestaurantEdition ? 'restaurant' : 'service', currentPort);
});
