import { useState } from 'react';
import axios from 'axios';
import { ShieldX, ShieldAlert, Clock, KeyRound, CheckCircle2, AlertTriangle, Cpu, Copy, Check, Hourglass, MessageCircle } from 'lucide-react';
import { getApiBaseUrl } from '../api/client';
import { productMeta } from '../product';

const fmt = (ts) => ts ? new Date(ts * 1000).toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' }) : '-';

// Tedarikçi (destek) iletişim bilgisi — deneme dolunca / lisans gerekince gösterilir.
const SUPPORT_PHONE = '0535 078 61 01';
const SUPPORT_WA_NUMBER = '905350786101';
// Bu ekranların kullanıcıya "tedarikçinizle iletişime geçin" yönlendirmesi yaptığı durumlar.
const CONTACT_REASONS = new Set(['TRIAL_EXPIRED', 'LICENSE_EXPIRED', 'LICENSE_NOT_FOUND', 'LICENSE_HARDWARE_MISMATCH']);

const REASON_META = {
    LICENSE_NOT_FOUND: {
        icon: KeyRound,
        color: 'text-slate-400',
        bg: 'bg-slate-800',
        title: 'Lisans Bulunamadı',
        desc: 'Bu yazılım için henüz bir lisans tanımlanmamış. Lütfen lisans dosyanızı aşağıya yapıştırın.',
    },
    LICENSE_INVALID: {
        icon: ShieldX,
        color: 'text-red-400',
        bg: 'bg-red-900/30',
        title: 'Geçersiz Lisans',
        desc: 'Lisans imzası doğrulanamadı. Dosya değiştirilmiş ya da bu yazılıma ait değil.',
    },
    LICENSE_CORRUPT: {
        icon: ShieldX,
        color: 'text-red-400',
        bg: 'bg-red-900/30',
        title: 'Bozuk Lisans',
        desc: 'Lisans dosyası okunamadı. Yeni bir lisans girin.',
    },
    LICENSE_EXPIRED: {
        icon: ShieldAlert,
        color: 'text-amber-400',
        bg: 'bg-amber-900/30',
        title: 'Lisans Süresi Doldu',
        desc: null,
    },
    TRIAL_EXPIRED: {
        icon: Hourglass,
        color: 'text-amber-400',
        bg: 'bg-amber-900/30',
        title: 'Deneme Süreniz Doldu',
        desc: '15 günlük ücretsiz deneme süreniz sona erdi. Kullanmaya devam etmek için tedarikçinizle iletişime geçip lisansınızı alın.',
    },
    LICENSE_NOT_YET_VALID: {
        icon: Clock,
        color: 'text-blue-400',
        bg: 'bg-blue-900/30',
        title: 'Lisans Henüz Aktif Değil',
        desc: 'Lisans başlangıç tarihi henüz gelmedi.',
    },
    CLOCK_TAMPERED: {
        icon: AlertTriangle,
        color: 'text-red-400',
        bg: 'bg-red-900/30',
        title: 'Sistem Saati Müdahalesi Tespit Edildi',
        desc: null,
    },
    LICENSE_HARDWARE_MISMATCH: {
        icon: Cpu,
        color: 'text-amber-400',
        bg: 'bg-amber-900/30',
        title: 'Lisans Bu Bilgisayara Ait Değil',
        desc: 'Bu lisans başka bir bilgisayar için üretilmiş. Aşağıdaki Donanım Kimliği ile tedarikçinizden bu makineye özel yeni bir lisans talep edin.',
    },
};

