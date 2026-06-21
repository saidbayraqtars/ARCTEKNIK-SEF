import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { initTheme } from './theme'
import { registerServiceWorker } from './pwa'

// Kayıtlı temayı (gece modu) ilk boyamadan ÖNCE uygula — beyaz parlama olmasın.
initTheme()

// PWA service worker — yalnız güvenli + uzak bağlamda (Tailscale HTTPS) kaydolur.
registerServiceWorker()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
