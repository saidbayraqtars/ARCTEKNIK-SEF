'use strict';
/**
 * ArcTeknik Şef — demo veri tohumlayıcı (idempotent).
 *
 * Var olan veriyi SİLMEZ; yalnızca eksik olanı ada göre ekler:
 *   • zengin menü (kategori + ürün), içecekleri Bar yazıcısına yönlendirir
 *   • seçenek (opsiyon) grupları + opsiyonlar + ürün bağları
 *   • ek bölüm + masalar
 *   • TÜM masaları boşaltır, açık adisyonları iptal eder ("açık masa bırakma")
 *
 * Kullanım (Şef veritabanı için):
 *   DB_NAME=ARCSEFDB node server/scripts/seedSefDemo.js
 * Belirtilmezse .env'deki DB_NAME kullanılır.
 */
const sql = require('mssql');
require('dotenv').config();

const DB = process.env.DB_NAME_OVERRIDE || process.env.DB_NAME || 'ARCSEFDB';
const cfg = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER || 'localhost',
    database: DB,
    port: process.env.DB_PORT ? +process.env.DB_PORT : 1433,
    options: { encrypt: false, trustServerCertificate: true },
};

// ── Menü tanımı ──────────────────────────────────────────────────────────────
// printer: kategori → yazıcı hedefi (Mutfak / Bar). Var olan kategori de güncellenir.
const MENU = [
    { cat: 'Çorbalar', printer: 'Mutfak', items: [
        ['Mercimek Çorbası', 90], ['Ezogelin Çorbası', 90], ['Yayla Çorbası', 95], ['İşkembe Çorbası', 130],
    ] },
    { cat: 'Başlangıçlar', printer: 'Mutfak', items: [
        ['Humus', 90], ['Haydari', 80], ['Sigara Böreği', 120], ['Patates Kızartması', 90], ['Söğüş Tabağı', 110],
    ] },
    { cat: 'Salatalar', printer: 'Mutfak', items: [
        ['Mevsim Salata', 120], ['Çoban Salata', 110], ['Akdeniz Salata', 160], ['Sezar Salata', 180],
    ] },
    { cat: 'Izgaralar', printer: 'Mutfak', items: [
        ['Adana Kebap', 320], ['Urfa Kebap', 320], ['Izgara Köfte', 280], ['Tavuk Şiş', 260],
        ['Kuzu Şiş', 420], ['Karışık Izgara', 650],
    ] },
    { cat: 'Pide & Lahmacun', printer: 'Mutfak', items: [
        ['Kıymalı Pide', 220], ['Kaşarlı Pide', 200], ['Kuşbaşılı Pide', 260], ['Karışık Pide', 280], ['Lahmacun', 90],
    ] },
    { cat: 'Tatlılar', printer: 'Mutfak', items: [
        ['Künefe', 180], ['Sütlaç', 110], ['Baklava', 200], ['Profiterol', 150], ['Dondurma (3 Top)', 90],
    ] },
    { cat: 'Sıcak İçecekler', printer: 'Bar', items: [
        ['Çay', 25], ['Türk Kahvesi', 80], ['Espresso', 90], ['Latte', 110], ['Cappuccino', 110], ['Filtre Kahve', 95], ['Sahlep', 95],
    ] },
    { cat: 'Soğuk İçecekler', printer: 'Bar', items: [
        ['Su', 20], ['Soda', 30], ['Ayran', 35], ['Kola', 60], ['Meyve Suyu', 55], ['Limonata', 70], ['Şalgam', 40],
    ] },
];

// Var olan kategorilerin yazıcı hedefini düzelt (içecek → Bar).
const PRINTER_FIX = { 'alkol': 'Bar', 'kahve': 'Bar' };

// ── Seçenek grupları ───────────────────────────────────────────────────────
// link: hangi ÜRÜN adlarına bağlanacağı (ada göre, büyük/küçük harf duyarsız).
const OPTION_GROUPS = [
    { name: 'Pişirme Derecesi', min: 1, max: 1, opts: [['Az Pişmiş', 0], ['Orta', 0], ['İyi Pişmiş', 0]],
      link: ['Pirzola', 'Kuzu Şiş', 'Karışık Izgara', 'Izgara Köfte'] },
    { name: 'Ekstra Malzeme', min: 0, max: 5, opts: [['Ekstra Peynir', 30], ['Sucuk', 40], ['Mantar', 25], ['Yumurta', 20], ['Acı Sos', 10]],
      link: ['Kıymalı Pide', 'Kaşarlı Pide', 'Karışık Pide', 'Menemen'] },
    { name: 'İçecek Boyu', min: 1, max: 1, opts: [['Küçük', 0], ['Orta', 15], ['Büyük', 30]],
      link: ['Kola', 'Limonata', 'Meyve Suyu', 'Ayran'] },
    { name: 'Salata Sosu', min: 0, max: 1, opts: [['Sos İstemiyorum', 0], ['Limon', 0], ['Zeytinyağı', 0], ['Sezar Sos', 10]],
      link: ['Mevsim Salata', 'Çoban Salata', 'Akdeniz Salata', 'Sezar Salata'] },
];

