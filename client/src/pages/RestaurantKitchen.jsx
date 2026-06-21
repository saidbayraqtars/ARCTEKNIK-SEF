import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ChefHat, ArrowLeft, RefreshCw, Check, Clock, Flame, Loader2, AlertTriangle } from 'lucide-react';
import { api, getApiBaseUrl } from '../api/client';

// ArcTeknik Şef — Mutfak Ekranı (KDS). Açık adisyonların hazırlanmamış kalemleri,
// masaya göre gruplu. Dokun → Bekliyor → Hazırlanıyor → Hazır. Hazır olunca düşer.
// Ayrı bir mutfak cihazında tam ekran çalışacak şekilde tasarlandı (--mode=kitchen).

const STATUS_NEXT = { 'Bekliyor': 'Hazırlanıyor', 'Hazırlanıyor': 'Hazır' };
const DELAY_MIN = 15; // bu süreyi geçen kalem = geciken → kırmızı blink + sesli uyarı
const CARD = {
  'Bekliyor': 'border-slate-600 bg-slate-800',
  'Hazırlanıyor': 'border-amber-500 bg-amber-500/15',
};
const BADGE = {
  'Bekliyor': 'bg-slate-600 text-slate-100',
  'Hazırlanıyor': 'bg-amber-500 text-amber-950',
};

const fmtWait = (m) => (m <= 0 ? 'şimdi' : `${m} dk`);
const isLate = (it) => (Number(it.waitMinutes) || 0) >= DELAY_MIN;

