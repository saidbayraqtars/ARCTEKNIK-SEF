import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import {
  PenTool, Database, MessageCircle, CheckCircle2, Loader2,
  RefreshCw, ChevronRight, AlertCircle, Server, SkipForward,
} from 'lucide-react';
import { getApiBaseUrl } from '../api/client';
import { PRODUCT } from '../product';

const setupApi = axios.create({ baseURL: `${getApiBaseUrl()}/setup` });

// WhatsApp adımı YALNIZCA Servis Paneli kurulumunda görünür (müşteriye servis
// durum/teslim bildirimi). ArcTeknik Şef (restoran) WhatsApp bağlantısı sormaz.
// Şef sürümü RUNTIME'da (status.edition) belirlenir; aynı client bundle
// Suite+Şef'te paylaşıldığı için build-time PRODUCT tek başına yetmez.
const WHATSAPP_ENABLED = PRODUCT === 'SERVIS';

const buildSteps = (whatsappEnabled) => [
  { id: 1, title: 'Veritabanı', icon: Database },
  ...(whatsappEnabled ? [{ id: 2, title: 'WhatsApp', icon: MessageCircle }] : []),
  { id: 3, title: 'Tamamla', icon: CheckCircle2 },
];

const SetupWizard = ({ onComplete }) => {
  const [status, setStatus] = useState(null);
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [restarting, setRestarting] = useState(false);

  const [role, setRole] = useState('server'); // 'server' = yerel veritabanı, 'client' = uzak sunucu
  const [server, setServer] = useState('');
  const [port, setPort] = useState('1433');
  const [useWindowsAuth, setUseWindowsAuth] = useState(true);
  const [user, setUser] = useState('sa');
  const [password, setPassword] = useState('');
  const [sqlError, setSqlError] = useState('');
  const [sqlTechnical, setSqlTechnical] = useState('');
  const [showTechnical, setShowTechnical] = useState(false);
  const [sqlBusy, setSqlBusy] = useState(false);

  const [wa, setWa] = useState(null);
  const [waBusy, setWaBusy] = useState(false);
  const [windowsStartup, setWindowsStartup] = useState(false);
  const [logs, setLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const { data } = await setupApi.get('/status');
      setStatus(data);
      const waOn = WHATSAPP_ENABLED && data.edition !== 'restaurant';
      if (data.sqlConfigured && step < 2) setStep(waOn ? 2 : 3);
      if (data.complete) onComplete?.();
      return data;
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  }, [step, onComplete]);

  const loadLogs = async () => {
    try {
      const { data } = await setupApi.get('/logs');
      setLogs(data.logs || []);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    const waOn = WHATSAPP_ENABLED && status?.edition !== 'restaurant';
    if (!waOn || step !== 2 || !status?.sqlConfigured) return undefined;
    let cancelled = false;

    const poll = async () => {
      try {
        const { data } = await setupApi.get('/whatsapp');
        if (cancelled) return;
        setWa(data);
        if (data.ready) {
          setStep(3);
        }
      } catch { /* ignore */ }
    };

    poll();
    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [step, status?.sqlConfigured]);

  const handleSqlTest = async () => {
    setSqlError('');
    setSqlTechnical('');
    setSqlBusy(true);
    try {
      const { data } = await setupApi.post('/sql/test', {
        role,
        server: server.trim() || undefined,
        port: role === 'client' ? (parseInt(port, 10) || 1433) : undefined,
        useWindowsAuth: role === 'client' ? false : useWindowsAuth,
        user: role === 'client' || !useWindowsAuth ? user : undefined,
        password: role === 'client' || !useWindowsAuth ? password : undefined,
      });
      setServer(data.server || server);
      setSqlError('');
      alert(`Bağlantı başarılı: ${data.server}`);
    } catch (err) {
      setSqlError(err.response?.data?.error || 'Bağlantı testi başarısız.');
      setSqlTechnical(err.response?.data?.technical || '');
    } finally {
      setSqlBusy(false);
    }
  };

  const handleSqlSave = async () => {
    setSqlError('');
    setSqlTechnical('');
    setSqlBusy(true);
    try {
      const { data } = await setupApi.post('/sql/save', {
        role,
        server: server.trim() || undefined,
        port: role === 'client' ? (parseInt(port, 10) || 1433) : undefined,
        useWindowsAuth: role === 'client' ? false : useWindowsAuth,
        user: role === 'client' || !useWindowsAuth ? user : undefined,
        password: role === 'client' || !useWindowsAuth ? password : undefined,
      });
      setRestarting(true);
      setSqlError('');
      alert(data.restartMessage || 'Yeniden başlatılıyor...');
    } catch (err) {
      setSqlError(err.response?.data?.error || 'Kayıt başarısız.');
      setSqlTechnical(err.response?.data?.technical || '');
      setSqlBusy(false);
    }
  };

  const handleWaRefresh = async () => {
    setWaBusy(true);
    try {
      await setupApi.post('/whatsapp/refresh');
    } finally {
      setWaBusy(false);
    }
  };

  const handleWaSkip = async () => {
    await setupApi.post('/whatsapp/skip');
    setStep(3);
  };

  const handleFinish = async () => {
    setSqlBusy(true);
    try {
      const { data } = await setupApi.post('/complete', { windowsStartup });
      setRestarting(true);
      alert(data.restartMessage || 'Kurulum tamamlandı, yeniden başlatılıyor...');
    } catch (err) {
      setSqlError(err.response?.data?.error || 'Kurulum tamamlanamadı.');
    } finally {
      setSqlBusy(false);
    }
  };

  const isRestaurant = status?.edition === 'restaurant';
  const whatsappEnabled = WHATSAPP_ENABLED && !isRestaurant;
  const steps = buildSteps(whatsappEnabled);
  const productSubtitle = isRestaurant
    ? 'ArcTeknik Şef — Restoran Otomasyon Sistemi'
    : 'Teknik Servis Yönetim Sistemi';

  if (loading && !status) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900 text-slate-300">
        <Loader2 className="animate-spin mr-2" size={24} />
        Kurulum yükleniyor...
      </div>
    );
  }

  if (restarting) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-900 text-white p-8 text-center">
        <Loader2 className="animate-spin mb-4 text-brand-400" size={48} />
        <h2 className="text-2xl font-bold mb-2">Yeniden başlatılıyor</h2>
        <p className="text-slate-400 max-w-md">
          Ayarlar kaydedildi, uygulama yeniden başlatılıyor. Lütfen birkaç saniye bekleyin...
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-brand-900 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-brand-500 to-brand-700 rounded-2xl shadow-lg shadow-brand-900/40 mb-4">
            <PenTool size={32} className="text-white" />
          </div>
          <h1 className="text-3xl font-bold text-white">İlk Kurulum Sihirbazı</h1>
          <p className="text-slate-400 mt-2">{productSubtitle}</p>
        </div>

        <div className="flex justify-center gap-2 mb-8">
          {steps.map((s) => {
            const Icon = s.icon;
            const active = step === s.id;
            const done = step > s.id;
            return (
              <div
                key={s.id}
                className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                  active ? 'bg-brand-500 text-white' : done ? 'bg-brand-500/30 text-brand-200' : 'bg-white/10 text-slate-400'
                }`}
              >
                <Icon size={16} />
                {s.title}
              </div>
            );
          })}
        </div>

        <div className="bg-white/10 backdrop-blur-lg rounded-2xl border border-white/20 p-8 shadow-2xl">
          {step === 1 && (
            <div className="space-y-5">
              <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                <Server size={22} /> SQL Server Bağlantısı
              </h2>

              {/* Rol seçimi: bu bilgisayar veritabanını barındırıyor mu, yoksa uzak sunucuya mı bağlanıyor? */}
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setRole('server')}
                  className={`p-4 rounded-xl border text-left transition-colors ${
                    role === 'server' ? 'border-brand-400 bg-brand-500/20' : 'border-white/20 bg-white/5 hover:bg-white/10'
                  }`}
                >
                  <div className="font-medium text-white">Sunucu (bu bilgisayar)</div>
                  <div className="text-xs text-slate-400 mt-1">Veritabanı bu bilgisayarda tutulur ve oluşturulur.</div>
                </button>
                <button
                  type="button"
                  onClick={() => setRole('client')}
                  className={`p-4 rounded-xl border text-left transition-colors ${
                    role === 'client' ? 'border-brand-400 bg-brand-500/20' : 'border-white/20 bg-white/5 hover:bg-white/10'
                  }`}
                >
                  <div className="font-medium text-white">İstemci (uzak sunucu)</div>
                  <div className="text-xs text-slate-400 mt-1">Başka bir bilgisayardaki veritabanına bağlanır.</div>
                </button>
              </div>

              <p className="text-slate-400 text-sm">
                {role === 'client'
                  ? 'Sunucu bilgisayarın IP adresini ve SQL kullanıcı/şifresini girin. Sunucuda TCP 1433 portu açık ve SQL kimlik doğrulaması etkin olmalıdır.'
                  : `${status?.dbName || 'TEKNIKDB'} veritabanı otomatik oluşturulur. Sunucu adını boş bırakırsanız sistem otomatik arar (localhost\\SQLEXPRESS, bilgisayar adı vb.).`}
              </p>

              {sqlError && (
                <div className="p-3 bg-red-500/20 border border-red-500/40 rounded-lg text-red-200 text-sm">
                  <div className="flex items-start gap-2">
                    <AlertCircle size={18} className="shrink-0 mt-0.5" />
                    <div>
                      <p>{sqlError}</p>
                      {sqlTechnical && (
                        <button
                          type="button"
                          onClick={() => { setShowTechnical(!showTechnical); loadLogs(); }}
                          className="text-xs underline mt-1 text-red-300"
                        >
                          Hata Detayını Gör
                        </button>
                      )}
                      {showTechnical && (
                        <pre className="mt-2 text-xs bg-black/30 p-2 rounded overflow-auto max-h-32">{sqlTechnical}</pre>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div className={role === 'client' ? 'grid grid-cols-3 gap-3' : ''}>
                <div className={role === 'client' ? 'col-span-2' : ''}>
                  <label className="block text-sm text-slate-300 mb-1">
                    {role === 'client' ? 'Sunucu IP adresi' : 'Sunucu (isteğe bağlı)'}
                  </label>
                  <input
                    value={server}
                    onChange={(e) => setServer(e.target.value)}
                    placeholder={role === 'client' ? '192.168.1.100' : 'localhost\\SQLEXPRESS'}
                    className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-slate-500 focus:ring-2 focus:ring-brand-500 outline-none"
                  />
                </div>
                {role === 'client' && (
                  <div>
                    <label className="block text-sm text-slate-300 mb-1">Port</label>
                    <input
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                      placeholder="1433"
                      className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-slate-500 focus:ring-2 focus:ring-brand-500 outline-none"
                    />
                  </div>
                )}
              </div>

              {role === 'server' && (
                <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useWindowsAuth}
                    onChange={(e) => setUseWindowsAuth(e.target.checked)}
                    className="rounded"
                  />
                  Windows Kimlik Doğrulaması (önerilen)
                </label>
              )}

              {(role === 'client' || !useWindowsAuth) && (
                <div className="grid grid-cols-2 gap-3">
                  <input
                    value={user}
                    onChange={(e) => setUser(e.target.value)}
                    placeholder="Kullanıcı (sa)"
                    className="px-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white"
                  />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Şifre"
                    className="px-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white"
                  />
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleSqlTest}
                  disabled={sqlBusy}
                  className="flex-1 py-3 border border-white/30 rounded-lg text-white hover:bg-white/10 disabled:opacity-50"
                >
                  {sqlBusy ? <Loader2 className="animate-spin mx-auto" size={20} /> : 'Bağlantıyı Test Et'}
                </button>
                <button
                  type="button"
                  onClick={handleSqlSave}
                  disabled={sqlBusy}
                  className="flex-1 py-3 bg-brand-500 hover:bg-brand-600 rounded-lg text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  Kaydet ve Devam <ChevronRight size={18} />
                </button>
              </div>

              <button
                type="button"
                onClick={() => { setShowLogs(!showLogs); loadLogs(); }}
                className="text-xs text-slate-400 underline"
              >
                Kurulum Günlüğü
              </button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5 text-center">
              <h2 className="text-xl font-semibold text-white">WhatsApp Bağlantısı</h2>
              <p className="text-slate-400 text-sm">
                Telefonunuzdan WhatsApp → Bağlı Cihazlar → Cihaz Bağla ile QR kodu okutun.
              </p>

              {wa?.ready ? (
                <div className="flex flex-col items-center gap-3 py-6">
                  <CheckCircle2 size={64} className="text-green-400" />
                  <p className="text-green-300 font-medium">WhatsApp bağlandı!</p>
                  <button
                    type="button"
                    onClick={() => setStep(3)}
                    className="px-6 py-3 bg-brand-500 rounded-lg text-white font-medium"
                  >
                    Devam Et <ChevronRight size={18} className="inline" />
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex justify-center min-h-[280px] items-center">
                    {wa?.qrImage ? (
                      <img src={wa.qrImage} alt="WhatsApp QR" className="rounded-xl bg-white p-2" />
                    ) : (
                      <div className="text-slate-400 flex flex-col items-center gap-2">
                        <Loader2 className="animate-spin" size={40} />
                        <span>QR kodu hazırlanıyor...</span>
                      </div>
                    )}
                  </div>
                  {wa?.qrExpired && (
                    <p className="text-amber-300 text-sm">QR süresi doldu. Yenileyin.</p>
                  )}
                  <div className="flex gap-3 justify-center">
                    <button
                      type="button"
                      onClick={handleWaRefresh}
                      disabled={waBusy}
                      className="px-4 py-2 border border-white/30 rounded-lg text-white flex items-center gap-2 hover:bg-white/10"
                    >
                      <RefreshCw size={16} className={waBusy ? 'animate-spin' : ''} />
                      QR Yenile
                    </button>
                    <button
                      type="button"
                      onClick={handleWaSkip}
                      className="px-4 py-2 text-slate-400 hover:text-white flex items-center gap-2"
                    >
                      <SkipForward size={16} /> Şimdilik Atla
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6">
              <h2 className="text-xl font-semibold text-white text-center">Kurulumu Tamamla</h2>
              <ul className="space-y-2 text-slate-300 text-sm">
                <li className="flex items-center gap-2">
                  <CheckCircle2 size={16} className="text-green-400" />
                  Veritabanı: {status?.dbName || 'TEKNIKDB'}
                </li>
                {whatsappEnabled && (
                  <li className="flex items-center gap-2">
                    {wa?.ready || status?.whatsappConfigured ? (
                      <CheckCircle2 size={16} className="text-green-400" />
                    ) : (
                      <AlertCircle size={16} className="text-amber-400" />
                    )}
                    WhatsApp: {wa?.ready ? 'Bağlı' : status?.whatsappSkipped ? 'Atlandı' : 'Bağlı değil'}
                  </li>
                )}
              </ul>

              <label className="flex items-center gap-3 p-4 bg-white/5 rounded-lg cursor-pointer">
                <input
                  type="checkbox"
                  checked={windowsStartup}
                  onChange={(e) => setWindowsStartup(e.target.checked)}
                  className="rounded"
                />
                <span className="text-slate-300 text-sm">Windows açılışında otomatik başlat</span>
              </label>

              <p className="text-slate-500 text-xs text-center">
                Varsayılan giriş: admin / admin123 — ilk girişten sonra şifrenizi değiştirin.
              </p>

              <button
                type="button"
                onClick={handleFinish}
                disabled={sqlBusy}
                className="w-full py-3 bg-brand-500 hover:bg-brand-600 rounded-lg text-white font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {sqlBusy ? <Loader2 className="animate-spin" size={20} /> : (
                  <>Kurulumu Bitir ve Panele Git <ChevronRight size={18} /></>
                )}
              </button>
            </div>
          )}

          {showLogs && logs.length > 0 && (
            <div className="mt-6 pt-4 border-t border-white/10">
              <p className="text-xs text-slate-400 mb-2">Kurulum günlüğü</p>
              <pre className="text-xs text-slate-300 bg-black/30 p-3 rounded max-h-40 overflow-auto">
                {logs.map((l) => `[${l.level}] ${l.message}${l.detail ? ` — ${l.detail}` : ''}`).join('\n')}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SetupWizard;
