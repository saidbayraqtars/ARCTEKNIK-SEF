'use strict';
// ─── B2B Web Mağaza Senkronizasyon Servisi ──────────────────────────────────
// Stok değişikliklerinde (ekleme/güncelleme/satış-düşümü) "Web'de Göster"
// işaretli ürünleri firma bilgileriyle birlikte uzak web sitesine (Webhook/API)
// POST eder. TAMAMEN FAIL-SAFE: hedef site kapalı/yavaş olsa bile yerel sunucu
// asla çökmez veya beklemez (fire-and-forget + debounce + try-catch).

const { getPool } = require('../config/db');

const DEBOUNCE_MS = 1500;   // Art arda gelen değişiklikleri tek POST'ta topla
const TIMEOUT_MS = 10000;   // Hedef site yanıt vermezse iste­ği iptal et

let _debounceTimer = null;
let _inFlight = false;

async function loadConfig(pool) {
    const r = await pool.request().query(`
        SELECT TOP 1 CompanyName, Phone, Address, Email, Website, TaxOffice,
                     B2BApiEndpoint, B2BLicenseKey
        FROM CompanySettings WHERE Id = 1
    `);
    return r.recordset[0] || null;
}

async function loadWebProducts(pool) {
    const r = await pool.request().query(`
        SELECT StockID, Name, Barcode, Quantity, SalePrice, WebDescription
        FROM Stocks
        WHERE ShowOnWeb = 1
        ORDER BY Name ASC
    `);
    return r.recordset.map((p) => ({
        id: p.StockID,
        name: p.Name,
        barcode: p.Barcode || null,
        quantity: p.Quantity,
        price: p.SalePrice == null ? null : Number(p.SalePrice),
        description: p.WebDescription || '',
    }));
}

// Senkronizasyonu hemen yapar; sonuç nesnesi döner (test butonu için).
// Hiçbir koşulda exception fırlatmaz.
async function syncNow() {
    try {
        const pool = await getPool();
        const cfg = await loadConfig(pool);

        if (!cfg || !cfg.B2BApiEndpoint || !cfg.B2BApiEndpoint.trim()) {
            return { ok: false, skipped: true, error: 'B2B API adresi tanımlı değil.' };
        }

        const products = await loadWebProducts(pool);
        const body = JSON.stringify({
            company: {
                name: cfg.CompanyName || '',
                phone: cfg.Phone || '',
                address: cfg.Address || '',
                email: cfg.Email || '',
                website: cfg.Website || '',
                taxOffice: cfg.TaxOffice || '',
            },
            products,
            productCount: products.length,
            syncedAt: new Date().toISOString(),
        });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        let res;
        try {
            res = await fetch(cfg.B2BApiEndpoint.trim(), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // Lisans anahtarı iki standart başlıkta da gönderilir.
                    'Authorization': `Bearer ${cfg.B2BLicenseKey || ''}`,
                    'X-API-Key': cfg.B2BLicenseKey || '',
                },
                body,
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }

        if (!res.ok) {
            console.warn(`[B2B] Senkronizasyon başarısız: HTTP ${res.status}`);
            return { ok: false, status: res.status, error: `Sunucu HTTP ${res.status} döndü.` };
        }

        console.log(`[B2B] ${products.length} ürün web mağazasına senkronize edildi.`);
        return { ok: true, count: products.length };
    } catch (err) {
        // Hedef site kapalı / DNS / timeout / ağ hatası — sessizce logla, çökme.
        const msg = err.name === 'AbortError' ? 'Hedef site zaman aşımına uğradı.' : err.message;
        console.warn('[B2B] Senkronizasyon hatası (yoksayıldı):', msg);
        return { ok: false, error: msg };
    }
}

// Fire-and-forget tetikleyici: ana isteği ASLA bekletmez. Art arda gelen
// değişiklikleri debounce ile tek POST'ta birleştirir.
function triggerWebSync() {
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
        _debounceTimer = null;
        if (_inFlight) return;          // Önceki POST sürüyorsa bir sonraki tetikte gönderilir
        _inFlight = true;
        syncNow().finally(() => { _inFlight = false; });
    }, DEBOUNCE_MS);
    // Sunucu kapanışını bu zamanlayıcı engellemesin.
    if (_debounceTimer.unref) _debounceTimer.unref();
}

module.exports = { triggerWebSync, syncNow };
