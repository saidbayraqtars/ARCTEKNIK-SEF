const fs = require('fs');
const path = require('path');
const { getDataDir } = require('../config/paths');
const {
    buildTemplatesForSector, DEFAULT_SECTOR_ID, SERVICE_KEYS, ACCOUNT_KEYS,
} = require('./sectorProfiles');

const TEMPLATES_FILE = () => path.join(getDataDir(), 'whatsappTemplates.json');

// Varsayılan şablon haritası — kurulumda sektör seçilmemişse genel teknik servis.
// Şekil: { key: { body, enabled } }. Eski sürümün düz string biçimi okuma anında
// otomatik bu şekle çevrilir (geriye dönük uyumluluk).
const DEFAULT_TEMPLATES = buildTemplatesForSector(DEFAULT_SECTOR_ID);

const ALL_KEYS = [...SERVICE_KEYS, ...ACCOUNT_KEYS];

// Servis durumu -> mesaj şablonu eşlemesi (statuses.js STATUSES değerleri)
const STATUS_TEMPLATE_MAP = {
    'Teslim Alındı': 'intake',
    'Onay Bekliyor': 'awaitingApproval',
    'Onaylandı - Parça Bekleniyor': 'approvedParts',
    'İşleme Alındı': 'inProgress',
    'İade İstendi': 'returnRequested',
    'Tamir Edildi': 'repaired',
    'Teslim Edildi': 'delivered',
};

// Cari hareket tipi -> şablon anahtarı (accountWatcher kullanır).
const ACCOUNT_TYPE_MAP = {
    'Borçlandır': 'accountDebit',
    'Alacaklandır': 'accountCredit',
    'Tahsilat': 'accountCollection',
    'Ödeme': 'accountPayment',
};

// Tek bir şablon değerini { body, enabled } şekline getirir (string'i de kabul eder).
const normalizeEntry = (val, fallback) => {
    if (val == null) return fallback;
    if (typeof val === 'string') return { body: val, enabled: true };
    return {
        body: typeof val.body === 'string' ? val.body : (fallback ? fallback.body : ''),
        enabled: val.enabled !== false,
    };
};

const readFile = () => {
    const file = TEMPLATES_FILE();
    if (!fs.existsSync(file)) return {};
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; }
    catch { return {}; }
};

// Tüm şablonları normalize edilmiş halde döner: { key: { body, enabled } }.
const getTemplates = () => {
    const saved = readFile();
    const out = {};
    for (const key of ALL_KEYS) {
        out[key] = normalizeEntry(saved[key], DEFAULT_TEMPLATES[key]);
    }
    return out;
};

const writeTemplates = (map) => {
    const dir = getDataDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TEMPLATES_FILE(), JSON.stringify(map, null, 2), 'utf8');
};

// Kısmi güncelleme: patch[key] string ya da { body?, enabled? } olabilir; mevcut
// değerle birleştirilir.
const updateTemplates = (patch) => {
    const current = getTemplates();
    for (const [key, val] of Object.entries(patch || {})) {
        if (!ALL_KEYS.includes(key)) continue;
        if (typeof val === 'string') {
            current[key] = { ...current[key], body: val };
        } else if (val && typeof val === 'object') {
            current[key] = {
                body: typeof val.body === 'string' ? val.body : current[key].body,
                enabled: typeof val.enabled === 'boolean' ? val.enabled : current[key].enabled,
            };
        }
    }
    writeTemplates(current);
    return current;
};

// Kurulumda/sektör değişiminde seçilen sektörün varsayılan metinlerini yazar.
// Kullanıcı daha önce düzenlediyse (dosya varsa) ÜZERİNE YAZMAZ — yalnız ilk
// kurulumda tohumlar (force=true ile zorlanabilir).
const seedTemplatesForSector = (sectorId, force = false) => {
    if (!force && fs.existsSync(TEMPLATES_FILE())) return getTemplates();
    const map = buildTemplatesForSector(sectorId);
    writeTemplates(map);
    return map;
};

// Şablonu doldurup döner. Şablon KAPALI (enabled:false) ise '' döner → çağıran
// taraf boş mesaj göndermez ("mesajın başındaki tik" mantığı).
const renderTemplate = (templateName, data) => {
    const tpl = getTemplates()[templateName];
    if (!tpl || tpl.enabled === false) return '';
    let text = tpl.body || '';
    if (!text) return '';
    for (const [key, value] of Object.entries(data || {})) {
        text = text.replace(new RegExp(`{{${key}}}`, 'g'), value ?? '');
    }
    return text;
};

const isEnabled = (templateName) => {
    const tpl = getTemplates()[templateName];
    return !!tpl && tpl.enabled !== false;
};

module.exports = {
    getTemplates, updateTemplates, renderTemplate, isEnabled, seedTemplatesForSector,
    DEFAULT_TEMPLATES, STATUS_TEMPLATE_MAP, ACCOUNT_TYPE_MAP,
};
