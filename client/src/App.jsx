import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, useLocation, Navigate } from 'react-router-dom';
import axios from 'axios';
import { Lock } from 'lucide-react';
import { Toaster } from 'react-hot-toast';
import Login from './pages/Login';
import Restaurant from './pages/Restaurant';
import RestaurantKitchen from './pages/RestaurantKitchen';
import RestaurantWaiter from './pages/RestaurantWaiter';
import RestaurantControl from './pages/RestaurantControl';
import RestaurantSelfService from './pages/RestaurantSelfService';
import RestaurantCallScreen from './pages/RestaurantCallScreen';
import AppLoader from './components/AppLoader';
import SetupWizard from './pages/SetupWizard';
import Onboarding from './pages/Onboarding';
import LicensePage from './pages/LicensePage';
import { AuthProvider, useAuth, PERMISSIONS } from './context/AuthContext';
import { LicenseProvider, useLicense } from './context/LicenseContext';
import { FeatureProvider } from './context/FeatureContext';
import { getApiBaseUrl } from './api/client';
import { applyPwaForEdition } from './pwa';

const ProtectedRoute = ({ children, adminOnly = false, permission = null }) => {
  const { user, loading } = useAuth();
  const loc = useLocation();

  if (loading) return <AppLoader message="Oturum doğrulanıyor…" />;
  // Girişten sonra istenen derin bağlantıya (ör. /restoran/garson) geri dönebilmek
  // için hedef yolu taşı; Login bunu okur, yoksa '/'.
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;

  // RBAC: Admin her şeye erişir; aksi halde belirtilen izin gerekir.
  const isAdmin = user.role === 'Admin';
  const perms = Array.isArray(user.permissions) ? user.permissions : [];
  const allowed = isAdmin || (permission && perms.includes(permission));
  if ((adminOnly || permission) && !allowed) return <Navigate to="/" replace />;

  return children;
};

// Lisans durumunu LicenseContext'ten okur; geçerli lisans yüklenene kadar LicensePage gösterir.
const LicenseGate = ({ children }) => {
  const { status, refresh } = useLicense();

  if (status === null) {
    return <AppLoader message="Lisans denetleniyor…" />;
  }

  if (!status.valid) {
    return <LicensePage status={status} onActivated={refresh} />;
  }

  // ArcTeknik Şef: RESTAURANT modülü ürünün KENDİSİDİR (edition restaurant'ta
  // örtük verilir, trial dahil — bkz. server/services/license.withEditionModules).
  return (
    <>
      {status.trial && <TrialBanner daysLeft={status.daysLeft} />}
      {children}
    </>
  );
};

// Deneme sürümünde alt köşede kalan gün sayısını gösteren ince şerit.
const TrialBanner = ({ daysLeft }) => {
  const urgent = (daysLeft ?? 0) <= 3;
  return (
    <div
      className={`fixed bottom-3 right-3 z-50 px-3 py-1.5 rounded-full text-xs font-semibold shadow-lg border ${
        urgent
          ? 'bg-red-600 border-red-500 text-white'
          : 'bg-amber-500 border-amber-400 text-slate-900'
      }`}
      title="Deneme sürümü"
    >
      Deneme: {Math.max(0, daysLeft ?? 0)} gün kaldı
    </div>
  );
};

// Modülü lisanslı olmayan bir özelliğe gidilince gösterilen kilit ekranı.
const ModuleLocked = ({ title }) => (
  <div className="min-h-screen flex items-center justify-center bg-slate-900 text-slate-200 p-6">
    <div className="max-w-md text-center space-y-3">
      <Lock size={48} className="mx-auto text-amber-400" />
      <h1 className="text-2xl font-bold">{title} modülü lisanslı değil</h1>
      <p className="text-slate-400">
        Bu özellik lisansınızda tanımlı değil. Satın almak için yetkilinizle iletişime geçin;
        size özel yeni lisans metnini <b>Lisans</b> ekranından girince anında açılır.
      </p>
    </div>
  </div>
);

// Veritabanında hiç yönetici yoksa İlk Kurulum (Onboarding) sihirbazını gösterir.
// AuthProvider içinde olmalı — tamamlanınca otomatik giriş yapar.
const OnboardingGate = ({ children }) => {
  const { user } = useAuth();
  const [needed, setNeeded] = useState(null);

  useEffect(() => {
    // Zaten giriş yapılmışsa kurulum gerekmez.
    if (user) { setNeeded(false); return; }
    let cancelled = false;
    axios.get(`${getApiBaseUrl()}/onboarding/status`)
      .then(({ data }) => { if (!cancelled) setNeeded(!!data.needed); })
      .catch(() => { if (!cancelled) setNeeded(false); });
    return () => { cancelled = true; };
  }, [user]);

  if (needed === null) {
    return <AppLoader message="Hazırlanıyor…" />;
  }

  if (needed) {
    return <Onboarding onComplete={() => setNeeded(false)} />;
  }

  return children;
};

