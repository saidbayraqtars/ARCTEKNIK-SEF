// ERP/Şef penceresi preload — yalnızca güvenli, sınırlı bir köprü açar:
// uygulama içinden (Ayarlar) Yedekleme Merkezi penceresini açtırmak için.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bayraktarDesktop', {
  isDesktop: true,
  openBackup: () => ipcRenderer.send('open-backup-center'),
  // Ayarlar → "Güncellemeleri denetle": { status: 'available'|'uptodate'|'error'|'dev', version?, message? }
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  // ArcTeknik Şef — sessiz termal yazdırma:
  //   listPrinters() → [{ name, displayName, isDefault, ... }]
  //   silentPrint({ html, deviceName }) → { ok: boolean, error?: string }
  // deviceName boş ('') ise OS varsayılan yazıcısına basar.
  listPrinters: () => ipcRenderer.invoke('list-printers'),
  silentPrint: (payload) => ipcRenderer.invoke('silent-print', payload),
  // ArcTeknik Şef — dokunmatik kiosk için güvenli kapatma (klavyesiz terminal).
  // React onay modalından sonra çağrılır → uygulama temiz kapanır.
  quitApp: () => ipcRenderer.invoke('quit-app'),
  // Destek paketi: logları Masaüstü'ne klasör olarak toplar → { ok, path?, error? }
  createSupportBundle: () => ipcRenderer.invoke('create-support-bundle'),
});
