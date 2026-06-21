// ─── Yazdırma Dizaynları — SEÇENEK tabanlı (token/sürükleme yok) ──────────────
// Kullanıcı form panelinden seçenekleri (renk, yazı/logo boyutu, hizalama, kenar
// boşluğu, hangi alanlar görünsün) ayarlar. buildTemplate() bu seçeneklerden
// sabit-güzel şablonu üretir; veri tokenları ({{...}}) sonra Mustache ile dolar.
// Çıktı her zaman düzenlidir — kullanıcı yerleşimi bozamaz.

// KİLİTLİ REKLAM — alt-orta, silinemez. Boyut !important + max ile sabit (asla büyümez).
export const LOCKED_AD_HTML =
  '<div id="arc-locked-ad" style="margin-top:14px;padding-top:7px;border-top:1px solid #e5e7eb;' +
  'text-align:center;page-break-inside:avoid;line-height:1;">' +
  '<img src="__ORIGIN__/logo.png" alt="ArcTeknik" style="height:12px !important;max-height:12px !important;' +
  'width:auto !important;max-width:80px !important;object-fit:contain;display:inline-block;vertical-align:middle;opacity:.85;" />' +
  '<span style="font-size:8px;color:#9ca3af;margin-left:5px;vertical-align:middle;">ile hazırlanmıştır</span></div>';

const FS = { sm: 0.9, md: 1, lg: 1.12 };
const PAD = { dar: '8mm', orta: '12mm', genis: '16mm' };

const f = (base, scale) => Math.round(base * scale * 100) / 100;

// HTML + Mustache güvenli kaçış: kullanıcının yazdığı serbest metin token ({{ }})
// gibi yorumlanmasın ve etiket enjekte edemesin. Süslü parantezleri de entity yap.
const esc = (str) => String(str == null ? '' : str)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');

