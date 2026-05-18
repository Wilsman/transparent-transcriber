const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("transcriber", {
  start: (settings) => ipcRenderer.invoke("transcriber:start", settings),
  stop: () => ipcRenderer.invoke("transcriber:stop"),
  sendAudioChunk: (payload) => ipcRenderer.invoke("transcriber:audio-chunk", payload),
  listDesktopSources: () => ipcRenderer.invoke("desktop-sources:list"),
  selectDesktopSource: (sourceId) => ipcRenderer.invoke("desktop-sources:select", sourceId),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("transcriber:event", listener);
    return () => ipcRenderer.removeListener("transcriber:event", listener);
  }
});
