const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lastHour", {
  appInfo: () => ipcRenderer.invoke("app:info"),
  snapshot: () => ipcRenderer.invoke("feeds:snapshot"),
  refreshAll: (options = {}) => ipcRenderer.invoke("feeds:refresh-all", options),
  refreshTopic: (topic, options = {}) => ipcRenderer.invoke("feeds:refresh-topic", topic, options),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  exportFeed: (format, feed) => ipcRenderer.invoke("feed:export", format, feed),
  summarize: (story) => ipcRenderer.invoke("story:summarize", story),
  speak: (text) => ipcRenderer.invoke("speech:speak", text),
  stopSpeaking: () => ipcRenderer.invoke("speech:stop"),
  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  currentWeather: (force = false) => ipcRenderer.invoke("weather:current", force),
  onProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("feeds:progress", listener);
    return () => ipcRenderer.removeListener("feeds:progress", listener);
  },
  onSpeechState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("speech:state", listener);
    return () => ipcRenderer.removeListener("speech:state", listener);
  },
  onUpdateProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("update:progress", listener);
    return () => ipcRenderer.removeListener("update:progress", listener);
  }
});
