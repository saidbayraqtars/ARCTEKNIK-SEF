#!/usr/bin/env node
'use strict';
// ─── Bayraktar Yazilim Suite — Tek Komut Yayın (auto-update) ─────────────────
// Kullanım:
//   node scripts/release.js              → patch artır + yayınla (1.8.0 → 1.8.1)
//   node scripts/release.js minor        → 1.8.0 → 1.9.0
//   node scripts/release.js major        → 1.8.0 → 2.0.0
//   node scripts/release.js 1.8.0        → sürümü AYNEN ayarla (baseline ilk yayın için)
//
// Yaptıkları:
//   1) desktop/package.json version'ı artırır (semver)
//   2) client/dist'i tazeler (vite build)
//   3) electron-builder --publish always → installer+latest.yml GitHub Releases'e yüklenir
//      (repo: saidbayraqtars/ARCTEKNIK-SUITE-releases — PUBLIC, müşteri token'sız indirir)
//
// ÖN KOŞUL: $env:GH_TOKEN ayarlı olmalı (repo yetkili token). Koda GÖMÜLMEZ.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DESKTOP_PKG = path.join(ROOT, 'desktop', 'package.json');

const arg = (process.argv[2] || 'patch').trim();

function nextVersion(current, kind) {
    const m = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!m) throw new Error(`Mevcut sürüm semver değil: ${current}`);
    const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (kind === 'major') return `${maj + 1}.0.0`;
    if (kind === 'minor') return `${maj}.${min + 1}.0`;
    if (kind === 'patch') return `${maj}.${min}.${pat + 1}`;
    if (/^\d+\.\d+\.\d+$/.test(kind)) return kind; // açık sürüm (baseline)
    throw new Error(`Geçersiz argüman: "${kind}". Beklenen: patch | minor | major | x.y.z`);
}

if (!process.env.GH_TOKEN) {
    console.error('HATA: GH_TOKEN ortam değişkeni yok — GitHub yayını yapılamaz.');
    console.error('PowerShell: $env:GH_TOKEN = "ghp_xxxx"  (Settings → Developer settings → Tokens, repo yetkisi)');
    process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(DESKTOP_PKG, 'utf8'));
const oldV = pkg.version;
const newV = nextVersion(oldV, arg);
pkg.version = newV;
fs.writeFileSync(DESKTOP_PKG, JSON.stringify(pkg, null, 2) + '\n');
console.log(`\n=== Yayın: ${oldV} → ${newV} ===`);

const run = (cmd, cwd) => {
    console.log(`\n$ ${cmd}  (${path.relative(ROOT, cwd) || '.'})`);
    execSync(cmd, { cwd, stdio: 'inherit' });
};

try {
    run('npm run build', path.join(ROOT, 'client'));      // client/dist tazele
    run('npm run release', path.join(ROOT, 'desktop'));   // electron-builder --publish always
} catch (err) {
    // Yayın başarısızsa version'ı geri al (yarı-yayın kalmasın)
    pkg.version = oldV;
    fs.writeFileSync(DESKTOP_PKG, JSON.stringify(pkg, null, 2) + '\n');
    console.error(`\n✗ Yayın başarısız. Sürüm ${oldV}'a geri alındı.`);
    process.exit(1);
}

console.log(`\n✓ ${newV} yayınlandı → GitHub Releases (saidbayraqtars/ARCTEKNIK-SUITE-releases).`);
console.log('  Müşteriler uygulamayı bir sonraki açışta güncellemeyi otomatik alır.');
