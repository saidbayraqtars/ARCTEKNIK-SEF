import { qrSvg } from './engine';

// Servis fişi token verisi — ServiceDetail + CustomerIntake aynı şekli üretir.
// customer = { type, name, phone, address, taxOffice, taxNumber }
// devices  = [{ serviceId, brand, model, serialNumber, faultDescription, status, entryDate }]
export function buildReceiptData({ customer = {}, devices = [], settings = {} }) {
  const isBulk = devices.length > 1;
  const isCorp = customer.type === 'Kurumsal';
  const first = devices[0] || {};
  const scanUrl = first.serviceId ? `${window.location.origin}/sorgula?id=${first.serviceId}` : '';

  return {
    company: {
      name: settings.CompanyName || 'Teknik Servis',
      address: settings.Address || '',
      phone: settings.Phone || '',
      email: settings.Email || '',
      website: settings.Website || '',
      logoUrl: settings.LogoUrl || '',
      legalTerms: settings.LegalTerms || '',
    },
    doc: {
      title: isBulk ? 'Toplu Servis Fişi' : 'Servis Fişi',
      isBulk,
      count: devices.length,
      serviceId: first.serviceId || '',
      date: new Date().toLocaleDateString('tr-TR'),
    },
    customer: {
      heading: isCorp ? 'Firma Bilgileri' : 'Müşteri Bilgileri',
      nameLabel: isCorp ? 'Ünvan' : 'Ad Soyad',
      name: customer.name || '',
      phone: customer.phone || '',
      address: customer.address || '',
      taxOffice: isCorp ? (customer.taxOffice || '') : '',
      taxNumber: isCorp ? (customer.taxNumber || '') : '',
    },
    devices: devices.map((d) => ({
      serviceId: d.serviceId,
      brand: d.brand,
      model: d.model,
      serialNumber: d.serialNumber || '—',
      faultDescription: d.faultDescription || '',
    })),
    first: {
      brand: first.brand || '',
      model: first.model || '',
      serialNumber: first.serialNumber || '',
      entryDate: first.entryDate ? new Date(first.entryDate).toLocaleString('tr-TR') : '',
      status: first.status || '',
      faultDescription: first.faultDescription || '',
    },
    hasLogo: !!settings.LogoUrl,
    hasLegal: !!settings.LegalTerms,
    hasQr: !isBulk && !!scanUrl,
    qrSvg: (!isBulk && scanUrl) ? qrSvg(scanUrl, 76) : '',
  };
}

// Cihaz etiketi token verisi.
export function buildLabelData({ serviceId, brand, model, customerName, settings = {} }) {
  const scanUrl = `${window.location.origin}/servis/${serviceId}`;
  return {
    company: { name: settings.CompanyName || 'Teknik Servis' },
    serviceId,
    brand: brand || '',
    model: model || '',
    customerName: customerName || '',
    date: new Date().toLocaleDateString('tr-TR'),
    qrSvg: qrSvg(scanUrl, 100),
  };
}
