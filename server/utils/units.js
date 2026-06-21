'use strict';

// Desteklenen ölçü birimleri. 'Adet' tam sayı; KG/Metre/Litre küsuratlı (DECIMAL).
const ALLOWED_UNITS = ['Adet', 'KG', 'Metre', 'Litre'];

const normalizeUnit = (u) => {
    const s = String(u == null ? '' : u).trim();
    return ALLOWED_UNITS.includes(s) ? s : 'Adet';
};

// Miktarı birime göre normalize eder: Adet → tam sayı, diğerleri → 3 ondalık.
// Stocks/DocumentItems.Quantity DECIMAL(18,3)/(12,3) ile uyumlu.
const normalizeQuantity = (qty, unit) => {
    const n = Number(qty);
    if (!Number.isFinite(n)) return 0;
    if (normalizeUnit(unit) === 'Adet') return Math.round(n);
    return Math.round(n * 1000) / 1000;
};

module.exports = { ALLOWED_UNITS, normalizeUnit, normalizeQuantity };
