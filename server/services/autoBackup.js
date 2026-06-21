'use strict';
// ─── Otomatik Zamanlanmış Veritabanı Yedekleme ───────────────────────────────
// Esnaf elle yedek almaz; disk arızasında yılların verisi gider. Bu servis her
// gece (varsayılan 03:30) SQL Server native .bak yedeği alır ve eski yedekleri
// döndürür (rotasyon). Yedekleme Merkezi (manuel) aynen durur — bu onun sigortası.
//
// Önemli kısıt: BACKUP DATABASE komutunu SQL Server SERVİSİ yazar (node değil).
// Servis hesabının kullanıcı profiline (AppData) yazma izni çoğu kurulumda YOKTUR.
// Bu yüzden hedef sırası:
//   1) Yapılandırılan klasör (varsayılan: C:\ProgramData\ArcTeknik\Backups)
//   2) Erişim reddedilirse SQL'in kendi varsayılan yedek klasörü
//      (SERVERPROPERTY('InstanceDefaultBackupPath') — servis her zaman yazabilir)
// Kullanılan gerçek klasör durumda raporlanır.
//
// İstemci modunda (APP_ROLE=client) yedek alınmaz — sorumluluk sunucu makinededir.

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const dataDir = () => process.env.TEKNIK_DATA_DIR || process.cwd();
const configPath = () => path.join(dataDir(), 'backup.json');

const DEFAULTS = {
    enabled: true,
    hour: 3,
    minute: 30,
    keep: 14,      // tutulacak yedek sayısı (≈ 2 hafta)
    dir: '',       // boş → ProgramData\ArcTeknik\Backups
};

let task = null;            // aktif cron görevi
let running = false;        // eşzamanlı iki yedek çalışmasın
let lastResult = null;      // { at, ok, file?, dir?, error? } — süreç içi + diske yazılır

function readConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
        const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
        cfg.hour = Math.min(23, Math.max(0, parseInt(cfg.hour, 10) || 0));
        cfg.minute = Math.min(59, Math.max(0, parseInt(cfg.minute, 10) || 0));
        cfg.keep = Math.min(120, Math.max(1, parseInt(cfg.keep, 10) || DEFAULTS.keep));
        if (raw && raw.lastResult && !lastResult) lastResult = raw.lastResult;
        return cfg;
    } catch {
        return { ...DEFAULTS };
    }
}

function writeConfig(cfg) {
    try {
        const out = { ...cfg, lastResult };
        fs.writeFileSync(configPath(), JSON.stringify(out, null, 2), 'utf8');
    } catch (e) {
        console.error('backup.json yazılamadı:', e.message);
    }
}

function defaultBackupDir() {
    const programData = process.env.ProgramData || 'C:\\ProgramData';
    return path.join(programData, 'ArcTeknik', 'Backups');
}

function stamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

