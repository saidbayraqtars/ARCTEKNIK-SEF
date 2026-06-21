// ArcTeknik Şef — sessiz (silent) termal yazdırma yardımcıları.
//
// Tarayıcıda (geliştirme / web) köprü yoktur → çağıran taraf window.print()
// diyaloğuna düşer. Masaüstü (Electron) sürümünde erp-preload.js
// `bayraktarDesktop.silentPrint({ html, deviceName })` köprüsünü açar; bu modül
// her fiş için tam bir HTML belgesi üretip ana sürece yollar, ana süreç de
// Windows yazdırma diyaloğu ÇIKMADAN tanımlı yazıcıdan basar.
//
// Yazıcı eşlemesi terminal başına saklanır (localStorage). Çünkü her kasa/cihaz
// kendi fiziksel yazıcısına basar (Mutfak fişi mutfak yazıcısına, hesap fişi
// kasa yazıcısına). Bu "terminal başına ayar" tasarımıdır.

const fmt = (v) =>
  `${(Number(v) || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TL`;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// RestaurantPrint.jsx @media print kuralı ile aynı görsel kalıp (80mm termal).
const RECEIPT_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  #r { width: 76mm; font-family: 'Courier New', monospace; color: #000; font-size: 12px; padding: 4px 6px; }
  .c { text-align: center; }
  .row { display: flex; justify-content: space-between; }
  .hr { border-top: 1px dashed #000; margin: 4px 0; }
  .b { font-weight: 700; }
  .big { font-size: 16px; }
  .note { font-style: italic; }
`;

const wrap = (inner) =>
  `<!doctype html><html lang="tr"><head><meta charset="utf-8"><style>${RECEIPT_CSS}</style></head>` +
  `<body><div id="r">${inner}</div></body></html>`;

const when = (at) => new Date(at || Date.now()).toLocaleString('tr-TR');

// ── Fiş gövdeleri (RestaurantPrint.jsx markup'ının düz HTML karşılığı) ────────
function kitchenGroupBody(job, g) {
  const items = (g.items || [])
    .map(
      (it) =>
        `<div style="margin-bottom:4px"><div class="b big">${esc(it.quantity)} x ${esc(it.name)}</div>` +
        (it.options ? `<div>+ ${esc(it.options)}</div>` : '') +
        (it.note ? `<div class="note">» ${esc(it.note)}</div>` : '') +
        `</div>`
    )
    .join('');
  // Başlık: sunucudan gelen etiket (MASA 4 / SİPARİŞ #42 / PAKET — Ali) öncelikli;
  // eski istemciler için tableNo'ya düşülür.
  const heading = job.label || (job.tableNo != null ? `MASA ${job.tableNo}` : 'SİPARİŞ');
  return (
    `<div class="c b big">${esc(g.target || 'MUTFAK')}</div>` +
    `<div class="c b">SİPARİŞ FİŞİ</div>` +
    `<div class="hr"></div>` +
    `<div class="row b big"><span>${esc(heading)}</span>` +
    `${job.guestCount ? `<span>${esc(job.guestCount)} kişi</span>` : ''}</div>` +
    `<div class="c">${when(job.at)}</div>` +
    `<div class="hr"></div>${items}<div class="hr"></div>`
  );
}

function billBody(job, company) {
  const name = company?.CompanyName || 'ArcTeknik Şef';
  const lines = (job.lines || [])
    .map(
      (l) =>
        `<div style="margin-bottom:2px"><div>${esc(l.name)}${l.treat ? ' (İKRAM)' : ''}</div>` +
        (l.options ? `<div style="font-size:11px">+ ${esc(l.options)}</div>` : '') +
        `<div class="row"><span>${esc(l.quantity)} x ${fmt(l.unitPrice)}</span>` +
        `<span>${l.treat ? '0,00 TL' : fmt(l.unitPrice * l.quantity)}</span></div></div>`
    )
    .join('');
  const discount =
    job.discount > 0
      ? `<div class="row"><span>Ara Toplam</span><span>${fmt(job.subtotal)}</span></div>` +
        `<div class="row"><span>İndirim</span><span>- ${fmt(job.discount)}</span></div>`
      : '';
  // Self-servis fişinde sipariş numarası DEVASA basılır — müşteri çağrı
  // ekranından bu numarayla yemeğini alır (McDonald's numaratör düzeni).
  const heading = job.orderNo != null
    ? `<div class="c b" style="font-size:28px;margin:4px 0">SİPARİŞ NO: ${esc(job.orderNo)}</div>`
    : `<div class="row b"><span>${esc(job.label || `MASA ${job.tableNo ?? ''}`)}</span>` +
      `${job.guestCount ? `<span>${esc(job.guestCount)} kişi</span>` : ''}</div>`;
  return (
    `<div class="c b big">${esc(name)}</div>` +
    (company?.Phone ? `<div class="c">${esc(company.Phone)}</div>` : '') +
    (company?.Address ? `<div class="c">${esc(company.Address)}</div>` : '') +
    `<div class="hr"></div>` +
    heading +
    `<div class="c">${when(job.at)}</div>` +
    `<div class="c b" style="font-size:11px">${job.type === 'preview' ? 'ÖN HESAP / PUSULA — MALİ DEĞERİ YOKTUR' : 'HESAP FİŞİ (Mali değeri yoktur)'}</div>` +
    `<div class="hr"></div>${lines}<div class="hr"></div>${discount}` +
    `<div class="row b big"><span>TOPLAM</span><span>${fmt(job.total)}</span></div>` +
    `<div class="hr"></div>` +
    (job.type !== 'preview'
      ? (job.paymentMethod ? `<div class="row"><span>Ödeme</span><span>${esc(job.paymentMethod)}</span></div>` : '') +
        (job.received != null ? `<div class="row"><span>Alınan</span><span>${fmt(job.received)}</span></div>` : '') +
        (job.change != null ? `<div class="row"><span>Para Üstü</span><span>${fmt(job.change)}</span></div>` : '') +
        `<div class="hr"></div>`
      : '') +
    `<div class="c">${job.type === 'preview' ? 'Bu bir ön hesaptır. Mali değeri yoktur.' : 'Afiyet olsun · Teşekkürler!'}</div>`
  );
}

function summaryBody(job, company) {
  const name = company?.CompanyName || 'ArcTeknik Şef';
  const s = job.summary;
  return (
    `<div class="c b big">${esc(name)}</div>` +
    `<div class="c b">GÜN SONU (Z) RAPORU</div>` +
    `<div class="c">${esc(s.date)}</div>` +
    `<div class="hr"></div>` +
    `<div class="row"><span>Adisyon (kapanan)</span><span>${esc(s.orders)}</span></div>` +
    `<div class="row"><span>Toplam kişi</span><span>${esc(s.guests)}</span></div>` +
    `<div class="hr"></div>` +
    `<div class="row"><span>Nakit</span><span>${fmt(s.cash)}</span></div>` +
    `<div class="row"><span>Kredi Kartı</span><span>${fmt(s.card)}</span></div>` +
    `<div class="row"><span>Yemek Fişi</span><span>${fmt(s.ticket)}</span></div>` +
    `<div class="hr"></div>` +
    `<div class="row b big"><span>TOPLAM</span><span>${fmt(s.total)}</span></div>` +
    (s.compTotal > 0
      ? `<div class="hr"></div><div class="c">— Bedelsiz (ciro dışı) —</div>` +
        (s.compTreat > 0 ? `<div class="row"><span>İkram</span><span>${fmt(s.compTreat)}</span></div>` : '') +
        (s.compUnpaid > 0 ? `<div class="row"><span>Ödenmez</span><span>${fmt(s.compUnpaid)}</span></div>` : '') +
        (s.compStaff > 0 ? `<div class="row"><span>Personel</span><span>${fmt(s.compStaff)}</span></div>` : '') +
        `<div class="row b"><span>Toplam bedelsiz</span><span>${fmt(s.compTotal)}</span></div>`
      : '') +
    `<div class="hr"></div><div class="c">ArcTeknik Şef</div>`
  );
}

// Bir yazdırma işini, her biri TEK fiziksel yazıcıya gidecek bölümlere ayırır.
// Mutfak işi birden çok hedef (Mutfak + Bar) içerebilir → her grup ayrı bölüm.
// Hesap/Z fişi tek bölüm (Kasa).
export function renderSections(job, company) {
  if (!job) return [];
  if (job.type === 'kitchen') {
    return (job.groups || []).map((g) => ({
      target: g.target || 'Mutfak',
      html: wrap(kitchenGroupBody(job, g)),
    }));
  }
  if (job.type === 'bill' || job.type === 'preview') return [{ target: 'Kasa', html: wrap(billBody(job, company)) }];
  if (job.type === 'summary' && job.summary) return [{ target: 'Kasa', html: wrap(summaryBody(job, company)) }];
  return [];
}

// ── Yazıcı eşlemesi (terminal başına, localStorage) ──────────────────────────
const MAP_KEY = 'sef_printer_map';

export function getPrinterMap() {
  try {
    const m = JSON.parse(localStorage.getItem(MAP_KEY) || '{}');
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}

export function setPrinterMap(map) {
  try {
    localStorage.setItem(MAP_KEY, JSON.stringify(map || {}));
  } catch {
    /* yoksay */
  }
}

// Hedef için fiziksel yazıcı adı: tam eşleme → varsayılan eşleme → sistem
// varsayılanı ('' → ana süreç deviceName boş bırakır, OS varsayılanına basar).
export function deviceFor(target) {
  const m = getPrinterMap();
  return m[target] || m._default || '';
}

// Sessiz basım köprüsü mevcut (masaüstü) ve en az bir yazıcı tanımlı mı?
// Tanım yoksa çağıran taraf window.print() diyaloğuna düşer (davranış değişmez).
export function silentReady() {
  if (!(typeof window !== 'undefined' && window.bayraktarDesktop && window.bayraktarDesktop.silentPrint)) return false;
  const m = getPrinterMap();
  return Object.keys(m).length > 0;
}

export function silentAvailable() {
  return !!(typeof window !== 'undefined' && window.bayraktarDesktop && window.bayraktarDesktop.silentPrint);
}

// ── Yazdırma kuyruğu (kağıt bitti / yazıcı kapalı → fiş KAYBOLMAZ) ───────────
// Basılamayan her bölüm terminalde kalıcı kuyruğa (localStorage) alınır.
// Restaurant ekranı 30 sn'de bir yeniden dener + kırmızı uyarı rozeti gösterir.
// Cihaz adı baskı ANINDA çözülür (deviceFor) → kuyruktayken eşleme değişse de
// güncel yazıcıya basılır.
const QUEUE_KEY = 'sef_print_queue';
const QUEUE_LIMIT = 200; // taşma koruması (en eskiler düşer)

function notifyQueue(q) {
  try {
    window.dispatchEvent(new CustomEvent('sef-print-queue', { detail: { count: q.length } }));
  } catch { /* yoksay */ }
}

export function getPrintQueue() {
  try {
    const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

function saveQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* dolu — en kötü kuyruk uçar */ }
  notifyQueue(q);
}

function enqueueSection(section, label) {
  const q = getPrintQueue();
  q.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    target: section.target,
    html: section.html,
    label: label || section.target,
    ts: Date.now(),
    tries: 0,
  });
  saveQueue(q.slice(-QUEUE_LIMIT));
}

// Kuyruktakileri sırayla yeniden dene. Basılan düşer; basılamayan deneme sayacıyla kalır.
export async function retryPrintQueue() {
  if (!silentAvailable()) return { remaining: getPrintQueue().length, printed: 0 };
  let printed = 0;
  let q = getPrintQueue();
  for (const item of [...q]) {
    let ok = false;
    try {
      const res = await window.bayraktarDesktop.silentPrint({ html: item.html, deviceName: deviceFor(item.target) });
      ok = !!(res && res.ok !== false);
    } catch { ok = false; }
    q = getPrintQueue(); // başka sekme değiştirmiş olabilir — taze oku
    if (ok) {
      q = q.filter((x) => x.id !== item.id);
      printed += 1;
    } else {
      q = q.map((x) => (x.id === item.id ? { ...x, tries: (x.tries || 0) + 1 } : x));
    }
    saveQueue(q);
  }
  return { remaining: q.length, printed };
}

export function removeFromPrintQueue(id) {
  saveQueue(getPrintQueue().filter((x) => x.id !== id));
}

export function clearPrintQueue() {
  saveQueue([]);
}

// İnsan-okur etiket: kuyruk listesinde "Mutfak — MASA 4" gibi görünür.
function jobLabel(job, section) {
  const who = job?.label || (job?.tableNo != null ? `MASA ${job.tableNo}` : (job?.orderNo != null ? `SİPARİŞ #${job.orderNo}` : ''));
  const kind = job?.type === 'kitchen' ? section.target
    : job?.type === 'preview' ? 'Ön Hesap'
    : job?.type === 'summary' ? 'Z Raporu'
    : 'Hesap';
  return `${kind}${who ? ' — ' + who : ''}`;
}

// Bir işi sessizce bas. Dönüş: { ok, queued } — ok=false + queued>0 ise
// basılamayan bölümler kuyruğa alındı (fiş kaybolmadı); çağıran kullanıcıyı uyarır.
export async function silentPrintJob(job, company) {
  const sections = renderSections(job, company);
  if (!sections.length) return { ok: false, queued: 0 };
  let queued = 0;
  for (const s of sections) {
    let ok = false;
    try {
      const res = await window.bayraktarDesktop.silentPrint({ html: s.html, deviceName: deviceFor(s.target) });
      ok = !!(res && res.ok !== false);
    } catch { ok = false; }
    if (!ok) {
      enqueueSection(s, jobLabel(job, s));
      queued += 1;
    }
  }
  return { ok: queued === 0, queued };
}
