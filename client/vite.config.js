import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(() => ({
  plugins: [react()],
  // Absolute base ('/') — uygulama her zaman http://127.0.0.1 kökünden sunulur
  // (Electron win.loadURL, asla file://). Göreli './' base, 2 seviye derin
  // rotalarda (ör. /restoran/yonetim, /restoran/mutfak) asset yolunu
  // /restoran/assets/... olarak çözüp 404 → boş beyaz ekrana yol açıyordu.
  base: '/',
  server: {
    host: '0.0.0.0', // LAN üzerinden erişime izin verir
    port: 3000,
  },
}))
