'use strict';
const sql = require('mssql');
const { poolPromise } = require('../config/db');

// ─── Döviz Kurları — TCMB (Merkez Bankası) ────────────────────────────────────
// Belgeler (Teklif/Fatura) ve stok fiyatları yabancı para biriminde olabilir.
// Belge düzenlendiği günün TCMB kuru ile TL karşılığı hesaplanır.
//
// Kaynak: https://www.tcmb.gov.tr/kurlar/today.xml (bugün) veya
//         https://www.tcmb.gov.tr/kurlar/YYYYAA/GGAAYYYY.xml (geçmiş gün)
// Hafta sonu / resmi tatil günleri kur yayınlanmaz → en yakın önceki iş gününe
// geri yürünür. Çekilen kurlar ExchangeRates tablosunda önbelleğe alınır; böylece
// tekrar tekrar internete çıkılmaz ve internet yoksa son bilinen kur kullanılır.
//
// Karar: faturada TCMB "Döviz Alış" (ForexBuying) kuru kullanılır (muhasebede yaygın).

const SUPPORTED = ['USD', 'EUR', 'GBP']; // TRY baz alınır (kur = 1)
const ALL_CURRENCIES = ['TRY', ...SUPPORTED];
const RATE_KINDS = ['ForexBuying', 'ForexSelling', 'BanknoteBuying'];
const DEFAULT_KIND = 'ForexBuying';
const RATE_SOURCE = 'TCMB Döviz Alış';

const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

function normCurrency(cur) {
    return String(cur || '').trim().toUpperCase();
}
function isSupported(cur) {
    return ALL_CURRENCIES.includes(normCurrency(cur));
}

// Date | string → YYYY-MM-DD (yerel gün). issueDate genelde bugün olur.
function ymd(date) {
    const d = date ? new Date(date) : new Date();
    if (Number.isNaN(d.getTime())) return ymd(new Date());
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// TCMB geçmiş gün XML adresi: kurlar/YYYYAA/GGAAYYYY.xml
function tcmbHistoricUrl(ymdStr) {
    const [y, m, d] = ymdStr.split('-');
    return `https://www.tcmb.gov.tr/kurlar/${y}${m}/${d}${m}${y}.xml`;
}

// Düz/öngörülebilir TCMB XML'inden tek para biriminin değerlerini regex ile ayıkla.
// (Bağımlılık eklememek için; yapı sabit.) Unit (ör. JPY=100) varsa böl → 1 birim.
function parseCurrencyFromXml(xml, code) {
    const blockRe = new RegExp(`<Currency[^>]*\\bCurrencyCode="${code}"[^>]*>([\\s\\S]*?)</Currency>`, 'i');
    const block = blockRe.exec(xml);
    if (!block) return null;
    const body = block[1];
    const pick = (tag) => {
        const m = new RegExp(`<${tag}>\\s*([\\d.,]+)\\s*</${tag}>`, 'i').exec(body);
        if (!m) return null;
        const v = parseFloat(String(m[1]).replace(',', '.'));
        return Number.isFinite(v) ? v : null;
    };
    const unitM = /<Unit>\s*(\d+)\s*<\/Unit>/i.exec(body);
    const unit = unitM ? Math.max(1, parseInt(unitM[1], 10)) : 1;
    const div = (v) => (v == null ? null : round6(v / unit));
    return {
        ForexBuying: div(pick('ForexBuying')),
        ForexSelling: div(pick('ForexSelling')),
        BanknoteBuying: div(pick('BanknoteBuying')),
    };
}

// TCMB'nin yayın tarihini XML başlığından oku (Tarih_Date Date="AA/GG/YYYY").
function parseEffectiveDate(xml, fallbackYmd) {
    const m = /<Tarih_Date[^>]*\bDate="(\d{2})\/(\d{2})\/(\d{4})"/i.exec(xml);
    if (m) return `${m[3]}-${m[1]}-${m[2]}`; // Date="AA/GG/YYYY"
    return fallbackYmd;
}

async function httpGetText(url, timeoutMs = 6000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'BayraktarSuite' } });
        if (!res.ok) return null;
        return await res.text();
    } catch {
        return null;
    } finally {
        clearTimeout(t);
    }
}

// İstenen güne (veya öncesine) ait kurları TCMB'den çeker; iş günü değilse en
// yakın önceki güne (≤7 gün) geri yürür. Sonuç: { effectiveDate, rates:{USD:{...}} }.
async function fetchFromTcmb(requestedYmd) {
    const today = ymd(new Date());
    for (let back = 0; back <= 7; back++) {
        const d = new Date(`${requestedYmd}T12:00:00`);
        d.setDate(d.getDate() - back);
        const tryYmd = ymd(d);
        const url = (tryYmd === today && back === 0)
            ? 'https://www.tcmb.gov.tr/kurlar/today.xml'
            : tcmbHistoricUrl(tryYmd);
        const xml = await httpGetText(url);
        if (!xml || !/<Currency/i.test(xml)) continue;
        const rates = {};
        let any = false;
        for (const code of SUPPORTED) {
            const c = parseCurrencyFromXml(xml, code);
            if (c && c.ForexBuying) { rates[code] = c; any = true; }
        }
        if (any) return { effectiveDate: parseEffectiveDate(xml, tryYmd), rates };
    }
    return null;
}

