import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Utensils, Plus, Minus, ArrowLeft, RefreshCw, Send, Check, Loader2, X, Users } from 'lucide-react';
import { api } from '../api/client';

// ArcTeknik Şef — Mobil Garson Terminali (Faz 4). Telefon/tablet için tek-sütun,
// büyük dokunmatik hedefler. Mevcut izole restoran API'sini kullanır (floor / menu
// / tables/:id/order / tables/:id/items / items / send-kitchen). Ödeme YOK —
// tahsilat kasa/host terminalinde. "Ana Ekrana Ekle" ile PWA gibi tam ekran çalışır
// (manifest.webmanifest + apple-meta). Rota: /restoran/garson.

const fmtTL = (v) => `${(Number(v) || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺`;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const TABLE_STYLE = {
  'Boş': 'bg-emerald-600/20 border-emerald-500/50 text-emerald-100',
  'Dolu': 'bg-rose-600/25 border-rose-500/60 text-rose-50',
  'Rezerve': 'bg-amber-600/20 border-amber-500/50 text-amber-100',
};

export default function RestaurantWaiter() {
  const navigate = useNavigate();

  const [view, setView] = useState('floor');
  const [sections, setSections] = useState([]);
  const [menu, setMenu] = useState([]);
  const [loading, setLoading] = useState(true);

  const [activeTable, setActiveTable] = useState(null);
  const [order, setOrder] = useState(null);
  const [pendingGuests, setPendingGuests] = useState(null);
  const [activeCat, setActiveCat] = useState(0);
  const [busy, setBusy] = useState(false);

  const [guestPrompt, setGuestPrompt] = useState(null);
  const [optionProduct, setOptionProduct] = useState(null);
  const [optionSel, setOptionSel] = useState({});

  const loadFloor = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    try {
      const { data } = await api.get('/restoran/floor');
      setSections(Array.isArray(data) ? data : []);
    } catch (e) {
      if (e?.response?.status === 403) toast.error('ArcTeknik Şef yetkiniz/lisansınız yok.');
      else if (!silent) toast.error('Masa planı yüklenemedi.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadMenu = useCallback(async () => {
    try {
      const { data } = await api.get('/restoran/menu');
      setMenu(Array.isArray(data) ? data : (data.categories || []));
    } catch { /* sessiz */ }
  }, []);

  useEffect(() => { loadFloor(); loadMenu(); }, [loadFloor, loadMenu]);

  // Masa planındayken canlı durum.
  useEffect(() => {
    if (view !== 'floor') return;
    const t = setInterval(() => loadFloor(true), 12000);
    return () => clearInterval(t);
  }, [view, loadFloor]);

  const refreshOrder = useCallback(async (tableId) => {
    try {
      const { data } = await api.get(`/restoran/tables/${tableId}/order`);
      setOrder(data.order || { orderId: null, items: [], total: 0 });
    } catch { /* sessiz */ }
  }, []);

  const openTable = useCallback(async (table, guests) => {
    setPendingGuests(guests ?? null);
    setActiveTable({ tableId: table.tableId, tableNo: table.tableNo });
    setView('order');
    setActiveCat(0);
    try {
      const { data } = await api.get(`/restoran/tables/${table.tableId}/order`);
      setOrder(data.order || { orderId: null, items: [], total: 0, guestCount: guests ?? null });
    } catch {
      toast.error('Adisyon açılamadı.');
      setOrder({ orderId: null, items: [], total: 0, guestCount: guests ?? null });
    }
  }, []);

  const handleTap = (table) => {
    if (table.status === 'Dolu' || table.currentOrderId) openTable(table, null);
    else { setGuestPrompt(table); }
  };
  const confirmGuest = (g) => {
    const t = guestPrompt;
    setGuestPrompt(null);
    if (t) openTable(t, g);
  };

  const addProduct = (product) => {
    if (product.optionGroups && product.optionGroups.length) {
      const init = {};
      for (const g of product.optionGroups) init[g.id] = new Set();
      setOptionSel(init);
      setOptionProduct(product);
      return;
    }
    doAddProduct(product, []);
  };

  const doAddProduct = async (product, optionIds) => {
    if (!activeTable || busy) return;
    setBusy(true);
    try {
      const body = { productId: product.id, quantity: 1, optionIds };
      if (!order?.orderId && pendingGuests) body.guestCount = pendingGuests;
      await api.post(`/restoran/tables/${activeTable.tableId}/items`, body);
      setOptionProduct(null); setOptionSel({});
      await refreshOrder(activeTable.tableId);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Ürün eklenemedi.');
    } finally { setBusy(false); }
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
    const ids = Object.values(optionSel).flatMap((s) => [...s]);
    doAddProduct(p, ids);
  };

  const optionPrice = useMemo(() => {
    if (!optionProduct) return 0;
    let total = optionProduct.price;
    for (const g of optionProduct.optionGroups) {
      for (const oid of (optionSel[g.id] || [])) {
        const o = g.options.find((x) => x.id === oid);
        if (o) total += o.priceDelta;
      }
    }
    return round2(total);
  }, [optionProduct, optionSel]);

  const changeQty = async (item, delta) => {
    if (busy) return;
    const next = item.quantity + delta;
    setBusy(true);
    try {
      if (next <= 0) await api.delete(`/restoran/items/${item.itemId}`);
      else await api.patch(`/restoran/items/${item.itemId}`, { quantity: next });
      await refreshOrder(activeTable.tableId);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Güncellenemedi.');
    } finally { setBusy(false); }
  };

  const sendKitchen = async () => {
    if (!order?.orderId || busy) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/restoran/orders/${order.orderId}/send-kitchen`);
      if (!data.groups || data.groups.length === 0) toast('Gönderilecek yeni kalem yok.', { icon: 'ℹ️' });
      else toast.success('Mutfağa gönderildi.');
      await refreshOrder(activeTable.tableId);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Gönderilemedi.');
    } finally { setBusy(false); }
  };

  const goFloor = () => { setView('floor'); setActiveTable(null); setOrder(null); loadFloor(true); };

  const items = order?.items || [];
  const unsent = items.filter((i) => !i.sent && !i.paid).length;
  const cats = menu;

  // ── Masa planı ────────────────────────────────────────────────────────────
  if (view === 'floor') {
    return (
      <div className="min-h-[100dvh] bg-slate-950 text-slate-100 flex flex-col">
        <header className="sticky top-0 z-10 h-14 px-3 flex items-center gap-2 bg-slate-900 border-b border-slate-800">
          <span className="flex items-center gap-2 font-extrabold"><Utensils size={20} className="text-amber-400" /> Garson</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => loadFloor()} className="h-10 w-10 grid place-items-center rounded-xl bg-slate-800 active:bg-slate-700"><RefreshCw size={18} /></button>
            <button onClick={() => navigate('/')} className="h-10 px-3 rounded-xl bg-slate-800 active:bg-slate-700 text-sm font-semibold">Panel</button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          {loading ? (
            <div className="py-16 flex items-center justify-center text-slate-400"><Loader2 className="animate-spin mr-2" size={20} /> Yükleniyor…</div>
          ) : sections.length === 0 ? (
            <p className="text-center text-slate-400 py-16">Masa yok. Yönetimden masa ekleyin.</p>
          ) : sections.map((s) => (
            <div key={s.id ?? 'none'}>
              <h2 className="text-sm font-bold text-slate-400 mb-2">{s.name}</h2>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {(s.tables || []).map((t) => (
                  <button key={t.tableId} onClick={() => handleTap(t)}
                    className={`aspect-square rounded-2xl border-2 flex flex-col items-center justify-center font-extrabold active:scale-95 transition ${TABLE_STYLE[t.status] || 'bg-slate-800 border-slate-700'}`}>
                    <span className="text-xl">{t.tableNo}</span>
                    {t.orderTotal > 0 && <span className="text-[11px] font-semibold opacity-80 mt-0.5">{fmtTL(t.orderTotal)}</span>}
                  </button>
                ))}
                {(s.tables || []).length === 0 && <span className="text-slate-600 text-sm col-span-3">Masa yok.</span>}
              </div>
            </div>
          ))}
        </div>

        {/* Kişi sayısı sor (boş masa) */}
        {guestPrompt && (
          <Sheet title={`Masa ${guestPrompt.tableNo} — Kişi sayısı`} onClose={() => setGuestPrompt(null)}>
            <div className="grid grid-cols-4 gap-2">
              {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
                <button key={n} onClick={() => confirmGuest(n)} className="h-14 rounded-xl bg-slate-800 active:bg-amber-500 active:text-amber-950 font-extrabold text-lg">{n}</button>
              ))}
            </div>
            <button onClick={() => confirmGuest(null)} className="mt-3 w-full h-12 rounded-xl bg-slate-700 active:bg-slate-600 font-bold">Atla (kişi belirtme)</button>
          </Sheet>
        )}
      </div>
    );
  }

  // ── Adisyon (sipariş alma) ──────────────────────────────────────────────────
  return (
    <div className="min-h-[100dvh] bg-slate-950 text-slate-100 flex flex-col">
      <header className="sticky top-0 z-10 h-14 px-2 flex items-center gap-2 bg-slate-900 border-b border-slate-800">
        <button onClick={goFloor} className="h-10 w-10 grid place-items-center rounded-xl bg-slate-800 active:bg-slate-700"><ArrowLeft size={20} /></button>
        <span className="font-extrabold">Masa {activeTable?.tableNo}{order?.guestCount ? <span className="text-xs text-slate-400 font-medium"> · {order.guestCount} kişi</span> : null}</span>
        <span className="ml-auto text-lg font-extrabold text-amber-400">{fmtTL(order?.total || 0)}</span>
      </header>

      {/* Mevcut kalemler */}
      {items.length > 0 && (
        <div className="shrink-0 max-h-[34dvh] overflow-y-auto p-2 space-y-1.5 border-b border-slate-800 bg-slate-900/40">
          {items.map((it) => (
            <div key={it.itemId} className={`rounded-xl p-2 border flex items-center gap-2 ${it.paid ? 'border-emerald-700 bg-emerald-900/20 opacity-70' : 'border-slate-700 bg-slate-800'}`}>
              <div className="flex-1 min-w-0">
                <div className="font-bold text-sm truncate">{it.name}{!it.sent && !it.paid && <span className="ml-1 text-[10px] text-amber-400">●yeni</span>}</div>
                {it.options && <div className="text-[11px] text-sky-300 truncate">{it.options}</div>}
                <div className="text-[11px] text-slate-400">{fmtTL(it.unitPrice)} × {it.quantity}</div>
              </div>
              {it.paid ? (
                <span className="text-xs font-bold text-emerald-400 flex items-center gap-1"><Check size={13} /> Ödendi</span>
              ) : (
                <div className="flex items-center gap-1.5">
                  <button onClick={() => changeQty(it, -1)} className="h-9 w-9 grid place-items-center rounded-lg bg-slate-700 active:bg-slate-600"><Minus size={16} /></button>
                  <span className="w-5 text-center font-bold">{it.quantity}</span>
                  <button onClick={() => changeQty(it, +1)} className="h-9 w-9 grid place-items-center rounded-lg bg-slate-700 active:bg-slate-600"><Plus size={16} /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Kategori sekmeleri */}
      <div className="shrink-0 flex gap-2 overflow-x-auto p-2 border-b border-slate-800">
        {cats.map((c, i) => (
          <button key={c.id ?? i} onClick={() => setActiveCat(i)}
            className={`shrink-0 h-10 px-4 rounded-full font-bold text-sm ${activeCat === i ? 'bg-amber-500 text-amber-950' : 'bg-slate-800 text-slate-200'}`}>
            {c.name}
          </button>
        ))}
        {cats.length === 0 && <span className="text-slate-500 text-sm px-2 py-2">Menü boş.</span>}
      </div>

      {/* Ürünler */}
      <div className="flex-1 overflow-y-auto p-2">
        <div className="grid grid-cols-2 gap-2 pb-2">
          {(cats[activeCat]?.products || []).map((p) => (
            <button key={p.id} onClick={() => addProduct(p)} disabled={busy}
              className="min-h-[72px] rounded-2xl bg-slate-800 active:bg-slate-700 border border-slate-700 p-2.5 flex flex-col justify-between text-left disabled:opacity-50">
              <span className="font-bold text-sm leading-tight">{p.name}</span>
              <span className="text-amber-400 font-extrabold mt-1">{fmtTL(p.price)}</span>
            </button>
          ))}
          {(cats[activeCat]?.products || []).length === 0 && <p className="text-slate-500 text-sm col-span-2 text-center py-6">Bu kategoride ürün yok.</p>}
        </div>
      </div>

      {/* Mutfağa gönder */}
      <div className="shrink-0 p-2 border-t border-slate-800 bg-slate-900" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}>
        <button onClick={sendKitchen} disabled={busy || unsent === 0}
          className="w-full h-14 rounded-2xl bg-amber-500 text-amber-950 font-extrabold flex items-center justify-center gap-2 active:bg-amber-400 disabled:opacity-40">
          {busy ? <Loader2 className="animate-spin" size={20} /> : <Send size={20} />} Mutfağa Gönder{unsent > 0 ? ` (${unsent})` : ''}
        </button>
      </div>

      {/* Seçenek alt-sayfası */}
      {optionProduct && (
        <Sheet title={optionProduct.name} onClose={() => setOptionProduct(null)}>
          <div className="space-y-3 max-h-[50dvh] overflow-y-auto">
            {optionProduct.optionGroups.map((g) => (
              <div key={g.id}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-bold">{g.name}</span>
                  <span className="text-xs text-slate-400">{g.min > 0 ? `en az ${g.min}` : 'opsiyonel'}{g.max > 0 ? ` · en çok ${g.max}` : ''}</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {g.options.map((o) => {
                    const sel = (optionSel[g.id] || new Set()).has(o.id);
                    return (
                      <button key={o.id} onClick={() => toggleOption(g, o.id)}
                        className={`h-12 rounded-xl px-3 flex items-center justify-between font-semibold border ${sel ? 'border-amber-500 bg-amber-500/15 text-amber-100' : 'border-slate-700 bg-slate-800'}`}>
                        <span className="truncate">{o.name}</span>
                        {o.priceDelta !== 0 && <span className="text-xs shrink-0 ml-1">{o.priceDelta > 0 ? '+' : ''}{fmtTL(o.priceDelta)}</span>}
                      </button>
                    );
                  })}
                  {g.options.length === 0 && <span className="text-slate-500 text-sm col-span-2">Seçenek yok.</span>}
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between mt-3 mb-2 text-lg">
            <span className="text-slate-400">Fiyat</span>
            <span className="font-extrabold text-amber-400">{fmtTL(optionPrice)}</span>
          </div>
          <button onClick={confirmOptions} disabled={busy} className="w-full h-14 rounded-2xl bg-emerald-600 active:bg-emerald-500 font-extrabold flex items-center justify-center gap-2 disabled:opacity-40"><Plus size={20} /> Adisyona Ekle</button>
        </Sheet>
      )}
    </div>
  );
}

// ── Alt-sayfa (bottom sheet) ─────────────────────────────────────────────────
function Sheet({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end" onClick={onClose}>
      <div className="w-full bg-slate-900 border-t border-slate-700 rounded-t-3xl p-4 max-h-[85dvh] overflow-y-auto" onClick={(e) => e.stopPropagation()}
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-lg flex items-center gap-2"><Users size={18} className="text-amber-400" /> {title}</h3>
          <button onClick={onClose} className="h-9 w-9 grid place-items-center rounded-lg bg-slate-800 active:bg-slate-700"><X size={20} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
