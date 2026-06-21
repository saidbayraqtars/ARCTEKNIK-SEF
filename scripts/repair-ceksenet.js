#!/usr/bin/env node
'use strict';
// ─── TEK SEFERLİK: mevcut DB'ye demo çek/senet ekle ─────────────────────────
// seed-demo.js'in 8b bölümü sonradan eklendi; zaten tohumlanmış DB'lerde Çek/Senet
// ekranı boştu. Cari adına göre eşleyip ekler. CheckNo bazında çift-eklemeyi önler.
//   node scripts/repair-ceksenet.js
const path = require('path');
const sql = require(path.join(__dirname, '../server/node_modules/mssql'));
try { require(path.join(__dirname, '../server/node_modules/dotenv')).config({ path: path.join(__dirname, '../server/.env') }); } catch { /* */ }
const CFG = {
    server: process.env.SEED_DB_SERVER || process.env.DB_SERVER || 'localhost',
    user: process.env.SEED_DB_USER || process.env.DB_USER || 'sa',
    password: process.env.SEED_DB_PASSWORD || process.env.DB_PASSWORD || '',
    database: process.env.SEED_DB_NAME || process.env.DB_NAME || 'TEKNIKDB',
    options: { trustServerCertificate: true, encrypt: false },
};
if (!CFG.password) { console.error('HATA: DB şifresi yok.'); process.exit(1); }
const d = (daysAgo, hour = 11) => { const t = new Date(); t.setDate(t.getDate() - daysAgo); t.setHours(hour, 0, 0, 0); const p = (n) => String(n).padStart(2, '0'); return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}:00`; };

const notesPlan = [
    ['Cek',   'Alinan',  'Kemal Polat (Polat Market)',    1650,  18, 'Ziraat Bankası', '0042817', 'Kemal Polat',     'Portfoyde'],
    ['Cek',   'Alinan',  'Serkan Bulut (Bulut Kafe)',     1870,  35, 'İş Bankası',     '0091355', 'Serkan Bulut',    'Portfoyde'],
    ['Senet', 'Alinan',  'Yıldız Lojistik Ltd. Şti.',     2800,  60, null,             null,      'Yıldız Lojistik', 'Portfoyde'],
    ['Cek',   'Verilen', 'Teknopar Elektronik San. Tic.', 6000,  25, 'Garanti BBVA',   '0117204', 'ArcTeknik',       'Portfoyde'],
    ['Cek',   'Verilen', 'Global Parça İthalat',          5000,  -3, 'Akbank',         '0203918', 'ArcTeknik',       'Portfoyde'],
    ['Cek',   'Alinan',  'Serkan Bulut (Bulut Kafe)',     1200,  -8, 'İş Bankası',     '0077120', 'Serkan Bulut',    'Tahsil Edildi'],
];

(async () => {
    const pool = await sql.connect(CFG);
    let added = 0, skipped = 0;
    for (const [type, dir, cariName, amt, dueDays, bank, checkNo, drawer, status] of notesPlan) {
        const acc = (await pool.request().input('n', cariName).query('SELECT AccountID FROM CurrentAccounts WHERE Name = @n')).recordset[0];
        if (!acc) { console.log(`  ⚠ cari yok: ${cariName}`); skipped++; continue; }
        if (checkNo) {
            const dup = (await pool.request().input('c', checkNo).query('SELECT 1 FROM CekSenet WHERE CheckNo = @c')).recordset[0];
            if (dup) { skipped++; continue; }
        }
        const due = d(dueDays < 0 ? Math.abs(dueDays) : -dueDays, 0).slice(0, 10);
        await pool.request().query(`INSERT INTO CekSenet
            (Type, Direction, AccountID, Amount, Currency, ExchangeRate, AmountTRY, DueDate, BankName, CheckNo, Drawer, Status, CreatedBy, CreatedAt)
            VALUES (N'${type}', N'${dir}', ${acc.AccountID}, ${amt}, N'TRY', 1, ${amt}, '${due}',
                    ${bank ? `N'${bank}'` : 'NULL'}, ${checkNo ? `N'${checkNo}'` : 'NULL'}, ${drawer ? `N'${drawer}'` : 'NULL'},
                    N'${status}', N'admin', '${d(10, 11)}')`);
        added++;
    }
    const tot = (await pool.request().query('SELECT COUNT(*) c FROM CekSenet')).recordset[0].c;
    console.log(`✓ Çek/Senet eklendi: ${added}, atlanan: ${skipped}, toplam: ${tot}`);
    await pool.close();
})().catch((e) => { console.error('HATA:', e.message); process.exit(1); });