// Ek salon bölümleri + masa sayıları (ada göre idempotent).
const SECTIONS = [
    { name: 'Teras', tables: 8 },
    { name: 'Üst Kat', tables: 6 },
];

let added = { cats: 0, prods: 0, groups: 0, opts: 0, links: 0, sections: 0, tables: 0, printerFix: 0 };

async function main() {
    const pool = await sql.connect(cfg);
    console.log(`→ Bağlanıldı: ${cfg.server}/${DB}`);

    // ── Kategori + ürün ──
    for (const { cat, printer, items } of MENU) {
        const catId = await getOrCreateCategory(pool, cat, printer);
        let sort = await nextProductSort(pool, catId);
        for (const [name, price] of items) {
            await getOrCreateProduct(pool, catId, name, price, sort++);
        }
    }

    // ── Var olan kategori yazıcı hedefi düzelt ──
    for (const [name, target] of Object.entries(PRINTER_FIX)) {
        const r = await pool.request().input('n', sql.NVarChar(100), name).input('t', sql.NVarChar(40), target)
            .query(`UPDATE RestoranCategories SET PrinterTarget=@t WHERE LOWER(Name)=LOWER(@n) AND (PrinterTarget IS NULL OR PrinterTarget<>@t)`);
        added.printerFix += r.rowsAffected[0] || 0;
    }

    // ── Seçenek grupları + opsiyonlar + bağlar ──
    for (const g of OPTION_GROUPS) {
        const gid = await getOrCreateGroup(pool, g.name, g.min, g.max);
        let os = 0;
        for (const [on, delta] of g.opts) await getOrCreateOption(pool, gid, on, delta, os++);
        for (const pName of g.link) {
            const pid = await findProductId(pool, pName);
            if (pid) await linkProductGroup(pool, pid, gid);
        }
    }

    // ── Ek bölüm + masa ──
    for (const s of SECTIONS) {
        const sid = await getOrCreateSection(pool, s.name);
        const have = (await pool.request().input('s', sql.Int, sid)
            .query(`SELECT TableNo FROM RestoranTables WHERE SectionID=@s`)).recordset.map(x => String(x.TableNo));
        for (let i = 1; i <= s.tables; i++) {
            const no = String(i);
            if (have.includes(no)) continue;
            await pool.request().input('s', sql.Int, sid).input('no', sql.NVarChar(20), no).input('so', sql.Int, i)
                .query(`INSERT INTO RestoranTables (SectionID, TableNo, Status, SortOrder) VALUES (@s, @no, N'Boş', @so)`);
            added.tables++;
        }
    }

    // ── "Açık masa bırakma": açık adisyonları iptal et + tüm masaları boşalt ──
    const cancelled = await pool.request()
        .query(`UPDATE RestoranOrders SET Status=N'İptal' WHERE Status=N'Açık'`);
    const freed = await pool.request()
        .query(`UPDATE RestoranTables SET Status=N'Boş', CurrentOrderID=NULL WHERE Status<>N'Boş' OR CurrentOrderID IS NOT NULL`);

    console.log('✓ Eklenen:', JSON.stringify(added));
    console.log(`✓ Açık adisyon iptal: ${cancelled.rowsAffected[0]} | Boşaltılan masa: ${freed.rowsAffected[0]}`);

    // Özet
    const sum = await pool.request().query(`
        SELECT (SELECT COUNT(*) FROM RestoranCategories) cats, (SELECT COUNT(*) FROM RestoranProducts) prods,
               (SELECT COUNT(*) FROM RestoranOptionGroups) grps, (SELECT COUNT(*) FROM RestoranOptions) opts,
               (SELECT COUNT(*) FROM RestoranProductOptionGroups) links, (SELECT COUNT(*) FROM RestoranTables) tables,
               (SELECT COUNT(*) FROM RestoranSections) sections`);
    console.log('Σ Toplam:', JSON.stringify(sum.recordset[0]));
    await pool.close();
}

// ── İdempotent yardımcılar ─────────────────────────────────────────────────
async function getOrCreateCategory(pool, name, printer) {
    const ex = await pool.request().input('n', sql.NVarChar(100), name)
        .query(`SELECT CategoryID FROM RestoranCategories WHERE LOWER(Name)=LOWER(@n)`);
    if (ex.recordset.length) {
        await pool.request().input('id', sql.Int, ex.recordset[0].CategoryID).input('t', sql.NVarChar(40), printer)
            .query(`UPDATE RestoranCategories SET PrinterTarget=@t WHERE CategoryID=@id AND (PrinterTarget IS NULL OR PrinterTarget=N'Mutfak')`);
        return ex.recordset[0].CategoryID;
    }
    const so = (await pool.request().query(`SELECT ISNULL(MAX(SortOrder),0)+1 s FROM RestoranCategories`)).recordset[0].s;
    const r = await pool.request().input('n', sql.NVarChar(100), name).input('so', sql.Int, so).input('t', sql.NVarChar(40), printer)
        .query(`INSERT INTO RestoranCategories (Name, SortOrder, PrinterTarget) OUTPUT INSERTED.CategoryID VALUES (@n, @so, @t)`);
    added.cats++;
    return r.recordset[0].CategoryID;
}

