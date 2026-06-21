'use strict';
// ─── ArcTeknik Şef — Online Sipariş Entegrasyon Altyapısı (Faz 3 iskeleti) ────
// Yemeksepeti / Getir / Trendyol / Migros gibi platformlar için EKLENEBİLİR
// adaptör katmanı. API anahtarı/sözleşme gelince her sağlayıcının normalizeOrder
// + verifyWebhook fonksiyonu doldurulur; çekirdek restoran akışı (restoran.js)
// bu katmandan HABERSİZ kalır (izolasyon). Kimlikler HWID-bağlı AES ile şifreli
// saklanır (config/secret.js · E maddesiyle aynı yöntem).
const sql = require('mssql');
const { getPool } = require('../config/db');
const { encryptSecret, decryptSecret } = require('../config/secret');

// Sağlayıcı kayıt defteri. fields → kontrol panelindeki yapılandırma formu.
// secret:true alanlar diske şifreli yazılır ve API'de maskelenir.
const PROVIDERS = {
    yemeksepeti: {
        key: 'yemeksepeti', name: 'Yemeksepeti',
        fields: [
            { key: 'vendorId', label: 'Restoran (Vendor) ID', secret: false },
            { key: 'apiKey', label: 'API Anahtarı', secret: true },
            { key: 'apiSecret', label: 'API Secret', secret: true },
            { key: 'webhookSecret', label: 'Webhook Doğrulama Anahtarı', secret: true },
        ],
    },
    getir: {
        key: 'getir', name: 'Getir Yemek',
        fields: [
            { key: 'restaurantId', label: 'Restoran ID', secret: false },
            { key: 'appSecret', label: 'App Secret', secret: true },
            { key: 'restaurantSecret', label: 'Restaurant Secret', secret: true },
        ],
    },
    trendyol: {
        key: 'trendyol', name: 'Trendyol Yemek',
        fields: [
            { key: 'supplierId', label: 'Tedarikçi (Supplier) ID', secret: false },
            { key: 'apiKey', label: 'API Key', secret: true },
            { key: 'apiSecret', label: 'API Secret', secret: true },
        ],
    },
    migros: {
        key: 'migros', name: 'Migros Yemek',
        fields: [
            { key: 'storeId', label: 'Mağaza ID', secret: false },
            { key: 'apiKey', label: 'API Key', secret: true },
            { key: 'apiSecret', label: 'API Secret', secret: true },
        ],
    },
};

const isKnown = (p) => Object.prototype.hasOwnProperty.call(PROVIDERS, p);

// Sağlayıcı meta verisi (gizli değer YOK) — kontrol paneli formu için.
function listProviders() {
    return Object.values(PROVIDERS).map((p) => ({
        key: p.key, name: p.name,
        fields: p.fields.map((f) => ({ key: f.key, label: f.label, secret: !!f.secret })),
    }));
}

// DB satırını oku → { enabled, config } (config çözülmüş). Yoksa null.
async function readRow(provider) {
    const pool = await getPool();
    const r = await pool.request()
        .input('p', sql.NVarChar(40), provider)
        .query(`SELECT Provider, Enabled, ConfigJson FROM RestoranIntegrations WHERE Provider = @p`);
    if (!r.recordset.length) return null;
    const row = r.recordset[0];
    let config = {};
    if (row.ConfigJson) {
        try { config = JSON.parse(decryptSecret(row.ConfigJson)) || {}; } catch { config = {}; }
    }
    return { enabled: !!row.Enabled, config };
}

// Sunucu içi kullanım — çözülmüş kimlikleri döner (webhook/adapter için).
async function getConfig(provider) {
    if (!isKnown(provider)) return null;
    const row = await readRow(provider);
    return row ? row.config : {};
}

async function isEnabled(provider) {
    if (!isKnown(provider)) return false;
    const row = await readRow(provider);
    return !!(row && row.enabled);
}

// Kontrol paneli durumu — gizli alanlar MASKELENİR (set mi değil mi görünür, değer GÖRÜNMEZ).
async function getStatus() {
    const out = [];
    for (const meta of Object.values(PROVIDERS)) {
        const row = await readRow(meta.key);
        const cfg = row ? row.config : {};
        const masked = {};
        for (const f of meta.fields) {
            const has = cfg[f.key] !== undefined && cfg[f.key] !== '';
            masked[f.key] = f.secret ? (has ? '••••••' : '') : (cfg[f.key] || '');
        }
        out.push({
            key: meta.key, name: meta.name,
            enabled: !!(row && row.enabled),
            configured: !!row && Object.keys(cfg).length > 0,
            fields: meta.fields.map((f) => ({ key: f.key, label: f.label, secret: !!f.secret })),
            values: masked,
        });
    }
    return out;
}

// Yapılandırmayı kaydet. Gizli alanlar maske (••••) gelirse MEVCUT değer korunur.
// Tüm ConfigJson tek blob olarak HWID-AES ile şifrelenir.
async function saveConfig(provider, { enabled, config }) {
    if (!isKnown(provider)) throw new Error('Bilinmeyen sağlayıcı: ' + provider);
    const meta = PROVIDERS[provider];
    const existing = (await readRow(provider))?.config || {};
    const merged = { ...existing };
    for (const f of meta.fields) {
        const incoming = config ? config[f.key] : undefined;
        if (incoming === undefined) continue;
        // Maskeli gizli değer geldiyse (kullanıcı dokunmadı) eskiyi koru.
        if (f.secret && /^[•*]+$/.test(String(incoming))) continue;
        merged[f.key] = incoming;
    }
    const blob = encryptSecret(JSON.stringify(merged));
    const pool = await getPool();
    await pool.request()
        .input('p', sql.NVarChar(40), provider)
        .input('en', sql.Bit, enabled ? 1 : 0)
        .input('cfg', sql.NVarChar(sql.MAX), blob)
        .query(`
            MERGE RestoranIntegrations AS t
            USING (SELECT @p AS Provider) AS s ON t.Provider = s.Provider
            WHEN MATCHED THEN UPDATE SET Enabled = @en, ConfigJson = @cfg, UpdatedAt = GETDATE()
            WHEN NOT MATCHED THEN INSERT (Provider, Enabled, ConfigJson, UpdatedAt)
                VALUES (@p, @en, @cfg, GETDATE());
        `);
    return getStatus();
}

// ── Adaptör kancaları — API anahtarı gelince doldurulacak ──────────────────
// Dış webhook imzasını doğrula. Şu an her sağlayıcı için NOT_IMPLEMENTED.
function verifyWebhook(/* provider, req, config */) {
    return false;
}

// Dış platform sipariş yükünü RestoranOrders/RestoranOrderItems modeline çevir.
// Doldurulunca restoran.js'teki insertOrderItems/package-order kalıbını kullanır.
function normalizeOrder(provider /*, payload, config */) {
    const err = new Error('NOT_IMPLEMENTED');
    err.code = 'NOT_IMPLEMENTED';
    err.provider = provider;
    throw err;
}

module.exports = {
    PROVIDERS, isKnown, listProviders, getStatus, getConfig, isEnabled,
    saveConfig, verifyWebhook, normalizeOrder,
};
