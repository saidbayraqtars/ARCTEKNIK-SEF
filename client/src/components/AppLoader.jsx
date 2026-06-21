import { PenTool } from 'lucide-react';
import { productMeta } from '../product';

/**
 * Tam ekran, markalı yükleme göstergesi.
 * Açılış kapıları (SetupGate / LicenseGate / ProtectedRoute) düz "Yükleniyor..."
 * yazısı yerine bunu kullanır — kurumsal his + "açılmak üzere" geri bildirimi.
 */
export default function AppLoader({ message = 'Yükleniyor…' }) {
  return (
    <div className="app-loader">
      <div className="app-loader__logo">
        <PenTool size={34} className="text-white" />
      </div>
      <div className="text-center">
        <div className="text-xl font-bold text-white tracking-wide">{productMeta.short}</div>
        <div className="text-xs text-slate-400 mt-0.5">İşletme Yönetim Sistemi</div>
      </div>
      <div className="app-loader__bar" />
      <div className="app-loader__text">{message}</div>
    </div>
  );
}
