'use strict';

// ─── Sektör (Firma Tipi) Profilleri ──────────────────────────────────────────
// Kurulum sihirbazında seçilen firma tipine göre uygulama başlığı, kullanılan
// "cihaz" sözcüğü ve HAZIR MESAJ ŞABLONLARI değişir. Tek bir teknik-servis metni
// yerine her sektör kendi diline uygun varsayılan metinlerle başlar; kullanıcı
// sonradan Ayarlar > Mesaj Taslakları'ndan düzenleyebilir.
//
// Şablon değişkenleri (servis): {{ad}} {{marka}} {{model}} {{ariza}}
//   {{servisNo}} {{ucret}}  (araç sektörü ayrıca {{plaka}} kullanır)
// Şablon değişkenleri (cari):   {{ad}} {{tutar}} {{bakiye}} {{durum}} {{aciklama}}

// `dev` = cihazın iyelikli (2. tekil çoğul) hali → "cihazınız", "ürününüz" gibi.
// Türkçe ek sorunlarını önlemek için metinlerde doğrudan bu hazır biçim kullanılır.
// Araç sektörlerinde (oto servis) cihaz yerine ARAÇ akar; metinler plaka içerir →
// buildVehicleServiceTemplates kullanılır (buildTemplatesForSector seçer).
function buildVehicleServiceTemplates() {
    return {
        intake:
            `Merhaba {{ad}},\n\n{{plaka}} plakalı {{marka}} {{model}} aracınız, "{{ariza}}" talebiyle {{servisNo}} numaralı kayıt ile servisimize alınmıştır.\n\nİyi günler dileriz.`,
        awaitingApproval:
            `Sayın {{ad}},\n\n{{plaka}} plakalı {{marka}} {{model}} aracınız için inceleme tamamlanmıştır.\nÜcret: {{ucret}} TL\n\nOnaylamak veya iade talep etmek için lütfen bizimle iletişime geçin.`,
        approvedParts:
            `Sayın {{ad}},\n\n{{plaka}} plakalı {{marka}} {{model}} aracınız için işlem onaylanmıştır. Gerekli parça/malzeme temin edilmektedir.\n\nİyi günler dileriz.`,
        inProgress:
            `Sayın {{ad}},\n\n{{plaka}} plakalı {{marka}} {{model}} aracınız işleme alınmıştır, çalışma başlamıştır.\n\nİyi günler dileriz.`,
        returnRequested:
            `Sayın {{ad}},\n\n{{plaka}} plakalı {{marka}} {{model}} aracınız için iade talebiniz alınmıştır. Teslim alabilirsiniz.\n\nİyi günler dileriz.`,
        repaired:
            `Sayın {{ad}},\n\n{{plaka}} plakalı {{marka}} {{model}} aracınız için işlem başarıyla tamamlanmıştır. Teslim alabilirsiniz.\n\nİyi günler dileriz.`,
        delivered:
            `Sayın {{ad}},\n\n{{plaka}} plakalı {{marka}} {{model}} aracınız teslim edilmiştir. Bizi tercih ettiğiniz için teşekkür ederiz!`,
    };
}

function buildServiceTemplates(dev) {
    return {
        intake:
            `Merhaba {{ad}},\n\n{{marka}} {{model}} ${dev}, "{{ariza}}" talebiyle {{servisNo}} numaralı kayıt ile teslim alınmıştır.\n\nİyi günler dileriz.`,
        awaitingApproval:
            `Sayın {{ad}},\n\n{{marka}} {{model}} ${dev} için inceleme tamamlanmıştır.\nÜcret: {{ucret}} TL\n\nOnaylamak veya iade talep etmek için lütfen bizimle iletişime geçin.`,
        approvedParts:
            `Sayın {{ad}},\n\n{{marka}} {{model}} ${dev} için işlem onaylanmıştır. Gerekli parça/malzeme temin edilmektedir.\n\nİyi günler dileriz.`,
        inProgress:
            `Sayın {{ad}},\n\n{{marka}} {{model}} ${dev} işleme alınmıştır, çalışma başlamıştır.\n\nİyi günler dileriz.`,
        returnRequested:
            `Sayın {{ad}},\n\n{{marka}} {{model}} ${dev} için iade talebiniz alınmıştır. Teslim alabilirsiniz.\n\nİyi günler dileriz.`,
        repaired:
            `Sayın {{ad}},\n\n{{marka}} {{model}} ${dev} için işlem başarıyla tamamlanmıştır. Teslim alabilirsiniz.\n\nİyi günler dileriz.`,
        delivered:
            `Sayın {{ad}},\n\n{{marka}} {{model}} ${dev} teslim edilmiştir. Bizi tercih ettiğiniz için teşekkür ederiz!`,
    };
}

// Cari hareket bildirimleri — sektörden bağımsız ortak metinler. Her hareket
// tipinin kendi şablonu vardır (ekstre/açık hesap bildirimi).
const ACCOUNT_TEMPLATES = {
    accountDebit:
        'Sayın {{ad}}, hesabınıza {{tutar}} TL borç işlenmiştir. Güncel bakiyeniz: {{bakiye}} TL ({{durum}}).',
    accountCredit:
        'Sayın {{ad}}, hesabınıza {{tutar}} TL alacak işlenmiştir. Güncel bakiyeniz: {{bakiye}} TL ({{durum}}).',
    accountCollection:
        'Sayın {{ad}}, {{tutar}} TL ödemeniz alınmıştır. Güncel bakiyeniz: {{bakiye}} TL ({{durum}}). Teşekkür ederiz.',
    accountPayment:
        'Sayın {{ad}}, tarafınıza {{tutar}} TL ödeme yapılmıştır. Güncel bakiyeniz: {{bakiye}} TL ({{durum}}).',
};

