'use strict';
// Yapılandırma sırlarını (DB şifresi) donanıma bağlı AES-256-GCM ile şifreler.
// Forked Node sunucuda Electron safeStorage YOK → lisans dosyasıyla aynı yöntem:
// anahtar = SHA-256(sabit etiket + HWID). .env başka makineye kopyalansa çözülemez.
// Düz-metin değerler (prefix yoksa) olduğu gibi döner → tam geriye dönük uyum.
const crypto = require('crypto');

// HWID üreticisini lisans servisinden ödünç al (tek kaynak). Yüklenemezse
// (test/izole) hostname'e düş — şifreleme yine çalışır, yalnız bağ zayıflar.
let getHardwareId;
try {
    ({ getHardwareId } = require('../services/license'));
} catch {
    getHardwareId = () => 'HOST:' + require('os').hostname();
}

const PREFIX = 'enc:';

function key() {
    return crypto.createHash('sha256').update('TS-CONFIG-AES-v1::' + getHardwareId()).digest();
}

function isEncrypted(v) {
    return typeof v === 'string' && v.startsWith(PREFIX);
}

// Düz metni 'enc:<base64>' biçimine şifreler. Boş/null → '' (şifrelenmez).
function encryptSecret(plain) {
    if (plain === null || plain === undefined || plain === '') return '';
    if (isEncrypted(plain)) return plain; // zaten şifreli — iki kez sarma
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // [12 IV][16 TAG][n DATA] → base64
    return PREFIX + Buffer.concat([iv, tag, data]).toString('base64');
}

// 'enc:...' değerini çözer. Prefix yoksa düz metindir → olduğu gibi döner.
// Çözülemezse (yanlış makine/bozuk) '' döner → kurulum sihirbazı tekrar sorar.
function decryptSecret(value) {
    if (!isEncrypted(value)) return value;
    try {
        const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
        const iv = buf.subarray(0, 12);
        const tag = buf.subarray(12, 28);
        const data = buf.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
        return '';
    }
}

module.exports = { encryptSecret, decryptSecret, isEncrypted };
