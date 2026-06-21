import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, ChefHat, BellRing } from 'lucide-react';
import { api, getApiBaseUrl } from '../api/client';

// ArcTeknik Şef — MÜŞTERİ ÇAĞRI / NUMARATÖR EKRANI (/restoran/cagri).
// Tavana asılan ikinci monitör için: solda "HAZIRLANIYOR", sağda "HAZIR — ALINIZ"
// devasa sipariş numaraları (McDonald's / Burger King düzeni). Mutfak son kalemi
// "Hazır" yaptığı an numara sağa geçer + ding sesi çalar + yanıp söner.
// Personel hazır numaraya dokununca sipariş teslim edilir (panodan düşer).
// Veri: SSE anlık sinyal + 5 sn polling yedek.

export default function RestaurantCallScreen() {
  const [board, setBoard] = useState({ preparing: [], ready: [] });
  const [loading, setLoading] = useState(true);
  const prevReadyRef = useRef(new Set());
  const audioRef = useRef(null);

  // "Hazır" anonsu — iki tonlu ding-dong (Web Audio, ses dosyası gerekmez).
  const ding = useCallback(() => {
    try {
      let ctx = audioRef.current;
      if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); audioRef.current = ctx; }
      if (ctx.state === 'suspended') ctx.resume();
      const tone = (freq, t0, dur) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.12, ctx.currentTime + t0);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t0 + dur);
        o.connect(g); g.connect(ctx.destination);
        o.start(ctx.currentTime + t0); o.stop(ctx.currentTime + t0 + dur);
      };
      tone(880, 0, 0.5);
      tone(660, 0.35, 0.7);
    } catch { /* ses yoksa sessiz geç */ }
  }, []);

  const load = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    try {
      const { data } = await api.get('/restoran/self-orders/board');
      const next = { preparing: data.preparing || [], ready: data.ready || [] };
      // Yeni hazır olan numara var mı → anons.
      const prev = prevReadyRef.current;
      if (next.ready.some((o) => !prev.has(o.orderId))) ding();
      prevReadyRef.current = new Set(next.ready.map((o) => o.orderId));
      setBoard(next);
    } catch { /* sessiz — bir sonraki turda toparlar */ }
    finally { if (!silent) setLoading(false); }
  }, [ding]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => load(true), 5000); return () => clearInterval(t); }, [load]);

  // SSE: mutfak kalemi "Hazır" yaptığı an pano tazelenir.
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token || typeof EventSource === 'undefined') return;
    const es = new EventSource(`${getApiBaseUrl()}/restoran/events?token=${encodeURIComponent(token)}`);
    let t = null;
    es.onmessage = () => { clearTimeout(t); t = setTimeout(() => load(true), 250); };
    return () => { clearTimeout(t); es.close(); };
  }, [load]);

  // Personel: hazır numaraya dokun → teslim edildi, panodan düşer.
  const deliver = async (o) => {
    try { await api.post(`/restoran/orders/${o.orderId}/deliver`); load(true); }
    catch { /* sessiz */ }
  };

  return (
    <div className="fixed inset-0 bg-slate-950 text-slate-100 flex flex-col select-none">
      <header className="h-20 shrink-0 flex items-center justify-center gap-3 bg-slate-900 border-b border-slate-800">
        <BellRing size={32} className="text-amber-400" />
        <span className="text-3xl font-black tracking-wide">SİPARİŞ TAKİP</span>
      </header>

      {loading ? (
        <div className="flex-1 grid place-items-center text-slate-500"><Loader2 className="animate-spin" size={48} /></div>
      ) : (
        <div className="flex-1 grid grid-cols-2 min-h-0">
          {/* Hazırlanıyor */}
          <section className="border-r border-slate-800 flex flex-col min-h-0">
            <div className="h-16 shrink-0 grid place-items-center bg-amber-500/15 border-b border-slate-800">
              <span className="text-2xl font-extrabold text-amber-400 flex items-center gap-2"><ChefHat size={26} /> HAZIRLANIYOR</span>
            </div>
            <div className="flex-1 overflow-y-auto p-6 content-start flex flex-wrap gap-4 justify-center">
              {board.preparing.length === 0 ? (
                <div className="text-slate-600 text-xl mt-10">—</div>
              ) : board.preparing.map((o) => (
                <div key={o.orderId} className="min-w-36 px-6 py-4 rounded-3xl bg-slate-800 border-2 border-slate-700 text-center">
                  <span className="text-6xl font-black text-slate-200">{o.orderNo}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Hazır — alınız */}
          <section className="flex flex-col min-h-0">
            <div className="h-16 shrink-0 grid place-items-center bg-emerald-500/15 border-b border-slate-800">
              <span className="text-2xl font-extrabold text-emerald-400 flex items-center gap-2"><BellRing size={26} /> HAZIR — LÜTFEN ALINIZ</span>
            </div>
            <div className="flex-1 overflow-y-auto p-6 content-start flex flex-wrap gap-4 justify-center">
              {board.ready.length === 0 ? (
                <div className="text-slate-600 text-xl mt-10">—</div>
              ) : board.ready.map((o) => (
                <button key={o.orderId} onClick={() => deliver(o)} title="Teslim edildi olarak işaretle"
                  className="min-w-44 px-8 py-5 rounded-3xl bg-emerald-600 border-2 border-emerald-400 text-center animate-pulse active:scale-95 transition-all">
                  <span className="text-7xl font-black text-white">{o.orderNo}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      <footer className="h-10 shrink-0 grid place-items-center text-slate-500 text-sm bg-slate-900 border-t border-slate-800">
        Siparişiniz hazır olduğunda numaranız yeşil alanda yanıp söner.
      </footer>
    </div>
  );
}
