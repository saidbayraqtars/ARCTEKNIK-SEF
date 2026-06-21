'use strict';
// ─── Birim testleri (DB GEREKMEZ — her ortamda koşar) ────────────────────────
// Çalıştırma: cd server && npm test
// Para/parse yolundaki saf fonksiyonlar: yuvarlama, kalem doğrulama, yazıcı
// hedefi temizliği, config şifreleme gidiş-dönüşü, telefon normalizasyonu.

const test = require('node:test');
const assert = require('node:assert/strict');

// restoran.js require'ı lisans servisini de yükler — HWID okuması test
// makinesinde sorunsuz; DB bağlantısı AÇILMAZ (yalnız modül grafiği).
const { parseItems, sanitizeTarget, round2 } = require('../routes/restoran');
const { encryptSecret, decryptSecret, isEncrypted } = require('../config/secret');
const { normalizePhone } = require('../utils/phone');

test('round2 — para yuvarlama', () => {
    assert.equal(round2(10.005), 10.01);
    assert.equal(round2(0.1 + 0.2), 0.3);        // IEEE754 artığı temizlenir
    assert.equal(round2('12.345'), 12.35);       // ondalık yarım yukarı
    assert.equal(round2(null), 0);
    assert.equal(round2(undefined), 0);
    assert.equal(round2(-5.555), -5.55);         // Math.round negatifte .5'i yukarı çeker
});

test('parseItems — tekli ürün gövdesi', () => {
    const r = parseItems({ productId: '7', quantity: '3', note: 'az pişsin', optionIds: ['1', 'x', 2] });
    assert.equal(r.error, undefined);
    assert.equal(r.items.length, 1);
    assert.deepEqual(r.items[0], { productId: 7, quantity: 3, note: 'az pişsin', optionIds: [1, 2] });
});

test('parseItems — toplu items[] (self-servis sepeti)', () => {
    const r = parseItems({ items: [
        { productId: 1, quantity: 2 },
        { name: 'Açık Kalem', unitPrice: '12.5', quantity: 1 },
    ] });
    assert.equal(r.error, undefined);
    assert.equal(r.items.length, 2);
    assert.equal(r.items[1].productId, null);
    assert.equal(r.items[1].unitPrice, 12.5);
});

test('parseItems — geçersiz girdiler reddedilir', () => {
    assert.ok(parseItems({ items: [] }).error);                              // boş sipariş
    assert.ok(parseItems({ productId: 1, quantity: 0 }).error);              // sıfır miktar
    assert.ok(parseItems({ productId: 1, quantity: -2 }).error);             // negatif miktar
    assert.ok(parseItems({ productId: 'abc' }).error);                       // bozuk ürün id
    assert.ok(parseItems({ name: '', unitPrice: 5 }).error);                 // adsız açık kalem
    assert.ok(parseItems({ name: 'X', unitPrice: -1 }).error);               // negatif fiyat
});

test('parseItems — not 300 karakterde kırpılır', () => {
    const r = parseItems({ productId: 1, note: 'a'.repeat(500) });
    assert.equal(r.items[0].note.length, 300);
});

test('sanitizeTarget — yazıcı hedefi temizliği', () => {
    assert.equal(sanitizeTarget('  Fırın  '), 'Fırın');
    assert.equal(sanitizeTarget(''), 'Mutfak');          // boş → güvenli varsayılan
    assert.equal(sanitizeTarget(null), 'Mutfak');
    assert.equal(sanitizeTarget('x'.repeat(80)).length, 40); // 40 char tavanı
});

test('secret — şifrele/çöz gidiş-dönüşü', () => {
    const enc = encryptSecret('Vega1234!çğüş');
    assert.ok(isEncrypted(enc));
    assert.equal(decryptSecret(enc), 'Vega1234!çğüş');
});

test('secret — düz metin olduğu gibi döner (geriye uyum)', () => {
    assert.equal(decryptSecret('plain-password'), 'plain-password');
    assert.equal(isEncrypted('plain-password'), false);
});

test('secret — çift sarmalama yok, boş güvenli', () => {
    const once = encryptSecret('abc');
    assert.equal(encryptSecret(once), once);     // zaten şifreli → dokunma
    assert.equal(encryptSecret(''), '');
    assert.equal(encryptSecret(null), '');
});

test('secret — bozuk şifreli değer boş döner (sihirbaz yeniden sorar)', () => {
    assert.equal(decryptSecret('enc:bozukbase64!!!'), '');
});

test('normalizePhone — Türkiye biçimleri', () => {
    // Kabul edilen tüm yazımlar aynı kanonik biçime inmeli.
    const variants = ['0532 123 45 67', '05321234567', '+90 532 123 45 67', '90 532 123 45 67', '532 123 45 67'];
    const canon = normalizePhone('05321234567');
    assert.ok(canon); // normalizasyon bir değer üretmeli
    for (const v of variants) {
        assert.equal(normalizePhone(v), canon, `farklı yazım aynı sonuca inmeli: ${v}`);
    }
});

test('autoBackup — config sınırları kelepçelenir', async (t) => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    // İzole veri klasörü → gerçek backup.json'a dokunma. enabled:false →
    // updateBackupConfig cron görevi KURMAZ (test süreci asılı kalmaz).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-test-'));
    process.env.TEKNIK_DATA_DIR = tmp;
    t.after(() => { delete process.env.TEKNIK_DATA_DIR; fs.rmSync(tmp, { recursive: true, force: true }); });

    const { updateBackupConfig, getBackupStatus } = require('../services/autoBackup');
    const cfg = updateBackupConfig({ enabled: false, hour: 99, minute: -5, keep: 100000, dir: 'D:\\Yedek' });
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.hour, 23);     // 0-23 kelepçesi
    assert.equal(cfg.minute, 0);    // 0-59 kelepçesi
    assert.equal(cfg.keep, 120);    // üst sınır
    assert.equal(cfg.dir, 'D:\\Yedek');

    const st = await getBackupStatus(); // DB yoksa lastBackupAt null döner, hata atmaz
    assert.equal(st.enabled, false);
    assert.equal(st.hour, 23);
});
