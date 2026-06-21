#!/usr/bin/env node
'use strict';
/**
 * Yeni bir RSA-2048 anahtar çifti üretir.
 *
 * Kullanım:
 *   node scripts/generate-license-keys.js
 *
 * Çıktı:
 *   - license-manager/private.key  → güvende saklayın, asla dağıtmayın
 *   - Ekrana yazdırılan public key → server/services/license.js içine yapıştırın
 *
 * DİKKAT: Mevcut private.key'i değiştirirseniz, daha önce verilmiş tüm
 * lisanslar geçersiz kalır. Bunu yalnızca güvenlik ihlali şüphesinde yapın.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const privateKeyPath = path.join(__dirname, '..', 'license-manager', 'private.key');
fs.writeFileSync(privateKeyPath, privateKey, { encoding: 'utf8', mode: 0o600 });

console.log('\n✓ Private key yazıldı:', privateKeyPath);
console.log('\n─────────────────────────────────────────────────');
console.log('Aşağıdaki PUBLIC KEY\'i server/services/license.js dosyasındaki');
console.log('PUBLIC_KEY sabitine yapıştırın:\n');
console.log(publicKey);
console.log('─────────────────────────────────────────────────\n');