const SetupGate = ({ children }) => {
  const [setupRequired, setSetupRequired] = useState(null);
  const [retryCount, setRetryCount] = useState(0);

  const checkSetup = async () => {
    try {
      const { data } = await axios.get(`${getApiBaseUrl()}/setup/status`);
      setSetupRequired(!data.complete);
    } catch (err) {
      // 503 with setupRequired flag = setup mode
      if (err.response?.status === 503 || err.response?.data?.setupRequired) {
        setSetupRequired(true);
        return;
      }
      // Any other HTTP response (404, etc.) = server is up and setup is complete
      if (err.response) {
        setSetupRequired(false);
        return;
      }
      // True network error (no response) — server not booted yet, retry
      setRetryCount(prev => {
        const next = prev + 1;
        if (next >= 30) {
          setSetupRequired(false);
        }
        return next;
      });
    }
  };

  useEffect(() => {
    if (setupRequired !== null) return;
    const timer = setTimeout(checkSetup, retryCount === 0 ? 0 : 1000);
    return () => clearTimeout(timer);
  }, [retryCount, setupRequired]);

  if (setupRequired === null) {
    return <AppLoader message="Sunucuya bağlanılıyor…" />;
  }

  if (setupRequired) {
    return <SetupWizard onComplete={() => setSetupRequired(false)} />;
  }

  return children;
};

// ArcTeknik Şef — bağımsız restoran uygulaması (TEK ürün). Teknik servis/ERP
// rotaları YOK (ayrı klasör/repo); her bilinmeyen yol /restoran'a yönlenir.
function ProductRoutes() {
  const { hasModule } = useLicense();
  useEffect(() => { applyPwaForEdition('restaurant'); }, []);

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Ana ekran yalnızca oturum ister (yetki sunucu tarafında da denetlenir) —
          böylece yetki hatasında "/" → "*" → /restoran sonsuz döngüsü oluşmaz. */}
      <Route path="/restoran" element={<ProtectedRoute>{hasModule('RESTAURANT') ? <Restaurant standalone /> : <ModuleLocked title="ArcTeknik Şef" />}</ProtectedRoute>} />
      <Route path="/restoran/mutfak" element={<ProtectedRoute permission={PERMISSIONS.USE_RESTAURANT}>{hasModule('RESTAURANT') ? <RestaurantKitchen /> : <ModuleLocked title="ArcTeknik Şef" />}</ProtectedRoute>} />
      <Route path="/restoran/garson" element={<ProtectedRoute permission={PERMISSIONS.USE_RESTAURANT}>{hasModule('RESTAURANT') ? <RestaurantWaiter /> : <ModuleLocked title="ArcTeknik Şef" />}</ProtectedRoute>} />
      {/* Self-Servis Kasa (--mode=selfservice) — masa planı atlanır, peşin tahsilat. */}
      <Route path="/restoran/self" element={<ProtectedRoute permission={PERMISSIONS.USE_RESTAURANT}>{hasModule('RESTAURANT') ? <RestaurantSelfService /> : <ModuleLocked title="ArcTeknik Şef" />}</ProtectedRoute>} />
      {/* Müşteri Çağrı Ekranı (--mode=cagri) — tavan TV'si, hazır numaraları anons eder. */}
      <Route path="/restoran/cagri" element={<ProtectedRoute permission={PERMISSIONS.USE_RESTAURANT}>{hasModule('RESTAURANT') ? <RestaurantCallScreen /> : <ModuleLocked title="ArcTeknik Şef" />}</ProtectedRoute>} />
      {/* Kontrol Paneli (--mode=control) — ayrı yönetim penceresi, yalnızca yönetici. */}
      <Route path="/restoran/yonetim" element={<ProtectedRoute adminOnly>{hasModule('RESTAURANT') ? <RestaurantControl /> : <ModuleLocked title="ArcTeknik Şef" />}</ProtectedRoute>} />
      <Route path="*" element={<Navigate to="/restoran" replace />} />
    </Routes>
  );
}

function App() {
  return (
    <SetupGate>
    <LicenseProvider>
    <LicenseGate>
    <AuthProvider>
      <FeatureProvider>
      <Toaster position="top-right" />
      <OnboardingGate>
      <BrowserRouter>
        <ProductRoutes />
      </BrowserRouter>
      </OnboardingGate>
      </FeatureProvider>
    </AuthProvider>
    </LicenseGate>
    </LicenseProvider>
    </SetupGate>
  );
}

export default App;
