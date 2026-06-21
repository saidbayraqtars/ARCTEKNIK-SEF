import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  ShoppingCart, Plus, Minus, Trash2, Banknote, CreditCard, Loader2, X, Check,
  UtensilsCrossed, RefreshCw, ArrowLeft,
} from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import RestaurantPrint from '../components/RestaurantPrint';
import { silentReady, silentPrintJob } from '../utils/sefPrint';

// ArcTeknik Şef — SELF-SERVİS KASA (masa bypass modu).
// Fast-food / kahveci / büfe düzeni: masa planı YOK. Büyük butonlu menü + sepet,
// tahsilat PEŞİN (Nakit/KK). Ödeme anında: gün içi SİPARİŞ NUMARASI üretilir,
// mutfak fişleri kendi yazıcılarına düşer, müşteri fişinde numara DEVASA basılır,
// çağrı ekranı (/restoran/cagri) hazır olunca numarayı anons eder.
// Para yolu %100 mevcut adisyon checkout'udur (reçete sarfiyatı + kasa + Z dahil).

const fmtTL = (v) =>
  `${(Number(v) || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺`;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export default function RestaurantSelfService() {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [menu, setMenu] = useState([]);
  const [company, setCompany] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeCat, setActiveCat] = useState(0);
  const [cart, setCart] = useState([]); // [{ key, product, qty, optionIds, optionLabel, priceEach }]
  const [busy, setBusy] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [received, setReceived] = useState('');
  const [doneNo, setDoneNo] = useState(null);   // ödeme bitti — devasa sipariş no overlay'i
  const [optionProduct, setOptionProduct] = useState(null);
  const [optionSel, setOptionSel] = useState({});
  const [printJob, setPrintJob] = useState(null);
  const keyRef = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/restoran/menu');
      setMenu(Array.isArray(data) ? data : (data.categories || []));
    } catch (e) {
      if (e?.response?.status === 403) toast.error('ArcTeknik Şef modülü lisanslı değil veya yetkiniz yok.');
      else toast.error('Menü yüklenemedi.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    api.get('/settings').then(({ data }) => setCompany(data)).catch(() => {});
  }, [load]);

  // Sessiz basım hazırsa yazıcıya, değilse window.print() diyaloğuna.
  const doPrint = async (job) => {
    if (silentReady()) {
      try {
        const res = await silentPrintJob(job, company);
        if (res.ok) return;
        if (res.queued > 0) {
          toast.error(`${res.queued} fiş basılamadı — kuyruğa alındı, yazıcıyı kontrol edin.`, { duration: 6000 });
          return;
        }
      } catch { /* aşağıdaki diyaloğa düş */ }
    }
    setPrintJob(job);
    setTimeout(() => { window.print(); }, 80);
  };

  // ── Sepet ──────────────────────────────────────────────────────────────────
  const optionLabelOf = (product, ids) => {
    if (!ids?.length || !product.optionGroups) return '';
    const names = [];
    for (const g of product.optionGroups) {
      for (const o of g.options || []) if (ids.includes(o.id)) names.push(o.name);
    }
    return names.join(', ');
  };
  const optionDeltaOf = (product, ids) => {
    let d = 0;
    if (!ids?.length || !product.optionGroups) return 0;
    for (const g of product.optionGroups) {
      for (const o of g.options || []) if (ids.includes(o.id)) d += Number(o.priceDelta) || 0;
    }
    return d;
  };

  const addToCart = (product, optionIds = []) => {
    const label = optionLabelOf(product, optionIds);
    setCart((prev) => {
      // Aynı ürün + aynı seçenek → miktar artır.
      const same = prev.find((l) => l.product.id === product.id && l.optionLabel === label);
      if (same) return prev.map((l) => (l === same ? { ...l, qty: l.qty + 1 } : l));
      keyRef.current += 1;
      return [...prev, {
        key: keyRef.current, product, qty: 1, optionIds, optionLabel: label,
        priceEach: round2(Number(product.price) + optionDeltaOf(product, optionIds)),
      }];
    });
  };

  const tapProduct = (p) => {
    if (p.optionGroups && p.optionGroups.length) {
      const init = {};
      for (const g of p.optionGroups) init[g.id] = new Set();
      setOptionSel(init);
      setOptionProduct(p);
      return;
    }
    addToCart(p, []);
  };

  const toggleOption = (group, optionId) => {
    setOptionSel((prev) => {
      const cur = new Set(prev[group.id] || []);
      if (group.max === 1) { cur.clear(); cur.add(optionId); }
      else if (cur.has(optionId)) cur.delete(optionId);
      else { if (group.max > 0 && cur.size >= group.max) return prev; cur.add(optionId); }
      return { ...prev, [group.id]: cur };
    });
  };
  const confirmOptions = () => {
    const p = optionProduct;
    if (!p) return;
    for (const g of p.optionGroups) {
      const n = (optionSel[g.id] || new Set()).size;
      if (g.min > 0 && n < g.min) { toast.error(`"${g.name}" için en az ${g.min} seçim gerekli.`); return; }
    }
    addToCart(p, Object.values(optionSel).flatMap((s) => [...s]));
    setOptionProduct(null); setOptionSel({});
  };

  const changeQty = (line, delta) => {
    setCart((prev) => prev
      .map((l) => (l.key === line.key ? { ...l, qty: l.qty + delta } : l))
      .filter((l) => l.qty > 0));
  };

  const total = useMemo(() => round2(cart.reduce((s, l) => s + l.priceEach * l.qty, 0)), [cart]);
  const recNum = Number(received);
  const change = Number.isFinite(recNum) && recNum > total ? round2(recNum - total) : 0;

  // ── Ödeme: sipariş aç → kalemleri ekle → mutfağa gönder → tahsil et ────────
  // Adım başarısız olursa eklenen kalemler geri silinir (boş sipariş zararsız,
  // panoda görünmez). Fiyatlar sunucuda yeniden hesaplanır (istemciye güvenilmez).
  const checkout = async (method) => {
    if (!cart.length || busy) return;
    if (method === 'Nakit' && received !== '' && Number.isFinite(recNum) && recNum < total) {
      toast.error('Alınan tutar toplamın altında.');
      return;
    }
    setBusy(true);
    try {
      const open = await api.post('/restoran/self-orders');
      const orderId = open.data.orderId;
      // Tüm sepet TEK çağrıda (sunucu tarafı tek transaction — yarım sipariş kalmaz).
      await api.post(`/restoran/orders/${orderId}/items`, {
        items: cart.map((l) => ({ productId: l.product.id, quantity: l.qty, optionIds: l.optionIds })),
      });
      const sk = await api.post(`/restoran/orders/${orderId}/send-kitchen`);
      const co = await api.post(`/restoran/orders/${orderId}/checkout`, {
        paymentMethod: method,
        received: method === 'Nakit' && received !== '' ? recNum : undefined,
      });
      const orderNo = co.data.orderNo || open.data.orderNo;

      // Mutfak fişleri (hedef yazıcılara) + müşteri fişi (devasa sipariş no).
      if (sk.data?.groups?.length) {
        doPrint({ type: 'kitchen', label: sk.data.label || `SİPARİŞ #${orderNo}`, at: sk.data.at, groups: sk.data.groups });
      }
      doPrint({
        type: 'bill', orderNo, label: `SİPARİŞ #${orderNo}`, at: new Date(),
        lines: cart.map((l) => ({ name: l.product.name, quantity: l.qty, unitPrice: l.priceEach, options: l.optionLabel })),
        subtotal: co.data.subtotal, discount: 0, total: co.data.paidAmount,
        paymentMethod: method, received: co.data.received, change: co.data.change,
      });

      setCart([]); setPayOpen(false); setReceived('');
      setDoneNo(orderNo);
      setTimeout(() => setDoneNo(null), 8000);
    } catch (e) {
      // Kalem ekleme tek trx olduğundan yarım sipariş kalmaz; en kötü boş sipariş
      // kalır (panoda görünmez, zararsız). Sepet korunur — kasiyer tekrar dener.
      toast.error(e?.response?.data?.error || 'Sipariş tamamlanamadı.');
    } finally { setBusy(false); }
  };

  const cats = menu.filter((c) => (c.products || []).length);
  const cat = cats[Math.min(activeCat, Math.max(0, cats.length - 1))];

  return (
    <div className="fixed inset-0 bg-slate-950 text-slate-100 flex flex-col select-none">
      {/* Üst bar */}
      <header className="h-16 shrink-0 flex items-center gap-3 px-4 bg-slate-900 border-b border-slate-800">
        <div className="flex items-center gap-2 text-amber-400 font-extrabold text-xl">
          <UtensilsCrossed size={26} /> Self-Servis Kasa
        </div>
        <div className="flex-1" />
        <button onClick={load} className="h-11 w-11 grid place-items-center rounded-xl bg-slate-800 hover:bg-slate-700" title="Menüyü yenile"><RefreshCw size={20} /></button>
        {isAdmin && (
          <button onClick={() => navigate('/restoran')} className="h-11 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold flex items-center gap-2">
            <ArrowLeft size={18} /> Masa Planı
          </button>
        )}
      </header>

      <div className="flex-1 flex min-h-0">
        {/* Kategoriler */}
        <nav className="w-44 shrink-0 overflow-y-auto bg-slate-900/60 border-r border-slate-800 p-2 space-y-2">
          {cats.map((c, i) => (
            <button key={c.id ?? i} onClick={() => setActiveCat(i)}
              className={`w-full min-h-14 px-3 py-2 rounded-xl font-bold text-left ${i === activeCat ? 'bg-amber-500 text-amber-950' : 'bg-slate-800 hover:bg-slate-700'}`}>
              {c.name}
            </button>
          ))}
        </nav>

        {/* Ürünler */}
        <main className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="h-full grid place-items-center text-slate-500"><Loader2 className="animate-spin" size={40} /></div>
          ) : !cat ? (
            <div className="h-full grid place-items-center text-slate-400">Menü boş — Yönetim panelinden ürün ekleyin.</div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3">
              {cat.products.map((p) => (
                <button key={p.id} onClick={() => tapProduct(p)} disabled={busy}
                  className="min-h-28 rounded-2xl bg-slate-800 hover:bg-slate-700 active:scale-95 transition-all border border-slate-700 p-3 flex flex-col items-start justify-between text-left">
                  <span className="font-bold leading-tight">{p.name}</span>
                  <span className="text-amber-400 font-extrabold text-lg">{fmtTL(p.price)}</span>
                </button>
              ))}
            </div>
          )}
        </main>

        {/* Sepet */}
        <aside className="w-96 shrink-0 flex flex-col bg-slate-900 border-l border-slate-800">
          <div className="h-12 shrink-0 flex items-center gap-2 px-4 border-b border-slate-800 font-bold">
            <ShoppingCart size={18} className="text-amber-400" /> Sepet
            {cart.length > 0 && (
              <button onClick={() => setCart([])} className="ml-auto h-8 px-2 rounded-lg bg-slate-800 hover:bg-rose-600 text-xs font-semibold flex items-center gap-1">
                <Trash2 size={14} /> Boşalt
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {cart.length === 0 ? (
              <div className="h-full grid place-items-center text-slate-500 text-sm">Ürün seçin…</div>
            ) : cart.map((l) => (
              <div key={l.key} className="rounded-xl bg-slate-800 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-bold">{l.product.name}</div>
                    {l.optionLabel && <div className="text-xs text-sky-300">+ {l.optionLabel}</div>}
                  </div>
                  <div className="font-extrabold text-amber-400">{fmtTL(l.priceEach * l.qty)}</div>
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <button onClick={() => changeQty(l, -1)} className="h-10 w-10 grid place-items-center rounded-lg bg-slate-700 hover:bg-slate-600"><Minus size={18} /></button>
                  <span className="w-8 text-center font-extrabold text-lg">{l.qty}</span>
                  <button onClick={() => changeQty(l, 1)} className="h-10 w-10 grid place-items-center rounded-lg bg-slate-700 hover:bg-slate-600"><Plus size={18} /></button>
                </div>
              </div>
            ))}
          </div>
          <div className="shrink-0 border-t border-slate-800 p-3 space-y-2">
            <div className="flex items-center justify-between text-lg">
              <span className="font-semibold text-slate-300">TOPLAM</span>
              <span className="font-black text-2xl text-amber-400">{fmtTL(total)}</span>
            </div>
            <button onClick={() => { setReceived(''); setPayOpen(true); }} disabled={!cart.length || busy}
              className="w-full h-16 rounded-2xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 font-black text-xl flex items-center justify-center gap-2">
              {busy ? <Loader2 className="animate-spin" size={24} /> : <><Check size={24} /> ÖDEME AL</>}
            </button>
          </div>
        </aside>
      </div>

      {/* Ödeme modalı */}
      {payOpen && (
        <div className="fixed inset-0 z-40 bg-black/70 grid place-items-center p-4" onClick={() => !busy && setPayOpen(false)}>
          <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-700 p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-extrabold text-lg">Tahsilat — {fmtTL(total)}</h3>
              <button onClick={() => setPayOpen(false)} className="h-10 w-10 grid place-items-center rounded-xl bg-slate-800 hover:bg-slate-700"><X size={18} /></button>
            </div>
            <label className="block text-sm text-slate-400 mb-1">Alınan nakit (isteğe bağlı — para üstü için)</label>
            <input type="number" inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)}
              className="w-full h-14 rounded-xl bg-slate-800 border border-slate-700 px-4 text-2xl font-bold mb-1" placeholder={String(total)} />
            {change > 0 && <div className="text-emerald-400 font-bold mb-2">Para üstü: {fmtTL(change)}</div>}
            <div className="grid grid-cols-2 gap-3 mt-3">
              <button onClick={() => checkout('Nakit')} disabled={busy}
                className="h-20 rounded-2xl bg-emerald-600 hover:bg-emerald-500 font-black text-lg flex flex-col items-center justify-center gap-1">
                <Banknote size={26} /> NAKİT
              </button>
              <button onClick={() => checkout('Kredi Kartı')} disabled={busy}
                className="h-20 rounded-2xl bg-sky-600 hover:bg-sky-500 font-black text-lg flex flex-col items-center justify-center gap-1">
                <CreditCard size={26} /> KREDİ KARTI
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Seçenek modalı */}
      {optionProduct && (
        <div className="fixed inset-0 z-40 bg-black/70 grid place-items-center p-4" onClick={() => setOptionProduct(null)}>
          <div className="w-full max-w-lg rounded-2xl bg-slate-900 border border-slate-700 p-5 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-extrabold text-lg">{optionProduct.name}</h3>
              <button onClick={() => setOptionProduct(null)} className="h-10 w-10 grid place-items-center rounded-xl bg-slate-800 hover:bg-slate-700"><X size={18} /></button>
            </div>
            {optionProduct.optionGroups.map((g) => (
              <div key={g.id} className="mb-4">
                <div className="font-bold text-sm text-slate-300 mb-2">
                  {g.name} {g.min > 0 && <span className="text-amber-400">(zorunlu{g.min > 1 ? ` ×${g.min}` : ''})</span>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {(g.options || []).map((o) => {
                    const on = (optionSel[g.id] || new Set()).has(o.id);
                    return (
                      <button key={o.id} onClick={() => toggleOption(g, o.id)}
                        className={`h-12 px-4 rounded-xl font-semibold ${on ? 'bg-amber-500 text-amber-950' : 'bg-slate-800 hover:bg-slate-700'}`}>
                        {o.name}{o.priceDelta ? ` (${o.priceDelta > 0 ? '+' : ''}${fmtTL(o.priceDelta)})` : ''}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <button onClick={confirmOptions} className="w-full h-14 rounded-2xl bg-emerald-600 hover:bg-emerald-500 font-black text-lg">SEPETE EKLE</button>
          </div>
        </div>
      )}

      {/* Ödeme tamam — devasa sipariş numarası */}
      {doneNo != null && (
        <div className="fixed inset-0 z-50 bg-emerald-700 grid place-items-center" onClick={() => setDoneNo(null)}>
          <div className="text-center">
            <Check size={72} className="mx-auto mb-4 text-emerald-200" />
            <div className="text-3xl font-bold text-emerald-100 mb-2">Sipariş alındı</div>
            <div className="text-[120px] leading-none font-black text-white">#{doneNo}</div>
            <div className="mt-4 text-emerald-100 text-xl">Numaranız ekranda görününce alınız. Afiyet olsun!</div>
          </div>
        </div>
      )}

      <RestaurantPrint job={printJob} company={company} />
    </div>
  );
}