export default function LicensePage({ status, onActivated }) {
    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(null);
    const [copied, setCopied] = useState(false);

    const reason = status?.reason || 'LICENSE_NOT_FOUND';
    const meta = REASON_META[reason] || REASON_META.LICENSE_NOT_FOUND;
    const Icon = meta.icon;
    const hardwareId = status?.hardwareId;

    const canActivate = reason !== 'CLOCK_TAMPERED';

    // Tedarikçi iletişim kartı (WhatsApp). Donanım kimliği varsa mesaja ekler.
    const showContact = CONTACT_REASONS.has(reason);
    const waText = encodeURIComponent(
        `Merhaba, ${productMeta.title} lisansı almak istiyorum.` +
        (hardwareId ? `\nDonanım Kimliğim: ${hardwareId}` : '')
    );
    const waLink = `https://wa.me/${SUPPORT_WA_NUMBER}?text=${waText}`;

    const copyHwId = async () => {
        if (!hardwareId) return;
        try {
            await navigator.clipboard.writeText(hardwareId);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
        } catch { /* clipboard yoksa yoksay */ }
    };

    async function handleActivate(e) {
        e.preventDefault();
        if (!content.trim()) return;
        setLoading(true);
        setError('');
        try {
            const { data } = await axios.post(`${getApiBaseUrl()}/license/activate`, { content });
            setSuccess(data);
            setTimeout(() => onActivated?.(), 1500);
        } catch (err) {
            setError(err.response?.data?.error || 'Aktivasyon başarısız.');
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
            <div className="w-full max-w-lg">
                {/* Logo / branding */}
                <div className="text-center mb-8">
                    <img src="/icon.png" alt="ArcTeknik" className="w-20 h-20 mx-auto mb-4 drop-shadow-lg" />
                    <h1 className="text-2xl font-bold text-white tracking-tight">{productMeta.title}</h1>
                    <p className="text-slate-400 text-sm mt-1">Lisans Yönetimi</p>
                </div>

                {/* Status card */}
                <div className={`rounded-xl p-5 mb-6 flex items-start gap-4 ${meta.bg}`}>
                    <Icon size={28} className={`mt-0.5 shrink-0 ${meta.color}`} />
                    <div>
                        <p className={`font-semibold ${meta.color}`}>{meta.title}</p>
                        {meta.desc && <p className="text-slate-300 text-sm mt-1">{meta.desc}</p>}
                        {reason === 'LICENSE_EXPIRED' && (
                            <div className="text-slate-300 text-sm mt-1 space-y-0.5">
                                <p>Müşteri: <span className="text-white font-medium">{status.customerName}</span></p>
                                <p>Bitiş tarihi: <span className="text-amber-300 font-medium">{fmt(status.expiresAt)}</span></p>
                                <p className="text-red-400">{status.daysExpired} gün önce sona erdi.</p>
                            </div>
                        )}
                        {reason === 'CLOCK_TAMPERED' && (
                            <div className="text-slate-300 text-sm mt-1">
                                <p>{status.detail}</p>
                                <p className="mt-1 text-red-300">Sistem saatini doğru değere alın ve uygulamayı yeniden başlatın. Lisans süresi geçerli olduğu sürece yazılım çalışmaya devam edecek.</p>
                            </div>
                        )}
                    </div>
                </div>

                {/* Tedarikçi iletişim — deneme dolunca / lisans gerekince */}
                {showContact && !success && (
                    <div className="bg-emerald-900/20 border border-emerald-700/50 rounded-xl p-5 mb-6">
                        <p className="text-slate-200 font-semibold text-sm mb-1">Sağlayıcınız ile iletişime geçin</p>
                        <p className="text-slate-400 text-xs mb-4">
                            Lisansınızı almak için aşağıdaki numaradan bize ulaşın. Tıkladığınızda WhatsApp açılır.
                        </p>
                        <a
                            href={waLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center justify-center gap-2 w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-lg transition-colors"
                        >
                            <MessageCircle size={18} />
                            WhatsApp: {SUPPORT_PHONE}
                        </a>
                    </div>
                )}

                {/* Donanım Kimliği — tedarikçiye iletilecek */}
                {hardwareId && !success && (
                    <div className="bg-slate-800/70 border border-slate-700 rounded-xl p-5 mb-6">
                        <div className="flex items-center gap-2 mb-2">
                            <Cpu size={18} className="text-brand-400" />
                            <span className="text-slate-200 font-semibold text-sm">Donanım Kimliği</span>
                        </div>
                        <p className="text-slate-400 text-xs mb-3">
                            Lisans talebinizde bu kodu tedarikçinize iletin. Lisansınız yalnızca bu bilgisayarda çalışır.
                        </p>
                        <div className="flex items-center gap-2">
                            <code className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-brand-300 font-mono text-sm tracking-wider select-all break-all">
                                {hardwareId}
                            </code>
                            <button
                                type="button"
                                onClick={copyHwId}
                                className="shrink-0 px-3 py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg transition-colors flex items-center gap-1.5 text-sm"
                                title="Kopyala"
                            >
                                {copied ? <Check size={16} className="text-green-400" /> : <Copy size={16} />}
                                {copied ? 'Kopyalandı' : 'Kopyala'}
                            </button>
                        </div>
                    </div>
                )}

                {/* Activation form */}
                {canActivate && !success && (
                    <form onSubmit={handleActivate} className="bg-slate-800 rounded-xl p-6 space-y-4">
                        <h2 className="text-white font-semibold text-lg">Lisans Aktivasyonu</h2>
                        <p className="text-slate-400 text-sm">
                            Tedarikçinizden aldığınız <code className="text-brand-400">.lic</code> dosyasının içeriğini aşağıya yapıştırın.
                        </p>
                        <textarea
                            className="w-full h-40 bg-slate-900 text-slate-200 text-xs font-mono border border-slate-600 rounded-lg p-3 resize-none focus:outline-none focus:ring-2 focus:ring-brand-500 placeholder-slate-600"
                            placeholder={'{\n  "payload": { ... },\n  "signature": "..."\n}'}
                            value={content}
                            onChange={e => setContent(e.target.value)}
                            spellCheck={false}
                        />
                        {error && (
                            <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-2 text-red-300 text-sm">
                                {error}
                            </div>
                        )}
                        <button
                            type="submit"
                            disabled={loading || !content.trim()}
                            className="w-full py-2.5 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-colors"
                        >
                            {loading ? 'Doğrulanıyor...' : 'Lisansı Etkinleştir'}
                        </button>
                    </form>
                )}

                {/* Success state */}
                {success && (
                    <div className="bg-green-900/40 border border-green-700 rounded-xl p-6 text-center space-y-2">
                        <CheckCircle2 size={40} className="text-green-400 mx-auto" />
                        <p className="text-green-300 font-semibold text-lg">Lisans Etkinleştirildi!</p>
                        <p className="text-slate-300 text-sm">
                            <span className="text-white font-medium">{success.customerName}</span> adına
                            {' '}<span className="text-green-400 font-medium">{success.daysLeft} gün</span> geçerli lisans yüklendi.
                        </p>
                        <p className="text-slate-400 text-xs">Uygulama yeniden yükleniyor...</p>
                    </div>
                )}
            </div>
        </div>
    );
}