export default function RestaurantKitchen() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');  // '' | 'Bekliyor' | 'Hazırlanıyor'
  const [busy, setBusy] = useState(false);
  const audioRef = useRef(null);

  // Geciken sipariş alarmı — kısa bip (Web Audio, asset gerekmez). İlk dokunuştan
  // sonra ses açılır (tarayıcı politikası); açılamazsa sessiz geçer.
  const beep = useCallback(() => {
    try {
      let ctx = audioRef.current;
      if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); audioRef.current = ctx; }
      if (ctx.state === 'suspended') ctx.resume();
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'square'; o.frequency.value = 880; g.gain.value = 0.06;
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.25);
    } catch { /* ses yoksa sessiz geç */ }
  }, []);

  const load = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    try {
      const { data } = await api.get('/restoran/kitchen');
      const arr = Array.isArray(data) ? data : [];
      setItems(arr);
      if (arr.some(isLate)) beep(); // geciken kalem varsa sesli uyar
    } catch (e) {
      if (e?.response?.status === 403) toast.error('ArcTeknik Şef modülü lisanslı değil veya yetkiniz yok.');
      else if (!silent) toast.error('Mutfak siparişleri alınamadı.');
    } finally { if (!silent) setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => load(true), 8000); return () => clearInterval(t); }, [load]);

  // Gerçek-zamanlı (SSE): garson siparişi gönderdiği AN mutfakta belirir.
  // 8 sn'lik polling yedek olarak kalır; bağlantı koparsa EventSource kendisi toparlar.
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token || typeof EventSource === 'undefined') return;
    const es = new EventSource(`${getApiBaseUrl()}/restoran/events?token=${encodeURIComponent(token)}`);
    let t = null;
    es.onmessage = () => { clearTimeout(t); t = setTimeout(() => load(true), 250); };
    return () => { clearTimeout(t); es.close(); };
  }, [load]);

  const advance = async (item) => {
    const next = STATUS_NEXT[item.kitchenStatus];
    if (!next || busy) return;
    setBusy(true);
    try {
      await api.patch(`/restoran/items/${item.itemId}`, { kitchenStatus: next });
      await load(true);
    } catch (e) { toast.error(e?.response?.data?.error || 'Güncellenemedi.'); }
    finally { setBusy(false); }
  };

  const shown = filter ? items.filter((i) => i.kitchenStatus === filter) : items;
  // Masaya göre grupla. Masasız işler (Self-Servis #42, Paket) sipariş bazında
  // gruplanır ve kendi başlığıyla görünür.
  const headingOf = (i) => (
    i.tableNo != null ? `Masa ${i.tableNo}`
      : i.orderType === 'Self' ? `Sipariş #${i.orderNo || i.orderId}`
      : `${i.orderType || 'Sipariş'} #${i.orderNo || i.orderId}`
  );
  const byTable = [];
  const map = new Map();
  for (const i of shown) {
    const key = i.tableNo != null ? `t|${i.section}|${i.tableNo}` : `o|${i.orderId}`;
    if (!map.has(key)) { const g = { section: i.section, heading: headingOf(i), items: [] }; map.set(key, g); byTable.push(g); }
    map.get(key).items.push(i);
  }

  return (
    <div className="fixed inset-0 bg-slate-950 text-slate-100 flex flex-col select-none">
      <header className="h-16 shrink-0 flex items-center gap-3 px-4 bg-slate-900 border-b border-slate-800">
        <div className="flex items-center gap-2 text-amber-400 font-extrabold text-xl"><ChefHat size={26} /> Mutfak Ekranı</div>
        <div className="flex gap-2 ml-4">
          {[['', 'Tümü'], ['Bekliyor', 'Bekleyen'], ['Hazırlanıyor', 'Hazırlanan']].map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className={`h-10 px-4 rounded-xl font-bold ${filter === k ? 'bg-amber-500 text-amber-950' : 'bg-slate-800 hover:bg-slate-700'}`}>{l}</button>
          ))}
        </div>
        <div className="flex-1" />
        {items.filter(isLate).length > 0 && (
          <div className="mr-2 px-3 h-10 grid place-items-center rounded-xl bg-rose-600 text-white font-bold animate-pulse flex items-center gap-1">
            <AlertTriangle size={16} /> {items.filter(isLate).length} geciken
          </div>
        )}
        <div className="text-slate-400 font-semibold mr-2">{shown.length} kalem</div>
        <button onClick={() => load()} className="h-11 w-11 grid place-items-center rounded-xl bg-slate-800 hover:bg-slate-700" title="Yenile"><RefreshCw size={20} /></button>
        <button onClick={() => navigate('/restoran')} className="h-11 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold flex items-center gap-2"><ArrowLeft size={18} /> Masalar</button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="h-full grid place-items-center text-slate-500"><Loader2 className="animate-spin" size={40} /></div>
        ) : shown.length === 0 ? (
          <div className="h-full grid place-items-center text-center text-slate-400">
            <div><Check size={48} className="mx-auto mb-3 text-emerald-500" /><p className="text-lg font-semibold">Bekleyen sipariş yok. Mutfak temiz! 🎉</p></div>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
            {byTable.map((g, gi) => (
              <div key={gi} className="rounded-2xl bg-slate-900 border border-slate-800 overflow-hidden">
                <div className={`px-4 py-3 flex items-center justify-between ${g.items.some(isLate) ? 'bg-rose-700' : 'bg-slate-800'}`}>
                  <span className="font-extrabold text-lg flex items-center gap-2">{g.items.some(isLate) && <AlertTriangle size={18} className="text-rose-200" />} {g.heading}</span>
                  {g.section && <span className="text-xs text-slate-300">{g.section}</span>}
                </div>
                <div className="p-3 space-y-2">
                  {g.items.map((it) => {
                    const late = isLate(it);
                    return (
                    <button key={it.itemId} onClick={() => advance(it)} disabled={busy}
                      className={`w-full text-left rounded-xl border-2 p-3 active:scale-[.98] transition-all ${late ? 'border-rose-500 bg-rose-600/25 animate-pulse' : (CARD[it.kitchenStatus] || CARD['Bekliyor'])}`}>
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-bold text-lg">{it.quantity} × {it.name}</span>
                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 ${late ? 'bg-rose-500 text-white' : BADGE[it.kitchenStatus]}`}>{it.kitchenStatus}</span>
                      </div>
                      {it.options && <div className="text-sm text-sky-300 mt-1">+ {it.options}</div>}
                      {it.note && <div className="text-sm text-amber-300 italic mt-1">» {it.note}</div>}
                      <div className="flex items-center justify-between mt-2 text-xs text-slate-400">
                        <span className={`flex items-center gap-1 ${late ? 'text-rose-300 font-bold' : ''}`}>
                          {late ? <AlertTriangle size={12} /> : <Clock size={12} />} {fmtWait(it.waitMinutes)}{late ? ' • GECİKTİ' : ''}
                        </span>
                        <span className="flex items-center gap-1 font-semibold">
                          {it.kitchenStatus === 'Bekliyor' ? <><Flame size={13} /> Başlat</> : <><Check size={13} /> Hazır</>}
                        </span>
                      </div>
                    </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
