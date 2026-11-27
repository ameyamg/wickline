// What the desktop app's pages may ask the app itself (everything else goes through the built-in
// server): the network proxy setting, read and changed from Data sources (desktop/proxy.mjs), and
// updates that install themselves (desktop/updater.mjs).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wicklineDesktop', {
  getProxy: () => ipcRenderer.invoke('proxy:get'),
  setProxy: (settings) => ipcRenderer.invoke('proxy:set', { mode: settings?.mode, server: settings?.server }),
  canSelfUpdate: () => ipcRenderer.invoke('update:supported'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (fn) => { ipcRenderer.on('update:status', (_e, s) => fn(s)); },
});