async function nextProductSort(pool, catId) {
    return (await pool.request().input('c', sql.Int, catId)
        .query(`SELECT ISNULL(MAX(SortOrder),0)+1 s FROM RestoranProducts WHERE CategoryID=@c`)).recordset[0].s;
}

async function getOrCreateProduct(pool, catId, name, price, sort) {
    const ex = await pool.request().input('c', sql.Int, catId).input('n', sql.NVarChar(150), name)
        .query(`SELECT ProductID FROM RestoranProducts WHERE CategoryID=@c AND LOWER(Name)=LOWER(@n)`);
    if (ex.recordset.length) return ex.recordset[0].ProductID;
    const r = await pool.request().input('c', sql.Int, catId).input('n', sql.NVarChar(150), name)
        .input('p', sql.Decimal(12, 2), price).input('so', sql.Int, sort)
        .query(`INSERT INTO RestoranProducts (CategoryID, Name, Price, IsActive, SortOrder, IsCombo)
                OUTPUT INSERTED.ProductID VALUES (@c, @n, @p, 1, @so, 0)`);
    added.prods++;
    return r.recordset[0].ProductID;
}

async function findProductId(pool, name) {
    const r = await pool.request().input('n', sql.NVarChar(150), name)
        .query(`SELECT TOP 1 ProductID FROM RestoranProducts WHERE LOWER(Name)=LOWER(@n) ORDER BY ProductID`);
    return r.recordset.length ? r.recordset[0].ProductID : null;
}

async function getOrCreateGroup(pool, name, min, max) {
    const ex = await pool.request().input('n', sql.NVarChar(100), name)
        .query(`SELECT GroupID FROM RestoranOptionGroups WHERE LOWER(Name)=LOWER(@n)`);
    if (ex.recordset.length) return ex.recordset[0].GroupID;
    const so = (await pool.request().query(`SELECT ISNULL(MAX(SortOrder),0)+1 s FROM RestoranOptionGroups`)).recordset[0].s;
    const r = await pool.request().input('n', sql.NVarChar(100), name).input('mn', sql.Int, min).input('mx', sql.Int, max).input('so', sql.Int, so)
        .query(`INSERT INTO RestoranOptionGroups (Name, MinSelect, MaxSelect, SortOrder) OUTPUT INSERTED.GroupID VALUES (@n, @mn, @mx, @so)`);
    added.groups++;
    return r.recordset[0].GroupID;
}

async function getOrCreateOption(pool, gid, name, delta, sort) {
    const ex = await pool.request().input('g', sql.Int, gid).input('n', sql.NVarChar(100), name)
        .query(`SELECT OptionID FROM RestoranOptions WHERE GroupID=@g AND LOWER(Name)=LOWER(@n)`);
    if (ex.recordset.length) return ex.recordset[0].OptionID;
    const r = await pool.request().input('g', sql.Int, gid).input('n', sql.NVarChar(100), name)
        .input('d', sql.Decimal(12, 2), delta).input('so', sql.Int, sort)
        .query(`INSERT INTO RestoranOptions (GroupID, Name, PriceDelta, SortOrder) OUTPUT INSERTED.OptionID VALUES (@g, @n, @d, @so)`);
    added.opts++;
    return r.recordset[0].OptionID;
}

async function linkProductGroup(pool, pid, gid) {
    const ex = await pool.request().input('p', sql.Int, pid).input('g', sql.Int, gid)
        .query(`SELECT 1 FROM RestoranProductOptionGroups WHERE ProductID=@p AND GroupID=@g`);
    if (ex.recordset.length) return;
    await pool.request().input('p', sql.Int, pid).input('g', sql.Int, gid)
        .query(`INSERT INTO RestoranProductOptionGroups (ProductID, GroupID) VALUES (@p, @g)`);
    added.links++;
}

async function getOrCreateSection(pool, name) {
    const ex = await pool.request().input('n', sql.NVarChar(100), name)
        .query(`SELECT SectionID FROM RestoranSections WHERE LOWER(Name)=LOWER(@n)`);
    if (ex.recordset.length) return ex.recordset[0].SectionID;
    const so = (await pool.request().query(`SELECT ISNULL(MAX(SortOrder),0)+1 s FROM RestoranSections`)).recordset[0].s;
    const r = await pool.request().input('n', sql.NVarChar(100), name).input('so', sql.Int, so)
        .query(`INSERT INTO RestoranSections (Name, SortOrder) OUTPUT INSERTED.SectionID VALUES (@n, @so)`);
    added.sections++;
    return r.recordset[0].SectionID;
}

main().catch((e) => { console.error('SEED HATASI:', e.message); process.exit(1); });
