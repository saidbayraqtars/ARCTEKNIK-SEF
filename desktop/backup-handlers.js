const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DB_NAME = 'TEKNIKDB';

const getServerRoot = (app) => (
    app.isPackaged
        ? path.join(process.resourcesPath, 'app', 'server')
        : path.join(__dirname, '..', 'server')
);

const loadSql = (app) => {
    const sqlPath = path.join(getServerRoot(app), 'node_modules', 'mssql');
    return require(sqlPath);
};

const loadDotenv = (app) => {
    const dotenvPath = path.join(getServerRoot(app), 'node_modules', 'dotenv');
    return require(dotenvPath);
};

const getEnvPath = (app) => path.join(app.getPath('userData'), '.env');

const loadEnv = (app) => {
    const envPath = getEnvPath(app);
    if (!fs.existsSync(envPath)) {
        throw new Error('Ana uygulama yapılandırması bulunamadı (.env yok).');
    }
    const dotenv = loadDotenv(app);
    return dotenv.parse(fs.readFileSync(envPath, 'utf8'));
};

const buildSqlConfig = (env, database = 'master') => {
    const useWindowsAuth = env.DB_USE_WINDOWS_AUTH === 'true' || env.DB_USE_WINDOWS_AUTH === '1';
    const cfg = {
        server: env.DB_SERVER || 'localhost\\SQLEXPRESS',
        database,
        options: {
            encrypt: false,
            trustServerCertificate: true,
            enableArithAbort: true,
        },
        pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
        connectionTimeout: 15000,
        requestTimeout: 600000,
    };
    if (useWindowsAuth) {
        cfg.options.trustedConnection = true;
    } else {
        cfg.user = env.DB_USER || 'sa';
        cfg.password = env.DB_PASSWORD || '';
    }
    return cfg;
};

const tsStamp = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

const formatBytes = (n) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
};

const driveTypeName = (code) => {
    switch (String(code)) {
        case '2': return 'USB / Çıkarılabilir';
        case '3': return 'Sabit Disk';
        case '4': return 'Ağ Sürücüsü';
        case '5': return 'CD/DVD';
        default: return 'Bilinmeyen';
    }
};

const listDrives = () => {
    if (process.platform !== 'win32') return [];
    try {
        const out = execSync(
            'wmic logicaldisk get DeviceID,DriveType,VolumeName,FreeSpace,Size /format:csv',
            { encoding: 'utf8', windowsHide: true, timeout: 5000 }
        );
        const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
        const headers = lines[0].split(',').map(h => h.trim());
        const idx = (name) => headers.indexOf(name);
        const drives = [];
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            if (cols.length < headers.length) continue;
            const id = cols[idx('DeviceID')]?.trim();
            const dtype = cols[idx('DriveType')]?.trim();
            const vname = cols[idx('VolumeName')]?.trim();
            const free = parseInt(cols[idx('FreeSpace')], 10);
            const size = parseInt(cols[idx('Size')], 10);
            if (!id) continue;
            drives.push({
                letter: id,
                path: `${id}\\`,
                type: dtype,
                typeName: driveTypeName(dtype),
                label: vname || '',
                size: Number.isFinite(size) ? size : null,
                free: Number.isFinite(free) ? free : null,
                sizeFmt: Number.isFinite(size) ? formatBytes(size) : null,
                freeFmt: Number.isFinite(free) ? formatBytes(free) : null,
                isRemovable: dtype === '2',
            });
        }
        return drives.sort((a, b) => {
            if (a.isRemovable !== b.isRemovable) return a.isRemovable ? -1 : 1;
            return a.letter.localeCompare(b.letter);
        });
    } catch {
        return [];
    }
};

