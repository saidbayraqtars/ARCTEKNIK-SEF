'use strict';
// ─── Gerçek-zamanlı olay yayını (SSE) ────────────────────────────────────────
// Restoran terminalleri (masa planı, KDS, çağrı ekranı) polling yerine anlık
// güncellensin diye hafif bir Server-Sent Events katmanı. WebSocket'e göre
// avantajı: ek bağımlılık yok, Express üzerinde düz HTTP, LAN'da proxy derdi yok.
// İstemci kopması sorun değil — EventSource otomatik yeniden bağlanır ve
// terminaller polling'i yedek mekanizma olarak korur (SSE = hızlandırıcı).

const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(100); // çok terminal (kasa + garson + mutfak + çağrı) olabilir

// Restoran verisi değişti — dinleyen tüm ekranlar tazelesin.
// detail: { scope: 'orders' | 'kitchen' | 'floor' | 'menu', ... } (bilgi amaçlı)
function emitRestoran(detail) {
    try {
        bus.emit('restoran', detail || {});
    } catch { /* yayın hatası ana akışı asla bozmasın */ }
}

// Express handler: SSE akışı başlat. Kimlik doğrulaması ÇAĞIRAN rotada yapılır
// (EventSource header gönderemez → token query'den doğrulanır, bkz. restoran.js).
function sseHandler(req, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.write(': bagli\n\n');

    const onEvent = (detail) => {
        try {
            res.write(`data: ${JSON.stringify(detail || {})}\n\n`);
        } catch { /* kapanmış sokete yazma hatası — cleanup aşağıda */ }
    };
    bus.on('restoran', onEvent);

    // Ara kutular (proxy/antivirüs) boştaki bağlantıyı kesmesin diye kalp atışı.
    const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* yoksay */ }
    }, 25000);

    req.on('close', () => {
        clearInterval(heartbeat);
        bus.removeListener('restoran', onEvent);
    });
}

module.exports = { emitRestoran, sseHandler };