// ── Servis Fişi ──────────────────────────────────────────────────────────────
function receipt(o) {
  const s = FS[o.fontScale] || 1;
  const pad = PAD[o.margin] || '12mm';
  const logoMax = Math.round(52 * (o.logoScale || 1));
  const center = o.align === 'center';
  const fld = o.fields || {};
  const css = `
*{box-sizing:border-box}
body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#0f172a;font-size:${f(13, s)}px}
img{max-width:100%}
.sheet{padding:${pad}}
.r-head{display:flex;${center ? 'flex-direction:column;align-items:center;text-align:center;gap:6px;' : 'justify-content:space-between;align-items:flex-start;'}border-bottom:2px solid ${o.accent};padding-bottom:14px;margin-bottom:20px}
.brand{display:flex;gap:12px;align-items:center;${center ? 'flex-direction:column;' : ''}}
.brand img{height:auto;max-height:${logoMax}px;max-width:170px;width:auto;object-fit:contain}
.brand h1{font-size:${f(20, s)}px;font-weight:800;margin:0;letter-spacing:.3px}
.brand .meta{margin-top:2px;font-size:${f(11, s)}px;color:#475569}
.rinfo{${center ? '' : 'text-align:right;'}}
.rinfo .lbl{font-size:${f(11, s)}px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#64748b}
.rinfo .big{font-size:${f(24, s)}px;font-weight:900;line-height:1}
.rinfo .qr{margin-top:8px;display:flex;${center ? 'justify-content:center;' : 'justify-content:flex-end;'}}
.rinfo .date{font-size:${f(10, s)}px;color:#64748b;margin-top:4px}
.sec{margin-bottom:18px}
.sec h3{font-size:${f(11, s)}px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#64748b;border-bottom:1px solid #cbd5e1;padding-bottom:4px;margin:0 0 8px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:4px 32px}.grid2 p{margin:0;font-size:${f(13, s)}px}.grid2 .full{grid-column:1/-1}
b{font-weight:600}
table{width:100%;border-collapse:collapse;font-size:${f(13, s)}px}
th{text-align:left;font-size:${f(11, s)}px;text-transform:uppercase;color:#64748b;border-bottom:1px solid #cbd5e1;padding:6px 8px 6px 0}
td{border-bottom:1px solid #e2e8f0;padding:6px 8px 6px 0;vertical-align:top}
.fault{font-size:${f(13, s)}px;white-space:pre-wrap;margin:0}
.legal p{font-size:${f(9, s)}px;line-height:1.35;color:#475569;white-space:pre-wrap;margin:0}
.signs{display:flex;justify-content:space-between;gap:48px;margin-top:46px}.signs .s{flex:1;text-align:center}.signs .s .ln{border-top:1px solid #94a3b8;padding-top:4px;font-size:${f(12, s)}px;color:#475569}`;

  // ── Sabit bölüm parçaları (token'lı) ───────────────────────────────────────
  const head = `<div class="r-head">
  <div class="brand">{{#hasLogo}}<img src="{{company.logoUrl}}" alt="logo"/>{{/hasLogo}}<div><h1>{{company.name}}</h1>{{#company.address}}<div class="meta">{{company.address}}</div>{{/company.address}}<div class="meta">{{#company.phone}}Tel: {{company.phone}}{{/company.phone}}{{#company.email}} · {{company.email}}{{/company.email}}{{#company.website}} · {{company.website}}{{/company.website}}</div></div></div>
  <div class="rinfo"><div class="lbl">{{doc.title}}</div>{{#doc.isBulk}}<div class="big">{{doc.count}} Cihaz</div>{{/doc.isBulk}}{{^doc.isBulk}}<div class="big">#{{doc.serviceId}}</div>${fld.qr ? '{{#hasQr}}<div class="qr">{{{qrSvg}}}</div>{{/hasQr}}' : ''}{{/doc.isBulk}}<div class="date">Tarih: {{doc.date}}</div></div>
</div>`;
  const customer = `<div class="sec"><h3>{{customer.heading}}</h3><div class="grid2">
   <p><b>{{customer.nameLabel}}:</b> {{customer.name}}</p><p><b>Telefon:</b> {{customer.phone}}</p>
   {{#customer.address}}<p class="full"><b>Adres:</b> {{customer.address}}</p>{{/customer.address}}
   ${fld.tax ? '{{#customer.taxOffice}}<p><b>Vergi Dairesi:</b> {{customer.taxOffice}}</p>{{/customer.taxOffice}}{{#customer.taxNumber}}<p><b>Vergi No:</b> {{customer.taxNumber}}</p>{{/customer.taxNumber}}' : ''}
  </div></div>`;
  const bulk = `{{#doc.isBulk}}<div class="sec"><h3>Teslim Alınan Cihazlar</h3><table><thead><tr><th style="width:66px">Servis No</th><th>Marka / Model</th>${fld.serial ? '<th>Seri No / IMEI</th>' : ''}<th>Arıza / Şikayet</th></tr></thead><tbody>{{#devices}}<tr><td><b>#{{serviceId}}</b></td><td>{{brand}} {{model}}</td>${fld.serial ? '<td>{{serialNumber}}</td>' : ''}<td>{{faultDescription}}</td></tr>{{/devices}}</tbody></table></div>{{/doc.isBulk}}`;
  // Cihaz bilgisi (tekli) — arıza AYRI blok olduğu için buradan çıkarıldı.
  const deviceSingle = `{{^doc.isBulk}}<div class="sec"><h3>Cihaz Bilgileri</h3><div class="grid2"><p><b>Marka / Model:</b> {{first.brand}} {{first.model}}</p>${fld.serial ? '{{#first.serialNumber}}<p><b>Seri No / IMEI:</b> {{first.serialNumber}}</p>{{/first.serialNumber}}' : ''}{{#first.entryDate}}<p><b>Giriş Tarihi:</b> {{first.entryDate}}</p>{{/first.entryDate}}{{#first.status}}<p><b>Durum:</b> {{first.status}}</p>{{/first.status}}</div></div>{{/doc.isBulk}}`;
  const faultSingle = `{{^doc.isBulk}}<div class="sec"><h3>Arıza / Şikayet</h3><p class="fault">{{first.faultDescription}}</p></div>{{/doc.isBulk}}`;
  const legal = '{{#hasLegal}}<div class="sec legal"><h3>Yasal Şartlar / Garanti Sözleşmesi</h3><p>{{company.legalTerms}}</p></div>{{/hasLegal}}';
  const signs = '<div class="signs"><div class="s"><div class="ln">Teslim Eden (Yetkili)</div></div><div class="s"><div class="ln">Teslim Alan (Müşteri)</div></div></div>';

  const PARTS = {
    header: head,
    customer,
    device: bulk + deviceSingle,
    fault: faultSingle,
    legal,
    signature: signs,
  };

  // ── Eklenebilir (serbest) blok parçaları ──────────────────────────────────
  const customFragment = (b) => {
    if (b.type === 'divider') return `<div style="border-top:1px solid ${o.accent};margin:10px 0"></div>`;
    if (b.type === 'spacer') return `<div style="height:${Math.max(0, Number(b.height) || 16)}px"></div>`;
    if (b.type === 'text') {
      const map = { sm: f(11, s), md: f(13, s), lg: f(16, s) };
      const size = map[b.size] || map.md;
      const align = ['left', 'center', 'right'].includes(b.align) ? b.align : 'left';
      const weight = b.bold ? '700' : '400';
      return `<div class="sec" style="text-align:${align};font-size:${size}px;font-weight:${weight};white-space:pre-wrap;color:${o.accent === '#1e293b' ? '#0f172a' : '#0f172a'}">${esc(b.content)}</div>`;
    }
    return '';
  };

  const blocks = receiptBlocks(o);
  const body = blocks
    .filter((b) => b.visible !== false)
    .map((b) => (PARTS[b.type] !== undefined ? PARTS[b.type] : customFragment(b)))
    .join('');

  return { html: `<div class="sheet">${body}</div>`, css, pageSize: o.pageSize || 'A4' };
}

