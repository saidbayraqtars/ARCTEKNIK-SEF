const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('backup', {
    getConfig: () => ipcRenderer.invoke('backup:get-config'),
    listDrives: () => ipcRenderer.invoke('backup:list-drives'),
    pickFolder: (defaultPath) => ipcRenderer.invoke('backup:pick-folder', defaultPath),
    pickFile: (defaultPath) => ipcRenderer.invoke('backup:pick-file', defaultPath),
    listExisting: (folder) => ipcRenderer.invoke('backup:list-existing', folder),
    runBackup: (dest) => ipcRenderer.invoke('backup:run-backup', dest),
    runRestore: (file) => ipcRenderer.invoke('backup:run-restore', file),
    deleteFile: (file) => ipcRenderer.invoke('backup:delete-file', file),
    defaultFolder: () => ipcRenderer.invoke('backup:default-folder'),
});
