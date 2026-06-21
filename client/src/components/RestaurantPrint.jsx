// ArcTeknik Şef — termal (80mm) yazdırma şablonu.
// Ekranda gizli (#restoran-print { display:none }); yalnızca window.print() anında,
// @media print kuralıyla görünür. İki tür iş:
//   job.type = 'kitchen' → mutfak/bar fişi (yazıcı hedefine göre gruplu, her grup ayrı sayfa)
//   job.type = 'bill'    → hesap (adisyon) fişi
// (Eski FastPOS PrintArea kalıbından türedi; restoran için ayrı id — çakışma olmasın.)

const fmt = (v) => `${(Number(v) || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TL`;

export default function RestaurantPrint({ job, company }) {
  if (!job) return null;
  const name = company?.CompanyName || 'ArcTeknik Şef';

  return (
    <div id="restoran-print">
      <style>{`
        #restoran-print { display: none; }
        @media print {
          body * { visibility: hidden !important; }
          #restoran-print, #restoran-print * { visibility: visible !important; }
          #restoran-print { display: block !important; position: absolute; left: 0; top: 0; width: 76mm;
            font-family: 'Courier New', monospace; color: #000; font-size: 12px; padding: 4px 6px; }
          .rp-center { text-align: center; }
          .rp-row { display: flex; justify-content: space-between; }
          .rp-hr { border-top: 1px dashed #000; margin: 4px 0; }
          .rp-bold { font-weight: 700; }
          .rp-big { font-size: 16px; }
          .rp-note { font-style: italic; }
          .rp-page { page-break-after: always; }
          .rp-page:last-child { page-break-after: auto; }
        }
      `}</style>

      {job.type === 'kitchen' && (job.groups || []).map((g, gi) => (
        <div key={gi} className="rp-page">
          <div className="rp-center rp-bold rp-big">{g.target || 'MUTFAK'}</div>
          <div className="rp-center rp-bold">SİPARİŞ FİŞİ</div>
          <div className="rp-hr" />
          <div className="rp-row rp-bold rp-big"><span>MASA {job.tableNo}</span>{job.guestCount ? <span>{job.guestCount} kişi</span> : null}</div>
          <div className="rp-center">{new Date(job.at || Date.now()).toLocaleString('tr-TR')}</div>
          <div className="rp-hr" />
          {g.items.map((it, i) => (
            <div key={i} style={{ marginBottom: 4 }}>
              <div className="rp-bold rp-big">{it.quantity} x {it.name}</div>
              {it.options ? <div>+ {it.options}</div> : null}
              {it.note ? <div className="rp-note">» {it.note}</div> : null}
            </div>
          ))}
          <div className="rp-hr" />
        </div>
      ))}

      {(job.type === 'bill' || job.type === 'preview') && (
        <>
          <div className="rp-center rp-bold rp-big">{name}</div>
          {company?.Phone && <div className="rp-center">{company.Phone}</div>}
          {company?.Address && <div className="rp-center">{company.Address}</div>}
          <div className="rp-hr" />
          <div className="rp-row rp-bold"><span>MASA {job.tableNo}</span>{job.guestCount ? <span>{job.guestCount} kişi</span> : null}</div>
          <div className="rp-center">{new Date(job.at || Date.now()).toLocaleString('tr-TR')}</div>
          <div className="rp-center rp-bold" style={{ fontSize: 11 }}>{job.type === 'preview' ? 'ÖN HESAP / PUSULA — MALİ DEĞERİ YOKTUR' : 'HESAP FİŞİ (Mali değeri yoktur)'}</div>
          <div className="rp-hr" />
          {(job.lines || []).map((l, i) => (
            <div key={i} style={{ marginBottom: 2 }}>
              <div>{l.name}{l.treat ? ' (İKRAM)' : ''}</div>
              {l.options ? <div style={{ fontSize: 11 }}>+ {l.options}</div> : null}
              <div className="rp-row">
                <span>{l.quantity} x {fmt(l.unitPrice)}</span>
                <span>{l.treat ? '0,00 TL' : fmt(l.unitPrice * l.quantity)}</span>
              </div>
            </div>
          ))}
          <div className="rp-hr" />
          {job.discount > 0 && (
            <>
              <div className="rp-row"><span>Ara Toplam</span><span>{fmt(job.subtotal)}</span></div>
              <div className="rp-row"><span>İndirim</span><span>- {fmt(job.discount)}</span></div>
            </>
          )}
          <div className="rp-row rp-bold rp-big"><span>TOPLAM</span><span>{fmt(job.total)}</span></div>
          <div className="rp-hr" />
          {job.type !== 'preview' && (
            <>
              {job.paymentMethod && <div className="rp-row"><span>Ödeme</span><span>{job.paymentMethod}</span></div>}
              {job.received != null && <div className="rp-row"><span>Alınan</span><span>{fmt(job.received)}</span></div>}
              {job.change != null && <div className="rp-row"><span>Para Üstü</span><span>{fmt(job.change)}</span></div>}
              <div className="rp-hr" />
            </>
          )}
          <div className="rp-center">{job.type === 'preview' ? 'Bu bir ön hesaptır. Mali değeri yoktur.' : 'Afiyet olsun · Teşekkürler!'}</div>
        </>
      )}

      {job.type === 'summary' && job.summary && (
        <>
          <div className="rp-center rp-bold rp-big">{name}</div>
          <div className="rp-center rp-bold">GÜN SONU (Z) RAPORU</div>
          <div className="rp-center">{job.summary.date}</div>
          <div className="rp-hr" />
          <div className="rp-row"><span>Adisyon (kapanan)</span><span>{job.summary.orders}</span></div>
          <div className="rp-row"><span>Toplam kişi</span><span>{job.summary.guests}</span></div>
          <div className="rp-hr" />
          <div className="rp-row"><span>Nakit</span><span>{fmt(job.summary.cash)}</span></div>
          <div className="rp-row"><span>Kredi Kartı</span><span>{fmt(job.summary.card)}</span></div>
          <div className="rp-row"><span>Yemek Fişi</span><span>{fmt(job.summary.ticket)}</span></div>
          <div className="rp-hr" />
          <div className="rp-row rp-bold rp-big"><span>TOPLAM</span><span>{fmt(job.summary.total)}</span></div>
          {job.summary.compTotal > 0 && (
            <>
              <div className="rp-hr" />
              <div className="rp-center">— Bedelsiz (ciro dışı) —</div>
              {job.summary.compTreat > 0 && <div className="rp-row"><span>İkram</span><span>{fmt(job.summary.compTreat)}</span></div>}
              {job.summary.compUnpaid > 0 && <div className="rp-row"><span>Ödenmez</span><span>{fmt(job.summary.compUnpaid)}</span></div>}
              {job.summary.compStaff > 0 && <div className="rp-row"><span>Personel</span><span>{fmt(job.summary.compStaff)}</span></div>}
              <div className="rp-row rp-bold"><span>Toplam bedelsiz</span><span>{fmt(job.summary.compTotal)}</span></div>
            </>
          )}
          <div className="rp-hr" />
          <div className="rp-center">ArcTeknik Şef</div>
        </>
      )}
    </div>
  );
}