// Servis fişi blok düzeni. Kayıtlı bloks varsa onu, yoksa alanlardan türetilen
// varsayılan sırayı döndürür (geriye dönük: legal/signature görünürlüğü fields'tan).
export function receiptBlocks(o) {
  if (Array.isArray(o.blocks) && o.blocks.length) return o.blocks;
  const fld = o.fields || {};
  return [
    { id: 'header', type: 'header', visible: true },
    { id: 'customer', type: 'customer', visible: true },
    { id: 'device', type: 'device', visible: true },
    { id: 'fault', type: 'fault', visible: true },
    { id: 'legal', type: 'legal', visible: fld.legal !== false },
    { id: 'signature', type: 'signature', visible: fld.signature !== false },
  ];
}

// Editör için blok meta — ad + eklenebilir mi.
export const RECEIPT_BLOCK_META = {
  header: { name: 'Üst Bilgi (logo · firma · no)', icon: 'header' },
  customer: { name: 'Müşteri Bilgileri', icon: 'user' },
  device: { name: 'Cihaz Bilgileri', icon: 'device' },
  fault: { name: 'Arıza / Şikayet', icon: 'fault' },
  legal: { name: 'Yasal Şartlar / Sözleşme', icon: 'legal' },
  signature: { name: 'İmza Alanları', icon: 'sign' },
  text: { name: 'Serbest Metin', icon: 'text', addable: true },
  divider: { name: 'Ayraç Çizgi', icon: 'divider', addable: true },
  spacer: { name: 'Boşluk', icon: 'spacer', addable: true },
};

