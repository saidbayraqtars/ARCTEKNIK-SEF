'use strict';
// ─── Entegrasyon testleri — PARA YOLU (gerçek SQL Server gerekir) ────────────
// Uçtan uca: masa adisyonu → mutfak → tahsilat; self-servis → çağrı → teslim;
// bedelsiz (ikram) kapanış; Z raporu; tarih-aralığı raporu (garson join
// regresyonu); KVKK anonimleştirme. Tamamı GERÇEK Express + GERÇEK MSSQL üzerinde.
//
// Çalıştırma (scratch ARCSEF_TEST veritabanı DÜŞÜRÜLÜR ve yeniden kurulur):
//   cd server
//   set ARC_TEST_DB=1& set DB_SERVER=localhost\SQLEXPRESS& set DB_USER=sa& set DB_PASSWORD=...& npm test
// Windows kimlik doğrulaması ile: DB_USE_WINDOWS_AUTH=1 (DB_USER/PASSWORD gerekmez).
// ARC_TEST_DB=1 yoksa bu dosya tamamen ATLANIR (CI'sız makinede npm test yine yeşil).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RUN = process.env.ARC_TEST_DB === '1';

// ── Ortam — TÜM server modüllerinden ÖNCE kurulmalı (DB_NAME require anında
// yakalanır; bkz. config/bootstrapDb.js). Bu yüzden require'lar testin içinde.
const TEST_DB = 'ARCSEF_TEST';
function prepareEnv() {
    process.env.DB_NAME = TEST_DB;
    process.env.NODE_ENV = 'test';
    process.env.APP_EDITION = 'restaurant';        // reminders/whatsapp yüklenmez
    process.env.ARC_TEST_BYPASS_LICENSE = '1';     // lisans kapısı test kaçışı (yalnız üretim dışı)
    process.env.SEED_DEFAULT_ADMIN = '1';          // admin / admin123
    process.env.PORT = '0';                        // geçici port
    delete process.env.DESKTOP_MODE;
    delete process.env.APP_ROLE;
    // İzole veri klasörü: backup.json {enabled:false} → autoBackup cron kurulmaz,
    // test süreci asılı kalmaz; .env yok → dotenv sessiz geçer, env'imiz bozulmaz.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-int-'));
    fs.writeFileSync(path.join(tmp, 'backup.json'), JSON.stringify({ enabled: false }), 'utf8');
    process.env.TEKNIK_DATA_DIR = tmp;
    return tmp;
}

// Scratch veritabanını düşür (temiz başlangıç — Z/rapor toplamları deterministik).
async function dropTestDb() {
    const sql = require('mssql');
    const { buildConfig } = require('../config/bootstrapDb');
    const master = await new sql.ConnectionPool(buildConfig('master')).connect();
    try {
        await master.request().query(`
            IF DB_ID(N'${TEST_DB}') IS NOT NULL
            BEGIN
                ALTER DATABASE [${TEST_DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
                DROP DATABASE [${TEST_DB}];
            END
        `);
    } finally {
        await master.close();
    }
}

