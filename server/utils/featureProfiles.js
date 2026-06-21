'use strict';

// ─── Sektör Özellik Profilleri (Ekran/Yetenek Bayrakları) ────────────────────
// Üçüncü gating ekseni (lisans + RBAC'ın üstüne): firma tipine (sektör) göre
// hangi panel/özelliklerin VARSAYILAN açık geldiği. Sektörün ihtiyacı olmayan
// özellik varsayılan KAPALI → menüde gizli + route bloklu. Yönetici, Ayarlar'dan
// her özelliği aç/kapatıp sektör varsayılanını ezebilir (şirket geneli tek ayar).
//
// Efektif kural:  efektif = lisanslı? && (override ?? sektör_varsayılanı)
// Lisans üst kuraldır: lisansta olmayan modül bayrakla AÇILAMAZ.
//
// İzin (RBAC) ayrı eksendir ve istemcide ayrıca uygulanır (canSee + hasFeature).

const { getSector } = require('./sectorProfiles');

// Aç/kapatılabilir özellikler (ekran + yetenek düzeyi). Core ekranlar (Dashboard,
// Personel, Ayarlar, Geçmiş, Dizayn) buraya DAHİL DEĞİL → her zaman açık.
// module: gerektirdiği lisans modülü (varsa lisansta yoksa zorla kapalı).
const FEATURES = [
    { key: 'services', label: 'Servis / Cihaz Takibi', desc: 'Müşteri kabul, QR takip, servis fişi', module: null },
    { key: 'stock', label: 'Stok & Depo', desc: 'Envanter, kritik seviye, stok hareketleri', module: null },
    { key: 'accounts', label: 'Cari Hesaplar', desc: 'Açık hesap, ekstre, bakiye', module: null },
    { key: 'cash', label: 'Kasa', desc: 'Gelir / gider hareketleri', module: null },
    { key: 'documents', label: 'Belgeler', desc: 'Teklif · Sipariş · İrsaliye · Fatura', module: null },
    { key: 'multiCurrency', label: 'Çoklu Para Birimi', desc: 'USD/EUR/GBP fiyat + TCMB kuru ile TL karşılığı', module: null },
    { key: 'reports', label: 'İstatistik & Patron Özeti', desc: 'Raporlar, net kâr, özet ekranı', module: null },
    { key: 'whatsapp', label: 'WhatsApp Bildirim', desc: 'Otomatik mesaj + telefondan bağlan', module: null },
    // Ön Muhasebe derinliği (şemsiye): çoklu iskonto, masraf dağıtımı, ödeme planı,
    // çek/senet, muhasebe aktarımı… Açıkken belgelerde/stokta gelişmiş alanlar görünür.
    // İleride ücretli lisans modülüne çevrilebilir (module:'ONMUHASEBE').
    { key: 'onmuhasebe', label: 'Ön Muhasebe (Gelişmiş)', desc: 'Çoklu iskonto, masraf, ödeme planı, çek/senet vb. gelişmiş ticari özellikler', module: null },
];

const FEATURE_KEYS = FEATURES.map((f) => f.key);

// Sektöre özgü varsayılan SAPMALAR (taban kuralın üzerine). Belirtilmeyen sektör
// taban kuralı kullanır: hepsi açık, multiCurrency kapalı; servis vermeyen
// sektörlerde (sectorProfiles.service:false) 'services' kapalı.
const SECTOR_OVERRIDES = {
    // Toptancı/bayi: cihaz servisi yok; ithalat/döviz + ticaret ağırlıklı →
    // çoklu para + ön muhasebe derinliği açık.
    toptanci: { services: false, multiCurrency: true, onmuhasebe: true },
    // Oto yedek parça satıcısı: tamir/servis yok, satış+cari ağırlıklı (toptancı gibi).
    oto_yedek_parca: { services: false, multiCurrency: true, onmuhasebe: true },
};

// Bir özelliğin sektörden bağımsız taban varsayılanı.
function baseDefault(key) {
    if (key === 'multiCurrency') return false; // opt-in (çoğu yerel firma TL)
    if (key === 'onmuhasebe') return false;    // opt-in (gelişmiş ticari katman)
    return true;
}

// Bir sektör için varsayılan özellik haritası: { key: bool }.
function sectorDefaults(sectorId) {
    const sec = getSector(sectorId);
    const out = {};
    for (const key of FEATURE_KEYS) out[key] = baseDefault(key);
    if (sec.service === false) out.services = false;     // servis vermeyen tip
    const ov = SECTOR_OVERRIDES[sec.id] || {};
    return { ...out, ...ov };
}

// Kaydedilmiş override JSON'unu güvenli parse et: { key: bool } (yalnız bilinen anahtarlar).
function parseOverrides(raw) {
    if (!raw) return {};
    let obj = raw;
    if (typeof raw === 'string') {
        try { obj = JSON.parse(raw); } catch { return {}; }
    }
    if (!obj || typeof obj !== 'object') return {};
    const out = {};
    for (const key of FEATURE_KEYS) {
        if (key in obj) out[key] = obj[key] === true || obj[key] === 1 || obj[key] === '1';
    }
    return out;
}

// Efektif özellik haritası: sektör varsayılanı, override ile ezilir, lisans ile sınırlanır.
function effectiveFeatures(sectorId, overridesRaw, licenseModules = []) {
    const def = sectorDefaults(sectorId);
    const overrides = parseOverrides(overridesRaw);
    const modules = Array.isArray(licenseModules) ? licenseModules : [];
    const out = {};
    for (const f of FEATURES) {
        let on = (f.key in overrides) ? overrides[f.key] : def[f.key];
        if (f.module && !modules.includes(f.module)) on = false; // lisans üst kural
        out[f.key] = on;
    }
    return out;
}

// İstemci için katalog (kilitli = lisans modülü yoksa).
function listFeatures(licenseModules = []) {
    const modules = Array.isArray(licenseModules) ? licenseModules : [];
    return FEATURES.map((f) => ({
        key: f.key, label: f.label, desc: f.desc,
        module: f.module || null,
        locked: !!(f.module && !modules.includes(f.module)),
    }));
}

module.exports = {
    FEATURES, FEATURE_KEYS,
    sectorDefaults, parseOverrides, effectiveFeatures, listFeatures,
};
