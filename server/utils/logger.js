'use strict';
// ─── Sunucu Loglama (electron-log/node) ──────────────────────────────────────
// Forklanan Node sunucu sürecinin kurumsal log mekanizması. Loglar kullanıcının
// veri klasöründe (Electron ana süreci TEKNIK_DATA_DIR ile geçer:
// AppData/Roaming/Bayraktar Yazilim Suite/logs) tarih damgalı + rotasyonlu tutulur.
//
// ÖNEMLİ: electron-log'un console transport'u orijinal console metodlarını
// require ANINDA (aşağıdaki require) yakalar. Bu modül yüklendikten SONRA global
// console.* yeniden atanırsa özyineleme (infinite loop) OLUŞMAZ — transport hâlâ
// orijinal stdout/stderr'e yazar. server.js bu güvenceye dayanarak console'u tee'ler.
const path = require('path');
const log = require('electron-log/node');

// Masaüstü modunda Electron userData yolunu verir; aksi halde (dev/CLI) cwd.
const dataDir = process.env.TEKNIK_DATA_DIR || process.cwd();
const logDir = path.join(dataDir, 'logs');

// Dosya transport — tarih damgalı, rotasyonlu (boyut tavanı aşılınca .old.log'a arşivler).
log.transports.file.resolvePathFn = () => path.join(logDir, 'server.log');
log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB → dosya şişmez
log.transports.file.level = 'info';
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';

// Konsol transport — stdout/stderr akışı korunur (Electron ana süreci portu buradan algılar).
log.transports.console.level = 'info';

// Yakalanmamış hatalar sessizce kaybolmasın — dosyaya 'error' seviyesinde düşsün.
process.on('uncaughtException', (err) => {
    log.error('uncaughtException:', err);
    // Mevcut çökme semantiğini koru → Electron ana süreci yeniden başlatma/uyarı akışını sürdürür.
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection:', reason);
});

module.exports = log;