// Tek bir yedek dene — hedef klasöre yazılamazsa hata fırlatır (çağıran düşer).
async function backupTo(pool, dbName, dir) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${dbName}_${stamp()}.bak`);
    // DB adı köşeli parantezle güvenli; dosya yolu parametre olarak bağlanır.
    await pool.request()
        .input('path', file)
        .query(`BACKUP DATABASE [${dbName.replace(/[\[\]]/g, '')}] TO DISK = @path WITH INIT, CHECKSUM`);
    return file;
}

// Eski yedekleri sil (yalnız bizim ürettiğimiz DBNAME_*.bak desenini dokunur).
function rotate(dir, dbName, keep) {
    try {
        const files = fs.readdirSync(dir)
            .filter((f) => f.startsWith(`${dbName}_`) && f.toLowerCase().endsWith('.bak'))
            .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t);
        for (const old of files.slice(keep)) {
            try { fs.unlinkSync(path.join(dir, old.f)); } catch { /* kilitliyse atla */ }
        }
    } catch (e) {
        // SQL varsayılan klasörü (Program Files) kullanıcı izniyle okunamayabilir —
        // rotasyon yapılamadıysa logla, yedeklemeyi başarısız sayma.
        console.warn('Yedek rotasyonu yapılamadı:', e.message);
    }
}

// Şimdi yedek al (zamanlanmış veya elle). Sonucu döndürür + duruma kaydeder.
async function runBackupNow() {
    if (running) return { ok: false, error: 'Yedekleme zaten çalışıyor.' };
    if (process.env.APP_ROLE === 'client') {
        return { ok: false, error: 'İstemci modunda yedek sunucu makinede alınır.' };
    }
    running = true;
    const { getPool } = require('../config/db');
    const dbName = process.env.DB_NAME || 'TEKNIKDB';
    const cfg = readConfig();
    const primaryDir = (cfg.dir || '').trim() || defaultBackupDir();
    try {
        const pool = await getPool();
        let file = null;
        let usedDir = primaryDir;
        try {
            file = await backupTo(pool, dbName, primaryDir);
        } catch (e1) {
            // Tipik neden: SQL servis hesabının klasöre yazma izni yok (OS error 5).
            // SQL'in kendi yedek klasörüne düş — orada her zaman yazabilir.
            console.warn(`Yedek '${primaryDir}' klasörüne alınamadı (${e1.message}) — SQL varsayılan klasörü deneniyor.`);
            const def = await pool.request()
                .query(`SELECT CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS NVARCHAR(500)) AS P`);
            const sqlDir = def.recordset[0] && def.recordset[0].P;
            if (!sqlDir) throw e1;
            usedDir = sqlDir;
            file = await backupTo(pool, dbName, sqlDir);
        }
        rotate(usedDir, dbName, cfg.keep);
        lastResult = { at: new Date().toISOString(), ok: true, file, dir: usedDir };
        console.log(`Otomatik yedek alındı: ${file}`);
    } catch (err) {
        lastResult = { at: new Date().toISOString(), ok: false, error: err.message };
        console.error('Otomatik yedekleme hatası:', err.message);
    } finally {
        running = false;
        writeConfig(readConfig());
    }
    return lastResult;
}

// msdb'den son TAM yedek zamanı (Yedekleme Merkezi'nden alınanlar dahil —
// kaynaktan bağımsız "en son ne zaman yedeklendi" gerçeği).
async function lastBackupFromMsdb() {
    try {
        const { getPool } = require('../config/db');
        const pool = await getPool();
        const r = await pool.request()
            .input('db', process.env.DB_NAME || 'TEKNIKDB')
            .query(`SELECT MAX(backup_finish_date) AS LastAt FROM msdb.dbo.backupset WHERE database_name = @db AND type = 'D'`);
        return r.recordset[0] ? r.recordset[0].LastAt : null;
    } catch {
        return null; // msdb okunamıyorsa (yetki) durum yine config'ten döner
    }
}

async function getBackupStatus() {
    const cfg = readConfig();
    const lastAt = await lastBackupFromMsdb();
    return {
        enabled: cfg.enabled,
        hour: cfg.hour,
        minute: cfg.minute,
        keep: cfg.keep,
        dir: (cfg.dir || '').trim() || defaultBackupDir(),
        lastBackupAt: lastAt,          // msdb gerçeği (her kaynaktan)
        lastRun: lastResult,           // bu servisin son denemesi
        clientMode: process.env.APP_ROLE === 'client',
    };
}

function updateBackupConfig(patch) {
    const cfg = readConfig();
    if (patch.enabled !== undefined) cfg.enabled = !!patch.enabled;
    if (patch.hour !== undefined) cfg.hour = Math.min(23, Math.max(0, parseInt(patch.hour, 10) || 0));
    if (patch.minute !== undefined) cfg.minute = Math.min(59, Math.max(0, parseInt(patch.minute, 10) || 0));
    if (patch.keep !== undefined) cfg.keep = Math.min(120, Math.max(1, parseInt(patch.keep, 10) || DEFAULTS.keep));
    if (patch.dir !== undefined) cfg.dir = String(patch.dir || '').trim().slice(0, 400);
    writeConfig(cfg);
    scheduleFrom(cfg); // saat değiştiyse cron'u yeniden kur
    return cfg;
}

function scheduleFrom(cfg) {
    if (task) { task.stop(); task = null; }
    if (!cfg.enabled) return;
    task = cron.schedule(`${cfg.minute} ${cfg.hour} * * *`, () => {
        runBackupNow().catch(() => { /* sonuç lastResult'ta */ });
    });
}

// Sunucu açılışında çağrılır. İstemci modunda hiçbir şey kurmaz.
function startAutoBackup() {
    if (process.env.APP_ROLE === 'client') return;
    scheduleFrom(readConfig());
}

module.exports = { startAutoBackup, runBackupNow, getBackupStatus, updateBackupConfig };
