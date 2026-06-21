import axios from 'axios';

export const getApiBaseUrl = () => {
  // Dev mode (vite serves frontend on :3000, API server runs separately on :5000)
  if (import.meta.env.DEV) {
    const envUrl = import.meta.env.VITE_API_URL;
    if (envUrl) return envUrl.replace(/\/$/, '');
    return `http://${window.location.hostname}:5000/api`;
  }
  // Production / desktop: frontend is served from the same origin as the API
  return `${window.location.origin}/api`;
};

export const api = axios.create({
  baseURL: getApiBaseUrl(),
});

export const setupApiInterceptors = (onUnauthorized) => {
  api.interceptors.response.use(
    (response) => response,
    (error) => {
      const isLogin = error.config?.url?.includes('/auth/login');
      if (error.response?.status === 401 && !isLogin) {
        onUnauthorized();
      }
      return Promise.reject(error);
    }
  );
};