// ── Belge: Teklif / Sipariş / İrsaliye / Fatura ─────────────────────────────
function document(o) {
  const s = FS[o.fontScale] || 1;
  const pad = PAD[o.margin] || '12mm';
  const fld = o.fields || {};
  const css = `
*{font-family:Arial,Helvetica,sans-serif;box-sizing:border-box}
body{margin:0;padding:${pad};color:#1e293b;font-size:${f(13, s)}px}
img{max-width:100%}
.head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid ${o.accent};padding-bottom:16px;margin-bottom:24px}
.company h1{margin:0;font-size:${f(20, s)}px}.company p{margin:2px 0;color:#64748b;font-size:${f(12, s)}px}
.doctitle{text-align:right}.doctitle h2{margin:0;font-size:${f(24, s)}px;text-transform:uppercase;color:${o.accent}}
.doctitle p{margin:2px 0;font-size:${f(12, s)}px;color:#64748b}
.party{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;margin-bottom:20px}.party b{font-size:${f(14, s)}px}
table{width:100%;border-collapse:collapse;margin-top:8px}
th,td{padding:8px;border-bottom:1px solid #e2e8f0;text-align:left}
th{background:#f1f5f9;font-size:${f(11, s)}px;text-transform:uppercase;color:#475569}
td.r,th.r{text-align:right}
.totals{margin-top:16px;margin-left:auto;width:280px}.totals div{display:flex;justify-content:space-between;padding:4px 0}
.totals .grand{border-top:2px solid #1e293b;font-size:${f(18, s)}px;font-weight:bold;margin-top:4px;padding-top:8px}
.plan{margin-top:22px;clear:both}.plan h3{font-size:${f(12, s)}px;text-transform:uppercase;letter-spacing:.5px;color:#475569;margin:0 0 4px;border-bottom:1px solid #e2e8f0;padding-bottom:4px}
.plan table{margin-top:4px}.plan td,.plan th{padding:5px 8px}
.note{margin-top:20px;font-size:${f(12, s)}px;color:#64748b;border-top:1px solid #e2e8f0;padding-top:12px;white-space:pre-line}`;
  const party = fld.party ? `<div class="party"><b>{{party.name}}</b>{{#party.taxNumber}}<div>VKN/TCKN: {{party.taxNumber}}</div>{{/party.taxNumber}}{{#party.address}}<div>{{party.address}}</div>{{/party.address}}{{#party.phone}}<div>Tel: {{party.phone}}</div>{{/party.phone}}</div>` : '';
  const html = `<div class="head">
  <div class="company"><h1>{{company.name}}</h1>{{#company.address}}<p>{{company.address}}</p>{{/company.address}}{{#company.phone}}<p>Tel: {{company.phone}}</p>{{/company.phone}}{{#company.taxLine}}<p>{{company.taxLine}}</p>{{/company.taxLine}}</div>
  <div class="doctitle"><h2>{{doc.label}}</h2><p><b>{{doc.no}}</b></p><p>Tarih: {{doc.date}}</p>{{#doc.dueDate}}<p>Vade: {{doc.dueDate}}</p>{{/doc.dueDate}}</div>
</div>
${party}
<table><thead><tr><th>Açıklama</th><th class="r">Miktar</th><th class="r">B.Fiyat</th><th class="r">İsk.</th><th class="r">KDV</th><th class="r">Tutar</th></tr></thead>
<tbody>{{#items}}<tr><td>{{name}}{{#description}}<br><small>{{description}}</small>{{/description}}</td><td class="r">{{qtyText}}</td><td class="r">{{unitPrice}}</td><td class="r">{{discountRate}}</td><td class="r">{{vatRate}}</td><td class="r">{{lineTotal}}</td></tr>{{/items}}</tbody></table>
<div class="totals"><div><span>Ara Toplam</span><span>{{totals.subTotal}}</span></div>{{#totals.hasDiscount}}<div><span>İndirim</span><span>−{{totals.discount}}</span></div>{{/totals.hasDiscount}}<div><span>KDV</span><span>{{totals.vat}}</span></div><div class="grand"><span>GENEL TOPLAM</span><span>{{totals.grand}}</span></div>{{#totals.isFx}}<div style="font-size:0.85em;color:#64748b;padding-top:6px"><span>{{totals.rateLine}}</span></div><div class="grand"><span>TL KARŞILIĞI</span><span>{{totals.grandTRY}}</span></div>{{/totals.isFx}}</div>
${fld.installments !== false ? '{{#hasInstallments}}<div class="plan"><h3>Ödeme Planı</h3><table><thead><tr><th>#</th><th>Vade</th><th class="r">Tutar</th></tr></thead><tbody>{{#installments}}<tr><td>{{seq}}</td><td>{{due}}</td><td class="r">{{amount}}</td></tr>{{/installments}}</tbody></table></div>{{/hasInstallments}}' : ''}
${fld.note ? '{{#note}}<div class="note">{{note}}</div>{{/note}}' : ''}
${fld.iban ? '{{#iban}}<div class="note">IBAN: {{iban}}</div>{{/iban}}' : ''}`;
  return { html, css, pageSize: o.pageSize || 'A4' };
}

// ── Cihaz Etiketi (termal) ───────────────────────────────────────────────────
function label(o) {
  const s = FS[o.fontScale] || 1;
  const width = o.pageSize === '80mm' ? '76mm' : '54mm';
  const fld = o.fields || {};
  const css = `
body{margin:0;font-family:Arial,Helvetica,sans-serif}
img{max-width:100%}
.label{width:${width};padding:3mm;text-align:center;box-sizing:border-box}
.label .box{border:2px solid ${o.accent};padding:8px;border-radius:4px}
.label .t{font-size:${f(11, s)}px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;margin:0 0 4px}
.label .no{font-size:${f(26, s)}px;font-weight:900;margin:0 0 8px}
.label .qr{display:flex;justify-content:center;margin-bottom:8px}
.label .dev{font-size:${f(12, s)}px;font-weight:600;margin:0}
.label .cust{font-size:${f(10, s)}px;color:#555;margin:2px 0 0}
.label .date{font-size:${f(9, s)}px;color:#777;margin:8px 0 0}`;
  const html = `<div class="label"><div class="box">
  ${fld.company ? '<p class="t">{{company.name}}</p>' : ''}
  <p class="no">#{{serviceId}}</p>
  ${fld.qr ? '<div class="qr">{{{qrSvg}}}</div>' : ''}
  <p class="dev">{{brand}} {{model}}</p>
  ${fld.customer ? '{{#customerName}}<p class="cust">{{customerName}}</p>{{/customerName}}' : ''}
  <p class="date">{{date}}</p>
</div></div>`;
  return { html, css, pageSize: o.pageSize || '58mm' };
}