// Hangi şablonlar "servis akışı" mesajıdır (firma tipi servis vermiyorsa
// varsayılan kapalı gelir). Cari mesajları her sektörde geçerlidir.
const SERVICE_KEYS = ['intake', 'awaitingApproval', 'approvedParts', 'inProgress', 'returnRequested', 'repaired', 'delivered'];
const ACCOUNT_KEYS = ['accountDebit', 'accountCredit', 'accountCollection', 'accountPayment'];

// Sektör tanımları. `service: false` → servis (cihaz tamiri) yapmayan tipler
// (ör. toptancı); bunlarda servis mesajları varsayılan KAPALI gelir ama yine de
// düzenlenebilir kalır. `dev` metinlerdeki iyelikli cihaz/ürün sözcüğüdür.
const SECTORS = [
    { id: 'teknik_servis', label: 'Genel Teknik Servis', system: 'Teknik Servis Yönetim Sistemi', dev: 'cihazınız', service: true },
    { id: 'bilgisayar_servis', label: 'Bilgisayar / Laptop Servisi', system: 'Bilgisayar Servisi Yönetimi', dev: 'cihazınız', service: true },
    { id: 'telefon_servis', label: 'Telefon / Tablet Servisi', system: 'Telefon Servisi Yönetimi', dev: 'cihazınız', service: true },
    { id: 'beyaz_esya', label: 'Beyaz Eşya Servisi', system: 'Beyaz Eşya Servisi Yönetimi', dev: 'cihazınız', service: true },
    { id: 'klima_kombi', label: 'Klima & Kombi Servisi', system: 'Klima & Kombi Servisi', dev: 'cihazınız', service: true },
    { id: 'yazici_tamir', label: 'Yazıcı / Kartuş Servisi', system: 'Yazıcı Servisi Yönetimi', dev: 'yazıcınız', service: true },
    { id: 'kamera_montaj', label: 'Kamera & Güvenlik Sistemleri', system: 'Kamera & Güvenlik Yönetimi', dev: 'kamera sisteminiz', service: true },
    { id: 'saha_kurulum', label: 'Saha Kurulum / Montaj', system: 'Saha Kurulum & Montaj Yönetimi', dev: 'kurulumunuz', service: true },
    { id: 'elektronik_tamir', label: 'Elektronik / Genel Tamir', system: 'Elektronik Tamir Yönetimi', dev: 'cihazınız', service: true },
    // Oto sanayi: tamirci ARAÇ kabul eder (plaka/şasi/km, geçmiş plakayla); parçacı satış/cari ağırlıklı (OEM/uyumluluk).
    { id: 'oto_servis', label: 'Oto Servis / Tamir (Araç)', system: 'Oto Servis Yönetim Sistemi', dev: 'aracınız', service: true, vehicle: true },
    { id: 'oto_yedek_parca', label: 'Oto Yedek Parça (Satış / Cari)', system: 'Yedek Parça Satış Yönetimi', dev: 'ürününüz', service: false, parts: true },
    { id: 'toptanci', label: 'Toptancı / Bayi (Cari Ağırlıklı)', system: 'Toptan Satış & Cari Yönetimi', dev: 'ürününüz', service: false },
    { id: 'genel', label: 'Diğer / Genel İşletme', system: 'İşletme Yönetim Sistemi', dev: 'cihazınız', service: true },
];

const DEFAULT_SECTOR_ID = 'teknik_servis';

function getSector(id) {
    return SECTORS.find((s) => s.id === id) || SECTORS.find((s) => s.id === DEFAULT_SECTOR_ID);
}

// Bir sektör için tam şablon haritası: { key: { body, enabled } }.
// Servis mesajları: service:false sektörlerde kapalı. Cari mesajları: hepsi açık.
function buildTemplatesForSector(id) {
    const sec = getSector(id);
    const service = sec.vehicle ? buildVehicleServiceTemplates() : buildServiceTemplates(sec.dev);
    const out = {};
    for (const k of SERVICE_KEYS) out[k] = { body: service[k], enabled: sec.service !== false };
    for (const k of ACCOUNT_KEYS) out[k] = { body: ACCOUNT_TEMPLATES[k], enabled: true };
    return out;
}

// İstemciye gönderilecek hafif liste (id + etiket).
function listSectors() {
    return SECTORS.map(({ id, label, system, service, vehicle, parts }) => ({
        id, label, system, service, vehicle: !!vehicle, parts: !!parts,
    }));
}

module.exports = {
    SECTORS, SECTOR_KEYS: SERVICE_KEYS, SERVICE_KEYS, ACCOUNT_KEYS,
    ACCOUNT_TEMPLATES, DEFAULT_SECTOR_ID,
    getSector, buildTemplatesForSector, listSectors, buildServiceTemplates, buildVehicleServiceTemplates,
};