const registerIpc = (ipcMain, dialog, app) => {
    ipcMain.handle('backup:get-config', async () => {
        try {
            const env = loadEnv(app);
            return {
                ok: true,
                server: env.DB_SERVER || 'localhost\\SQLEXPRESS',
                database: DB_NAME,
                windowsAuth: env.DB_USE_WINDOWS_AUTH === 'true' || env.DB_USE_WINDOWS_AUTH === '1',
                envPath: getEnvPath(app),
            };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('backup:list-drives', async () => listDrives());

    ipcMain.handle('backup:pick-folder', async (event, defaultPath) => {
        const opts = {
            properties: ['openDirectory', 'createDirectory'],
            title: 'Yedek Konumu Seçin',
        };
        if (defaultPath && fs.existsSync(defaultPath)) opts.defaultPath = defaultPath;
        const result = await dialog.showOpenDialog(opts);
        if (result.canceled) return null;
        return result.filePaths[0];
    });

    ipcMain.handle('backup:pick-file', async (event, defaultPath) => {
        const opts = {
            properties: ['openFile'],
            filters: [{ name: 'SQL Yedek Dosyaları', extensions: ['bak'] }],
            title: 'Geri Yüklenecek Yedek Dosyası',
        };
        if (defaultPath && fs.existsSync(defaultPath)) opts.defaultPath = defaultPath;
        const result = await dialog.showOpenDialog(opts);
        if (result.canceled) return null;
        return result.filePaths[0];
    });

    ipcMain.handle('backup:list-existing', async (event, folder) => {
        if (!folder || !fs.existsSync(folder)) return [];
        try {
            const files = fs.readdirSync(folder)
                .filter(f => f.toLowerCase().endsWith('.bak'))
                .map(f => {
                    const full = path.join(folder, f);
                    const stat = fs.statSync(full);
                    return {
                        name: f,
                        path: full,
                        size: stat.size,
                        sizeFmt: formatBytes(stat.size),
                        mtime: stat.mtime.toISOString(),
                        mtimeFmt: stat.mtime.toLocaleString('tr-TR'),
                    };
                })
                .sort((a, b) => b.mtime.localeCompare(a.mtime));
            return files;
        } catch {
            return [];
        }
    });

    ipcMain.handle('backup:run-backup', async (event, destFolder) => {
        if (!destFolder) return { ok: false, error: 'Hedef klasör belirtilmedi.' };
        let pool;
        try {
            const env = loadEnv(app);
            const sql = loadSql(app);

            if (!fs.existsSync(destFolder)) {
                fs.mkdirSync(destFolder, { recursive: true });
            }
            const fileName = `${DB_NAME}_${tsStamp()}.bak`;
            const fullPath = path.join(destFolder, fileName);
            const sqlSafePath = fullPath.replace(/'/g, "''");

            pool = await new sql.ConnectionPool(buildSqlConfig(env, 'master')).connect();
            await pool.request().query(`
                BACKUP DATABASE [${DB_NAME}]
                TO DISK = N'${sqlSafePath}'
                WITH FORMAT, INIT, NAME = N'${DB_NAME} Full Backup', SKIP, NOREWIND, NOUNLOAD
            `);

            const stat = fs.statSync(fullPath);
            return {
                ok: true,
                file: fullPath,
                name: fileName,
                size: stat.size,
                sizeFmt: formatBytes(stat.size),
                mtimeFmt: stat.mtime.toLocaleString('tr-TR'),
            };
        } catch (err) {
            return { ok: false, error: err.message || String(err) };
        } finally {
            if (pool) try { await pool.close(); } catch { /* ignore */ }
        }
    });

    ipcMain.handle('backup:run-restore', async (event, bakPath) => {
        if (!bakPath || !fs.existsSync(bakPath)) {
            return { ok: false, error: 'Yedek dosyası bulunamadı.' };
        }
        let pool;
        try {
            const env = loadEnv(app);
            const sql = loadSql(app);
            const cleanPath = bakPath.replace(/'/g, "''");

            pool = await new sql.ConnectionPool(buildSqlConfig(env, 'master')).connect();

            const dbExists = await pool.request().query(
                `SELECT DB_ID('${DB_NAME}') AS Id`
            );
            if (dbExists.recordset[0].Id != null) {
                await pool.request().query(
                    `ALTER DATABASE [${DB_NAME}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`
                );
            }

            try {
                await pool.request().query(`
                    RESTORE DATABASE [${DB_NAME}]
                    FROM DISK = N'${cleanPath}'
                    WITH REPLACE, RECOVERY
                `);
            } finally {
                try {
                    await pool.request().query(
                        `ALTER DATABASE [${DB_NAME}] SET MULTI_USER`
                    );
                } catch { /* ignore */ }
            }

            return { ok: true, message: 'Veritabanı başarıyla geri yüklendi.' };
        } catch (err) {
            return { ok: false, error: err.message || String(err) };
        } finally {
            if (pool) try { await pool.close(); } catch { /* ignore */ }
        }
    });

    ipcMain.handle('backup:delete-file', async (event, filePath) => {
        try {
            if (filePath && fs.existsSync(filePath) && filePath.toLowerCase().endsWith('.bak')) {
                fs.unlinkSync(filePath);
                return { ok: true };
            }
            return { ok: false, error: 'Dosya bulunamadı veya geçersiz.' };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('backup:default-folder', async () => {
        const publicDocs = process.env.PUBLIC || 'C:\\Users\\Public';
        return path.join(publicDocs, 'Documents', 'ARCTEKNIK-Yedekler');
    });
};

module.exports = { registerIpc };
