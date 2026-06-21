#!/usr/bin/env node
'use strict';
// ─── TEK SEFERLİK ONARIM: AccountBalances backfill ──────────────────────────
// Özet kartları (Toplam Alacak/Borç) AccountBalances'tan okur. Eski demo seed'i
// (8. bölüm) bu tabloya yazmadığı için kartlar ₺0,00 görünüyordu. Bu script,
// HİÇ bakiye satırı OLMAYAN carilere kendi biriminde tek satır ekler (migration
// backfill ile aynı). Çok-birimli mevcut satırlara DOKUNMAZ. İdempotent.
//   node scripts/repair-account-balances.js
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
if (!CFG.password) { console.error('HATA: DB şifresi yok (SEED_DB_PASSWORD).'); process.exit(1); }

(async () => {
    const pool = await sql.connect(CFG);
    const before = (await pool.request().query('SELECT COUNT(*) AS c FROM AccountBalances')).recordset[0].c;
    const r = await pool.request().query(`
        INSERT INTO AccountBalances (AccountID, Currency, Balance, UpdatedAt)
        SELECT ca.AccountID, ISNULL(NULLIF(LTRIM(RTRIM(ca.Currency)), ''), 'TRY'), ca.Balance, GETDATE()
        FROM CurrentAccounts ca
        WHERE NOT EXISTS (SELECT 1 FROM AccountBalances ab WHERE ab.AccountID = ca.AccountID);
    `);
    const after = (await pool.request().query('SELECT COUNT(*) AS c FROM AccountBalances')).recordset[0].c;
    console.log(`✓ Eklenen bakiye satırı: ${r.rowsAffected[0]}  (önce ${before} → sonra ${after})`);
    await pool.close();
})().catch((e) => { console.error('HATA:', e.message); process.exit(1); });
