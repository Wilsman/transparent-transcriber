const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("transcriber", {
  start: (settings) => ipcRenderer.invoke("transcriber:start", settings),
  stop: () => ipcRenderer.invoke("transcriber:stop"),
  sendAudioChunk: (payload) => ipcRenderer.invoke("transcriber:audio-chunk", payload),
  listDesktopSources: () => ipcRenderer.invoke("desktop-sources:list"),
  selectDesktopSource: (sourceId) => ipcRenderer.invoke("desktop-sources:select", sourceId),
  getVersion: () => ipcRenderer.invoke("app:get-version"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  installUpdateAndRelaunch: () => ipcRenderer.invoke("updates:install-and-relaunch"),
  openUpdateRelease: () => ipcRenderer.invoke("updates:open-release"),
  closeWindow: () => ipcRenderer.invoke("app:close"),
  resizeToContent: (payload) => ipcRenderer.invoke("window:resize-to-content", payload),
  onUpdateEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("updates:event", listener);
    return () => ipcRenderer.removeListener("updates:event", listener);
  },
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("transcriber:event", listener);
    return () => ipcRenderer.removeListener("transcriber:event", listener);
  }
});
