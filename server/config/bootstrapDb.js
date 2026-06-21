const sql = require('mssql');
const path = require('path');
const fs = require('fs');
const { encryptSecret, decryptSecret } = require('./secret');

const DB_NAME = process.env.DB_NAME || 'TEKNIKDB';

const getDataDir = () => process.env.TEKNIK_DATA_DIR || path.resolve(__dirname, '..');

// Uygulamanın rolü: 'server' (yerel veritabanı barındırır) veya 'client' (uzak sunucuya bağlanır).
const resolveRole = (overrides = {}) => overrides.role || process.env.APP_ROLE || 'server';

// Host'tan portu ayırır — kullanıcı virgül (SQL standardı) veya iki nokta yazsa da çalışır:
//   "192.168.1.100,1433" → { server: '192.168.1.100', port: 1433 }
//   "192.168.1.100:1433"  → { server: '192.168.1.100', port: 1433 }
//   "BILGISAYAR\\SQLEXPRESS" → { server: 'BILGISAYAR\\SQLEXPRESS', port: undefined }
// SSMS aliaslarını (tedious/getaddrinfo bunları DNS olarak çözemez) localhost'a çevir.
// mssql kütüphanesi bu dönüşümü yalnızca connection-STRING parser'ında yapar; biz
// config OBJESİ verdiğimiz için burada elle yapmazsak "(local)" → ENOTFOUND olur.
const normalizeHost = (h) => {
    const t = String(h || '').trim();
    const low = t.toLowerCase();
    if (low === '.' || low === '(.)' || low === '(local)' || low === '(localhost)' || low === '(localdb)') return 'localhost';
    return t;
};

const parseServer = (raw) => {
    if (!raw) return { server: raw, port: undefined };
    const trimmed = String(raw).trim();
    // Adlandırılmış instance (ters bölü) varsa portu ayırma — bunlar birlikte kullanılmaz.
    if (trimmed.includes('\\')) {
        const idx = trimmed.indexOf('\\');
        const host = normalizeHost(trimmed.slice(0, idx));
        const instance = trimmed.slice(idx + 1).trim();
        return { server: instance ? `${host}\\${instance}` : host, port: undefined };
    }
    const sepIdx = Math.max(trimmed.indexOf(','), trimmed.lastIndexOf(':'));
    if (sepIdx !== -1) {
        const host = normalizeHost(trimmed.slice(0, sepIdx));
        const port = parseInt(trimmed.slice(sepIdx + 1).trim(), 10);
        return { server: host || trimmed, port: Number.isNaN(port) ? undefined : port };
    }
    return { server: normalizeHost(trimmed), port: undefined };
};

const buildConfig = (database, overrides = {}) => {
    const isClient = resolveRole(overrides) === 'client';

    // İstemci modu makineler arası olduğundan Windows kimlik doğrulaması kullanılmaz.
    const useWindowsAuth = !isClient && (
        overrides.options?.trustedConnection === true
        || overrides.useWindowsAuth === true
        || overrides.useWindowsAuth === 'true'
        || (!overrides.user && overrides.useWindowsAuth !== false
            && (process.env.DB_USE_WINDOWS_AUTH === 'true' || process.env.DB_USE_WINDOWS_AUTH === '1')));

    const rawServer = overrides.server || process.env.DB_SERVER || (isClient ? '' : 'localhost\\SQLEXPRESS');
    const parsed = parseServer(rawServer);

    const envPort = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined;
    let port = overrides.port ?? envPort ?? parsed.port;
    if (isClient && !port) port = 1433; // istemci modunda standart SQL portu

    const base = {
        server: parsed.server,
        database,
        options: {
            encrypt: false,
            trustServerCertificate: true,
            enableArithAbort: true,
            ...(overrides.options || {}),
        },
        pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
        connectionTimeout: overrides.connectionTimeout ?? 10000,
        requestTimeout: overrides.requestTimeout ?? 15000,
    };

    // Port ve adlandırılmış instance tedious'ta birlikte kullanılamaz.
    if (port) {
        base.port = port;
        delete base.options.instanceName;
    }

    if (useWindowsAuth) {
        base.options.trustedConnection = true;
    } else {
        base.user = overrides.user || process.env.DB_USER || 'sa';
        // overrides.password (sihirbazdan) düz metin; .env'deki DB_PASSWORD şifreli olabilir → çöz.
        base.password = overrides.password !== undefined ? overrides.password : decryptSecret(process.env.DB_PASSWORD || '');
    }

    return base;
};

