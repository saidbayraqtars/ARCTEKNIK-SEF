import { useState, useEffect } from 'react';
import axios from 'axios';
import {
  Building2, UserCog, ArrowRight, ArrowLeft, CheckCircle2,
  Sparkles, ShieldCheck, Eye, EyeOff, Loader2, Briefcase,
} from 'lucide-react';
import { getApiBaseUrl } from '../api/client';
import { useAuth } from '../context/AuthContext';

const Field = ({ label, required, children, hint }) => (
  <label className="block">
    <span className="text-sm font-medium text-slate-300">
      {label} {required && <span className="text-brand-400">*</span>}
    </span>
    {children}
    {hint && <span className="block text-xs text-slate-500 mt-1">{hint}</span>}
  </label>
);

const inputCls =
  'mt-1.5 w-full bg-slate-900/70 text-slate-100 border border-slate-700 rounded-lg px-3.5 py-2.5 ' +
  'focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder-slate-600 transition';

export default function Onboarding({ onComplete }) {
  const { login } = useAuth();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [done, setDone] = useState(false);

  const [company, setCompany] = useState({ companyName: '', taxOffice: '', phone: '', companyType: 'teknik_servis' });
  const [admin, setAdmin] = useState({ firstName: '', lastName: '', username: '', password: '', password2: '' });
  const [sectors, setSectors] = useState([]);
  const [edition, setEdition] = useState(null); // 'restaurant' → Şef sürümü (firma tipi alakasız)
  const isRestaurant = edition === 'restaurant';

  // Firma tipi listesi (oturum gerektirmez). Hata olursa varsayılan tek seçenek.
  useEffect(() => {
    axios.get(`${getApiBaseUrl()}/onboarding/sectors`)
      .then(({ data }) => setSectors(data.sectors || []))
      .catch(() => setSectors([{ id: 'teknik_servis', label: 'Genel Teknik Servis' }]));
  }, []);

  // Sürüm (edition): Şef'te firma tipi seçimi gizlenir, başlık restoran olur.
  useEffect(() => {
    axios.get(`${getApiBaseUrl()}/setup/status`)
      .then(({ data }) => {
        if (data?.edition === 'restaurant') {
          setEdition('restaurant');
          setCompany((p) => ({ ...p, companyType: 'genel' })); // restoran sektör profili kullanmaz
        } else {
          setEdition(data?.edition || 'service');
        }
      })
      .catch(() => {});
  }, []);

  const set = (setter) => (e) => setter((p) => ({ ...p, [e.target.name]: e.target.value }));

  const goStep2 = (e) => {
    e.preventDefault();
    setError('');
    if (!company.companyName.trim()) {
      setError('Şirket adı zorunludur.');
      return;
    }
    setStep(2);
  };

  const handleFinish = async (e) => {
    e.preventDefault();
    setError('');
    if (!admin.firstName.trim() || !admin.username.trim()) {
      setError('Ad ve kullanıcı adı zorunludur.');
      return;
    }
    if (admin.password.length < 6) {
      setError('Şifre en az 6 karakter olmalıdır.');
      return;
    }
    if (admin.password !== admin.password2) {
      setError('Şifreler eşleşmiyor.');
      return;
    }

    setLoading(true);
    try {
      const { data } = await axios.post(`${getApiBaseUrl()}/onboarding/complete`, {
        company: {
          companyName: company.companyName,
          taxOffice: company.taxOffice,
          phone: company.phone,
          companyType: company.companyType,
        },
        admin: {
          firstName: admin.firstName,
          lastName: admin.lastName,
          username: admin.username,
          password: admin.password,
        },
      });
      setDone(true);
      // Otomatik giriş → kısa bir kutlama ekranından sonra Dashboard.
      setTimeout(() => {
        login(data.user, data.token);
        onComplete?.();
      }, 1400);
    } catch (err) {
      setError(err.response?.data?.error || 'Kurulum tamamlanamadı.');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center p-4">
      {/* Dekoratif ışıltı */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-32 -right-32 w-96 h-96 bg-brand-600/20 rounded-full blur-3xl" />
        <div className="absolute -bottom-32 -left-32 w-96 h-96 bg-brand-500/10 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-xl">
        {/* Başlık */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 mb-4 shadow-lg shadow-brand-900/40">
            <Sparkles size={30} className="text-white" />
          </div>
          <h1 className="text-3xl font-bold text-white tracking-tight">Hoş Geldiniz</h1>
          <p className="text-slate-400 mt-2">
            {isRestaurant ? 'ArcTeknik Şef — Restoran Otomasyon Sistemi' : 'Teknik Servis Yönetim Sistemi'}'ni kullanmaya başlamak için son birkaç adım.
          </p>
        </div>

        {done ? (
          <div className="bg-slate-800/80 backdrop-blur border border-slate-700 rounded-2xl p-10 text-center space-y-3">
            <CheckCircle2 size={56} className="text-brand-400 mx-auto" />
            <h2 className="text-xl font-bold text-white">Kurulum Tamamlandı!</h2>
            <p className="text-slate-400">Yönetim paneline yönlendiriliyorsunuz...</p>
          </div>
        ) : (
          <div className="bg-slate-800/80 backdrop-blur border border-slate-700 rounded-2xl shadow-2xl overflow-hidden">
            {/* Adım göstergesi */}
            <div className="flex border-b border-slate-700/80">
              {[
                { n: 1, label: 'Firma Bilgileri', icon: Building2 },
                { n: 2, label: 'Yönetici Hesabı', icon: UserCog },
              ].map(({ n, label, icon: Icon }) => (
                <div
                  key={n}
                  className={`flex-1 flex items-center justify-center gap-2 py-4 text-sm font-medium transition ${
                    step === n
                      ? 'text-brand-300 bg-brand-600/10 border-b-2 border-brand-500'
                      : step > n
                        ? 'text-brand-400'
                        : 'text-slate-500'
                  }`}
                >
                  {step > n ? <CheckCircle2 size={18} /> : <Icon size={18} />}
                  <span className="hidden sm:inline">{label}</span>
                  <span className="sm:hidden">Adım {n}</span>
                </div>
              ))}
            </div>

            <div className="p-7">
              {error && (
                <div className="mb-5 bg-red-900/40 border border-red-700/60 rounded-lg px-4 py-2.5 text-red-300 text-sm">
                  {error}
                </div>
              )}

              {step === 1 && (
                <form onSubmit={goStep2} className="space-y-4">
                  <Field label="Şirket Adı" required>
                    <input
                      name="companyName" value={company.companyName} onChange={set(setCompany)}
                      className={inputCls} placeholder={isRestaurant ? 'Örn. Arc Restoran' : 'Örn. Arc Teknik Servis'} autoFocus
                    />
                  </Field>
                  {/* Firma tipi yalnız servis/işletme sürümünde — Şef (restoran) sektör profili kullanmaz. */}
                  {!isRestaurant && (
                    <Field label="Firma Tipi" required hint="Arayüz başlığı ve hazır WhatsApp mesajları bu seçime göre hazırlanır. Sonradan Ayarlar'dan değiştirebilirsiniz.">
                      <div className="relative">
                        <Briefcase size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                        <select
                          name="companyType" value={company.companyType} onChange={set(setCompany)}
                          className={inputCls + ' pl-9 appearance-none'}
                        >
                          {sectors.map((s) => (
                            <option key={s.id} value={s.id}>{s.label}</option>
                          ))}
                        </select>
                      </div>
                    </Field>
                  )}
                  <Field label="Vergi Dairesi" hint="Fiş ve faturalarda görünür (opsiyonel).">
                    <input
                      name="taxOffice" value={company.taxOffice} onChange={set(setCompany)}
                      className={inputCls} placeholder="Örn. Merkez V.D."
                    />
                  </Field>
                  <Field label="Telefon">
                    <input
                      name="phone" value={company.phone} onChange={set(setCompany)}
                      className={inputCls} placeholder="Örn. 0212 000 00 00"
                    />
                  </Field>
                  <button
                    type="submit"
                    className="w-full mt-2 py-3 bg-brand-600 hover:bg-brand-700 text-white font-semibold rounded-lg flex items-center justify-center gap-2 transition-colors"
                  >
                    Devam Et <ArrowRight size={18} />
                  </button>
                </form>
              )}

              {step === 2 && (
                <form onSubmit={handleFinish} className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Field label="Ad" required>
                      <input
                        name="firstName" value={admin.firstName} onChange={set(setAdmin)}
                        className={inputCls} placeholder="Ad" autoFocus
                      />
                    </Field>
                    <Field label="Soyad">
                      <input
                        name="lastName" value={admin.lastName} onChange={set(setAdmin)}
                        className={inputCls} placeholder="Soyad"
                      />
                    </Field>
                  </div>
                  <Field label="E-posta / Kullanıcı Adı" required hint="Giriş yaparken kullanacağınız ad.">
                    <input
                      name="username" value={admin.username} onChange={set(setAdmin)}
                      className={inputCls} placeholder="ornek@firma.com veya yonetici"
                    />
                  </Field>
                  <Field label="Şifre" required hint="En az 6 karakter.">
                    <div className="relative">
                      <input
                        name="password" type={showPw ? 'text' : 'password'}
                        value={admin.password} onChange={set(setAdmin)}
                        className={inputCls} placeholder="••••••••"
                      />
                      <button
                        type="button" onClick={() => setShowPw((v) => !v)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                        tabIndex={-1}
                      >
                        {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                  </Field>
                  <Field label="Şifre (Tekrar)" required>
                    <input
                      name="password2" type={showPw ? 'text' : 'password'}
                      value={admin.password2} onChange={set(setAdmin)}
                      className={inputCls} placeholder="••••••••"
                    />
                  </Field>

                  <div className="flex gap-3 pt-2">
                    <button
                      type="button" onClick={() => { setStep(1); setError(''); }}
                      disabled={loading}
                      className="px-4 py-3 text-slate-300 hover:text-white border border-slate-600 hover:border-slate-500 rounded-lg flex items-center gap-2 transition-colors disabled:opacity-50"
                    >
                      <ArrowLeft size={18} /> Geri
                    </button>
                    <button
                      type="submit" disabled={loading}
                      className="flex-1 py-3 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white font-semibold rounded-lg flex items-center justify-center gap-2 transition-colors"
                    >
                      {loading
                        ? (<><Loader2 size={18} className="animate-spin" /> Oluşturuluyor...</>)
                        : (<>Kurulumu Tamamla <CheckCircle2 size={18} /></>)}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        )}

        <p className="text-center text-slate-600 text-xs mt-6 flex items-center justify-center gap-1.5">
          <ShieldCheck size={14} /> Verileriniz yalnızca bu bilgisayardaki veritabanında saklanır.
        </p>
      </div>
    </div>
  );
}
