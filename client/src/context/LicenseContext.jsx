import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import { getApiBaseUrl } from '../api/client';

const LicenseContext = createContext(null);

export const LicenseProvider = ({ children }) => {
  const [status, setStatus] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await axios.get(`${getApiBaseUrl()}/license/status`);
      setStatus(data);
    } catch {
      // Sunucuya hiç ulaşılamıyorsa engelleme — SetupGate bağlantıyı yönetir.
      setStatus({ valid: true, modules: [] });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const modules = Array.isArray(status?.modules) ? status.modules : [];
  const hasModule = (name) => modules.includes(name);
  // Kullanıcı (seat) limiti: null/tanımsız → sınırsız.
  const maxUsers = Number.isInteger(status?.maxUsers) && status.maxUsers > 0 ? status.maxUsers : null;

  return (
    <LicenseContext.Provider value={{ status, modules, hasModule, maxUsers, refresh }}>
      {children}
    </LicenseContext.Provider>
  );
};

export const useLicense = () => {
  const ctx = useContext(LicenseContext);
  // Provider dışında kullanılırsa güvenli varsayılan döndür.
  return ctx || { status: null, modules: [], hasModule: () => false, maxUsers: null, refresh: () => {} };
};
