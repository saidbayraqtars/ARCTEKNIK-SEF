'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { getDataDir } = require('../config/paths');

// RSA-2048 public key — embedded at build time, never changes
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsoK/M1XIwR3CY13Z89pl
gVoLm5PE7/Ta1/SmsAInnE+oixf9/X5g9HbW2gpxA6MQjYJCngyyocZbCtLaLLOn
y4mznEZ35a/7VKDmX95jDFq2oozGKSt4KBznYm4bX3SjcGwB0i7AnQdvRxyCeV9u
0bhD0wDwNjXoEZXghgHhqVFHneYeDm+UHg68/zMrhysdJIWwyO0nH8EjOAmRU758
uAfaBDwkCjhAJZTmY4xJHTf6ORPbw6GdEeSq3LkZU8PN2J7FLRysr3ax879n2Uav
twXPaemaO4fU2ygEdj7RhKn9sQ1bZ1HAm9ubVMhERRhaEa7u+ciQ3pfLk0lOUlfb
ZwIDAQAB
-----END PUBLIC KEY-----`;

// Clock rollback: allow up to 5 minutes of drift (NTP corrections etc.)
const GRACE_SEC = 300;

// Deneme (trial) süresi — ilk kurulumda lisans sorulmadan bu kadar gün çalışır.
const TRIAL_DAYS = 15;

// Scrambles the sentinel value stored in file/registry — not encryption,
// just makes the timestamp unreadable to a casual observer
const XOR_KEY = 0x5A3C7B2D;

const REG_KEY = 'HKCU\\Software\\TeknikServis';
const REG_VAL = 'AppSentinel';
// Deneme başlangıç zamanı (epoch sn, scrambled). Dosya silinse de registry'de
// kalır → AppData temizlenerek deneme sıfırlanamaz (ikisini de silmek gerekir).
const REG_VAL_TRIAL = 'AppInit';

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 60_000;

// ─── Path helpers ──────────────────────────────────────────────────────────

// Eski (düz metin) lisans dosyası — yalnızca geriye dönük göç için okunur.
function getLegacyLicensePath() {
    return path.join(getDataDir(), 'license.lic');
}

// Aktif lisansın saklandığı GİZLİ + ŞİFRELİ dosya. İçeriği AES-256-GCM ile
// donanıma bağlı bir anahtarla şifrelenir; başka bilgisayara kopyalansa bile
// çözülemez. Adı bilinçli olarak sıradan görünür.
function getLicenseStorePath() {
    return path.join(getDataDir(), '.tslic');
}

function getSentinelPath() {
    // Hidden-looking name in the app data directory
    return path.join(getDataDir(), 'lc');
}

// Deneme başlangıcının saklandığı (scrambled) dosya. Registry ile birlikte tutulur.
function getTrialPath() {
    return path.join(getDataDir(), 'ti');
}

// Windows'ta dosyaya "gizli" özniteliği ekle (best-effort).
function hideFile(filePath) {
    if (process.platform !== 'win32') return;
    try {
        execSync(`attrib +h "${filePath}"`, { stdio: 'ignore', timeout: 2000 });
    } catch { /* best-effort */ }
}

// ─── Donanım Kimliği (Hardware ID) ───────────────────────────────────────────
// Anakart seri no + sistem UUID (Windows) ya da MAC adresleri temel alınır,
// SHA-256 ile karıştırılıp okunabilir gruplara bölünür. Aynı makinede sabit kalır.

let _hwId = null;

function isJunkValue(v) {
    return !v || /^(none|to be filled|default|system serial number|0+|f+)$/i.test(v);
}

function rawHardwareSources() {
    const parts = [];
    if (process.platform === 'win32') {
        const tryCmd = (cmd, opts = {}) => {
            try {
                return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, ...opts });
            } catch { return ''; }
        };

        let board = '';
        let uuid = '';

        // Önce PowerShell CIM (wmic yeni Windows sürümlerinde kaldırıldı).
        const ps = tryCmd(
            'powershell -NoProfile -NonInteractive -Command ' +
            '"(Get-CimInstance Win32_BaseBoard).SerialNumber; (Get-CimInstance Win32_ComputerSystemProduct).UUID"'
        ).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (ps.length >= 1) board = ps[0];
        if (ps.length >= 2) uuid = ps[1];

        // Yedek: eski wmic (varsa).
        if (isJunkValue(board)) {
            board = tryCmd('wmic baseboard get serialnumber')
                .split(/\r?\n/).map(s => s.trim()).filter(s => s && !/serialnumber/i.test(s))[0] || '';
        }
        if (isJunkValue(uuid)) {
            uuid = tryCmd('wmic csproduct get uuid')
                .split(/\r?\n/).map(s => s.trim()).filter(s => s && !/uuid/i.test(s))[0] || '';
        }

        if (!isJunkValue(board)) parts.push('BB:' + board);
        if (!isJunkValue(uuid)) parts.push('UUID:' + uuid);
    }
    // Yedek / ek kaynak: kalıcı (sanal olmayan) MAC adresleri
    if (parts.length === 0) {
        const ifaces = os.networkInterfaces();
        const macs = [];
        for (const name of Object.keys(ifaces)) {
            for (const net of ifaces[name] || []) {
                if (net.mac && net.mac !== '00:00:00:00:00:00' && !net.internal) {
                    macs.push(net.mac.toLowerCase());
                }
            }
        }
        macs.sort();
        if (macs.length) parts.push('MAC:' + macs.join(','));
    }
    return parts.join('|');
}

function getHardwareId() {
    if (_hwId) return _hwId;
    let source = rawHardwareSources();
    if (!source) {
        // Son çare: hostname (zayıf ama hiç yoktan iyidir)
        source = 'HOST:' + os.hostname();
    }
    const hash = crypto.createHash('sha256').update('TS-HWID-v1::' + source).digest('hex').toUpperCase();
    // 20 karakter, 4'erli 5 grup: XXXX-XXXX-XXXX-XXXX-XXXX
    const id = hash.slice(0, 20).match(/.{1,4}/g).join('-');
    _hwId = id;
    return id;
}

// ─── Lisans dosyası şifreleme (AES-256-GCM, donanıma bağlı anahtar) ──────────

function encryptionKey() {
    return crypto.createHash('sha256').update('TS-LICENSE-AES-v1::' + getHardwareId()).digest();
}

function encryptLicense(obj) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // [12 IV][16 TAG][n DATA]
    return Buffer.concat([iv, tag, data]);
}

function decryptLicense(buf) {
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(out.toString('utf8'));
}

// Saklanan lisansı okur. Dönüş:
//   { license } | null (dosya yok) | { decryptFailed: true } (çözülemedi → yanlış makine/bozuk)
function readStoredLicense() {
    const storePath = getLicenseStorePath();
    if (fs.existsSync(storePath)) {
        try {
            return { license: decryptLicense(fs.readFileSync(storePath)) };
        } catch {
            return { decryptFailed: true };
        }
    }
    // Geriye dönük göç: eski düz-metin license.lic varsa şifreliye taşı.
    const legacy = getLegacyLicensePath();
    if (fs.existsSync(legacy)) {
        try {
            const license = JSON.parse(fs.readFileSync(legacy, 'utf8'));
            saveLicense(license);
            try { fs.unlinkSync(legacy); } catch { /* yoksay */ }
            return { license };
        } catch {
            return null;
        }
    }
    return null;
}

function saveLicense(obj) {
    const storePath = getLicenseStorePath();
    // Windows'ta gizli (+h) bir dosyanın üzerine writeFileSync EPERM verir.
    // Bu yüzden önce mevcut dosyayı sil, sonra yaz, sonra tekrar gizle.
    try { fs.unlinkSync(storePath); } catch { /* yoksa yoksay */ }
    fs.writeFileSync(storePath, encryptLicense(obj));
    hideFile(storePath);
    // Varsa eski düz-metin dosyayı temizle.
    try { fs.unlinkSync(getLegacyLicensePath()); } catch { /* yoksay */ }
}

function removeStoredLicense() {
    try { fs.unlinkSync(getLicenseStorePath()); } catch { /* yoksay */ }
    try { fs.unlinkSync(getLegacyLicensePath()); } catch { /* yoksay */ }
}

// ─── Sentinel I/O (file) ───────────────────────────────────────────────────

function readSentinelFile() {
    try {
        const buf = fs.readFileSync(getSentinelPath());
        if (buf.length < 4) return null;
        const scrambled = buf.readUInt32BE(0);
        return (scrambled ^ XOR_KEY) >>> 0;
    } catch {
        return null;
    }
}

function writeSentinelFile(sec) {
    try {
        const buf = Buffer.allocUnsafe(4);
        buf.writeUInt32BE((sec ^ XOR_KEY) >>> 0, 0);
        fs.writeFileSync(getSentinelPath(), buf);
    } catch { /* best-effort */ }
}

// ─── Sentinel I/O (Windows registry) ──────────────────────────────────────

function readSentinelRegistry() {
    if (process.platform !== 'win32') return null;
    try {
        const out = execSync(
            `reg query "${REG_KEY}" /v "${REG_VAL}"`,
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }
        );
        const m = out.match(/0x([0-9a-fA-F]+)/i);
        if (!m) return null;
        return (parseInt(m[1], 16) ^ XOR_KEY) >>> 0;
    } catch {
        return null;
    }
}

function writeSentinelRegistry(sec) {
    if (process.platform !== 'win32') return;
    try {
        const scrambled = ((sec ^ XOR_KEY) >>> 0).toString();
        execSync(
            `reg add "${REG_KEY}" /v "${REG_VAL}" /t REG_DWORD /d ${scrambled} /f`,
            { stdio: 'ignore', timeout: 2000 }
        );
    } catch { /* best-effort */ }
}

// ─── Sentinel aggregation ─────────────────────────────────────────────────

// Returns { trustedLast: number|null }
// İki sentinel'in (dosya + registry) EN BÜYÜĞÜ güvenilir "son görülen zaman"dır.
// Saat geri-alma savunması bu max değere dayanır: bir sentinel'i DÜŞÜREREK saati
// geri alma denemesi max() ile zaten etkisizdir (yüksek olan kazanır), o yüzden
// "ikisi farklı → müdahale" gibi sert bir red gerekmez. Ayrıca registry kaydı aynı
// makinedeki tüm kopyalar (dev + kurulu exe) arasında ortaktır; sert red, meşru
// çok-kopyalı kullanımda sahte alarm üretiyordu.
function getSentinelStatus() {
    const file = readSentinelFile();
    const reg  = readSentinelRegistry();

    const fileOk = file !== null && file > 100_000_000;
    const regOk  = reg  !== null && reg  > 100_000_000;

    if (!fileOk && !regOk) return { trustedLast: null };

    const trustedLast = fileOk && regOk
        ? Math.max(file, reg)
        : fileOk ? file : reg;

    return { trustedLast };
}

function updateSentinels() {
    const sec = Math.floor(Date.now() / 1000);
    writeSentinelFile(sec);
    writeSentinelRegistry(sec);
}

// ─── Deneme (trial) başlangıcı ─────────────────────────────────────────────

function readTrialFile() {
    try {
        const buf = fs.readFileSync(getTrialPath());
        if (buf.length < 4) return null;
        const scrambled = buf.readUInt32BE(0);
        return (scrambled ^ XOR_KEY) >>> 0;
    } catch {
        return null;
    }
}

function writeTrialFile(sec) {
    try {
        const buf = Buffer.allocUnsafe(4);
        buf.writeUInt32BE((sec ^ XOR_KEY) >>> 0, 0);
        fs.writeFileSync(getTrialPath(), buf);
        hideFile(getTrialPath());
    } catch { /* best-effort */ }
}

function readTrialRegistry() {
    if (process.platform !== 'win32') return null;
    try {
        const out = execSync(
            `reg query "${REG_KEY}" /v "${REG_VAL_TRIAL}"`,
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }
        );
        const m = out.match(/0x([0-9a-fA-F]+)/i);
        if (!m) return null;
        return (parseInt(m[1], 16) ^ XOR_KEY) >>> 0;
    } catch {
        return null;
    }
}

function writeTrialRegistry(sec) {
    if (process.platform !== 'win32') return;
    try {
        const scrambled = ((sec ^ XOR_KEY) >>> 0).toString();
        execSync(
            `reg add "${REG_KEY}" /v "${REG_VAL_TRIAL}" /t REG_DWORD /d ${scrambled} /f`,
            { stdio: 'ignore', timeout: 2000 }
        );
    } catch { /* best-effort */ }
}

// İlk kurulumda deneme başlangıcını (şimdi) kaydeder; sonraki açılışlarda
// dosya+registry'deki EN ESKİ değeri kullanır → tek kaynağı silmek sıfırlamaz.
// Dönüş: epoch saniye (deneme başlangıcı).
function ensureTrialStart() {
    const fromFile = readTrialFile();
    const fromReg = readTrialRegistry();
    const known = [fromFile, fromReg].filter((v) => Number.isInteger(v) && v > 100_000_000);
    const start = known.length ? Math.min(...known) : Math.floor(Date.now() / 1000);
    // İki depoyu da en eski değere eşitle (idempotent).
    if (fromFile !== start) writeTrialFile(start);
    if (fromReg !== start) writeTrialRegistry(start);
    return start;
}

// Saklı (satın alınmış) lisans yokken çağrılır: deneme sürümünü değerlendirir.
function evaluateTrial(nowSec, hwId) {
    const start = ensureTrialStart();
    const expiresAt = start + TRIAL_DAYS * 86400;

    // Saat geri-alma tespiti (lisans ile aynı sentinel mekanizması).
    const { trustedLast } = getSentinelStatus();
    if (trustedLast !== null && nowSec < trustedLast - GRACE_SEC) {
        const rolledBackMin = Math.floor((trustedLast - nowSec) / 60);
        return {
            valid: false,
            reason: 'CLOCK_TAMPERED',
            hardwareId: hwId,
            detail: `Sistem saati ${rolledBackMin} dakika geri alınmış.`,
        };
    }

    if (nowSec > expiresAt) {
        return {
            valid: false,
            reason: 'TRIAL_EXPIRED',
            trial: true,
            hardwareId: hwId,
            expiresAt,
            daysExpired: Math.floor((nowSec - expiresAt) / 86400),
        };
    }

    // ✓ Deneme geçerli — sentinel'leri ilerlet (gelecekteki geri-almayı yakala).
    updateSentinels();
    return {
        valid: true,
        trial: true,
        hardwareId: hwId,
        customerName: 'Deneme Sürümü',
        modules: withEditionModules([]),
        maxUsers: null,
        issuedAt: start,
        expiresAt,
        daysLeft: Math.ceil((expiresAt - nowSec) / 86400),
    };
}

// ─── Sürüm (edition) modülleri ───────────────────────────────────────────────
// ArcTeknik Şef (restaurant) sürümünde RESTAURANT modülü ürünün KENDİSİDİR —
// satılan bir eklenti değil. Bu yüzden deneme dahil her geçerli lisans durumunda
// örtük olarak verilir; aksi halde Şef sürümü deneme süresince tümüyle kilitli kalır
// (tüm /restoran rotaları client'ta hasModule('RESTAURANT') ile gate edilir).
function withEditionModules(modules) {
    const list = Array.isArray(modules) ? [...modules] : [];
    if ((process.env.APP_EDITION || 'suite') === 'restaurant' && !list.includes('RESTAURANT')) {
        list.push('RESTAURANT');
    }
    return list;
}

// ─── Signature verification ────────────────────────────────────────────────

function verifySignature(payload, signature) {
    try {
        const v = crypto.createVerify('RSA-SHA256');
        v.update(JSON.stringify(payload));
        return v.verify(PUBLIC_KEY, Buffer.from(signature, 'base64'));
    } catch {
        return false;
    }
}

// ─── Core validation ───────────────────────────────────────────────────────

function validateLicense() {
    const nowSec = Math.floor(Date.now() / 1000);
    const hwId = getHardwareId();

    // 1. Saklanan (şifreli) lisansı oku
    const stored = readStoredLicense();
    if (stored === null) {
        // Hiç lisans yok → ilk kurulum: 15 günlük deneme sürümünü değerlendir.
        // Deneme dolunca TRIAL_EXPIRED döner (UI tedarikçi iletişim ekranı gösterir).
        return evaluateTrial(nowSec, hwId);
    }
    // Dosya var ama çözülemedi → başka bilgisayardan kopyalanmış ya da bozuk.
    if (stored.decryptFailed) {
        return {
            valid: false,
            reason: 'LICENSE_HARDWARE_MISMATCH',
            hardwareId: hwId,
            detail: 'Lisans dosyası bu bilgisayara ait değil. Bu makineye özel yeni bir lisans gerekli.',
        };
    }

    const license = stored.license;
    const { payload, signature } = license || {};
    if (!payload || !signature || typeof payload !== 'object') {
        return { valid: false, reason: 'LICENSE_CORRUPT', hardwareId: hwId };
    }

    // 2. RSA signature must be valid (forgery detection)
    if (!verifySignature(payload, signature)) {
        return { valid: false, reason: 'LICENSE_INVALID', hardwareId: hwId };
    }

    // 3. Donanım bağlama (ZORUNLU) — lisans bu bilgisayar için üretilmiş olmalı.
    if (payload.hardwareId !== hwId) {
        return {
            valid: false,
            reason: 'LICENSE_HARDWARE_MISMATCH',
            hardwareId: hwId,
            customerName: payload.customerName,
            detail: 'Bu lisans başka bir bilgisayara tanımlanmış. Bu makineye özel yeni bir lisans gerekli.',
        };
    }

    // 4. Saat geri-alma tespiti (sentinel'lerin en büyüğüne göre)
    const { trustedLast } = getSentinelStatus();

    if (trustedLast !== null && nowSec < trustedLast - GRACE_SEC) {
        const rolledBackMin = Math.floor((trustedLast - nowSec) / 60);
        return {
            valid: false,
            reason: 'CLOCK_TAMPERED',
            hardwareId: hwId,
            detail: `Sistem saati ${rolledBackMin} dakika geri alınmış.`,
        };
    }

    // 5. Issue date: license shouldn't be valid before it was issued
    if (nowSec < payload.issuedAt - GRACE_SEC) {
        return { valid: false, reason: 'LICENSE_NOT_YET_VALID', hardwareId: hwId };
    }

    // 6. Expiry check
    if (nowSec > payload.expiresAt) {
        return {
            valid: false,
            reason: 'LICENSE_EXPIRED',
            hardwareId: hwId,
            customerName: payload.customerName,
            expiresAt: payload.expiresAt,
            daysExpired: Math.floor((nowSec - payload.expiresAt) / 86400),
        };
    }

    // ✓ Valid — push sentinels forward so future rollbacks are caught
    updateSentinels();

    return {
        valid: true,
        licenseId: payload.id,
        customerName: payload.customerName,
        customerEmail: payload.customerEmail,
        hardwareId: hwId,
        // Aktif modüller (ör. 'B2B'). Lisansta yoksa boş dizi.
        // Şef sürümünde RESTAURANT örtük eklenir (ürünün kendisi).
        modules: withEditionModules(payload.modules),
        // Kullanıcı (seat) limiti. Lisansta yoksa null = SINIRSIZ (geriye dönük).
        maxUsers: Number.isInteger(payload.maxUsers) && payload.maxUsers > 0 ? payload.maxUsers : null,
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt,
        daysLeft: Math.ceil((payload.expiresAt - nowSec) / 86400),
    };
}

// ─── Cached accessor (re-validates at most once per minute) ───────────────

function getCachedStatus() {
    const now = Date.now();
    if (_cache && now - _cacheAt < CACHE_TTL_MS) return _cache;
    _cache = validateLicense();
    _cacheAt = now;
    return _cache;
}

function invalidateCache() {
    _cache = null;
    _cacheAt = 0;
}

module.exports = {
    validateLicense,
    getCachedStatus,
    invalidateCache,
    getHardwareId,
    saveLicense,
    readStoredLicense,
    removeStoredLicense,
    verifySignature,
    updateSentinels,
};