// ── Önbellek (ExchangeRates) — istenen takvim günü anahtarlı ─────────────────
async function readCache(pool, requestedYmd) {
    const r = await pool.request()
        .input('d', sql.Date, requestedYmd)
        .query(`SELECT Currency, ForexBuying, ForexSelling, BanknoteBuying, EffectiveDate, Source
                FROM ExchangeRates WHERE RateDate = @d`);
    if (r.recordset.length === 0) return null;
    const rates = {};
    let effectiveDate = requestedYmd;
    for (const row of r.recordset) {
        rates[row.Currency] = {
            ForexBuying: row.ForexBuying != null ? Number(row.ForexBuying) : null,
            ForexSelling: row.ForexSelling != null ? Number(row.ForexSelling) : null,
            BanknoteBuying: row.BanknoteBuying != null ? Number(row.BanknoteBuying) : null,
        };
        if (row.EffectiveDate) effectiveDate = ymd(row.EffectiveDate);
    }
    // Tüm desteklenenler önbellekte mi?
    const complete = SUPPORTED.every((c) => rates[c] && rates[c].ForexBuying);
    return complete ? { effectiveDate, rates, source: r.recordset[0].Source || RATE_SOURCE } : null;
}

async function writeCache(pool, requestedYmd, effectiveDate, rates) {
    for (const code of SUPPORTED) {
        const c = rates[code];
        if (!c) continue;
        await pool.request()
            .input('d', sql.Date, requestedYmd)
            .input('cur', sql.NVarChar(5), code)
            .input('fb', sql.Decimal(18, 6), c.ForexBuying)
            .input('fs', sql.Decimal(18, 6), c.ForexSelling)
            .input('bb', sql.Decimal(18, 6), c.BanknoteBuying)
            .input('eff', sql.Date, effectiveDate)
            .input('src', sql.NVarChar(30), RATE_SOURCE)
            .query(`
                MERGE ExchangeRates AS t
                USING (SELECT @d AS RateDate, @cur AS Currency) AS s
                  ON t.RateDate = s.RateDate AND t.Currency = s.Currency
                WHEN MATCHED THEN UPDATE SET
                    ForexBuying=@fb, ForexSelling=@fs, BanknoteBuying=@bb,
                    EffectiveDate=@eff, Source=@src, FetchedAt=GETDATE()
                WHEN NOT MATCHED THEN INSERT
                    (RateDate, Currency, ForexBuying, ForexSelling, BanknoteBuying, EffectiveDate, Source, FetchedAt)
                    VALUES (@d, @cur, @fb, @fs, @bb, @eff, @src, GETDATE());
            `);
    }
}

// İnternet yoksa: en son bilinen kuru (en güncel EffectiveDate) döndür.
async function readLatestCache(pool) {
    const r = await pool.request().query(`
        SELECT e.Currency, e.ForexBuying, e.ForexSelling, e.BanknoteBuying, e.EffectiveDate
        FROM ExchangeRates e
        INNER JOIN (
            SELECT Currency, MAX(EffectiveDate) AS MaxEff FROM ExchangeRates GROUP BY Currency
        ) m ON m.Currency = e.Currency AND m.MaxEff = e.EffectiveDate
    `);
    if (r.recordset.length === 0) return null;
    const rates = {};
    let effectiveDate = null;
    for (const row of r.recordset) {
        rates[row.Currency] = {
            ForexBuying: row.ForexBuying != null ? Number(row.ForexBuying) : null,
            ForexSelling: row.ForexSelling != null ? Number(row.ForexSelling) : null,
            BanknoteBuying: row.BanknoteBuying != null ? Number(row.BanknoteBuying) : null,
        };
        const eff = ymd(row.EffectiveDate);
        if (!effectiveDate || eff > effectiveDate) effectiveDate = eff;
    }
    const complete = SUPPORTED.every((c) => rates[c] && rates[c].ForexBuying);
    return complete ? { effectiveDate, rates, source: 'TCMB (önbellek)', stale: true } : null;
}

// İstenen güne ait tüm desteklenen kurları getir (önbellek → TCMB → son bilinen).
async function getRates(date) {
    const requestedYmd = ymd(date);
    const pool = await poolPromise;

    const cached = await readCache(pool, requestedYmd);
    if (cached) return { date: requestedYmd, ...cached };

    const fetched = await fetchFromTcmb(requestedYmd);
    if (fetched) {
        try { await writeCache(pool, requestedYmd, fetched.effectiveDate, fetched.rates); } catch { /* önbellek best-effort */ }
        return { date: requestedYmd, effectiveDate: fetched.effectiveDate, rates: fetched.rates, source: RATE_SOURCE };
    }

    const latest = await readLatestCache(pool);
    if (latest) return { date: requestedYmd, ...latest };

    return null;
}

// Tek bir para biriminin TL karşılığı (1 birim = ? TRY). TRY → 1.
// kind: ForexBuying | ForexSelling | BanknoteBuying (varsayılan ForexBuying).
// Döner: { rate, source, effectiveDate, stale } veya null (kur bulunamadı).
async function getRate(currency, date, kind = DEFAULT_KIND) {
    const cur = normCurrency(currency);
    if (cur === 'TRY' || cur === '') return { rate: 1, source: 'TRY', effectiveDate: ymd(date), stale: false };
    if (!SUPPORTED.includes(cur)) return null;
    const k = RATE_KINDS.includes(kind) ? kind : DEFAULT_KIND;
    const data = await getRates(date);
    if (!data || !data.rates[cur]) return null;
    const rate = data.rates[cur][k] || data.rates[cur].ForexBuying;
    if (!rate) return null;
    return { rate: round6(rate), source: data.source || RATE_SOURCE, effectiveDate: data.effectiveDate, stale: !!data.stale };
}

module.exports = {
    SUPPORTED, ALL_CURRENCIES, RATE_KINDS, DEFAULT_KIND, RATE_SOURCE,
    isSupported, normCurrency, round6,
    getRates, getRate,
};
