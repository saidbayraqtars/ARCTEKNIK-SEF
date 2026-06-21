import { useState, useEffect, useCallback, useMemo } from 'react';
import toast from 'react-hot-toast';
import {
  X, ArrowLeft, Plus, Minus, Trash2, Search, User, Phone, MapPin, Loader2, Check,
  Banknote, CreditCard, Ticket, Wallet, Send, Printer, Truck, Bike, Package, ShoppingBag, Layers, Gift,
} from 'lucide-react';
import { api } from '../api/client';

// ArcTeknik Şef — Paket Servis & Gel-Al paneli (Faz 2). Tam ekran overlay.
// Masasız adisyon: müşteri rehberi (telefon arama = caller-id karşılığı), adres,
// kurye atama + teslim durumu, açık hesap (veresiye) ödeme. İzole bileşen;
// menüyü + yazdırmayı ana ekrandan (props) alır.

const fmtTL = (v) => `${(Number(v) || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺`;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const DELIVERY_STYLE = {
  'Hazırlanıyor': 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  'Yolda': 'bg-sky-500/20 text-sky-300 border-sky-500/40',
  'Teslim': 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  'İptal': 'bg-rose-500/20 text-rose-300 border-rose-500/40',
};

export default function RestaurantPackages({ menu, company, isAdmin, onPrint, onClose }) {
  const [mode, setMode] = useState('list');        // 'list' | 'new' | 'detail'
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);      // seçili sipariş (GET /orders/:id)
  const [couriers, setCouriers] = useState([]);
  const [courierMgmt, setCourierMgmt] = useState(false);

  const loadList = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    try {
      const { data } = await api.get('/restoran/package-orders');
      setList(Array.isArray(data) ? data : []);
    } catch (e) {
      if (e?.response?.status === 403) toast.error('Modül lisanslı değil veya yetkiniz yok.');
      else if (!silent) toast.error('Paket siparişler alınamadı.');
    } finally { if (!silent) setLoading(false); }
  }, []);

  const loadCouriers = useCallback(async () => {
    try { const { data } = await api.get('/restoran/couriers'); setCouriers(Array.isArray(data) ? data : []); }
    catch { /* sessiz */ }
  }, []);

  useEffect(() => { loadList(); loadCouriers(); }, [loadList, loadCouriers]);
  useEffect(() => {
    if (mode !== 'list') return;
    const t = setInterval(() => loadList(true), 12000);
    return () => clearInterval(t);
  }, [mode, loadList]);

  const openDetail = async (orderId) => {
    try {
      const { data } = await api.get(`/restoran/orders/${orderId}`);
      setDetail(data); setMode('detail');
    } catch { toast.error('Sipariş açılamadı.'); }
  };
  const refreshDetail = async () => { if (detail?.orderId) { const { data } = await api.get(`/restoran/orders/${detail.orderId}`); setDetail(data); } };

  const activeCouriers = couriers.filter((c) => c.isActive);

  return (
    <div className="fixed inset-0 z-40 bg-slate-950 text-slate-100 flex flex-col select-none">
      {/* Üst bar */}
      <header className="h-16 shrink-0 flex items-center gap-3 px-4 bg-slate-900 border-b border-slate-800">
        {mode === 'list' ? (
          <div className="flex items-center gap-2 text-amber-400 font-extrabold text-xl"><Bike size={26} /> Paket Servis</div>
        ) : (
          <button onClick={() => { setMode('list'); setDetail(null); loadList(true); }} className="flex items-center gap-2 px-4 h-11 rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold">
            <ArrowLeft size={20} /> Liste
          </button>
        )}
        <div className="flex-1 text-center font-bold text-lg truncate">
          {mode === 'new' ? 'Yeni Sipariş' : mode === 'detail' ? `${detail?.orderType || ''} ${detail?.customerName || ''}` : `${list.length} aktif sipariş`}
        </div>
        <div className="flex items-center gap-2">
          {mode === 'list' && (
            <>
              {isAdmin && (
                <button onClick={() => setCourierMgmt(true)} className="h-11 px-3 flex items-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold" title="Kuryeler">
                  <Truck size={18} /> <span className="hidden sm:inline">Kuryeler</span>
                </button>
              )}
              <button onClick={() => setMode('new')} className="h-11 px-4 flex items-center gap-2 rounded-xl bg-amber-500 text-amber-950 font-extrabold">
                <Plus size={18} /> Yeni
              </button>
            </>
          )}
          <button onClick={onClose} className="h-11 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold flex items-center gap-2"><X size={18} /> Kapat</button>
        </div>
      </header>

      {mode === 'list' && (
        <PackageList list={list} loading={loading} onOpen={openDetail} onRefresh={() => loadList()} />
      )}
      {mode === 'new' && (
        <NewPackageOrder menu={menu} onCreated={(id) => { loadList(true); openDetail(id); }} onCancel={() => setMode('list')} />
      )}
      {mode === 'detail' && detail && (
        <PackageDetail
          menu={menu} detail={detail} company={company} couriers={activeCouriers} onPrint={onPrint}
          onRefresh={refreshDetail} onClosed={() => { setMode('list'); setDetail(null); loadList(true); }}
        />
      )}

      {courierMgmt && <CourierModal couriers={couriers} reload={loadCouriers} onClose={() => setCourierMgmt(false)} />}
    </div>
  );
}