/** İlk kurulumda varsayılan .env oluşturur (masaüstü uygulaması) */
const ensureDesktopEnv = () => {
    const dataDir = getDataDir();
    const envPath = path.join(dataDir, '.env');

    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    if (!fs.existsSync(envPath)) {
        const jwt = require('crypto').randomBytes(32).toString('hex');
        // DB_NAME ortamdan gelir (Şef sürümü ARCSEFDB ayarlar); yoksa ERP varsayılanı.
        const content = `# Teknik Servis - Otomatik oluşturuldu
DB_NAME=${process.env.DB_NAME || 'TEKNIKDB'}
JWT_SECRET=${jwt}
PORT=51234
NODE_ENV=production
DESKTOP_MODE=1
PUBLIC_FRONTEND_URL=http://127.0.0.1:51234
REMINDER_PICKUP_DAYS=7
`;
        fs.writeFileSync(envPath, content, 'utf8');
        console.log('Varsayılan yapılandırma oluşturuldu:', envPath);
    }

    return envPath;
};

/**
 * master veritabanına bağlanıp TEKNIKDB yoksa oluşturur.
 * Birden fazla bağlantı profili dener (SQLEXPRESS + Windows Auth öncelikli).
 */
const getDiscoveryCandidates = (overrides = {}) => {
    // İstemci modunda yerel instance taraması yapılmaz; yalnızca yapılandırılmış uzak sunucu denenir.
    if (resolveRole(overrides) === 'client') {
        return [buildConfig('master', {
            role: 'client',
            server: overrides.server || process.env.DB_SERVER,
            port: overrides.port,
            user: overrides.user,
            password: overrides.password,
            useWindowsAuth: false,
            connectionTimeout: 5000,
            requestTimeout: 5000,
        })];
    }

    const hostname = require('os').hostname();
    const useWindowsAuth = overrides.useWindowsAuth !== false
        && overrides.useWindowsAuth !== 'false'
        && (overrides.useWindowsAuth === true || overrides.useWindowsAuth === 'true'
            || process.env.DB_USE_WINDOWS_AUTH === 'true' || process.env.DB_USE_WINDOWS_AUTH === '1');

    const serverOverride = overrides.server || process.env.DB_SERVER;

    // Yapılandırılmış sunucu varsa önce onu dene, başarısız olursa diğer adayları dene
    const names = [
        ...(serverOverride ? [serverOverride] : []),
        'localhost\\SQLEXPRESS',
        'localhost\\MSSQLEXPRESS',
        `.\\SQLEXPRESS`,
        `.\\MSSQLEXPRESS`,
        `${hostname}\\SQLEXPRESS`,
        `${hostname}\\MSSQLEXPRESS`,
        'localhost',
        '(local)\\SQLEXPRESS',
    ];

    const seen = new Set();
    return names.filter((s) => {
        if (seen.has(s)) return false;
        seen.add(s);
        return true;
    }).map((server) => buildConfig('master', {
        server,
        user: overrides.user,
        password: overrides.password,
        options: { trustedConnection: useWindowsAuth },
        connectionTimeout: 3000,
        requestTimeout: 3000,
    }));
};

const tryConnectMaster = async (candidates) => {
    let lastError;
    for (const config of candidates) {
        let pool;
        try {
            pool = await new sql.ConnectionPool(config).connect();
            await pool.close();
            return config;
        } catch (err) {
            lastError = err;
            if (pool) try { await pool.close(); } catch { /* ignore */ }
        }
    }
    throw lastError;
};

