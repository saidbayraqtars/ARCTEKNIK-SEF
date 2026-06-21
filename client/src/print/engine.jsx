import Mustache from 'mustache';
import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../api/client';
import { buildTemplate, LOCKED_AD_HTML } from './defaults';

let _cache = null; // { key: { html, css, pageSize } }

export async function loadTemplates(force = false) {
  if (_cache && !force) return _cache;
  try {
    const { data } = await api.get('/print-templates');
    _cache = data || {};
  } catch {
    _cache = {};
  }
  return _cache;
}

export function clearTemplateCache() { _cache = null; }

// Kayıtlı seçeneklerden (varsa) yoksa varsayılan seçeneklerden şablonu üret.
export function resolveTemplate(saved, key) {
  return buildTemplate(key, saved && saved.options);
}

// @page boyutu — termal sürekli kağıt için 'auto' yükseklik.
function pageRule(pageSize) {
  if (pageSize === '80mm') return '80mm auto';
  if (pageSize === '58mm') return '58mm auto';
  return 'A4';
}

// QR'ı SVG string olarak üret — şablona {{{qrSvg}}} (ham) ile gömülür.
export function qrSvg(value, size = 76) {
  if (!value) return '';
  return renderToStaticMarkup(<QRCodeSVG value={value} size={size} level="M" />);
}

// Token doldur + sayfa kuralı + KİLİTLİ reklamı zorla → tam HTML belge.
// withAd=false yalnız küçük termal etikette (telefon stickerı) reklamı atlar.
export function buildDocumentHtml({ html, css, pageSize }, data, { withAd = true } = {}) {
  const origin = window.location.origin;
  let body;
  try {
    body = Mustache.render(html, data || {});
  } catch (e) {
    body = `<pre style="color:#b91c1c">Şablon hatası: ${String(e.message || e)}</pre>`;
  }
  // Kullanıcının bıraktığı reklamı SÖK → tek, kanonik reklamı yeniden ekle (silinemez).
  let bodyInner;
  try {
    const parsed = new DOMParser().parseFromString(`<body>${body}</body>`, 'text/html');
    parsed.querySelectorAll('#arc-locked-ad').forEach((n) => n.remove());
    bodyInner = parsed.body.innerHTML;
  } catch {
    bodyInner = body;
  }
  const ad = withAd ? LOCKED_AD_HTML.replace(/__ORIGIN__/g, origin) : '';
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<style>@page{size:${pageRule(pageSize)};margin:0}html,body{margin:0}
${css || ''}</style></head>
<body>${bodyInner}${ad}</body></html>`;
}

// Gizli iframe ile yazdır — popup engeline takılmaz, Electron + tarayıcı uyumlu.
export function printHtmlDocument(fullHtml) {
  const frame = document.createElement('iframe');
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  document.body.appendChild(frame);
  const doc = frame.contentWindow.document;
  doc.open(); doc.write(fullHtml); doc.close();
  frame.contentWindow.focus();
  // Logo/QR yüklensin diye kısa bekle, sonra bas + iframe'i kaldır.
  setTimeout(() => {
    try { frame.contentWindow.print(); } catch { /* ignore */ }
    setTimeout(() => frame.remove(), 1500);
  }, 350);
}

// Ana giriş: anahtar + veri → kayıtlı/varsayılan şablonu bas.
// Etikette (telefon stickerı) marka eklenmez; A4 fiş/belgede eklenir.
export async function printDesign(key, data) {
  const all = await loadTemplates();
  const tpl = resolveTemplate(all[key], key);
  printHtmlDocument(buildDocumentHtml(tpl, data, { withAd: key !== 'service-label' }));
}