// ── Aktif paket/gel-al listesi ───────────────────────────────────────────────
function PackageList({ list, loading, onOpen, onRefresh }) {
  if (loading) return <div className="flex-1 grid place-items-center text-slate-500"><Loader2 className="animate-spin" size={40} /></div>;
  if (list.length === 0) {
    return (
      <div className="flex-1 grid place-items-center text-center text-slate-400">
        <div>
          <Package size={48} className="mx-auto mb-3 opacity-60" />
          <p className="text-lg font-semibold">Aktif paket/gel-al siparişi yok.</p>
          <p className="mt-1">Sağ üstten <b>Yeni</b> ile sipariş açın.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
        {list.map((o) => (
          <button key={o.orderId} onClick={() => onOpen(o.orderId)}
            className="text-left rounded-2xl bg-slate-900 border border-slate-800 hover:border-slate-600 p-4 active:scale-[.99] transition-all">
            <div className="flex items-center justify-between mb-2">
              <span className="flex items-center gap-1.5 font-extrabold">
                {o.orderType === 'Gel-Al' ? <ShoppingBag size={16} className="text-amber-400" /> : <Bike size={16} className="text-sky-400" />}
                {o.orderType}
              </span>
              {o.deliveryStatus && <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${DELIVERY_STYLE[o.deliveryStatus] || ''}`}>{o.deliveryStatus}</span>}
            </div>
            <div className="font-bold truncate">{o.customerName || 'İsimsiz'}</div>
            {o.customerPhone && <div className="text-sm text-slate-400 flex items-center gap-1"><Phone size={12} /> {o.customerPhone}</div>}
            {o.deliveryAddress && <div className="text-xs text-slate-500 mt-1 line-clamp-2">{o.deliveryAddress}</div>}
            <div className="flex items-center justify-between mt-2">
              <span className="text-xs text-slate-500">{o.courierName ? `🛵 ${o.courierName}` : new Date(o.openedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</span>
              <span className="font-extrabold text-amber-400">{fmtTL(o.total)}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Müşteri arama / seçim (caller-id karşılığı) ──────────────────────────────
function CustomerPicker({ value, onPick }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', addressText: '', directions: '' });

  const search = useCallback(async (term) => {
    setSearching(true);
    try { const { data } = await api.get('/restoran/customers', { params: { q: term } }); setResults(Array.isArray(data) ? data : []); }
    catch { /* sessiz */ } finally { setSearching(false); }
  }, []);
  useEffect(() => { const t = setTimeout(() => search(q), 300); return () => clearTimeout(t); }, [q, search]);

  const pick = async (c) => {
    try {
      const { data } = await api.get(`/restoran/customers/${c.customerId}`);
      onPick(data);
    } catch { toast.error('Müşteri yüklenemedi.'); }
  };

  const createCustomer = async () => {
    if (!form.name.trim()) { toast.error('Ad gerekli.'); return; }
    try {
      const { data } = await api.post('/restoran/customers', form);
      const { data: full } = await api.get(`/restoran/customers/${data.id}`);
      onPick(full); setCreating(false);
      toast.success('Müşteri eklendi.');
    } catch (e) { toast.error(e?.response?.data?.error || 'Eklenemedi.'); }
  };

  if (value) {
    return (
      <div className="rounded-xl border border-emerald-700 bg-emerald-900/20 p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-bold flex items-center gap-1"><User size={15} /> {value.name}</div>
            {value.phone && <div className="text-sm text-slate-400 flex items-center gap-1"><Phone size={12} /> {value.phone}</div>}
          </div>
          <button onClick={() => onPick(null)} className="h-8 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm font-semibold">Değiştir</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {!creating ? (
        <>
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Telefon veya ad ile ara…"
              className="w-full h-12 rounded-xl bg-slate-800 border border-slate-700 pl-9 pr-3 outline-none focus:border-amber-500" />
          </div>
          <div className="max-h-44 overflow-y-auto mt-2 space-y-1">
            {searching && <div className="text-center text-slate-500 py-2"><Loader2 className="animate-spin inline" size={18} /></div>}
            {!searching && results.map((c) => (
              <button key={c.customerId} onClick={() => pick(c)} className="w-full text-left p-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700">
                <div className="font-semibold">{c.name} <span className="text-slate-400 font-normal">{c.phone}</span></div>
                {c.lastAddress && <div className="text-xs text-slate-500 truncate">{c.lastAddress}</div>}
              </button>
            ))}
            {!searching && q && results.length === 0 && <div className="text-center text-slate-500 text-sm py-2">Müşteri bulunamadı.</div>}
          </div>
          <button onClick={() => { setForm({ name: '', phone: q.match(/\d/) ? q : '', addressText: '', directions: '' }); setCreating(true); }}
            className="mt-2 w-full h-11 rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold flex items-center justify-center gap-2"><Plus size={16} /> Yeni Müşteri</button>
        </>
      ) : (
        <div className="space-y-2">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ad Soyad" className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" placeholder="Telefon" className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
          <textarea value={form.addressText} onChange={(e) => setForm({ ...form, addressText: e.target.value })} rows={2} placeholder="Adres (paket için)" className="w-full rounded-xl bg-slate-800 border border-slate-700 p-3 outline-none focus:border-amber-500" />
          <input value={form.directions} onChange={(e) => setForm({ ...form, directions: e.target.value })} placeholder="Adres tarifi (kapı no, kat…)" className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => setCreating(false)} className="h-11 rounded-xl bg-slate-700 hover:bg-slate-600 font-bold">Geri</button>
            <button onClick={createCustomer} className="h-11 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-extrabold">Kaydet</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Yeni paket / gel-al sipariş ──────────────────────────────────────────────
function NewPackageOrder({ menu, onCreated, onCancel }) {
  const [orderType, setOrderType] = useState('Paket');
  const [customer, setCustomer] = useState(null);   // {customerId, name, phone, addresses[]}
  const [addressId, setAddressId] = useState(null);
  const [manualAddr, setManualAddr] = useState('');
  const [activeCat, setActiveCat] = useState(0);
  const [cart, setCart] = useState([]);             // [{key, product, optionIds, optionsLabel, unitPrice, quantity}]
  const [optionProduct, setOptionProduct] = useState(null);
  const [busy, setBusy] = useState(false);

  const cartTotal = useMemo(() => round2(cart.reduce((s, c) => s + c.unitPrice * c.quantity, 0)), [cart]);

  const addToCart = (product, optionIds, optionsLabel, unitPrice) => {
    setCart((prev) => [...prev, { key: Date.now() + Math.random(), product, optionIds, optionsLabel, unitPrice, quantity: 1 }]);
  };
  const onProductTap = (p) => {
    if (p.optionGroups && p.optionGroups.length) { setOptionProduct(p); return; }
    addToCart(p, [], '', p.price);
  };
  const changeQty = (key, d) => setCart((prev) => prev.flatMap((c) => c.key !== key ? [c] : (c.quantity + d <= 0 ? [] : [{ ...c, quantity: c.quantity + d }])));

  const create = async () => {
    if (cart.length === 0) { toast.error('Sepet boş.'); return; }
    if (orderType === 'Paket' && !addressId && !manualAddr.trim() && !customer) { toast.error('Paket için adres gerekli.'); return; }
    setBusy(true);
    try {
      const body = {
        orderType,
        customerId: customer?.customerId || null,
        customerName: customer?.name || null,
        customerPhone: customer?.phone || null,
        addressId: orderType === 'Paket' ? addressId : null,
        deliveryAddress: orderType === 'Paket' && !addressId ? (manualAddr.trim() || null) : null,
        items: cart.map((c) => ({ productId: c.product.id, quantity: c.quantity, optionIds: c.optionIds })),
      };
      const { data } = await api.post('/restoran/package-orders', body);
      toast.success('Sipariş oluşturuldu.');
      onCreated(data.orderId);
    } catch (e) { toast.error(e?.response?.data?.error || 'Oluşturulamadı.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex-1 min-h-0 flex">
      {/* Sol: müşteri + sepet */}
      <div className="w-[42%] max-w-[540px] shrink-0 flex flex-col bg-slate-900 border-r border-slate-800">
        <div className="p-3 space-y-3 overflow-y-auto flex-1">
          {/* Tür */}
          <div className="grid grid-cols-2 gap-2">
            {['Paket', 'Gel-Al'].map((t) => (
              <button key={t} onClick={() => setOrderType(t)} className={`h-12 rounded-xl font-bold flex items-center justify-center gap-2 ${orderType === t ? 'bg-amber-500 text-amber-950' : 'bg-slate-800 hover:bg-slate-700'}`}>
                {t === 'Gel-Al' ? <ShoppingBag size={18} /> : <Bike size={18} />} {t}
              </button>
            ))}
          </div>

          {/* Müşteri */}
          <CustomerPicker value={customer} onPick={(c) => { setCustomer(c); setAddressId(c?.addresses?.[0]?.addressId || null); }} />

          {/* Adres (paket) */}
          {orderType === 'Paket' && (
            <div>
              <div className="text-sm text-slate-400 mb-1 flex items-center gap-1"><MapPin size={14} /> Teslim Adresi</div>
              {customer?.addresses?.length > 0 ? (
                <div className="space-y-1">
                  {customer.addresses.map((a) => (
                    <button key={a.addressId} onClick={() => setAddressId(a.addressId)}
                      className={`w-full text-left p-2.5 rounded-lg border ${addressId === a.addressId ? 'border-amber-500 bg-amber-500/10' : 'border-slate-700 bg-slate-800'}`}>
                      <div className="font-semibold text-sm">{a.label || 'Adres'}</div>
                      <div className="text-xs text-slate-400">{a.addressText}{a.directions ? ` — ${a.directions}` : ''}</div>
                    </button>
                  ))}
                  <button onClick={() => setAddressId(null)} className={`w-full text-left p-2.5 rounded-lg border ${addressId === null ? 'border-amber-500 bg-amber-500/10' : 'border-slate-700 bg-slate-800'} text-sm`}>Elle adres gir…</button>
                </div>
              ) : null}
              {(!customer || addressId === null) && (
                <textarea value={manualAddr} onChange={(e) => setManualAddr(e.target.value)} rows={2} placeholder="Teslim adresi…"
                  className="w-full mt-1 rounded-xl bg-slate-800 border border-slate-700 p-3 outline-none focus:border-amber-500" />
              )}
            </div>
          )}

          {/* Sepet */}
          <div>
            <div className="text-sm text-slate-400 mb-1">Sepet</div>
            {cart.length === 0 ? <p className="text-slate-600 text-sm">Sağdan ürün ekleyin.</p> : (
              <div className="space-y-1.5">
                {cart.map((c) => (
                  <div key={c.key} className="rounded-lg bg-slate-800 border border-slate-700 p-2 flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold truncate text-sm">{c.product.name}</div>
                      {c.optionsLabel && <div className="text-xs text-sky-300 truncate">{c.optionsLabel}</div>}
                      <div className="text-xs text-slate-400">{fmtTL(c.unitPrice)} × {c.quantity}</div>
                    </div>
                    <button onClick={() => changeQty(c.key, -1)} className="h-8 w-8 grid place-items-center rounded-lg bg-slate-700 hover:bg-slate-600"><Minus size={14} /></button>
                    <span className="w-6 text-center font-bold">{c.quantity}</span>
                    <button onClick={() => changeQty(c.key, +1)} className="h-8 w-8 grid place-items-center rounded-lg bg-slate-700 hover:bg-slate-600"><Plus size={14} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 p-3 border-t border-slate-800 space-y-2">
          <div className="flex items-center justify-between text-lg">
            <span className="text-slate-400">Toplam</span>
            <span className="font-extrabold text-amber-400 text-2xl">{fmtTL(cartTotal)}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={onCancel} className="h-12 rounded-xl bg-slate-700 hover:bg-slate-600 font-bold">Vazgeç</button>
            <button onClick={create} disabled={busy || cart.length === 0} className="h-12 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-extrabold disabled:opacity-40 flex items-center justify-center gap-2">
              {busy ? <Loader2 className="animate-spin" size={18} /> : <Check size={18} />} Siparişi Aç
            </button>
          </div>
        </div>
      </div>

      {/* Sağ: menü */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="shrink-0 flex gap-2 p-3 overflow-x-auto border-b border-slate-800">
          {menu.length === 0 && <span className="text-slate-500 text-sm py-2">Menü boş.</span>}
          {menu.map((c, i) => (
            <button key={c.id ?? `c${i}`} onClick={() => setActiveCat(i)} className={`px-5 h-12 rounded-xl font-bold whitespace-nowrap ${i === activeCat ? 'bg-amber-500 text-amber-950' : 'bg-slate-800 hover:bg-slate-700'}`}>{c.name}</button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
            {(menu[activeCat]?.products || []).map((p) => (
              <button key={p.id} onClick={() => onProductTap(p)}
                className="h-28 rounded-2xl bg-slate-800 hover:bg-slate-700 border border-slate-700 active:scale-95 transition-all p-3 flex flex-col justify-between text-left">
                <span className="font-bold leading-tight flex items-start gap-1">{p.name}{p.optionGroups?.length > 0 && <Layers size={13} className="text-sky-400 shrink-0 mt-0.5" />}</span>
                <span className="text-amber-400 font-extrabold text-lg">{fmtTL(p.price)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {optionProduct && (
        <OptionModal product={optionProduct} onClose={() => setOptionProduct(null)}
          onConfirm={(ids, label, price) => { addToCart(optionProduct, ids, label, price); setOptionProduct(null); }} />
      )}
    </div>
  );
}

// ── Sipariş detayı (kalem ekle, kurye, teslim, tahsilat) ─────────────────────
function PackageDetail({ menu, detail, company, couriers, onPrint, onRefresh, onClosed }) {
  const [activeCat, setActiveCat] = useState(0);
  const [busy, setBusy] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [optionProduct, setOptionProduct] = useState(null);
  const [custPoints, setCustPoints] = useState(0);

  const unpaid = (detail.items || []).filter((i) => !i.paid);
  const unsent = unpaid.filter((i) => !i.sent).length;
  const isPaket = detail.orderType === 'Paket';

  // Müşteri puan bakiyesi (sadakat) — ödeme modalında "puan kullan" için.
  useEffect(() => {
    let alive = true;
    if (!detail.customerId) { setCustPoints(0); return; }
    api.get(`/restoran/customers/${detail.customerId}`)
      .then(({ data }) => { if (alive) setCustPoints(Number(data?.points || 0)); })
      .catch(() => { if (alive) setCustPoints(0); });
    return () => { alive = false; };
  }, [detail.customerId, detail.orderId]);

  const addItem = async (product, optionIds) => {
    setBusy(true);
    try {
      await api.post(`/restoran/orders/${detail.orderId}/items`, { productId: product.id, quantity: 1, optionIds });
      await onRefresh();
    } catch (e) { toast.error(e?.response?.data?.error || 'Eklenemedi.'); }
    finally { setBusy(false); }
  };
  const onProductTap = (p) => { if (p.optionGroups?.length) setOptionProduct(p); else addItem(p, []); };

  const changeQty = async (item, d) => {
    setBusy(true);
    try {
      const next = item.quantity + d;
      if (next <= 0) await api.delete(`/restoran/items/${item.itemId}`);
      else await api.patch(`/restoran/items/${item.itemId}`, { quantity: next });
      await onRefresh();
    } catch (e) { toast.error(e?.response?.data?.error || 'Güncellenemedi.'); }
    finally { setBusy(false); }
  };

  const sendKitchen = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(`/restoran/orders/${detail.orderId}/send-kitchen`);
      if (!data.groups || data.groups.length === 0) toast('Gönderilecek yeni kalem yok.', { icon: 'ℹ️' });
      else { onPrint({ type: 'kitchen', tableNo: `${detail.orderType} ${detail.customerName || ''}`, label: data.label, at: data.at, groups: data.groups }); toast.success('Mutfağa gönderildi.'); }
      await onRefresh();
    } catch (e) { toast.error(e?.response?.data?.error || 'Gönderilemedi.'); }
    finally { setBusy(false); }
  };

  const assignCourier = async (courierId) => {
    setBusy(true);
    try { await api.post(`/restoran/orders/${detail.orderId}/assign-courier`, { courierId }); toast.success('Kurye atandı.'); await onRefresh(); }
    catch (e) { toast.error(e?.response?.data?.error || 'Atanamadı.'); }
    finally { setBusy(false); }
  };
  const setDelivery = async (status) => {
    setBusy(true);
    try { await api.patch(`/restoran/orders/${detail.orderId}/delivery`, { status }); toast.success(`Durum: ${status}`); await onRefresh(); }
    catch (e) { toast.error(e?.response?.data?.error || 'Güncellenemedi.'); }
    finally { setBusy(false); }
  };

  const doCheckout = async (body) => {
    setBusy(true);
    try {
      const payingItems = unpaid;
      const { data } = await api.post(`/restoran/orders/${detail.orderId}/checkout`, body);
      toast.success(`Tahsilat: ${fmtTL(data.paidAmount)}`);
      if (data.pointsRedeemed > 0) toast(`${data.pointsRedeemed} puan kullanıldı`, { icon: '🎁' });
      if (data.pointsEarned > 0) toast.success(`+${data.pointsEarned} puan kazanıldı (bakiye ${data.pointsBalance})`);
      onPrint({
        type: 'bill', tableNo: `${detail.orderType} ${detail.customerName || ''}`,
        lines: payingItems.map((i) => ({ name: i.name, options: i.options, unitPrice: i.unitPrice, quantity: i.quantity, treat: i.kitchenStatus === 'İkram' })),
        subtotal: data.subtotal, discount: data.discount, total: data.paidAmount, paymentMethod: data.paymentMethod, received: data.received, change: data.change, at: new Date(),
      });
      setPayOpen(false);
      if (data.orderClosed) onClosed(); else await onRefresh();
    } catch (e) { toast.error(e?.response?.data?.error || 'Tahsilat başarısız.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex-1 min-h-0 flex">
      {/* Sol: bilgi + kalemler + aksiyon */}
      <div className="w-[42%] max-w-[540px] shrink-0 flex flex-col bg-slate-900 border-r border-slate-800">
        {/* Müşteri/teslim başlığı */}
        <div className="shrink-0 p-3 border-b border-slate-800">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 font-extrabold">{isPaket ? <Bike size={18} className="text-sky-400" /> : <ShoppingBag size={18} className="text-amber-400" />} {detail.orderType}</span>
            {detail.deliveryStatus && <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${DELIVERY_STYLE[detail.deliveryStatus] || ''}`}>{detail.deliveryStatus}</span>}
          </div>
          {detail.customerName && <div className="mt-1 font-bold flex items-center gap-1"><User size={14} /> {detail.customerName}
            {custPoints > 0 && <span className="ml-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/40 flex items-center gap-1"><Gift size={11} /> {custPoints} puan</span>}
          </div>}
          {detail.customerPhone && <div className="text-sm text-slate-400 flex items-center gap-1"><Phone size={12} /> {detail.customerPhone}</div>}
          {detail.deliveryAddress && <div className="text-xs text-slate-500 mt-1 flex items-start gap-1"><MapPin size={12} className="mt-0.5 shrink-0" /> {detail.deliveryAddress}</div>}
          {detail.courierName && <div className="text-xs text-sky-300 mt-1">🛵 {detail.courierName}{detail.assignedAt ? ` · ${new Date(detail.assignedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}` : ''}</div>}
        </div>

        {/* Kalemler */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {(detail.items || []).map((it) => (
            <div key={it.itemId} className={`rounded-xl p-2.5 border ${it.paid ? 'border-emerald-700 bg-emerald-900/20 opacity-70' : 'border-slate-700 bg-slate-800'}`}>
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="font-bold truncate text-sm">{it.name}{!it.sent && !it.paid && <span className="ml-1 text-[10px] text-amber-400">●yeni</span>}</div>
                  {it.options && <div className="text-xs text-sky-300 truncate">{it.options}</div>}
                  <div className="text-xs text-slate-400">{fmtTL(it.unitPrice)} × {it.quantity} = <b className="text-slate-200">{fmtTL(it.unitPrice * it.quantity)}</b></div>
                </div>
                {!it.paid ? (
                  <div className="flex items-center gap-1">
                    <button onClick={() => changeQty(it, -1)} className="h-8 w-8 grid place-items-center rounded-lg bg-slate-700 hover:bg-slate-600"><Minus size={14} /></button>
                    <span className="w-5 text-center font-bold text-sm">{it.quantity}</span>
                    <button onClick={() => changeQty(it, +1)} className="h-8 w-8 grid place-items-center rounded-lg bg-slate-700 hover:bg-slate-600"><Plus size={14} /></button>
                  </div>
                ) : <span className="text-xs font-bold text-emerald-400 flex items-center gap-1"><Check size={13} /> Ödendi</span>}
              </div>
            </div>
          ))}
          {(detail.items || []).length === 0 && <p className="text-center text-slate-500 mt-6">Adisyon boş. Sağdan ürün ekleyin.</p>}
        </div>

        {/* Aksiyonlar */}
        <div className="shrink-0 p-3 border-t border-slate-800 space-y-2">
          <button onClick={sendKitchen} disabled={busy || unsent === 0} className="w-full h-11 rounded-xl bg-amber-500 text-amber-950 font-extrabold flex items-center justify-center gap-2 disabled:opacity-40">
            <Send size={18} /> Mutfağa Gönder{unsent > 0 ? ` (${unsent})` : ''}
          </button>

          {/* Kurye atama + teslim durumu (yalnız paket) */}
          {isPaket && (
            <div className="space-y-2">
              {couriers.length > 0 ? (
                <select value={detail.courierId || ''} onChange={(e) => e.target.value && assignCourier(Number(e.target.value))} disabled={busy}
                  className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none">
                  <option value="">🛵 Kurye ata…</option>
                  {couriers.map((c) => <option key={c.courierId} value={c.courierId}>{c.name}{c.phone ? ` (${c.phone})` : ''}</option>)}
                </select>
              ) : <p className="text-xs text-slate-500 text-center">Kurye yok. Yönetici eklemeli.</p>}
              <div className="grid grid-cols-3 gap-1.5">
                {['Hazırlanıyor', 'Yolda', 'Teslim'].map((s) => (
                  <button key={s} onClick={() => setDelivery(s)} disabled={busy}
                    className={`h-10 rounded-lg text-xs font-bold border ${detail.deliveryStatus === s ? DELIVERY_STYLE[s] : 'border-slate-700 bg-slate-800 hover:bg-slate-700'}`}>{s}</button>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between text-lg">
            <span className="text-slate-400">Toplam</span>
            <span className="font-extrabold text-amber-400 text-2xl">{fmtTL(detail.liveTotal)}</span>
          </div>
          <button onClick={() => setPayOpen(true)} disabled={busy || detail.liveTotal <= 0}
            className="w-full h-14 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-extrabold text-lg flex items-center justify-center gap-2 disabled:opacity-40">
            <Banknote size={22} /> Hesabı Kapat
          </button>
        </div>
      </div>

      {/* Sağ: menü (kalem ekle) */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="shrink-0 flex gap-2 p-3 overflow-x-auto border-b border-slate-800">
          {menu.map((c, i) => (
            <button key={c.id ?? `c${i}`} onClick={() => setActiveCat(i)} className={`px-5 h-12 rounded-xl font-bold whitespace-nowrap ${i === activeCat ? 'bg-amber-500 text-amber-950' : 'bg-slate-800 hover:bg-slate-700'}`}>{c.name}</button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
            {(menu[activeCat]?.products || []).map((p) => (
              <button key={p.id} onClick={() => onProductTap(p)} disabled={busy}
                className="h-28 rounded-2xl bg-slate-800 hover:bg-slate-700 border border-slate-700 active:scale-95 transition-all p-3 flex flex-col justify-between text-left disabled:opacity-50">
                <span className="font-bold leading-tight flex items-start gap-1">{p.name}{p.optionGroups?.length > 0 && <Layers size={13} className="text-sky-400 shrink-0 mt-0.5" />}</span>
                <span className="text-amber-400 font-extrabold text-lg">{fmtTL(p.price)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {optionProduct && (
        <OptionModal product={optionProduct} onClose={() => setOptionProduct(null)}
          onConfirm={(ids) => { addItem(optionProduct, ids); setOptionProduct(null); }} />
      )}
      {payOpen && <PayModal total={detail.liveTotal} busy={busy} points={custPoints} onClose={() => setPayOpen(false)} onPay={doCheckout} />}
    </div>
  );
}

// ── Seçenek (modifier) modalı (sepet/sipariş ortak) ──────────────────────────
function OptionModal({ product, onClose, onConfirm }) {
  const [sel, setSel] = useState(() => { const o = {}; for (const g of product.optionGroups) o[g.id] = new Set(); return o; });
  const toggle = (g, oid) => setSel((prev) => {
    const cur = new Set(prev[g.id] || []);
    if (g.max === 1) { cur.clear(); cur.add(oid); }
    else if (cur.has(oid)) cur.delete(oid);
    else { if (g.max > 0 && cur.size >= g.max) return prev; cur.add(oid); }
    return { ...prev, [g.id]: cur };
  });
  const price = useMemo(() => {
    let t = product.price;
    for (const g of product.optionGroups) for (const oid of (sel[g.id] || [])) { const o = g.options.find((x) => x.id === oid); if (o) t += o.priceDelta; }
    return round2(t);
  }, [product, sel]);
  const confirm = () => {
    for (const g of product.optionGroups) { const n = (sel[g.id] || new Set()).size; if (g.min > 0 && n < g.min) { toast.error(`"${g.name}" için en az ${g.min} seçim.`); return; } }
    const ids = Object.values(sel).flatMap((s) => [...s]);
    const label = product.optionGroups.flatMap((g) => g.options.filter((o) => (sel[g.id] || new Set()).has(o.id)).map((o) => o.name)).join(', ');
    onConfirm(ids, label, price);
  };
  return (
    <ModalShell title={product.name} onClose={onClose}>
      <div className="space-y-4 max-h-[55vh] overflow-y-auto">
        {product.optionGroups.map((g) => (
          <div key={g.id}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-bold">{g.name}</span>
              <span className="text-xs text-slate-400">{g.min > 0 ? `en az ${g.min}` : 'opsiyonel'}{g.max > 0 ? ` · en çok ${g.max}` : ''}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {g.options.map((o) => {
                const s = (sel[g.id] || new Set()).has(o.id);
                return (
                  <button key={o.id} onClick={() => toggle(g, o.id)} className={`h-12 rounded-xl px-3 flex items-center justify-between font-semibold border ${s ? 'border-amber-500 bg-amber-500/15 text-amber-100' : 'border-slate-700 bg-slate-800'}`}>
                    <span className="truncate">{o.name}</span>
                    {o.priceDelta !== 0 && <span className="text-xs shrink-0 ml-1">{o.priceDelta > 0 ? '+' : ''}{fmtTL(o.priceDelta)}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between mt-4 mb-2 text-lg">
        <span className="text-slate-400">Fiyat</span><span className="font-extrabold text-amber-400">{fmtTL(price)}</span>
      </div>
      <button onClick={confirm} className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-extrabold flex items-center justify-center gap-2"><Plus size={20} /> Ekle</button>
    </ModalShell>
  );
}

// ── Tahsilat modalı (Nakit/Kart/Fiş/Açık Hesap) ──────────────────────────────
function PayModal({ total, busy, onClose, onPay, points = 0 }) {
  const [discount, setDiscount] = useState('');
  const [redeem, setRedeem] = useState('');
  const [received, setReceived] = useState('');
  const [acctMode, setAcctMode] = useState(false);
  const [q, setQ] = useState('');
  const [accounts, setAccounts] = useState([]);

  const disc = Math.min(round2(discount) || 0, total);
  const maxRedeem = Math.max(0, round2(Math.min(points, total - disc)));
  const redeemNum = Math.min(round2(redeem) || 0, maxRedeem);
  const net = round2(total - disc - redeemNum);

  const searchAcct = useCallback(async (term) => {
    try { const { data } = await api.get('/restoran/accounts', { params: { q: term } }); setAccounts(Array.isArray(data) ? data : []); }
    catch { /* sessiz */ }
  }, []);
  useEffect(() => { if (acctMode) { const t = setTimeout(() => searchAcct(q), 300); return () => clearTimeout(t); } }, [q, acctMode, searchAcct]);

  const redeemBody = redeemNum > 0 ? { redeemPoints: redeemNum } : {};
  const payKasa = (method) => onPay({ paymentMethod: method, discount: disc, ...redeemBody, ...(method === 'Nakit' && received ? { received: Number(received) } : {}) });
  const payAcct = (accountId) => onPay({ paymentMethod: 'Açık Hesap', accountId, discount: disc, ...redeemBody });

  return (
    <ModalShell title="Hesap Kapat" onClose={onClose}>
      <div className="text-center mb-4">
        <div className="text-slate-400">Ödenecek tutar</div>
        <div className="text-4xl font-black text-amber-400">{fmtTL(net)}</div>
      </div>
      {!acctMode ? (
        <>
          <div className="flex items-center gap-2 mb-2">
            <span className="w-24 text-sm font-semibold text-slate-300">İndirim</span>
            <input value={discount} onChange={(e) => setDiscount(e.target.value)} inputMode="decimal" placeholder="0,00 ₺" className="flex-1 h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
          </div>
          {points > 0 && (
            <div className="flex items-center gap-2 mb-2">
              <span className="w-24 text-sm font-semibold text-fuchsia-300 flex items-center gap-1"><Gift size={14} /> Puan</span>
              <input value={redeem} onChange={(e) => setRedeem(e.target.value)} inputMode="decimal" placeholder={`0 (mevcut ${points})`} className="flex-1 h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-fuchsia-500" />
              <button type="button" onClick={() => setRedeem(String(maxRedeem))} className="h-11 px-3 rounded-xl bg-fuchsia-700 hover:bg-fuchsia-600 text-sm font-bold shrink-0">Tümü</button>
            </div>
          )}
          <input value={received} onChange={(e) => setReceived(e.target.value)} inputMode="decimal" placeholder="Alınan nakit (opsiyonel)" className="w-full h-12 rounded-xl bg-slate-800 border border-slate-700 px-4 outline-none focus:border-emerald-500 mb-1" />
          {received && Number(received) >= net && <div className="text-emerald-400 font-bold mb-2 text-center">Para üstü: {fmtTL(Number(received) - net)}</div>}
          <div className="grid grid-cols-3 gap-2 mt-2">
            <button onClick={() => payKasa('Nakit')} disabled={busy} className="h-16 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-extrabold flex flex-col items-center justify-center gap-1"><Banknote size={20} /> Nakit</button>
            <button onClick={() => payKasa('Kredi Kartı')} disabled={busy} className="h-16 rounded-xl bg-sky-600 hover:bg-sky-500 font-extrabold flex flex-col items-center justify-center gap-1"><CreditCard size={20} /> Kart</button>
            <button onClick={() => payKasa('Yemek Fişi')} disabled={busy} className="h-16 rounded-xl bg-violet-600 hover:bg-violet-500 font-extrabold flex flex-col items-center justify-center gap-1"><Ticket size={20} /> Fiş</button>
          </div>
          <button onClick={() => setAcctMode(true)} className="mt-3 w-full h-12 rounded-xl bg-orange-600 hover:bg-orange-500 font-extrabold flex items-center justify-center gap-2"><Wallet size={18} /> Açık Hesap (Veresiye)</button>
        </>
      ) : (
        <>
          <div className="relative mb-2">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Cari ara (ad/telefon)…" className="w-full h-12 rounded-xl bg-slate-800 border border-slate-700 pl-9 pr-3 outline-none focus:border-amber-500" />
          </div>
          <div className="max-h-52 overflow-y-auto space-y-1 mb-2">
            {accounts.map((a) => (
              <button key={a.accountId} onClick={() => payAcct(a.accountId)} disabled={busy} className="w-full text-left p-3 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 flex items-center justify-between">
                <span className="font-semibold">{a.name} <span className="text-slate-400 font-normal text-sm">{a.phone}</span></span>
                <span className={`text-sm font-bold ${a.balance > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>{fmtTL(a.balance)}</span>
              </button>
            ))}
            {q && accounts.length === 0 && <p className="text-center text-slate-500 text-sm py-2">Cari bulunamadı.</p>}
          </div>
          <button onClick={() => setAcctMode(false)} className="w-full h-11 rounded-xl bg-slate-700 hover:bg-slate-600 font-bold">Geri</button>
        </>
      )}
    </ModalShell>
  );
}

// ── Kurye yönetimi (Admin) ───────────────────────────────────────────────────
function CourierModal({ couriers, reload, onClose }) {
  const [name, setName] = useState(''); const [phone, setPhone] = useState('');
  const [report, setReport] = useState(null);
  const add = async () => {
    if (!name.trim()) { toast.error('Ad gerekli.'); return; }
    try { await api.post('/restoran/couriers', { name, phone }); setName(''); setPhone(''); toast.success('Kurye eklendi.'); reload(); }
    catch (e) { toast.error(e?.response?.data?.error || 'Eklenemedi.'); }
  };
  const toggle = async (c) => { try { await api.patch(`/restoran/couriers/${c.courierId}`, { isActive: !c.isActive }); reload(); } catch { toast.error('Güncellenemedi.'); } };
  const del = async (c) => { try { await api.delete(`/restoran/couriers/${c.courierId}`); toast.success('Pasifleştirildi.'); reload(); } catch { toast.error('Silinemedi.'); } };
  const loadReport = async () => { try { const { data } = await api.get('/restoran/couriers/report'); setReport(data); } catch { toast.error('Rapor alınamadı.'); } };

  return (
    <ModalShell title="Kurye Yönetimi" onClose={onClose} wide>
      <div className="flex gap-2 mb-3">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Kurye adı" className="flex-1 h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
        <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="Telefon" className="w-32 h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
        <button onClick={add} className="h-11 px-4 rounded-xl bg-amber-500 text-amber-950 font-bold">Ekle</button>
      </div>
      <div className="space-y-1.5 mb-3 max-h-52 overflow-y-auto">
        {couriers.map((c) => (
          <div key={c.courierId} className={`flex items-center gap-2 p-2.5 rounded-xl border ${c.isActive ? 'border-slate-700 bg-slate-800' : 'border-slate-800 bg-slate-900 opacity-60'}`}>
            <Bike size={16} className="text-sky-400" />
            <span className="flex-1 font-semibold">{c.name} <span className="text-slate-400 font-normal text-sm">{c.phone}</span></span>
            <button onClick={() => toggle(c)} className={`h-8 px-3 rounded-lg text-xs font-bold ${c.isActive ? 'bg-emerald-600' : 'bg-slate-700'}`}>{c.isActive ? 'Aktif' : 'Pasif'}</button>
            <button onClick={() => del(c)} className="h-8 w-8 grid place-items-center rounded-lg bg-rose-900/60 hover:bg-rose-800 text-rose-200"><Trash2 size={14} /></button>
          </div>
        ))}
        {couriers.length === 0 && <p className="text-center text-slate-500 text-sm py-3">Henüz kurye yok.</p>}
      </div>
      <button onClick={loadReport} className="w-full h-11 rounded-xl bg-slate-800 hover:bg-slate-700 font-bold flex items-center justify-center gap-2"><Truck size={18} /> Bugünün Dağıtım Raporu</button>
      {report && (
        <div className="mt-3 space-y-1">
          <div className="text-center text-slate-400 text-sm mb-1">{report.date}</div>
          {report.couriers.map((c) => (
            <div key={c.courierId} className="flex items-center justify-between p-2.5 rounded-lg bg-slate-800 border border-slate-700">
              <span className="font-semibold">{c.name}</span>
              <span className="text-sm text-slate-400">{c.delivered} teslim · <b className="text-amber-400">{fmtTL(c.collected)}</b></span>
            </div>
          ))}
          {report.couriers.length === 0 && <p className="text-center text-slate-500 text-sm">Veri yok.</p>}
        </div>
      )}
    </ModalShell>
  );
}

// ── Ortak modal kabuğu ───────────────────────────────────────────────────────
function ModalShell({ title, children, onClose, wide }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className={`w-full ${wide ? 'max-w-lg' : 'max-w-md'} bg-slate-900 border border-slate-700 rounded-2xl p-5 max-h-[90vh] overflow-y-auto`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-lg">{title}</h3>
          <button onClick={onClose} className="h-9 w-9 grid place-items-center rounded-lg bg-slate-800 hover:bg-slate-700"><X size={20} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