const ensureDatabaseExists = async (overrides = {}) => {
    const candidates = getDiscoveryCandidates(overrides);

    let lastError;

    for (const config of candidates) {
        let pool;
        try {
            pool = await new sql.ConnectionPool(config).connect();
            await pool.request().query(`
                IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = N'${DB_NAME}')
                BEGIN
                    CREATE DATABASE [${DB_NAME}];
                END
            `);
            await pool.close();

            const serverChanged = process.env.DB_SERVER && config.server !== process.env.DB_SERVER;
            if (!process.env.DB_SERVER || overrides.server || serverChanged) {
                process.env.DB_SERVER = config.server;
                process.env.DB_USE_WINDOWS_AUTH = config.options?.trustedConnection ? 'true' : 'false';
                if (overrides.user) process.env.DB_USER = overrides.user;
                if (overrides.password !== undefined) process.env.DB_PASSWORD = overrides.password;
                if (process.env.DESKTOP_MODE === '1') {
                    persistEnvDiscovery(config);
                }
            }

            console.log(`Veritabanı hazır: ${DB_NAME} (${config.server})`);
            return { server: config.server, config };
        } catch (err) {
            lastError = err;
            if (pool) try { await pool.close(); } catch { /* ignore */ }
        }
    }

    throw lastError;
};

const testSqlConnection = async (overrides = {}) => {
    // İstemci: master yerine doğrudan paylaşılan veritabanına bağlanılabildiğini doğrula.
    if (resolveRole(overrides) === 'client') {
        const config = buildConfig(DB_NAME, { ...overrides, role: 'client' });
        let pool;
        try {
            pool = await new sql.ConnectionPool(config).connect();
            await pool.request().query('SELECT 1');
            return { ok: true, server: config.server, port: config.port, role: 'client', windowsAuth: false };
        } finally {
            if (pool) { try { await pool.close(); } catch { /* ignore */ } }
        }
    }

    const config = await tryConnectMaster(getDiscoveryCandidates(overrides));
    return { ok: true, server: config.server, role: 'server', windowsAuth: !!config.options?.trustedConnection };
};

const persistEnvDiscovery = (config) => {
    const envPath = path.join(getDataDir(), '.env');
    if (!fs.existsSync(envPath)) return;
    let content = fs.readFileSync(envPath, 'utf8');

    const serverVal = `DB_SERVER=${config.server}`;
    if (/^DB_SERVER=/m.test(content)) {
        content = content.replace(/^DB_SERVER=.*/m, serverVal);
    } else {
        content += `\n${serverVal}`;
    }

    const authVal = `DB_USE_WINDOWS_AUTH=${config.options?.trustedConnection ? 'true' : 'false'}`;
    if (/^DB_USE_WINDOWS_AUTH=/m.test(content)) {
        content = content.replace(/^DB_USE_WINDOWS_AUTH=.*/m, authVal);
    } else {
        content += `\n${authVal}`;
    }

    fs.writeFileSync(envPath, content, 'utf8');
};

const writeEnvFromConfig = (params) => {
    const dataDir = getDataDir();
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const envPath = path.join(dataDir, '.env');
    const jwt = require('crypto').randomBytes(32).toString('hex');
    const appPort = process.env.PORT || '51234';
    const role = params.role || 'server';
    const isClient = role === 'client';
    const lines = [
        `# Teknik Servis`,
        `APP_ROLE=${role}`,
        `DB_SERVER=${params.server}`,
        isClient ? `DB_PORT=${params.port || 1433}` : (params.port ? `DB_PORT=${params.port}` : ''),
        `DB_USE_WINDOWS_AUTH=${params.useWindowsAuth ? 'true' : 'false'}`,
        params.useWindowsAuth ? '' : `DB_USER=${params.user || 'sa'}`,
        params.useWindowsAuth ? '' : `DB_PASSWORD=${encryptSecret(params.password || '')}`,
        `DB_NAME=${DB_NAME}`,
        `JWT_SECRET=${params.jwtSecret || jwt}`,
        `PORT=${appPort}`,
        `NODE_ENV=production`,
        `DESKTOP_MODE=1`,
        `PUBLIC_FRONTEND_URL=http://127.0.0.1:${appPort}`,
        `REMINDER_PICKUP_DAYS=7`,
        `SETUP_COMPLETE=0`,
    ].filter(Boolean);
    fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
    return envPath;
};

