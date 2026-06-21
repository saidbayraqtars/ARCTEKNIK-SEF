import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from './AuthContext';

// ─── Sektör Özellik Bayrakları (Ekran/Yetenek Gating) ────────────────────────
// Sunucudan efektif özellik haritasını çeker (sektör varsayılanı + Ayarlar
// override + lisans). Menü/route + ekran-içi yetenekler buradan `hasFeature(key)`
// ile gizlenir. Fail-open: veri yoksa/çekilemezse özellik AÇIK sayılır (yanlışlıkla
// ekran kaybolmasın). Lisans/RBAC ayrı eksenlerde zaten korur.

const FeatureContext = createContext(null);

export const FeatureProvider = ({ children }) => {
  const { user } = useAuth();
  const [effective, setEffective] = useState(null); // null = henüz yüklenmedi
  const [catalog, setCatalog] = useState([]);
  const [sector, setSector] = useState(null); // { id, label, dev, vehicle, parts }

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get('/settings/features');
      setEffective(data.effective || {});
      setCatalog(Array.isArray(data.catalog) ? data.catalog : []);
      setSector(data.sector || null);
    } catch {
      // Oturum yok / sunucu erişilemiyor → fail-open (her şey açık).
      setEffective(null);
      setSector(null);
    }
  }, []);

  // Oturum açıldığında / değiştiğinde yeniden çek.
  useEffect(() => { if (user) refresh(); else { setEffective(null); setSector(null); } }, [user, refresh]);

  // Veri yoksa true (fail-open). Bilinmeyen anahtar da true.
  const hasFeature = useCallback((key) => {
    if (!effective) return true;
    return effective[key] !== false;
  }, [effective]);

  const isVehicleSector = !!sector?.vehicle; // oto servis → araç kabul formu
  const isPartsSector = !!sector?.parts;     // oto yedek parça → stok kartı OEM alanları

  return (
    <FeatureContext.Provider value={{ effective, catalog, sector, isVehicleSector, isPartsSector, hasFeature, refresh }}>
      {children}
    </FeatureContext.Provider>
  );
};

export const useFeatures = () => {
  const ctx = useContext(FeatureContext);
  return ctx || { effective: null, catalog: [], sector: null, isVehicleSector: false, isPartsSector: false, hasFeature: () => true, refresh: () => {} };
};
