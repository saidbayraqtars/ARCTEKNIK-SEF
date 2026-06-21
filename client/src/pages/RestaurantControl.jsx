// ArcTeknik Şef — Kontrol Paneli (--mode=control, rota /restoran/yonetim).
// Satış terminalinden AYRI yönetim uygulaması: "önce panelden hazırla → sonra çalıştır".
// Mevcut yönetim modalları Restaurant.jsx'ten import edilir (kod tekrarı yok).
import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import {
  ChefHat, Settings, Users, Printer, CalendarDays, TrendingUp, KeyRound,
  RefreshCw, LogOut, Copy, ShieldCheck, Database, Loader2, Check, X,
  HardDriveDownload, LifeBuoy, Play,
} from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useLicense } from '../context/LicenseContext';
import { silentAvailable } from '../utils/sefPrint';
import {
  ManagementModal, StaffModal, PrinterSetupModal, ReservationsModal, ReportsModal,
} from './Restaurant';

export default function RestaurantControl() {
  const { user, logout } = useAuth();
  const { status: lic, refresh: refreshLic, maxUsers } = useLicense();

  const [sections, setSections] = useState([]);
  const [menu, setMenu] = useState([]);
  const [users, setUsers] = useState([]);
  const [edition, setEdition] = useState(null);
  const [loading, setLoading] = useState(true);

  // Açık modal: 'mgmt' | 'staff' | 'printer' | 'rsv' | 'reports' | 'license' | null
  const [open, setOpen] = useState(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [floor, m, u, st] = await Promise.allSettled([
        api.get('/restoran/floor'),
        api.get('/restoran/menu'),
        api.get('/users'),
        api.get('/setup/status'),
      ]);
      if (floor.status === 'fulfilled') setSections(Array.isArray(floor.value.data) ? floor.value.data : []);
      if (m.status === 'fulfilled') {
        const d = m.value.data;
        setMenu(Array.isArray(d) ? d : (d.categories || []));
      }
      if (u.status === 'fulfilled') setUsers(Array.isArray(u.value.data) ? u.value.data : []);
      if (st.status === 'fulfilled') setEdition(st.value.data?.edition || 'suite');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const reloadMenuFloor = useCallback(() => {
    api.get('/restoran/floor').then(({ data }) => setSections(Array.isArray(data) ? data : [])).catch(() => {});
    api.get('/restoran/menu').then(({ data }) => setMenu(Array.isArray(data) ? data : (data.categories || []))).catch(() => {});
  }, []);

  const activeUsers = users.filter((u) => u.isActive !== false && u.IsActive !== false).length || users.length;
  const seatLabel = maxUsers ? `${users.length} / ${maxUsers}` : `${users.length}`;

  const tiles = [
    { key: 'mgmt', icon: Settings, label: 'Menü & Masa', sub: 'Bölüm, masa, kategori, ürün, seçenek, reçete, ayar' },
    { key: 'staff', icon: Users, label: 'Personel', sub: 'Garson / yönetici hesapları' },
    { key: 'rsv', icon: CalendarDays, label: 'Rezervasyon', sub: 'Gün takvimi, masa ayırma' },
    { key: 'reports', icon: TrendingUp, label: 'Raporlar', sub: 'Ciro, maliyet, kâr, garson, ürün' },
    ...(silentAvailable() ? [{ key: 'printer', icon: Printer, label: 'Yazıcılar', sub: 'Kasa / Mutfak / Bar eşleme' }] : []),
    { key: 'license', icon: KeyRound, label: 'Lisans', sub: 'Lisans gir / yenile, donanım kimliği' },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Üst bar */}
      <header className="sticky top-0 z-10 flex items-center gap-3 px-5 h-16 bg-slate-900 border-b border-slate-800">
        <ChefHat className="text-amber-400" size={26} />
        <div className="flex-1">
          <div className="font-extrabold text-lg leading-tight">ArcTeknik Şef · Kontrol Paneli</div>
          <div className="text-xs text-slate-400">{user?.fullName || user?.username} · Yönetim</div>
        </div>
        <button onClick={loadAll} className="h-10 px-3 flex items-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-sm font-semibold" title="Yenile">
          <RefreshCw size={16} /> Yenile
        </button>
        <button onClick={logout} className="h-10 px-3 flex items-center gap-2 rounded-xl bg-slate-800 hover:bg-rose-700 text-sm font-semibold">
          <LogOut size={16} /> Çıkış
        </button>
      </header>

      <main className="max-w-5xl mx-auto p-5 space-y-6">
        {/* Durum kartları */}
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatusCard
            icon={Database} title="Veritabanı"
            value={edition === 'restaurant' ? 'ARCSEFDB' : (edition || '—')}
            sub={loading ? 'okunuyor…' : 'Bağlı'} ok={!loading}
          />
          <StatusCard
            icon={ShieldCheck} title="Lisans"
            value={lic?.valid ? (lic.customerName || 'Etkin') : 'Lisanssız'}
            sub={lic?.valid ? `${lic.daysLeft ?? '?'} gün · ${(lic.modules || []).join(', ') || 'modül yok'}` : 'Lisans gerekli'}
            ok={!!lic?.valid}
          />
          <StatusCard
            icon={Users} title="Kullanıcı (seat)"
            value={seatLabel}
            sub={maxUsers ? `${activeUsers} etkin · limit ${maxUsers}` : `${activeUsers} etkin · sınırsız`}
            ok={!maxUsers || users.length <= maxUsers}
          />
        </section>

        {/* Yönetim kutucukları */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {tiles.map((t) => (
            <button key={t.key} onClick={() => setOpen(t.key)}
              className="text-left p-4 rounded-2xl bg-slate-900 border border-slate-800 hover:border-amber-500/60 hover:bg-slate-800 transition-all">
              <t.icon size={22} className="text-amber-400 mb-2" />
              <div className="font-bold">{t.label}</div>
              <div className="text-xs text-slate-400 mt-0.5">{t.sub}</div>
            </button>
          ))}
        </section>

        {/* Otomatik yedekleme + destek */}
        <BackupCard />

        <p className="text-center text-xs text-slate-500">
          Satış terminali ayrıdır — masa planı için <b>ArcTeknik Şef</b> kısayolunu açın.
          Self-servis kasa: <b>/restoran/self</b> · Müşteri çağrı ekranı: <b>/restoran/cagri</b>.
        </p>
      </main>

      {/* Modallar — mevcut Restaurant.jsx bileşenleri */}
      {open === 'mgmt' && <ManagementModal sections={sections} menu={menu} reload={reloadMenuFloor} onClose={() => { setOpen(null); reloadMenuFloor(); }} />}
      {open === 'staff' && <StaffModal onClose={() => { setOpen(null); api.get('/users').then(({ data }) => setUsers(Array.isArray(data) ? data : [])).catch(() => {}); }} />}
      {open === 'printer' && <PrinterSetupModal menu={menu} onClose={() => setOpen(null)} />}
      {open === 'rsv' && <ReservationsModal sections={sections} onClose={() => setOpen(null)} />}
      {open === 'reports' && <ReportsModal onClose={() => setOpen(null)} />}
      {open === 'license' && <LicenseModal status={lic} onClose={() => setOpen(null)} onActivated={refreshLic} />}
    </div>
  );
}

// Otomatik yedekleme durumu + elle yedek + destek paketi. Son yedek 3 günü
// geçtiyse (veya hiç yoksa) kart kırmızı uyarır — esnafın veri sigortası.
function BackupCard() {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [supBusy, setSupBusy] = useState(false);

  const load = useCallback(() => {
    api.get('/maintenance/backup').then(({ data }) => setSt(data)).catch(() => setSt(null));
  }, []);
  useEffect(() => { load(); }, [load]);

  const daysAgo = st?.lastBackupAt ? Math.floor((Date.now() - new Date(st.lastBackupAt).getTime()) / 86400000) : null;
  const stale = daysAgo === null || daysAgo > 3;

  const runNow = async () => {
    setBusy(true);
    try {
      const { data } = await api.post('/maintenance/backup/run');
      toast.success(`Yedek alındı: ${data.file || ''}`);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Yedek alınamadı.');
    } finally { setBusy(false); }
  };

  const toggleEnabled = async () => {
    try {
      await api.put('/maintenance/backup', { enabled: !st?.enabled });
      load();
    } catch { toast.error('Ayar kaydedilemedi.'); }
  };

  const supportBundle = async () => {
    if (!window.bayraktarDesktop?.createSupportBundle) return toast.error('Yalnızca masaüstü uygulamasında kullanılabilir.');
    setSupBusy(true);
    try {
      const r = await window.bayraktarDesktop.createSupportBundle();
      if (r?.ok) toast.success(`Destek paketi Masaüstü'ne kaydedildi: ${r.path || ''}`, { duration: 7000 });
      else toast.error(r?.error || 'Destek paketi oluşturulamadı.');
    } finally { setSupBusy(false); }
  };

  if (st?.clientMode) return null; // istemci modunda yedek sunucu makinede alınır

  return (
    <section className={`p-4 rounded-2xl border ${stale ? 'bg-rose-950/40 border-rose-700' : 'bg-slate-900 border-slate-800'}`}>
      <div className="flex flex-wrap items-center gap-3">
        <HardDriveDownload size={22} className={stale ? 'text-rose-400' : 'text-emerald-400'} />
        <div className="flex-1 min-w-52">
          <div className="font-bold">Otomatik Yedekleme {st ? (st.enabled ? '· Açık' : '· KAPALI') : ''}</div>
          <div className={`text-xs mt-0.5 ${stale ? 'text-rose-300 font-semibold' : 'text-slate-400'}`}>
            {st === null ? 'Durum okunamadı.'
              : daysAgo === null ? '⚠ Hiç yedek alınmamış — verileriniz sigortasız!'
              : daysAgo === 0 ? `Son yedek bugün · her gece ${String(st.hour).padStart(2, '0')}:${String(st.minute).padStart(2, '0')} · ${st.keep} kopya tutulur`
              : `Son yedek ${daysAgo} gün önce${stale ? ' — yazıcı/disk kontrolü gerekebilir!' : ''}`}
          </div>
          {st?.dir && <div className="text-[11px] text-slate-500 mt-0.5 truncate">Klasör: {st.lastRun?.dir || st.dir}</div>}
        </div>
        <button onClick={toggleEnabled} className="h-10 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-sm font-semibold">
          {st?.enabled ? 'Kapat' : 'Aç'}
        </button>
        <button onClick={runNow} disabled={busy}
          className="h-10 px-3 flex items-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-sm font-bold disabled:opacity-50">
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />} Şimdi Yedekle
        </button>
        <button onClick={supportBundle} disabled={supBusy}
          className="h-10 px-3 flex items-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-sm font-semibold disabled:opacity-50"
          title="Logları + sürüm bilgisini Masaüstü'ne tek klasörde toplar — desteğe gönderin">
          {supBusy ? <Loader2 size={16} className="animate-spin" /> : <LifeBuoy size={16} />} Destek Paketi
        </button>
      </div>
    </section>
  );
}