test('restoran para yolu — uçtan uca', { skip: !RUN && 'ARC_TEST_DB=1 değil — DB entegrasyonu atlandı' }, async (t) => {
    const tmp = prepareEnv();
    await dropTestDb();

    const { startNormalServer } = require('../server');
    const { server } = await startNormalServer();
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}/api`;

    let token = '';
    const call = async (method, p, body, expectOk = true) => {
        const res = await fetch(base + p, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        let data = null;
        try { data = await res.json(); } catch { /* gövdesiz */ }
        if (expectOk) assert.ok(res.ok, `${method} ${p} → ${res.status}: ${JSON.stringify(data)}`);
        return { status: res.status, data };
    };

    t.after(async () => {
        try { server.close(); } catch { /* zaten kapalı */ }
        try { const { getPool } = require('../config/db'); (await getPool()).close(); } catch { /* yoksay */ }
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* kilitliyse kalsın */ }
    });

    // ── Oturum ────────────────────────────────────────────────────────────────
    const login = await call('POST', '/auth/login', { username: 'admin', password: 'admin123' });
    token = login.data.token;
    assert.ok(token, 'login token dönmeli');

    // ── Katalog kur (bölüm, 2 masa, 2 kategori → 2 yazıcı hedefi, 2 ürün) ────
    const sec = await call('POST', '/restoran/sections', { name: 'Salon' });
    const t1 = await call('POST', '/restoran/tables', { sectionId: sec.data.id, tableNo: '1' });
    const t2 = await call('POST', '/restoran/tables', { sectionId: sec.data.id, tableNo: '2' });
    const catM = await call('POST', '/restoran/categories', { name: 'Pideler', printerTarget: 'Mutfak' });
    const catB = await call('POST', '/restoran/categories', { name: 'İçecekler', printerTarget: 'Bar' });
    const pide = await call('POST', '/restoran/products', { name: 'Kıymalı Pide', price: 100, categoryId: catM.data.id });
    const kola = await call('POST', '/restoran/products', { name: 'Kutu Kola', price: 30, categoryId: catB.data.id });

    // ── 1) MASA AKIŞI: 2x pide → mutfağa gönder → Nakit 250 ile kapat ────────
    await call('POST', `/restoran/tables/${t1.data.id}/items`, { productId: pide.data.id, quantity: 2, guestCount: 3 });
    const sk1 = await call('POST', `/restoran/orders/0/send-kitchen`, undefined, false); // sağlamlık: bozuk id 400
    assert.equal(sk1.status, 400);

    const ord1 = await call('GET', `/restoran/tables/${t1.data.id}/order`);
    const orderId1 = ord1.data.order.orderId;
    assert.equal(Number(ord1.data.order.total), 200);

    const send1 = await call('POST', `/restoran/orders/${orderId1}/send-kitchen`);
    assert.equal(send1.data.label, 'MASA 1');
    assert.equal(send1.data.groups.length, 1);
    assert.equal(send1.data.groups[0].target, 'Mutfak');

    const pay1 = await call('POST', `/restoran/orders/${orderId1}/checkout`, { paymentMethod: 'Nakit', received: 250 });
    assert.equal(pay1.data.orderClosed, true);
    assert.equal(pay1.data.paidAmount, 200);
    assert.equal(pay1.data.change, 50);

    // ── 2) SELF-SERVİS AKIŞI: #1 numara → mutfak → çağrı panosu → teslim ─────
    const self1 = await call('POST', '/restoran/self-orders');
    assert.equal(self1.data.orderNo, 1, 'gün içi ilk self sipariş #1 olmalı');
    const selfId = self1.data.orderId;

    await call('POST', `/restoran/orders/${selfId}/items`, {
        items: [
            { productId: pide.data.id, quantity: 1 },
            { productId: kola.data.id, quantity: 2 },
        ],
    });
    const send2 = await call('POST', `/restoran/orders/${selfId}/send-kitchen`);
    assert.equal(send2.data.label, 'SİPARİŞ #1');
    const targets = send2.data.groups.map((g) => g.target).sort();
    assert.deepEqual(targets, ['Bar', 'Mutfak'], 'combo gibi hedef bazlı ayrışmalı (pide→Mutfak, kola→Bar)');

    const pay2 = await call('POST', `/restoran/orders/${selfId}/checkout`, { paymentMethod: 'Kredi Kartı' });
    assert.equal(pay2.data.paidAmount, 160);
    assert.equal(pay2.data.orderClosed, false, 'self sipariş teslimata kadar AÇIK kalmalı');
    assert.equal(pay2.data.orderNo, 1);

    let board = await call('GET', '/restoran/self-orders/board');
    assert.equal(board.data.preparing.length, 1);
    assert.equal(board.data.ready.length, 0);

    // Mutfak: self kalemleri görünür (ödenmiş olsa bile) → hepsini Hazır yap.
    const kds = await call('GET', '/restoran/kitchen');
    const selfItems = kds.data.filter((i) => i.orderId === selfId);
    assert.equal(selfItems.length, 2, 'self kalemleri KDS\'de görünmeli (peşin ödendi)');
    assert.equal(selfItems[0].orderNo, 1);
    for (const it of selfItems) {
        await call('PATCH', `/restoran/items/${it.itemId}`, { kitchenStatus: 'Hazır' });
    }

    board = await call('GET', '/restoran/self-orders/board');
    assert.equal(board.data.ready.length, 1, 'tüm kalemler Hazır → çağrı ekranında HAZIR');
    assert.equal(board.data.ready[0].orderNo, 1);

    // Ödenmemiş self sipariş teslim EDİLEMEZ (para yolu atlanamaz).
    const self2 = await call('POST', '/restoran/self-orders');
    assert.equal(self2.data.orderNo, 2, 'numara gün içinde artmalı');
    const badDeliver = await call('POST', `/restoran/orders/${self2.data.orderId}/deliver`, undefined, false);
    assert.equal(badDeliver.status, 400);

    await call('POST', `/restoran/orders/${selfId}/deliver`);
    board = await call('GET', '/restoran/self-orders/board');
    assert.equal(board.data.ready.length, 0, 'teslim edilen panodan düşmeli');

    // ── 3) BEDELSİZ KAPANIŞ (İkram): ciroya yazmaz, Z'de ayrı görünür ────────
    await call('POST', `/restoran/tables/${t2.data.id}/items`, { productId: pide.data.id, quantity: 1 });
    const ord2 = await call('GET', `/restoran/tables/${t2.data.id}/order`);
    const pay3 = await call('POST', `/restoran/orders/${ord2.data.order.orderId}/checkout`, { compType: 'İkram' });
    assert.equal(pay3.data.paidAmount, 0);
    assert.equal(pay3.data.compAmount, 100);

    // ── 4) GÜN SONU (Z): Nakit 200 + KK 160 = 360; ikram 100 ciro DIŞI ───────
    const z = await call('GET', '/restoran/summary');
    assert.equal(z.data.cash, 200);
    assert.equal(z.data.card, 160);
    assert.equal(z.data.total, 360);
    assert.equal(z.data.compTreat, 100);
    assert.equal(z.data.compTotal, 100);

    // ── 5) RAPOR (garson join REGRESYONU — eskiden 500 veriyordu) ────────────
    const rep = await call('GET', '/restoran/reports');
    assert.equal(rep.status, 200);
    assert.ok(Array.isArray(rep.data.byWaiter) && rep.data.byWaiter.length >= 1, 'garson kırılımı dönmeli');
    assert.equal(rep.data.byWaiter[0].name, 'Yönetici', 'OpenedBy adı doğrudan raporlanmalı');
    assert.equal(rep.data.totals.revenue, 360);

    // ── 6) KVKK: restoran müşterisi anonimleştirme ───────────────────────────
    const cust = await call('POST', '/restoran/customers', { name: 'Test Kişi', phone: '05001112233' });
    await call('POST', `/restoran/customers/${cust.data.id}/anonymize`);
    const after = await call('GET', `/restoran/customers/${cust.data.id}`);
    assert.ok(String(after.data.name).startsWith('SİLİNMİŞ'), 'ad anonimleşmeli');
    assert.ok(!after.data.phone, 'telefon silinmeli');

    // ── 7) SSE ucu: token'sız 401 (kimliksiz akış açılmaz) ───────────────────
    const sse = await fetch(`${base}/restoran/events`);
    assert.equal(sse.status, 401);
});
