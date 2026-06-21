import { createContext, useState, useContext, useEffect } from 'react';
import { api, setupApiInterceptors } from '../api/client';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);

  const logout = () => {
    setUser(null);
    setToken(null);
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    delete api.defaults.headers.common['Authorization'];
  };

  useEffect(() => {
    setupApiInterceptors(() => {
      logout();
      if (window.location.pathname !== '/login' && !window.location.pathname.startsWith('/sorgula')) {
        window.location.href = '/login';
      }
    });
  }, []);

  useEffect(() => {
    const savedToken = localStorage.getItem('token');
    const savedUser = localStorage.getItem('user');
    if (savedToken && savedUser) {
      setToken(savedToken);
      setUser(JSON.parse(savedUser));
      api.defaults.headers.common['Authorization'] = `Bearer ${savedToken}`;
    }
    setLoading(false);
  }, []);

  const login = (userData, jwtToken) => {
    setUser(userData);
    setToken(jwtToken);
    localStorage.setItem('token', jwtToken);
    localStorage.setItem('user', JSON.stringify(userData));
    api.defaults.headers.common['Authorization'] = `Bearer ${jwtToken}`;
  };

  const isAdmin = user?.role === 'Admin';
  const permissions = Array.isArray(user?.permissions) ? user.permissions : [];
  const hasPermission = (perm) => isAdmin || permissions.includes(perm);

  return (
    <AuthContext.Provider value={{ user, token, login, logout, loading, isAdmin, permissions, hasPermission }}>
      {children}
    </AuthContext.Provider>
  );
};

export const PERMISSIONS = {
  DELETE_SERVICE: 'delete_service',
  ADD_CUSTOMER: 'add_customer',
  VIEW_PRICING: 'view_pricing',
  MANAGE_STOCK: 'manage_stock',
  MANAGE_ACCOUNTS: 'manage_accounts',
  MANAGE_DOCUMENTS: 'manage_documents',
  VIEW_REPORTS: 'view_reports',
  USE_RESTAURANT: 'use_restaurant',
};

export const PERMISSION_LABELS = {
  delete_service: 'Müşteri/Servis Silme',
  add_customer: 'Müşteri Ekleme',
  view_pricing: 'Ücret Görüntüleme',
  manage_stock: 'Stok & Depo',
  manage_accounts: 'Kasa & Cari',
  manage_documents: 'Belgeler (Teklif/Fatura)',
  view_reports: 'İstatistikler / Raporlar',
  use_restaurant: 'ArcTeknik Şef (Restoran)',
};

export const useAuth = () => useContext(AuthContext);
