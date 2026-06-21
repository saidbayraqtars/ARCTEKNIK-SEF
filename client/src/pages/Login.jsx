import { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { Lock, User, AlertCircle, ChevronDown, Delete } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { productMeta } from '../product';

const Login = () => {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [userList, setUserList] = useState([]);
  const [isRestaurant, setIsRestaurant] = useState(false);
  const [mode, setMode] = useState('password'); // 'pin' | 'password'

  // Sürüm sinyali: ArcTeknik Şef'te dokunmatik PIN girişi varsayılan.
  useEffect(() => {
    let alive = true;
    api.get('/setup/status')
      .then((res) => {
        if (!alive) return;
        if (res.data?.edition === 'restaurant') {
          setIsRestaurant(true);
          setMode('pin');
        }
      })
      .catch(() => { /* sürüm alınamadı → klasik parola modu */ });
    return () => { alive = false; };
  }, []);

  // Parola modu açılır listesi — aktif kullanıcılar (giriş öncesi, hassas veri yok).
  useEffect(() => {
    let alive = true;
    api.get('/auth/users-list')
      .then((res) => {
        if (!alive) return;
        const list = Array.isArray(res.data) ? res.data : [];
        setUserList(list);
        if (list.length > 0) setUsername(list[0].username); // ilk kullanıcıyı seç
      })
      .catch(() => { /* boş liste → elle yazmaya düşer */ });
    return () => { alive = false; };
  }, []);

  const afterLogin = (data) => {
    login(data.user, data.token);
    const dest = location.state?.from;
    navigate(dest && dest !== '/login' ? dest : '/');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const response = await api.post('/auth/login', { username, password });
      afterLogin(response.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Bağlantı hatası oluştu.');
    } finally {
      setLoading(false);
    }
  };

  const submitPin = async (value) => {
    setError('');
    setLoading(true);
    try {
      const response = await api.post('/auth/pin-login', { pin: value });
      afterLogin(response.data);
    } catch (err) {
      setError(err.response?.data?.error || 'PIN hatalı.');
      setPin('');
    } finally {
      setLoading(false);
    }
  };

  const pressDigit = (d) => {
    if (loading) return;
    setError('');
    setPin((p) => (p.length >= 8 ? p : p + d));
  };
  const backspace = () => { setError(''); setPin((p) => p.slice(0, -1)); };
  const clearPin = () => { setError(''); setPin(''); };

  // ── PIN NUMPAD (ArcTeknik Şef) ──────────────────────────────────────────
  const renderPin = () => (
    <div className="bg-white/10 backdrop-blur-lg rounded-2xl border border-white/20 p-6 shadow-2xl">
      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-red-500/20 border border-red-500/40 rounded-lg text-red-200 text-sm">
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      )}

      {/* PIN gösterge noktaları */}
      <div className="flex items-center justify-center gap-3 h-14 mb-5">
        {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
          <span
            key={i}
            className={`w-4 h-4 rounded-full transition-colors ${i < pin.length ? 'bg-brand-400' : 'bg-white/20'}`}
          />
        ))}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => pressDigit(d)}
            className="h-20 text-3xl font-semibold text-white bg-white/10 hover:bg-white/20 active:bg-white/30 rounded-2xl border border-white/15 transition-colors select-none"
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          onClick={clearPin}
          className="h-20 text-lg font-semibold text-slate-300 bg-white/5 hover:bg-white/15 active:bg-white/25 rounded-2xl border border-white/10 transition-colors select-none"
        >
          C
        </button>
        <button
          type="button"
          onClick={() => pressDigit('0')}
          className="h-20 text-3xl font-semibold text-white bg-white/10 hover:bg-white/20 active:bg-white/30 rounded-2xl border border-white/15 transition-colors select-none"
        >
          0
        </button>
        <button
          type="button"
          onClick={backspace}
          className="h-20 flex items-center justify-center text-slate-300 bg-white/5 hover:bg-white/15 active:bg-white/25 rounded-2xl border border-white/10 transition-colors select-none"
        >
          <Delete size={28} />
        </button>
      </div>

      <button
        type="button"
        disabled={loading || pin.length < 4}
        onClick={() => submitPin(pin)}
        className="w-full mt-5 py-4 bg-brand-600 hover:bg-brand-700 text-white text-lg font-semibold rounded-2xl transition-colors disabled:opacity-40"
      >
        {loading ? 'Giriş yapılıyor...' : 'Giriş Yap'}
      </button>

      <button
        type="button"
        onClick={() => { setMode('password'); setError(''); }}
        className="w-full mt-3 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
      >
        Yönetici parola ile giriş
      </button>
    </div>
  );

  // ── PAROLA MODU (klasik / admin yedek) ──────────────────────────────────
  const renderPassword = () => (
    <div className="bg-white/10 backdrop-blur-lg rounded-2xl border border-white/20 p-8 shadow-2xl">
      <form onSubmit={handleSubmit} className="space-y-5">
        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-500/20 border border-red-500/40 rounded-lg text-red-200 text-sm">
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">Kullanıcı</label>
          <div className="relative">
            <User size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none z-10" />
            {userList.length > 0 ? (
              <>
                <select
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full pl-10 pr-10 py-3 bg-white/10 border border-white/20 rounded-lg text-white appearance-none focus:outline-none focus:ring-2 focus:ring-brand-500"
                  required
                >
                  {userList.map((u) => (
                    <option key={u.username} value={u.username} className="bg-slate-800 text-white">
                      {u.fullName ? `${u.fullName} (${u.username})` : u.username}
                    </option>
                  ))}
                </select>
                <ChevronDown size={18} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              </>
            ) : (
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full pl-10 pr-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder="admin"
                required
                autoFocus
              />
            )}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">Şifre</label>
          <div className="relative">
            <Lock size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full pl-10 pr-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
              required
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 bg-brand-600 hover:bg-brand-700 text-white font-semibold rounded-lg transition-colors disabled:opacity-50"
        >
          {loading ? 'Giriş yapılıyor...' : 'Giriş Yap'}
        </button>
      </form>

      {isRestaurant && (
        <button
          type="button"
          onClick={() => { setMode('pin'); setError(''); }}
          className="w-full mt-3 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
        >
          PIN ile giriş
        </button>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-brand-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img
            src="/icon.png"
            alt="ArcTeknik"
            className="w-24 h-24 mx-auto mb-4 drop-shadow-lg"
          />
          <h1 className="text-3xl font-bold text-white tracking-tight">{productMeta.title}</h1>
          <p className="text-slate-400 mt-2">
            {mode === 'pin' ? 'PIN kodunuzu girin' : 'Yönetim Paneline Giriş Yapın'}
          </p>
        </div>

        {mode === 'pin' ? renderPin() : renderPassword()}

        {mode !== 'pin' && (
          <p className="text-center text-slate-500 text-xs mt-6">
            İlk kurulum: admin / admin123 — girişten sonra şifrenizi değiştirin.
          </p>
        )}
      </div>
    </div>
  );
};

export default Login;