const BUILDERS = { 'service-receipt': receipt, 'document': document, 'service-label': label };

// Seçeneklerden mustache şablonu + css üret. Eksik alan varsayılanla tamamlanır.
export function buildTemplate(key, options) {
  const o = mergeOptions(key, options);
  return (BUILDERS[key] || receipt)(o);
}

export const DEFAULT_OPTIONS = {
  'service-receipt': { pageSize: 'A4', accent: '#1e293b', fontScale: 'md', margin: 'orta', logoScale: 1, align: 'left', fields: { qr: true, legal: true, signature: true, tax: true, serial: true } },
  'document': { pageSize: 'A4', accent: '#0ea5e9', fontScale: 'md', margin: 'orta', logoScale: 1, align: 'left', fields: { party: true, note: true, iban: true, installments: true } },
  'service-label': { pageSize: '58mm', accent: '#000000', fontScale: 'md', margin: 'orta', logoScale: 1, fields: { qr: true, customer: true, company: true } },
};

export function mergeOptions(key, options) {
  const d = DEFAULT_OPTIONS[key] || DEFAULT_OPTIONS['service-receipt'];
  const o = { ...d, ...(options || {}) };
  o.fields = { ...d.fields, ...((options && options.fields) || {}) };
  return o;
}

// Form panelini süren şema: hangi kontroller, hangi dizaynda.
export const COMMON_CONTROLS = [
  { key: 'accent', type: 'color', label: 'Tema rengi' },
  { key: 'fontScale', type: 'segment', label: 'Yazı boyutu', options: [['sm', 'Küçük'], ['md', 'Orta'], ['lg', 'Büyük']] },
  { key: 'margin', type: 'segment', label: 'Kenar boşluğu', options: [['dar', 'Dar'], ['orta', 'Orta'], ['genis', 'Geniş']] },
];
export const OPTION_SCHEMA = {
  'service-receipt': [
    { key: 'align', type: 'segment', label: 'Üst bilgi hizası', options: [['left', 'Sol'], ['center', 'Orta']] },
    { key: 'logoScale', type: 'range', label: 'Logo boyutu', min: 0.6, max: 1.6, step: 0.1 },
    { key: 'fields.qr', type: 'toggle', label: 'QR kod' },
    { key: 'fields.serial', type: 'toggle', label: 'Seri No / IMEI' },
    { key: 'fields.tax', type: 'toggle', label: 'Vergi bilgisi (kurumsal)' },
    // Yasal şartlar + imza artık BLOK olarak yönetilir (sırala/aç-kapa) — bkz. blok paneli.
  ],
  'document': [
    { key: 'fields.party', type: 'toggle', label: 'Cari / müşteri kutusu' },
    { key: 'fields.note', type: 'toggle', label: 'Not alanı' },
    { key: 'fields.iban', type: 'toggle', label: 'IBAN' },
    { key: 'fields.installments', type: 'toggle', label: 'Ödeme planı (taksitler)' },
  ],
  'service-label': [
    { key: 'fields.company', type: 'toggle', label: 'Firma adı' },
    { key: 'fields.qr', type: 'toggle', label: 'QR kod' },
    { key: 'fields.customer', type: 'toggle', label: 'Müşteri adı' },
  ],
};

export const DESIGN_META = [
  { key: 'service-receipt', name: 'Servis Fişi', desc: 'Kabul/teslim fişi (tekli + toplu). A4.' },
  { key: 'document', name: 'Belge / Fatura', desc: 'Teklif · Sipariş · İrsaliye · Fatura. A4.' },
  { key: 'service-label', name: 'Cihaz Etiketi', desc: 'QR + servis no etiketi. Termal.' },
];

export const PAGE_SIZES = [
  { value: 'A4', label: 'A4 (210mm)' },
  { value: '80mm', label: 'Termal 80mm' },
  { value: '58mm', label: 'Termal 58mm' },
];