function StatusCard({ icon: Icon, title, value, sub, ok }) {
  return (
    <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
      <div className="flex items-center gap-2 text-slate-400 text-xs font-semibold uppercase tracking-wide">
        <Icon size={15} className={ok ? 'text-emerald-400' : 'text-rose-400'} /> {title}
      </div>
      <div className="text-xl font-extrabold mt-1 truncate">{value}</div>
      <div className="text-xs text-slate-400 mt-0.5 truncate">{sub}</div>
    </div>
  );
}

// Lisans gir/yenile + donanım kimliği. /license/activate + /license/hardware-id.
function LicenseModal({ status, onClose, onActivated }) {
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [hwid, setHwid] = useState(status?.hardwareId || '');

  useEffect(() => {
    if (!hwid) api.get('/license/hardware-id').then(({ data }) => setHwid(data.hardwareId || '')).catch(() => {});
  }, [hwid]);

  const copyHwid = async () => {
    try { await navigator.clipboard.writeText(hwid); toast.success('Donanım kimliği kopyalandı.'); }
    catch { toast.error('Kopyalanamadı — elle seçin.'); }
  };

  const activate = async () => {
    if (!content.trim()) return toast.error('Lisans metnini yapıştırın.');
    setBusy(true);
    try {
      await api.post('/license/activate', { content: content.trim() });
      toast.success('Lisans etkinleştirildi.');
      onActivated?.();
      onClose();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Lisans etkinleştirilemedi.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 grid place-items-center p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold flex items-center gap-2"><KeyRound size={20} className="text-amber-400" /> Lisans</h2>
          <button onClick={onClose} className="h-9 w-9 grid place-items-center rounded-lg hover:bg-slate-800"><X size={18} /></button>
        </div>

        <div className="text-sm space-y-1">
          <div className="flex items-center gap-2">
            {status?.valid ? <Check size={16} className="text-emerald-400" /> : <X size={16} className="text-rose-400" />}
            <span className={status?.valid ? 'text-emerald-300' : 'text-rose-300'}>
              {status?.valid ? `Etkin — ${status.customerName || ''} (${status.daysLeft ?? '?'} gün)` : 'Lisans yok / geçersiz'}
            </span>
          </div>
          {status?.valid && <div className="text-xs text-slate-400">Modüller: {(status.modules || []).join(', ') || '—'} · Seat: {status.maxUsers || 'sınırsız'}</div>}
        </div>

        <div className="rounded-xl bg-slate-800/60 p-3">
          <div className="text-xs text-slate-400 mb-1">Donanım Kimliği (lisans talebi için)</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-sm font-mono text-amber-300 break-all">{hwid || '…'}</code>
            <button onClick={copyHwid} className="h-9 px-3 flex items-center gap-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm"><Copy size={14} /> Kopyala</button>
          </div>
        </div>

        <div>
          <div className="text-xs text-slate-400 mb-1">Lisans metni (.tslic / JSON içeriği)</div>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={6}
            placeholder='{"payload":{...},"signature":"..."}'
            className="w-full rounded-xl bg-slate-800 border border-slate-700 p-3 text-xs font-mono focus:outline-none focus:border-amber-500" />
        </div>

        <button onClick={activate} disabled={busy}
          className="w-full h-11 rounded-xl bg-amber-500 hover:bg-amber-400 text-amber-950 font-bold flex items-center justify-center gap-2 disabled:opacity-60">
          {busy ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />} Etkinleştir
        </button>
      </div>
    </div>
  );
}