/**
 * Mevcut .env dosyasındaki belirtilen anahtarları yerinde günceller (JWT_SECRET vb. korunur).
 * Değer null/undefined ise ilgili satır kaldırılır. Kurulum sonrası rol/bağlantı değişimi için kullanılır.
 */
const setEnvVars = (updates) => {
    const envPath = path.join(getDataDir(), '.env');
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    for (const [key, rawValue] of Object.entries(updates)) {
        // DB şifresi diske şifreli yazılır (HWID-bağlı AES).
        const value = (key === 'DB_PASSWORD' && rawValue) ? encryptSecret(rawValue) : rawValue;
        const lineRe = new RegExp(`^${key}=.*\\r?\\n?`, 'm');
        if (value === null || value === undefined) {
            content = content.replace(lineRe, '');
        } else if (lineRe.test(content)) {
            content = content.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
        } else {
            if (content.length && !content.endsWith('\n')) content += '\n';
            content += `${key}=${value}\n`;
        }
    }
    fs.writeFileSync(envPath, content, 'utf8');
    return envPath;
};

/**
 * Installer'ın yazdığı .dbinit dosyasını (SQL sessiz kurulumdan gelen sa şifresi)
 * tek seferlik olarak .env'e ŞİFRELİ aktarır. NSIS install-sql.ps1 üretir; yol
 * main.js tarafından DB_INIT_FILE ortam değişkeniyle verilir.
 *
 * Idempotent: .env'de zaten SQL auth bilgisi varsa (DB_USER + DB_PASSWORD) tekrar
 * içe aktarmaz, sadece .dbinit'i temizlemeye çalışır. İçe aktarım best-effort —
 * hata durumunda sessizce geçer (Windows-auth keşfine düşülür).
 */
const importDbInit = () => {
    try {
        const initFile = process.env.DB_INIT_FILE;
        if (!initFile || !fs.existsSync(initFile)) return;

        const envPath = path.join(getDataDir(), '.env');
        const env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
        const hasSqlAuth = /^DB_USER=.+/m.test(env) && /^DB_PASSWORD=.+/m.test(env)
            && /^DB_USE_WINDOWS_AUTH=false/m.test(env);
        if (hasSqlAuth) {
            try { fs.unlinkSync(initFile); } catch { /* Program Files altında olabilir */ }
            return;
        }

        const { server, user, password } = JSON.parse(fs.readFileSync(initFile, 'utf8'));
        if (!password) return;

        setEnvVars({
            DB_SERVER: server || 'localhost\\SQLEXPRESS',
            DB_USER: user || 'sa',
            DB_PASSWORD: password,            // setEnvVars DB_PASSWORD'ü diske şifreler
            DB_USE_WINDOWS_AUTH: 'false',
            // SQL installer tarafından kuruldu → kurulum sihirbazının SQL adımına
            // gerek yok. SETUP_COMPLETE=1 ile sihirbaz tamamen atlanır → kullanıcı
            // doğrudan onboarding'e (firma+yönetici) ve ardından deneme sürümüne geçer.
            SETUP_COMPLETE: '1',
        });
        // process.env'i de hemen güncelle (çağıran dotenv override yapacak ama garanti).
        process.env.DB_SERVER = server || 'localhost\\SQLEXPRESS';
        process.env.DB_USER = user || 'sa';
        process.env.DB_USE_WINDOWS_AUTH = 'false';
        process.env.SETUP_COMPLETE = '1';

        try { fs.unlinkSync(initFile); } catch { /* best-effort: yetki yoksa kalır */ }
        console.log('SQL kurulum bilgileri içe aktarıldı (.dbinit → .env).');
    } catch (err) {
        console.warn('.dbinit içe aktarımı atlandı:', err.message);
    }
};

module.exports = {
    ensureDatabaseExists,
    ensureDesktopEnv,
    importDbInit,
    testSqlConnection,
    writeEnvFromConfig,
    setEnvVars,
    buildConfig,
    getDiscoveryCandidates,
    getDataDir,
    DB_NAME,
};
